import { stat } from 'node:fs/promises'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { Worker } from 'node:worker_threads'
import { createIndexProcess } from './process-worker'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import workerPath from './worker?modulePath'
import { DocumentMemoryStore, type DocumentMemoryHit } from './store'
import type { DocumentChunk } from './chunks'
import type { DocumentMemoryStatus } from '../../shared/home-api'
import type { DocumentIndexProgress } from '@genoffice/agent-core'

const EMBEDDING_MODEL_ID =
  'Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78:q8'
const POLL_INTERVAL_MS = 60_000
const SEARCH_EMBED_TIMEOUT_MS = 10_000
const WORKER_TIMEOUT_MS = 5 * 60_000
const MAX_PENDING_EMBED_DOCUMENTS = 16
const EMBED_RETRY_DELAY_MS = 30_000

interface ExtractResult {
  hash: string
  mtimeMs: number
  sizeBytes: number
  chunks: DocumentChunk[]
  status: 'text-only' | 'empty' | 'ready'
  error?: string
}
type WorkerReply =
  | { id: number; result: ExtractResult | number[][] | DocumentMemoryHit[] }
  | { id: number; error: string }
  | { type: 'model'; state: 'downloading' | 'ready' | 'error'; progress?: number; error?: string }
type WorkerRequest =
  | { type: 'extract'; path: string }
  | { type: 'embed'; texts: string[]; kind: 'query' | 'passage' }
  | {
      type: 'search'
      query: string
      vector: number[] | null
      limit: number
      embeddingModel: string
    }
interface PendingRequest {
  resolve: (reply: WorkerReply | null) => void
  timer: NodeJS.Timeout
}
interface EmbedJob {
  path: string
  generation: number
  epoch: number
  hash: string
  mtimeMs: number
  sizeBytes: number
  chunks: DocumentChunk[]
  priority?: number
  startOffset?: number
}
interface ManagerOptions {
  workerPath?: string
  workerFactory?: (path: string, workerData: { cacheDir: string; dbPath: string }) => Worker
  pollIntervalMs?: number
  searchTimeoutMs?: number
}

/** Coordinates opened-document enrollment, local extraction, embedding and fresh reads. */
export class DocumentMemoryManager {
  readonly dbPath: string
  private readonly store: DocumentMemoryStore
  private readonly settingsPath: string
  private readonly cacheDir: string
  private readonly pathToWorker: string
  private readonly workerFactory: (
    path: string,
    workerData: { cacheDir: string; dbPath: string },
  ) => Worker
  private readonly pollIntervalMs: number
  private readonly searchTimeoutMs: number
  private readonly queue: string[] = []
  private readonly queued = new Set<string>()
  private readonly activeExtractions = new Set<string>()
  private readonly embeds: EmbedJob[] = []
  private readonly pathGeneration = new Map<string, number>()
  private readonly waiting = new Map<number, PendingRequest>()
  private worker: Worker | null = null
  private nextRequestId = 1
  private epoch = 0
  private polling = false
  private embeddingRetryAt = 0
  private retryTimer: NodeJS.Timeout | null = null
  private extracting = false
  private embedding = false
  private pendingCount = 0
  private stopped = false
  private enabled: boolean
  private modelState: DocumentMemoryStatus['modelState'] = 'not-loaded'
  private modelProgress: number | undefined
  private lastError: string | undefined
  private pollTimer: NodeJS.Timeout | null = null

  constructor(userData: string, options: ManagerOptions = {}) {
    mkdirSync(userData, { recursive: true })
    this.dbPath = join(userData, 'document-memory.db')
    this.settingsPath = join(userData, 'document-memory-settings.json')
    this.cacheDir = join(userData, 'document-memory-models')
    this.pathToWorker = options.workerPath ?? workerPath
    this.workerFactory = options.workerFactory ?? createIndexProcess
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
    this.searchTimeoutMs = options.searchTimeoutMs ?? SEARCH_EMBED_TIMEOUT_MS
    this.store = new DocumentMemoryStore(this.dbPath)
    this.enabled = readEnabled(this.settingsPath)

    if (this.enabled) void this.poll()
    this.pollTimer = setInterval(() => void this.poll(), this.pollIntervalMs)
    this.pollTimer.unref?.()
  }

