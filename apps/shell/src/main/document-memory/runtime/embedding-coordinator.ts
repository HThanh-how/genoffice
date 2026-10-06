import { writeFileSync, mkdirSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { totalmem } from 'node:os'
import type { DocumentMemoryStore } from '../store'
import type { DocumentChunk } from '../chunks'
import { memoryTierFromTotal, MEMORY_TIER_POLICIES } from '../memory-tier'
import {
  DEFAULT_EMBEDDING_PROFILE,
  EMBEDDING_PROFILES,
  type EmbeddingProfile,
  type EmbeddingProfileId,
} from '../embedding-profiles'

const EMBED_RETRY_DELAY_MS = 15_000

export interface EmbedJob {
  path: string
  generation: number
  epoch: number
  hash: string
  mtimeMs: number
  sizeBytes: number
  chunks: DocumentChunk[]
  startOffset?: number
  priority?: number
}

export type AskWorkerEmbed = (
  request: { type: 'embed'; texts: string[]; kind: 'passage' },
  timeoutMs: number,
) => Promise<{ result?: number[][]; error?: string } | null>

export interface EmbeddingCoordinatorOptions {
  store: DocumentMemoryStore
  settingsPath: string
  initialProfileId?: EmbeddingProfileId
  workerTimeoutMs?: number
  isStoppedOrPaused?: () => boolean
  isCurrent?: (path: string, generation: number, epoch: number) => boolean
  onDrainNeeded?: () => void
  onEnqueueExtract?: (path: string) => void
  onError?: (error: string) => void
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Document memory operation failed.'
}

async function statMeta(path: string): Promise<{ mtimeMs: number; sizeBytes: number } | null> {
  try {
    const result = await stat(path)
    return { mtimeMs: result.mtimeMs, sizeBytes: result.size }
  } catch {
    return null
  }
}

export class EmbeddingCoordinator {
  private profileId: EmbeddingProfileId
  private profile: EmbeddingProfile
  private readonly embeds: EmbedJob[] = []
  private activeEmbedJob: EmbedJob | null = null
  private embeddingRetryAt = 0
  private retryTimer: NodeJS.Timeout | null = null
  private embedding = false

  constructor(private readonly options: EmbeddingCoordinatorOptions) {
    this.profileId = options.initialProfileId ?? DEFAULT_EMBEDDING_PROFILE
    this.profile = EMBEDDING_PROFILES[this.profileId]
    this.options.store.ensureEmbeddingSpace(this.profile)
  }

  get currentProfile(): EmbeddingProfile {
    return this.profile
  }

  get currentProfileId(): EmbeddingProfileId {
    return this.profileId
  }

  getQueueLength(): number {
    return this.embeds.length
  }

  getActiveJob(): EmbedJob | null {
    return this.activeEmbedJob
  }

  isEmbedding(): boolean {
    return this.embedding
  }

  isRetryPending(): boolean {
    return Date.now() < this.embeddingRetryAt
  }

  get embedsQueue(): readonly EmbedJob[] {
    return this.embeds
  }

  clearQueue(): void {
    this.embeds.length = 0
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  removePath(path: string): void {
    if (this.activeEmbedJob?.path === path) {
      this.activeEmbedJob = null
    }
    for (let i = this.embeds.length - 1; i >= 0; i--) {
      if (this.embeds[i]?.path === path) {
        this.embeds.splice(i, 1)
      }
    }
  }

  promotePath(path: string): boolean {
    const idx = this.embeds.findIndex((j) => j.path === path)
    if (idx >= 0) {
      const [job] = this.embeds.splice(idx, 1)
      if (job) this.embeds.unshift(job)
      this.embeddingRetryAt = 0
      if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
      return true
    }
    if (this.activeEmbedJob?.path === path) {
      this.embeddingRetryAt = 0
      if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
      return true
    }
    return false
  }

  isEmbeddingPath(path: string): boolean {
    return this.activeEmbedJob?.path === path
  }

  enqueueEmbed(job: EmbedJob): void {
    if (this.options.isStoppedOrPaused?.()) return
    job.priority = this.options.store.documentPriority(job.path)
    const position = this.embeds.findIndex((queued) => (job.priority ?? 0) > (queued.priority ?? 0))
    if (position < 0) this.embeds.push(job)
    else this.embeds.splice(position, 0, job)
    this.options.onDrainNeeded?.()
  }

  deferEmbeddingRetry(delayMs = EMBED_RETRY_DELAY_MS): void {
    this.embeddingRetryAt = Date.now() + delayMs
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.options.onDrainNeeded?.()
    }, delayMs)
    this.retryTimer.unref?.()
  }

  async drainEmbeddings(
    askWorker: AskWorkerEmbed,
    onBatchComplete?: (completedChunks: number) => void,
  ): Promise<void> {
    if (this.embedding || this.options.isStoppedOrPaused?.()) return
    this.embedding = true
    try {
      while (
        !this.options.isStoppedOrPaused?.() &&
        this.embeds.length > 0 &&
        Date.now() >= this.embeddingRetryAt
      ) {
        const job = this.embeds.shift()!
        if (this.options.isCurrent && !this.options.isCurrent(job.path, job.generation, job.epoch)) {
          continue
        }
        this.activeEmbedJob = job
        try {
          const start = job.startOffset ?? 0
          if (this.options.isCurrent && !this.options.isCurrent(job.path, job.generation, job.epoch)) {
            break
          }
          const tier = memoryTierFromTotal(totalmem() / (1024 * 1024))
          const policy = MEMORY_TIER_POLICIES[tier]
          const batchLimit = tier === 'low' ? policy.embeddingBatch : 8
          let totalTokens = 0
          const part: DocumentChunk[] = []
          for (let i = start; i < Math.min(job.chunks.length, start + batchLimit); i++) {
            const chunk = job.chunks[i]!
            const estTokens = Math.ceil(chunk.text.length / 3.5)
            if (part.length > 0 && totalTokens + estTokens > policy.maxBatchTokens) {
              break
            }
            part.push(chunk)
            totalTokens += estTokens
          }
          if (part.length === 0) continue

          const reply = await askWorker(
            { type: 'embed', texts: part.map((chunk) => chunk.text), kind: 'passage' },
            this.options.workerTimeoutMs ?? 60_000,
          )

          if (this.options.isCurrent && !this.options.isCurrent(job.path, job.generation, job.epoch)) {
            break
          }

          if (
            !reply ||
            !('result' in reply) ||
            !Array.isArray(reply.result) ||
            !reply.result.every((v) => Array.isArray(v))
          ) {
            const error =
              reply && 'error' in reply && typeof reply.error === 'string'
                ? reply.error
                : 'Embedding timed out.'
            this.options.onError?.(error)
            if (!this.options.isCurrent || this.options.isCurrent(job.path, job.generation, job.epoch)) {
              this.embeds.push(job)
            }
            this.deferEmbeddingRetry()
            break
          }

          const vectors = reply.result as number[][]
          if (vectors.length !== part.length) {
            throw new Error('Embedding count did not match chunk count')
          }

          const current = await statMeta(job.path)
          if (this.options.isCurrent && !this.options.isCurrent(job.path, job.generation, job.epoch)) {
            break
          }
          if (!current || current.mtimeMs !== job.mtimeMs || current.sizeBytes !== job.sizeBytes) {
            if (current) this.options.onEnqueueExtract?.(job.path)
            break
          }

          const complete = start + vectors.length >= job.chunks.length
          this.options.store.setChunkEmbeddings(
            job.path,
            job.hash,
            start,
            vectors,
            this.profile.embeddingId,
            complete,
          )
          onBatchComplete?.(vectors.length)

          if (!complete && (!this.options.isCurrent || this.options.isCurrent(job.path, job.generation, job.epoch))) {
            this.embeds.push({ ...job, startOffset: start + vectors.length })
            break
          }
        } catch (error) {
          if (!this.options.isCurrent || this.options.isCurrent(job.path, job.generation, job.epoch)) {
            this.options.onError?.(safeError(error))
            this.embeds.push(job)
            this.deferEmbeddingRetry()
          }
        } finally {
          this.activeEmbedJob = null
        }
      }
    } finally {
      this.embedding = false
      if (!this.options.isStoppedOrPaused?.()) {
        this.options.onDrainNeeded?.()
      }
    }
  }

  getEmbeddingSettings(): {
    profile: EmbeddingProfileId
    available: EmbeddingProfile[]
  } {
    return {
      profile: this.profileId,
      available: Object.values(EMBEDDING_PROFILES),
    }
  }

  setEmbeddingProfile(nextId: EmbeddingProfileId): {
    changed: boolean
    requeued: number
  } {
    if (nextId === this.profileId || !(nextId in EMBEDDING_PROFILES)) {
      return { changed: false, requeued: 0 }
    }
    this.profileId = nextId
    this.profile = EMBEDDING_PROFILES[nextId]
    this.options.store.ensureEmbeddingSpace(this.profile)

    try {
      mkdirSync(dirname(this.options.settingsPath), { recursive: true })
      writeFileSync(
        this.options.settingsPath,
        JSON.stringify({ profile: nextId }),
        'utf8',
      )
    } catch {
      // ignore
    }

    const requeued = this.options.store.requeueForEmbeddingModel(this.profile.embeddingId)
    return { changed: true, requeued }
  }

  getEmbeddingProgress(): Record<string, { done: number; total: number }> {
    const res: Record<string, { done: number; total: number }> = {}
    for (const job of this.embeds) res[job.path] = { done: job.startOffset ?? 0, total: job.chunks.length }
    if (this.activeEmbedJob) res[this.activeEmbedJob.path] = { done: this.activeEmbedJob.startOffset ?? 0, total: this.activeEmbedJob.chunks.length }
    return res
  }
}
