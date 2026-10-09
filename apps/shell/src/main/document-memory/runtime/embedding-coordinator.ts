import { executePostWriteAccounting } from './post-write-accounting'
import { stat } from 'node:fs/promises'
import { totalmem } from 'node:os'
import type { DocumentMemoryStore } from '../store'
import type { DocumentChunk } from '../chunks'
import { memoryTierFromTotal, MEMORY_TIER_POLICIES } from '../memory-tier'
import {
  DEFAULT_EMBEDDING_PROFILE,
  EMBEDDING_PROFILES,
  isEmbeddingProfileId,
  type EmbeddingProfile,
  type EmbeddingProfileId,
} from '../embedding-profiles'
import { writeActiveEmbeddingConfig } from '../storage/embedding-settings'
import {
  type StorageAdmissionController,
} from './storage-admission'
import {
  contentWriteCapBytes,
  CACHE_RETENTION_HIGH_WATERMARK,
  type DocumentIndexStorageBudget,
  type StorageBudgetSnapshot,
} from '../storage-budget'
import {
  estimateEmbeddingBatchBytes,
  validateReturnedVectors,
  CONSERVATIVE_EMBEDDING_HEADROOM_BYTES,
  DEFAULT_EMBED_RETRY_DELAY_MS,
} from './embedding-write-budget'

const EMBED_RETRY_DELAY_MS = DEFAULT_EMBED_RETRY_DELAY_MS

/** How often documents parked by the grace-zone value rule are re-checked for release. */
export const GRACE_DEFER_RECHECK_MS = 15_000
/**
 * Grace-zone value rule (deterministic, in-memory):
 * - PARK: while managed bytes >= the soft quota (grace zone), a job whose document has EFFECTIVE importance
 *   'low' (user override 'low') is not embedded. Its name row and lexical text were already admitted and stay
 *   searchable; only the expensive vectors are deferred. 'normal' and 'important' documents keep full embedding.
 * - RELEASE: parked jobs are re-queued once managed bytes are below GRACE_DEFER_RESUME_RATIO of the soft quota
 *   (the 90% retention high watermark). Embedding them can then never push usage straight back over the quota,
 *   and if it later crosses 90% retention evicts low-value vectors first and marks them (vector-eviction
 *   marker, 60% release rule), so there is no park/embed/evict oscillation.
 */