  /** Enroll a document because the user opened it; recent-file retention is irrelevant. */
  remember(path: string): void {
    if (this.stopped) return
    const p = resolve(path)
    this.store.remember(p)
    const document = this.store.documentByPath(p)
    if (!document || document.status === 'excluded') return
    const current = safeStat(p)
    if (
      this.enabled &&
      (!current ||
        document.status === 'pending' ||
        document.status === 'text-only' ||
        document.mtimeMs !== current.mtimeMs ||
        document.sizeBytes !== current.sizeBytes)
    )
      this.enqueue(p, true)
  }

  /** Enroll a file discovered under a user-selected folder without changing recency. */
  indexDiscoveredFile(path: string, metadata?: { mtimeMs: number; sizeBytes: number }): boolean {
    if (this.stopped) return false
    const p = resolve(path)
    const current = metadata ?? safeStat(p)
    if (!current) return false
    const needsIndex = this.store.enrollDiscovered(p, current.mtimeMs, current.sizeBytes)
    const document = this.store.documentByPath(p)
    if (!document || document.status === 'excluded') return false
    if (
      needsIndex &&
      this.enabled &&
      (document.status === 'pending' ||
        document.status === 'text-only' ||
        document.mtimeMs !== current.mtimeMs ||
        document.sizeBytes !== current.sizeBytes)
    )
      this.enqueue(p)
    return needsIndex
  }

  indexIssues(root: string, offset = 0) {
    return this.store.indexIssues(root, offset)
  }

  retryDocument(id: number): { ok: boolean; error?: string } {
    if (!this.enabled || this.stopped) return { ok: false, error: 'paused' }
    const path = this.store.retryDocument(id)
    if (!path) return { ok: false, error: 'unavailable' }
    this.invalidatePath(path)
    this.enqueue(path, true)
    return { ok: true }
  }

  indexDocumentPath(id: number): string | null {
    const document = this.store.documentById(id)
    return document && document.status !== 'excluded' ? document.path : null
  }

  move(oldPath: string, newPath: string): void {
    const oldResolved = resolve(oldPath)
    const newResolved = resolve(newPath)
    this.invalidatePath(oldResolved)
    if (!this.store.documentByPath(oldResolved)) return
    try {
      this.store.move(oldResolved, newResolved)
    } catch (error) {
      // A previously remembered destination can outlive its deleted original file.
      if (!this.store.documentByPath(newResolved)) throw error
      this.store.markError(oldResolved, 'Document moved to an already remembered path.', null)
    }
    if (this.enabled && this.store.documentByPath(newResolved)?.status !== 'excluded')
      this.enqueue(newResolved)
  }

  listPaths(): string[] {
    return this.store.listPaths()
  }

  /** Return durable per-document vector progress using a single path-scoped SQL count. */
  getDocumentIndexProgress(path: string): DocumentIndexProgress {
    const p = resolve(path)
    const progress = this.store.chunkProgress(p)
    const document = progress.document
    if (!document) return { state: 'idle', percent: null, completedChunks: 0, totalChunks: 0 }
    const base = {
      path: document.path,
      name: document.name,
      completedChunks: progress.completedChunks,
      totalChunks: progress.totalChunks,
    }
    if (document.status === 'excluded') return { ...base, state: 'excluded', percent: null }
    if (this.activeExtractions.has(p)) return { ...base, state: 'extracting', percent: null }
    if (this.queued.has(p)) return { ...base, state: 'queued', percent: null }
    if (document.status === 'empty') return { ...base, state: 'empty', percent: 100 }
    if (document.status === 'ready') return { ...base, state: 'ready', percent: 100 }
    if (document.status === 'error')
      return {
        ...base,
        state: 'error',
        percent: progressPercent(progress),
        ...(document.error ? { error: document.error } : {}),
      }
    if (document.status === 'text-only') {
      if (!this.enabled) return { ...base, state: 'paused', percent: progressPercent(progress) }
      if (this.modelState === 'error')
        return {
          ...base,
          state: 'error',
          percent: progressPercent(progress),
          ...(this.lastError ? { error: this.lastError } : {}),
        }
      return { ...base, state: 'indexing', percent: progressPercent(progress) }
    }
    if (!this.enabled) return { ...base, state: 'paused', percent: null }
    return { ...base, state: 'queued', percent: null }
  }

  /** SQL-only aggregate for a selected folder; excluded documents are omitted. */
  getFolderIndexProgress(
    root: string,
    discoveryComplete: boolean,
    scanErrors = 0,
  ): {
    totalFiles: number
    readyFiles: number
    pendingFiles: number
    errorFiles: number
    emptyFiles?: number
    completedChunks: number
    totalChunks: number
    percent: number | null
  } {
    const counts = this.store.folderChunkProgress(root)
    let percent: number | null = null
    if (discoveryComplete) {
      if (counts.totalFiles === 0) percent = scanErrors ? 99 : 100
      else {
        percent = Math.floor((counts.partialFileProgress / counts.totalFiles) * 100)
        if (counts.pendingFiles || counts.errorFiles || scanErrors) percent = Math.min(percent, 99)
      }
    }
    return {
      totalFiles: counts.totalFiles,
      readyFiles: counts.readyFiles,
      pendingFiles: counts.pendingFiles,
      errorFiles: counts.errorFiles,
      emptyFiles: counts.emptyFiles ?? 0,
      completedChunks: counts.completedChunks,
      totalChunks: counts.totalChunks,
      percent,
    }
  }

  status(): DocumentMemoryStatus {
    const stats = this.store.stats()
    const files = this.store
      .recentDocuments(20)
      .map(({ id, path, name, status }) => ({ id, path, name, status }))
    return {
      enabled: this.enabled,
      modelState: this.modelState,
      ...(this.modelProgress === undefined ? {} : { modelProgress: this.modelProgress }),
      documents: stats.docs,
      chunks: stats.chunks,
      vectors: stats.vectors,
      pending: this.pendingCount + this.queue.length + this.embeds.length,
      errors: stats.errors,
      dbPath: this.dbPath,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      files,
    }
  }

  /** Lightweight status for progress polling; does not enumerate document rows. */
  indexingActivityStatus(): {
    enabled: boolean
    modelState: string
    modelProgress?: number
    pending: number
    errors: number
  } {
    return {
      enabled: this.enabled,
      modelState: this.modelState,
      ...(this.modelProgress === undefined ? {} : { modelProgress: this.modelProgress }),
      pending: this.pendingCount + this.queue.length + this.embeds.length,
      errors: this.store.stats().errors,
    }
  }

  setEnabled(enabled: boolean): DocumentMemoryStatus {
    if (this.stopped) return this.status()
    this.enabled = enabled
    saveEnabled(this.settingsPath, enabled)
    if (!enabled) {
      this.epoch++
      this.queue.length = 0
      this.queued.clear()
      this.embeds.length = 0
    } else void this.poll()
    return this.status()
  }

  exclude(path: string): void {
    const p = resolve(path)
    this.invalidatePath(p)
    this.store.exclude(p)
  }

  clear(): void {
    this.epoch++
    this.queue.length = 0
    this.queued.clear()
    this.embeds.length = 0
    this.store.clear()
  }