export const GRACE_DEFER_RESUME_RATIO = CACHE_RETENTION_HIGH_WATERMARK

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
  settingsDir?: string
  settingsPath?: string
  initialProfileId?: EmbeddingProfileId
  workerTimeoutMs?: number
  isStopped?: () => boolean
  isStoppedOrPaused?: () => boolean
  isCurrent?: (path: string, generation: number, epoch: number) => boolean
  canAcceptExpensiveWork?: () => boolean
  onDrainNeeded?: () => void
  onEnqueueExtract?: (path: string) => void
  onError?: (error: string) => void
  admission?: StorageAdmissionController
  getStorageBudget?: () => DocumentIndexStorageBudget
  getCurrentUsage?: () => number
  /**
   * Admission by displacement: an embedding reservation was refused for quota while usage is at/over the soft quota.
   * Resolve true when space was freed and the reservation should be retried once (the owner single-flights and
   * cools down; the coordinator never loops).
   */
  makeRoom?: (neededBytes: number, path: string) => Promise<boolean>
  isDegraded?: () => boolean
  invalidateAccounting?: (reason: string) => void
  refreshUsage?: () => Promise<StorageBudgetSnapshot | null>
  isWriteReady?: () => boolean
  getFreeDiskBytes?: () => Promise<number | null>
  headroomBytes?: number
  /**
   * Admission feedback: `true` once a drain pass stopped on a TRANSIENT admission gate (accounting not fresh, free disk
   * unverifiable, quota refusal), `false` after a batch was committed. When set, the owner re-measures and re-drives the
   * queue with its own bounded backoff instead of the fixed retry delay.
   */
  onAdmission?: (blocked: boolean, accountingRelated?: boolean) => void
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
  /** Low-value jobs deferred while usage is in the grace zone (see GRACE_DEFER_RESUME_RATIO). */
  private readonly graceParked = new Map<string, EmbedJob>()
  private graceTimer: NodeJS.Timeout | null = null

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

  /** Queued + grace-parked jobs: callers use this to avoid re-extracting a document whose embedding is pending. */
  get embedsQueue(): readonly EmbedJob[] {
    return this.graceParked.size === 0 ? this.embeds : [...this.embeds, ...this.graceParked.values()]
  }

  /** Number of low-value jobs currently parked by the grace-zone value rule. */
  getGraceDeferredCount(): number {
    return this.graceParked.size
  }

  private currentUsageRatio(): { used: number; soft: number } | null {
    const budget = this.options.getStorageBudget?.()
    const used = this.options.getCurrentUsage?.()
    if (!budget || typeof used !== 'number' || !Number.isFinite(used) || !(budget.maxDatabaseBytes > 0)) return null
    return { used, soft: budget.maxDatabaseBytes }
  }

  /** True when the job must wait: usage is at/over the soft quota and the document is effectively 'low'. */
  private shouldParkForGrace(job: EmbedJob): boolean {
    const u = this.currentUsageRatio()
    if (!u || u.used < u.soft) return false
    try {
      return this.options.store.getImportance(job.path)?.effective === 'low'
    } catch {
      return false
    }
  }

  private parkForGrace(job: EmbedJob): void {
    this.graceParked.set(job.path, job)
    this.armGraceTimer()
  }

  private armGraceTimer(): void {
    if (this.graceTimer || this.graceParked.size === 0) return
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null
      this.releaseGraceDeferred()
    }, GRACE_DEFER_RECHECK_MS)
    this.graceTimer.unref?.()
  }

  /** Re-queues parked jobs when usage is back below GRACE_DEFER_RESUME_RATIO x soft quota; else re-arms. */
  releaseGraceDeferred(): number {
    if (this.graceParked.size === 0) return 0
    const u = this.currentUsageRatio()
    if (!u || u.used >= u.soft * GRACE_DEFER_RESUME_RATIO) {
      this.armGraceTimer()
      return 0
    }
    const jobs = [...this.graceParked.values()]
    this.graceParked.clear()
    for (const job of jobs) if (!this.isJobCancelled(job)) this.enqueueEmbed(job)
    return jobs.length
  }

  private clearGraceParked(): void {
    this.graceParked.clear()
    if (this.graceTimer) {
      clearTimeout(this.graceTimer)
      this.graceTimer = null
    }
  }

  clearQueue(): void {
    this.clearGraceParked()
    this.embeds.length = 0
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  removePath(path: string): void {
    this.graceParked.delete(path)
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
    if (this.options.isStopped ? this.options.isStopped() : this.options.isStoppedOrPaused?.()) return
    this.graceParked.delete(job.path) // fresher content supersedes a parked job
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

  private isJobCancelled(job: EmbedJob): boolean {
    if (this.options.isStopped ? this.options.isStopped() : this.options.isStoppedOrPaused?.()) return true
    if (this.options.isCurrent && !this.options.isCurrent(job.path, job.generation, job.epoch)) return true
    return false
  }

  /**
   * `yieldAfterMs`: once at least one batch is committed and this much time has passed the pass ends (the owner then gives
   * the other lane its turn and calls again), so a queue of small documents cannot hold the worker for minutes either.
   */
  async drainEmbeddings(
    askWorker: AskWorkerEmbed,
    onBatchComplete?: (completedChunks: number) => void,
    yieldAfterMs?: number,
  ): Promise<void> {
    if (this.embedding || this.options.isStoppedOrPaused?.()) return
    this.embedding = true
    let blockedByBudget = false
    let blockedOnAccounting = false
    const startedAt = Date.now()
    let committed = 0
    try {
      this.releaseGraceDeferred()
      while (
        !this.options.isStoppedOrPaused?.() &&
        this.embeds.length > 0 &&
        Date.now() >= this.embeddingRetryAt &&
        !(yieldAfterMs !== undefined && committed > 0 && Date.now() - startedAt >= yieldAfterMs)
      ) {
        if (this.options.canAcceptExpensiveWork && !this.options.canAcceptExpensiveWork()) {
          blockedByBudget = true; blockedOnAccounting = true
          break
        }
        if (this.options.isWriteReady && !this.options.isWriteReady()) {
          this.deferEmbeddingRetry()
          break
        }
        const job = this.embeds.shift()!
        if (this.isJobCancelled(job)) {
          continue
        }
        if (this.shouldParkForGrace(job)) {
          this.parkForGrace(job)
          continue
        }
        this.activeEmbedJob = job

        const start = job.startOffset ?? 0
        const startOffset = start
        const localReserveId = `embed:${job.path}:${startOffset}`
        const localOwnerToken = `embed:${job.path}:${startOffset}:${Date.now()}:${Math.random().toString(36).slice(2)}`
        let hasLocalReservation = false

        try {
          if (this.isJobCancelled(job)) break
          if (this.options.isWriteReady && !this.options.isWriteReady()) {
            this.deferEmbeddingRetry()
            this.embeds.push(job)
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

          const headroom = this.options.headroomBytes ?? CONSERVATIVE_EMBEDDING_HEADROOM_BYTES
          const estBytes = estimateEmbeddingBatchBytes(part.length, this.profile.dimensions)

          if (this.options.admission) {
            // Fresh physical accounting before admission
            let snap: StorageBudgetSnapshot | null = null
            if (this.options.refreshUsage) {
              try {
                snap = await this.options.refreshUsage()
              } catch {
                snap = null
              }
            }

            if (this.isJobCancelled(job)) break
            if (this.options.isWriteReady && !this.options.isWriteReady()) {
              this.deferEmbeddingRetry()
              this.embeds.push(job)
              break
            }

            // Do NOT fallback to DB-only or 0 if unknown or degraded
            if (!snap || snap.measurementStatus === 'unknown' || snap.isDegraded === true) {
              blockedByBudget = true; blockedOnAccounting = true
              const reason = snap?.isDegraded ? 'accounting-degraded' : 'accounting-unknown'
              this.options.onError?.(`Storage accounting degraded or unknown (${reason})`)
              this.deferEmbeddingRetry()
              this.embeds.push(job)
              break
            }

            const freeDiskBytes = this.options.getFreeDiskBytes ? await this.options.getFreeDiskBytes() : null
            if (this.isJobCancelled(job)) break
            if (this.options.isWriteReady && !this.options.isWriteReady()) {
              this.deferEmbeddingRetry()
              this.embeds.push(job)
              break
            }

            if (freeDiskBytes === null) {
              blockedByBudget = true; blockedOnAccounting = true
              this.options.onError?.('Free disk space could not be verified (statfs unreadable or unsafe)')
              this.deferEmbeddingRetry()
              this.embeds.push(job)
              break
            }

            const currentBytes = snap.totalManagedBytes ?? snap.databaseBytes
            // Grace zone: reserve against the HARD cap (soft quota + overshoot), never the soft quota
            const liveBudget = this.options.getStorageBudget?.()
            const budgetBytes = liveBudget ? contentWriteCapBytes(liveBudget) : 0

            const tryReserve = (usageBytes: number) =>
              this.options.admission!.reserve(
                localReserveId,
                'passage-embed',
                estBytes,
                usageBytes,
                budgetBytes,
                60_000,
                {
                  isAlive: () => !this.isJobCancelled(job),
                  holdUntilJobEnds: true,
                  accountingDegraded: false,
                  freeDiskBytes,
                  headroomBytes: headroom,
                  ownerId: localOwnerToken,
                },
              )
            let decision = tryReserve(currentBytes)
            if (
              !decision.admitted &&
              this.options.makeRoom &&
              (decision.reason === 'hard-limit-exceeded' || decision.reason === 'quota-exhausted') &&
              !this.isJobCancelled(job)
            ) {
              // retry once after displacement; refuse only if still impossible
              const shortfall = Math.max(1, Math.ceil(decision.projectedBytes - decision.budgetBytes))
              const freed = await this.options.makeRoom(shortfall, job.path).catch(() => false)
              if (freed && !this.isJobCancelled(job)) decision = tryReserve(this.options.getCurrentUsage?.() ?? currentBytes)
            }
            if (!decision.admitted) {
              blockedByBudget = true
              this.options.onError?.(`Storage quota exceeded for embedding (${decision.reason})`)
              this.deferEmbeddingRetry()
              this.embeds.push(job)
              break
            }
            hasLocalReservation = true
          }

          const reply = await askWorker(
            { type: 'embed', texts: part.map((chunk) => chunk.text), kind: 'passage' },
            this.options.workerTimeoutMs ?? 60_000,
          )

          if (this.isJobCancelled(job)) break

          // Gatepending shrink closes writes even modelreplyalreadyarrived
          if (this.options.isWriteReady && !this.options.isWriteReady()) {
            this.deferEmbeddingRetry()
            this.embeds.push(job)
            break
          }

          if (
            !reply ||
            !('result' in reply) ||
            !Array.isArray(reply.result)
          ) {
            const error =
              reply && 'error' in reply && typeof reply.error === 'string'
                ? reply.error
                : 'Embedding timed out.'
            this.options.onError?.(error)
            if (!this.isJobCancelled(job)) {
              this.embeds.push(job)
            }
            this.deferEmbeddingRetry()
            break
          }

          // Validate returned vectors count, dimension, and finite numeric values
          const valRes = validateReturnedVectors(reply.result, part.length, this.profile.dimensions)
          if (!valRes.valid) {
            const err = valRes.error ?? 'Invalid vector format from worker'
            this.options.onError?.(err)
            if (!this.isJobCancelled(job)) {
              this.embeds.push(job)
            }
            this.deferEmbeddingRetry()
            break
          }

          const vectors = reply.result as number[][]

          const current = await statMeta(job.path)
          if (this.isJobCancelled(job)) break
          if (this.options.isWriteReady && !this.options.isWriteReady()) {
            this.deferEmbeddingRetry()
            this.embeds.push(job)
            break
          }
          if (!current || current.mtimeMs !== job.mtimeMs || current.sizeBytes !== job.sizeBytes) {
            if (current) this.options.onEnqueueExtract?.(job.path)
            break
          }

          // checkedResize own lease before SQLite persistence with fresh measurement outside SQL
          if (this.options.admission && hasLocalReservation) {
            let freshSnap: StorageBudgetSnapshot | null = null
            if (this.options.refreshUsage) {
              try {
                freshSnap = await this.options.refreshUsage()
              } catch {
                freshSnap = null
              }
            }

            if (this.isJobCancelled(job)) break
            if (this.options.isWriteReady && !this.options.isWriteReady()) {
              this.deferEmbeddingRetry()
              this.embeds.push(job)
              break
            }

            if (!freshSnap || freshSnap.measurementStatus === 'unknown' || freshSnap.isDegraded === true) {
              blockedByBudget = true; blockedOnAccounting = true
              this.options.onError?.('Storage accounting unknown or degraded before embedding commit')
              this.deferEmbeddingRetry()
              this.embeds.push(job)
              break
            }

            const freshFreeDisk = this.options.getFreeDiskBytes ? await this.options.getFreeDiskBytes() : null
            if (this.isJobCancelled(job)) break
            if (this.options.isWriteReady && !this.options.isWriteReady()) {
              this.deferEmbeddingRetry()
              this.embeds.push(job)
              break
            }

            if (freshFreeDisk === null) {
              blockedByBudget = true; blockedOnAccounting = true
              this.options.onError?.('Free disk space check failed before embedding commit')
              this.deferEmbeddingRetry()
              this.embeds.push(job)
              break
            }

            const currentUsage = freshSnap.totalManagedBytes ?? freshSnap.databaseBytes
            const liveBudget = this.options.getStorageBudget?.()
            const budgetBytes = liveBudget ? contentWriteCapBytes(liveBudget) : 0

            const resizeDec = this.options.admission.checkedResize({
              reservationId: localReserveId,
              newBytes: estBytes,
              currentUsageBytes: currentUsage,
              budgetBytes,
              options: {
                headroomBytes: headroom,
                freeDiskBytes: freshFreeDisk,
                accountingDegraded: false,
                ownerId: localOwnerToken,
              },
            })

            if (!resizeDec.admitted) {
              blockedByBudget = true
              this.options.onError?.(`Storage quota exceeded before embedding commit (${resizeDec.reason})`)
              this.deferEmbeddingRetry()
              this.embeds.push(job)
              break
            }
          }

          // Final gate & cancellation check before mutation
          if (this.isJobCancelled(job) || (this.options.isWriteReady && !this.options.isWriteReady())) {
            this.deferEmbeddingRetry()
            this.embeds.push(job)
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
          committed++
          onBatchComplete?.(vectors.length)

          this.options.onAdmission?.(false)
          // Post-persist remeasure: with a lease the terminal `finally` below measures (and releases) right after this
          // point, so measuring here too would only double the worker-thread scans per batch.
          if (this.options.refreshUsage && !hasLocalReservation) {
            try {
              await this.options.refreshUsage()
            } catch {}
          }

          if (!complete && !this.isJobCancelled(job)) {
            this.embeds.push({ ...job, startOffset: start + vectors.length })
            break
          }
        } catch (error) {
          if (!this.isJobCancelled(job)) {
            this.options.onError?.(safeError(error))
            this.embeds.push(job)
            this.deferEmbeddingRetry()
          }
        } finally {
          if (hasLocalReservation) {
            await executePostWriteAccounting({
              refreshUsage: this.options.refreshUsage, invalidateAccounting: this.options.invalidateAccounting,
              admission: this.options.admission, reservationId: localReserveId, ownerToken: localOwnerToken,
              context: 'embedding-terminal', isStopped: this.options.isStopped,
            })
          }
          if (this.activeEmbedJob === job) {
            this.activeEmbedJob = null
          }
        }
      }
    } finally {
      this.embedding = false
      if (blockedByBudget && this.options.onAdmission && !this.options.isStoppedOrPaused?.()) {
        // The owner's backoff (re-measure, then drain) replaces the fixed 15 s retry armed at the refusal site.
        this.embeddingRetryAt = 0
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
        this.options.onAdmission(true, blockedOnAccounting)
      } else if (!blockedByBudget && !this.options.isStoppedOrPaused?.()) {
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
    if (nextId === this.profileId || !isEmbeddingProfileId(nextId)) {
      return { changed: false, requeued: 0 }
    }
    const nextProfile = EMBEDDING_PROFILES[nextId]
    this.options.store.ensureEmbeddingSpace(nextProfile)

    const target = this.options.settingsDir ?? this.options.settingsPath
    const oldId = this.profileId
    let settingsWritten = false

    if (target) {
      writeActiveEmbeddingConfig(target, nextId)
      settingsWritten = true
    }

    let requeued: number
    try {
      requeued = this.options.store.requeueForEmbeddingModel(nextProfile.embeddingId)
    } catch (dbError) {
      if (settingsWritten && target) {
        try {
          writeActiveEmbeddingConfig(target, oldId)
        } catch {
          // ignore rollback failure, rethrow original db error
        }
      }
      throw dbError
    }

    this.profileId = nextId
    this.profile = nextProfile
    this.clearQueue()
    return { changed: true, requeued }
  }

  getEmbeddingProgress(): Record<string, { done: number; total: number }> {
    const res: Record<string, { done: number; total: number }> = {}
    for (const job of this.embeds) res[job.path] = { done: job.startOffset ?? 0, total: job.chunks.length }
    if (this.activeEmbedJob) res[this.activeEmbedJob.path] = { done: this.activeEmbedJob.startOffset ?? 0, total: this.activeEmbedJob.chunks.length }
    return res
  }
}