  async search(
    query: string,
    limit = 8,
  ): Promise<{ hits: DocumentMemoryHit[]; pending: number; errors: number; modelState: string }> {
    let vector: number[] | null = null
    // Do not place a query behind a long passage batch; lexical FTS answers now.
    if (
      (this.enabled || this.modelState === 'ready') &&
      this.modelState !== 'downloading' &&
      this.modelState !== 'error' &&
      (this.modelState === 'ready' || (this.embeds.length === 0 && !this.embedding))
    ) {
      const reply = await this.ask(
        { type: 'embed', texts: [query], kind: 'query' },
        this.searchTimeoutMs,
      )
      if (
        reply &&
        'result' in reply &&
        Array.isArray(reply.result) &&
        Array.isArray(reply.result[0])
      ) {
        vector = reply.result[0] as number[]
      }
    }
    const reply = await this.ask(
      { type: 'search', query, vector, limit, embeddingModel: EMBEDDING_MODEL_ID },
      30_000,
    )
    const result =
      reply && 'result' in reply && Array.isArray(reply.result)
        ? (reply.result as DocumentMemoryHit[])
        : this.store.search(query, null, limit)
    return {
      hits: result,
      pending: this.queue.length + this.embeds.length + this.pendingCount,
      errors: this.store.stats().errors,
      modelState: this.modelState,
    }
  }

  /** Verify the indexed hash against a fresh worker extraction before exposing full text. */
  async read(chunkId: number): Promise<{
    path: string
    name: string
    location: string
    text: string
    verified: boolean
    error?: string
  }> {
    const hit = this.store.readChunk(chunkId)
    if (!hit)
      return {
        path: '',
        name: '',
        location: '',
        text: '',
        verified: false,
        error: 'The indexed chunk is no longer available.',
      }
    const generation = this.currentGeneration(hit.path)
    const epoch = this.epoch
    const reply = await this.ask({ type: 'extract', path: hit.path }, WORKER_TIMEOUT_MS)
    if (!reply || !('result' in reply) || !isExtractResult(reply.result)) {
      const error =
        reply && 'error' in reply && typeof reply.error === 'string'
          ? reply.error
          : 'Document verification timed out.'
      if (this.isCurrent(hit.path, generation, epoch))
        this.store.markError(hit.path, error, safeStat(hit.path))
      return {
        path: hit.path,
        name: hit.name,
        location: hit.location,
        text: '',
        verified: false,
        error,
      }
    }
    const fresh = reply.result
    if (
      this.stopped ||
      generation !== this.currentGeneration(hit.path) ||
      epoch !== this.epoch ||
      !this.store.documentByPath(hit.path) ||
      this.store.documentByPath(hit.path)?.status === 'excluded'
    ) {
      return {
        path: hit.path,
        name: hit.name,
        location: hit.location,
        text: '',
        verified: false,
        error: 'Document memory changed during verification.',
      }
    }
    const after = safeStat(hit.path)
    if (
      !after ||
      after.mtimeMs !== fresh.mtimeMs ||
      after.sizeBytes !== fresh.sizeBytes ||
      fresh.hash !== hit.hash
    ) {
      this.invalidatePath(hit.path)
      const freshGeneration = this.currentGeneration(hit.path)
      this.store.replaceDocument(hit.path, {
        hash: fresh.hash,
        mtimeMs: fresh.mtimeMs,
        sizeBytes: fresh.sizeBytes,
        chunks: fresh.chunks,
        embeddingModel: null,
        status: fresh.status === 'empty' ? 'empty' : 'text-only',
        error: fresh.error,
      })
      if (fresh.chunks.length && this.enabled)
        this.enqueueEmbed({
          path: hit.path,
          generation: freshGeneration,
          epoch,
          hash: fresh.hash,
          mtimeMs: fresh.mtimeMs,
          sizeBytes: fresh.sizeBytes,
          chunks: fresh.chunks,
        })
      return {
        path: hit.path,
        name: hit.name,
        location: hit.location,
        text: '',
        verified: false,
        error: 'The document changed since indexing. Search again for updated content.',
      }
    }
    return {
      path: hit.path,
      name: hit.name,
      location: hit.location,
      text: hit.text,
      verified: true,
    }
  }

  /** Safe document id lookup for the open-source action. */
  open(documentId: number): string | null {
    const document = this.store.documentById(documentId)
    if (!document || document.status === 'excluded') return null
    return safeStat(document.path) ? document.path : null
  }

  close(): void {
    if (this.stopped) return
    this.stopped = true
    this.epoch++
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.queue.length = 0
    this.embeds.length = 0
    for (const [id, pending] of this.waiting) {
      clearTimeout(pending.timer)
      pending.resolve(null)
      this.waiting.delete(id)
    }
    const worker = this.worker
    this.worker = null
    if (worker) void worker.terminate()
    this.store.close()
  }

  private async poll(): Promise<void> {
    if (this.stopped || !this.enabled || this.polling) return
    this.polling = true
    try {
      const resumeIncomplete = !this.embedding && !this.extracting
      for (const path of this.store.listPaths()) {
        if (this.stopped || !this.enabled) return
        if (this.activeExtractions.has(path)) continue
        const doc = this.store.documentByPath(path)
        if (!doc || doc.status === 'excluded') continue
        const current = await stat(path).then(
          (value) => ({ mtimeMs: value.mtimeMs, sizeBytes: value.size }),
          () => null,
        )
        if (this.stopped || !this.enabled) return
        if (!current) {
          if (doc.status !== 'error' || doc.mtimeMs !== null || doc.sizeBytes !== null)
            this.store.markError(path, 'Document is unavailable.', null)
        } else if (
          doc.status === 'pending' ||
          (doc.status === 'text-only' && resumeIncomplete) ||
          doc.mtimeMs !== current.mtimeMs ||
          doc.sizeBytes !== current.sizeBytes
        )
          this.enqueue(path)
        await yieldToEventLoop()
      }
    } finally {
      this.polling = false
    }
  }

  private enqueue(path: string, prioritize = false): void {
    if (this.stopped || !this.enabled) return
    if (this.queued.has(path)) {
      if (prioritize) {
        const index = this.queue.indexOf(path)
        if (index > 0) this.queue.splice(index, 1)
        if (index > 0) this.queue.unshift(path)
      }
      return
    }
    const doc = this.store.documentByPath(path)
    if (!doc || doc.status === 'excluded') return
    this.pathGeneration.set(path, this.currentGeneration(path) + 1)
    for (let i = this.embeds.length - 1; i >= 0; i--)
      if (this.embeds[i]?.path === path) this.embeds.splice(i, 1)
    this.queued.add(path)
    if (prioritize) this.queue.unshift(path)
    else this.queue.push(path)
    void this.drain()
  }

  private drain(): void {
    if (this.stopped || !this.enabled) return
    if (
      !this.extracting &&
      !this.embedding &&
      this.queue.length &&
      this.embeds.length < MAX_PENDING_EMBED_DOCUMENTS
    )
      void this.drainExtractions()
    if (
      !this.embedding &&
      !this.extracting &&
      this.embeds.length &&
      Date.now() >= this.embeddingRetryAt &&
      (this.queue.length === 0 || this.embeds.length >= MAX_PENDING_EMBED_DOCUMENTS)
    )
      void this.drainEmbeddings()
  }

  private async drainExtractions(): Promise<void> {
    if (this.extracting || this.stopped) return
    this.extracting = true
    try {
      while (
        !this.stopped &&
        this.enabled &&
        this.queue.length &&
        this.embeds.length < MAX_PENDING_EMBED_DOCUMENTS
      ) {
        const path = this.queue.shift()!
        this.queued.delete(path)
        this.activeExtractions.add(path)
        const generation = this.currentGeneration(path)
        const epoch = this.epoch
        this.pendingCount++
        try {
          const reply = await this.ask({ type: 'extract', path }, WORKER_TIMEOUT_MS)
          if (!this.isCurrent(path, generation, epoch)) continue
          if (!reply || !('result' in reply) || !isExtractResult(reply.result)) {
            const error =
              reply && 'error' in reply && typeof reply.error === 'string'
                ? reply.error
                : 'Document extraction timed out.'
            this.store.markError(path, error, safeStat(path))
            this.lastError = error
            continue
          }
          const extracted = reply.result
          const previous = this.store.documentByPath(path)
          const resumeOffset =
            previous?.mtimeMs === extracted.mtimeMs && previous.sizeBytes === extracted.sizeBytes
              ? this.store.resumeVectorOffset(path, extracted.hash, EMBEDDING_MODEL_ID)
              : null
          if (resumeOffset === null) {
            this.store.replaceDocument(path, {
              hash: extracted.hash,
              mtimeMs: extracted.mtimeMs,
              sizeBytes: extracted.sizeBytes,
              chunks: extracted.chunks,
              embeddingModel: null,
              status: extracted.chunks.length ? 'text-only' : 'empty',
              error: extracted.error,
            })
          }
          this.lastError = undefined
          if (extracted.chunks.length) {
            this.enqueueEmbed({
              path,
              generation,
              epoch,
              hash: extracted.hash,
              mtimeMs: extracted.mtimeMs,
              sizeBytes: extracted.sizeBytes,
              chunks: extracted.chunks,
              startOffset: resumeOffset ?? 0,
            })
            this.drain()
          }
        } catch (error) {
          if (this.isCurrent(path, generation, epoch)) {
            const message = safeError(error)
            this.store.markError(path, message, safeStat(path))
            this.lastError = message
          }
        } finally {
          this.activeExtractions.delete(path)
          this.pendingCount--
        }
      }
    } finally {
      this.extracting = false
      if (!this.stopped && this.enabled) this.drain()
    }
  }

  private async drainEmbeddings(): Promise<void> {
    if (this.embedding || this.stopped) return
    this.embedding = true
    try {
      while (!this.stopped && this.enabled && this.embeds.length) {
        const job = this.embeds.shift()!
        if (!this.isCurrent(job.path, job.generation, job.epoch)) continue
        this.pendingCount++
        try {
          // Commit one small batch per turn, then rotate incomplete files for fair queue progress.
          const start = job.startOffset ?? 0
          if (!this.isCurrent(job.path, job.generation, job.epoch)) break
          const part = job.chunks.slice(start, start + 8)
          const reply = await this.ask(
            { type: 'embed', texts: part.map((chunk) => chunk.text), kind: 'passage' },
            WORKER_TIMEOUT_MS,
          )
          if (!this.isCurrent(job.path, job.generation, job.epoch)) break
          if (
            !reply ||
            !('result' in reply) ||
            !Array.isArray(reply.result) ||
            !reply.result.every((v) => Array.isArray(v))
          ) {
            const error = reply && 'error' in reply ? reply.error : 'Embedding timed out.'
            this.lastError = error
            this.deferEmbeddingRetry()
            break
          }
          const vectors = reply.result as number[][]
          if (vectors.length !== part.length)
            throw new Error('Embedding count did not match chunk count')
          const current = safeStat(job.path)
          if (!current || current.mtimeMs !== job.mtimeMs || current.sizeBytes !== job.sizeBytes) {
            if (current) this.enqueue(job.path)
            break
          }
          const complete = start + vectors.length >= job.chunks.length
          this.store.setChunkVectors(
            job.path,
            job.hash,
            start,
            vectors,
            EMBEDDING_MODEL_ID,
            complete,
          )
          this.lastError = undefined
          if (!complete && this.isCurrent(job.path, job.generation, job.epoch)) {
            this.embeds.push({ ...job, startOffset: start + vectors.length })
            break
          }
        } catch (error) {
          if (this.isCurrent(job.path, job.generation, job.epoch)) {
            this.lastError = safeError(error)
            this.deferEmbeddingRetry()
          }
        } finally {
          this.pendingCount--
        }
      }
    } finally {
      this.embedding = false
      if (!this.stopped && this.enabled) this.drain()
    }
  }

  private enqueueEmbed(job: EmbedJob): void {
    if (this.stopped || !this.enabled) return
    job.priority = this.store.documentPriority(job.path)
    const position = this.embeds.findIndex((queued) => (job.priority ?? 0) > (queued.priority ?? 0))
    if (position < 0) this.embeds.push(job)
    else this.embeds.splice(position, 0, job)
    void this.drain()
  }

  private deferEmbeddingRetry(): void {
    this.embeddingRetryAt = Date.now() + EMBED_RETRY_DELAY_MS
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.drain()
    }, EMBED_RETRY_DELAY_MS)
    this.retryTimer.unref?.()
  }

  private invalidatePath(path: string): void {
    this.pathGeneration.set(path, this.currentGeneration(path) + 1)
    this.queued.delete(path)
    for (let i = this.queue.length - 1; i >= 0; i--)
      if (this.queue[i] === path) this.queue.splice(i, 1)
    for (let i = this.embeds.length - 1; i >= 0; i--)
      if (this.embeds[i]?.path === path) this.embeds.splice(i, 1)
  }

  private currentGeneration(path: string): number {
    return this.pathGeneration.get(path) ?? 0
  }
  private isCurrent(path: string, generation: number, epoch: number): boolean {
    return (
      !this.stopped &&
      this.enabled &&
      epoch === this.epoch &&
      generation === this.currentGeneration(path) &&
      !!this.store.documentByPath(path) &&
      this.store.documentByPath(path)?.status !== 'excluded'
    )
  }

  private ask(request: WorkerRequest, timeoutMs: number): Promise<WorkerReply | null> {
    if (this.stopped) return Promise.resolve(null)
    const id = this.nextRequestId++
    return new Promise((resolveReply) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        resolveReply(null)
      }, timeoutMs)
      this.waiting.set(id, { resolve: resolveReply, timer })
      try {
        this.ensureWorker().postMessage({ ...request, id })
      } catch (error) {
        clearTimeout(timer)
        this.waiting.delete(id)
        resolveReply({ id, error: safeError(error) })
      }
    })
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    mkdirSync(this.cacheDir, { recursive: true })
    const worker = this.workerFactory(this.pathToWorker, {
      cacheDir: this.cacheDir,
      dbPath: this.dbPath,
    })
    worker.on('message', (message: WorkerReply) => {
      if ('type' in message && message.type === 'model') {
        this.modelState = message.state
        this.modelProgress = message.progress
        if (message.error) this.lastError = message.error
        else if (message.state === 'ready') this.lastError = undefined
        return
      }
      if (!('id' in message)) return
      const pending = this.waiting.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.waiting.delete(message.id)
      pending.resolve(message)
    })
    const fail = (error: string) => {
      if (this.worker !== worker) return
      this.worker = null
      this.modelState = 'error'
      this.lastError = error
      for (const [id, pending] of this.waiting) {
        clearTimeout(pending.timer)
        pending.resolve({ id, error })
        this.waiting.delete(id)
      }
    }
    worker.on('error', (error) => fail(safeError(error)))
    worker.on('exit', () => {
      if (!this.stopped && this.worker === worker)
        fail('Document memory worker exited unexpectedly.')
    })
    this.worker = worker
    return worker
  }
}

function progressPercent(progress: {
  completedChunks: number
  totalChunks: number
}): number | null {
  if (!progress.totalChunks) return null
  return Math.min(99, Math.floor((progress.completedChunks / progress.totalChunks) * 100))
}

function readEnabled(path: string): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return !!value &&
      typeof value === 'object' &&
      (value as { enabled?: unknown }).enabled === false
      ? false
      : true
  } catch {
    return true
  }
}
function saveEnabled(path: string, enabled: boolean): void {
  writeFileSync(path, JSON.stringify({ enabled }), { mode: 0o600 })
}
function safeStat(path: string): { mtimeMs: number; sizeBytes: number } | null {
  try {
    const result = statSync(path)
    return { mtimeMs: result.mtimeMs, sizeBytes: result.size }
  } catch {
    return null
  }
}
function safeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Document memory operation failed.'
}
function isExtractResult(value: unknown): value is ExtractResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<ExtractResult>
  return (
    typeof result.hash === 'string' &&
    typeof result.mtimeMs === 'number' &&
    typeof result.sizeBytes === 'number' &&
    Array.isArray(result.chunks) &&
    ['text-only', 'empty', 'ready'].includes(String(result.status))
  )
}
