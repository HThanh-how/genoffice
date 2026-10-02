import type { IndexingNow } from '../../shared/fork/document-index-api'
import { stat } from 'node:fs/promises'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { Worker } from 'node:worker_threads'
import { createIndexProcess } from './process-worker'
import { isIndexingPaused, subscribeIndexingPolicy } from '../fork/indexing-policy-bus'
import { createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { extname, join, resolve, sep } from 'node:path'
import workerPath from './worker?modulePath'
import type { PdfScanInfo } from './ocr-sidecar'
import {
  DEFAULT_EMBEDDING_PROFILE,
  embeddingProfile,
  isEmbeddingProfileId,
  type EmbeddingProfile,
  type EmbeddingProfileId,
} from './embedding-profiles'
import { isIgnoredFileName, MAX_DOCUMENT_BYTES, SUPPORTED_EXTENSIONS } from './folder-scan'
import { volumeRootOf } from './volume-root'
import { createYielder } from './yield-budget'
import { orderQueue, rankOf, weightOf, type QueueInfo } from './queue-order'
import { clampPdfPages } from './chunks'
import { readPdfPages, writePdfPages } from './pdf-pages'
import { foldFolderProgress, type FolderIndexProgress } from './folder-progress'
import type { FolderChunkProgress } from './store'
import { DocumentMemoryStore, type DocumentMemoryHit, type StoredDocument } from './store'
import type { DocumentChunk } from './chunks'
import type { DocumentMemoryStatus } from '../../shared/home-api'
import type { DocumentIndexProgress } from '@genoffice/agent-core'
import { createOcrHost } from './ocr-host'
import type { OcrJobHost } from './agy-ocr-job'
import type { OcrRenderRequest, OcrRenderResult } from './agy-ocr-render'

/** Cheap safety poll: resumes interrupted work (SQL only); never stats the whole index. */
/** A boosted folder sorts ahead of every file the user could have opened or edited. */
const PRIORITY_BOOST_MS = 10 * 365 * 24 * 3600 * 1000
const POLL_INTERVAL_MS = 60_000
/** How often user-opened documents are stat()ed by the safety poll, and how many. */
const OPENED_CHECK_INTERVAL_MS = 5 * 60_000
const OPENED_CHECK_LIMIT = 200
/** A vanished file may be a move in progress; wait before forgetting its chunks. */
const TOMBSTONE_GRACE_MS = 30_000
/** Moves are detected by size + SHA-256; larger files are simply re-indexed. */
const RENAME_HASH_MAX_BYTES = 64 * 1024 * 1024
const FRESHNESS_STAT_TIMEOUT_MS = 1_500
const SEARCH_EMBED_TIMEOUT_MS = 10_000
const WORKER_TIMEOUT_MS = 5 * 60_000
const STOPPED_BY_USER = 'Stopped by you.'
/** How many times "read this one" reads a file again when a read was overtaken. */
const READ_NOW_ATTEMPTS = 3
const DEFERRED_MESSAGE = 'Put back so lighter files are read first.'
/** A large PDF is read in turns of about this long, so others can go between them. */
const PDF_SLICE_MS = 10_000
/** A heavy read that has run this long makes way for light files that are waiting. */
const AUTO_DEFER_AFTER_MS = 30_000
const INTERRUPTED_FOR_USER = 'Paused so a file you chose could be read first.'
const MAX_PENDING_EMBED_DOCUMENTS = 16
const EMBED_RETRY_DELAY_MS = 30_000
/** Wait after an index write before merging full-text segments (one pending run at a time). */
const FTS_MAINTENANCE_DELAY_MS = 250
/** Longest one maintenance run may keep going before it reschedules itself. */
const FTS_MAINTENANCE_RUN_MS = 2_000

interface ExtractResult {
  hash: string
  mtimeMs: number
  sizeBytes: number
  chunks: DocumentChunk[]
  status: 'text-only' | 'empty' | 'ready'
  error?: string
  /** Only part of the file was indexed (chunk cap or sampled tabular rows). */
  truncated?: boolean
  /** Lexical-only: embedding adds nothing (numeric tables). */
  skipEmbeddings?: boolean
  /** PDF pages with no text layer of their own (the OCR reader's work list). */
  scan?: PdfScanInfo
}
/** A search hit annotated with a cheap query-time freshness check (no hashing). */
export interface FreshDocumentMemoryHit extends DocumentMemoryHit {
  /** The file changed or vanished since it was indexed; do not quote `text` as current. */
  stale: boolean
  /** The file is no longer at `path` (`stale` is also true). */
  missing: boolean
}
interface MissingCandidate {
  path: string
  sizeBytes: number
  hash: string
}
type StatOutcome =
  | { kind: 'file'; mtimeMs: number; sizeBytes: number }
  | { kind: 'other' }
  | { kind: 'gone' }
  | { kind: 'unknown' }
type WorkerReply =
  | { id: number; result: ExtractResult | number[][] | DocumentMemoryHit[] }
  | { id: number; error: string }
  | { type: 'model'; state: 'downloading' | 'ready' | 'error'; progress?: number; error?: string }
type WorkerRequest =
  | { type: 'extract'; path: string; interactive?: boolean; sliceMs?: number; maxPdfPages?: number }
  | { type: 'embed'; texts: string[]; kind: 'query' | 'passage' }
  | { type: 'ocr-render'; path: string; ocr: OcrRenderRequest }
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
  workerFactory?: (
    path: string,
    workerData: { cacheDir: string; dbPath: string; embeddingProfile?: string },
  ) => Worker
  pollIntervalMs?: number
  searchTimeoutMs?: number
  /** How long a background extract/embed step may stay silent before the worker is restarted. */
  workerTimeoutMs?: number
  tombstoneGraceMs?: number
  /** Where the database file lives (default: the user data folder; the other files stay there). */
  dbDir?: string
  /** How long a heavy file may hold the reader while light ones wait (default 30 s). */
  autoDeferAfterMs?: number
  /** Another source of file names (Everything): files on disk that were never opened or indexed. */
  externalNames?: (query: string, limit: number) => Promise<Array<{ path: string; name: string }>>
}

/** Coordinates opened-document enrollment, local extraction, embedding and fresh reads. */
export class DocumentMemoryManager {
  readonly dbPath: string
  private readonly externalNames: ManagerOptions['externalNames']
  /** Files an outside name search offered, the only ones the assistant may open by path. */
  private readonly offeredPaths = new Set<string>()
  private readonly store: DocumentMemoryStore
  private readonly settingsPath: string
  private readonly pdfPagesPath: string
  private pdfMaxPages: number
  private readonly embeddingSettingsPath: string
  private embeddingProfileId: EmbeddingProfileId
  private readonly cacheDir: string
  private readonly pathToWorker: string
  private readonly workerFactory: (
    path: string,
    workerData: { cacheDir: string; dbPath: string; embeddingProfile?: string },
  ) => Worker
  private readonly pollIntervalMs: number
  private readonly searchTimeoutMs: number
  private readonly workerTimeoutMs: number
  private readonly tombstoneGraceMs: number
  private readonly missing = new Map<
    string,
    { candidate: MissingCandidate | null; timer: NodeJS.Timeout }
  >()
  private readonly enabledListeners = new Set<() => void>()
  private readonly clearedListeners = new Set<() => void>()
  private lastOpenedCheck = 0
  private readonly queue: string[] = []
  private readonly queued = new Set<string>()
  /** Files a person asked to read now: ahead of the whole line. */
  private readonly urgent = new Set<string>()
  /** Files pushed to the back of the line: behind every other file, however heavy. */
  private readonly deferred = new Set<string>()
  /** Size of each waiting file, for reading light ones first. */
  private readonly queueBytes = new Map<string, number>()
  private readonly autoDeferAfterMs: number
  private readonly sizeLookups = new Set<string>()
  /**
   * The generation each file being read right now was started under. A folder refresh that finds
   * the same unread file again must not queue it a second time and thereby make the read in
   * progress look out of date, which threw away the result of every read it overlapped.
   */
  private readonly activeGeneration = new Map<string, number>()
  /** Files being read in turns right now: they give way between turns, nothing is cut short. */
  private readonly slicing = new Set<string>()
  /** Pages read so far of a large PDF that is being read in turns (reading or waiting). */
  private readonly readProgress = new Map<string, { done: number; total: number }>()
  /** Size of each file being read now (its weight decides whether it makes way). */
  private readonly activeBytes = new Map<string, number>()
  private sizing = false
  private readonly activeExtractions = new Set<string>()
  private readonly activeSince = new Map<string, number>()
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
  private counterBackfill: Promise<void> = Promise.resolve()
  private ftsTimer: NodeJS.Timeout | null = null
  private stopPolicyWatch: () => void = () => {}

  constructor(userData: string, options: ManagerOptions = {}) {
    mkdirSync(userData, { recursive: true })
    mkdirSync(options.dbDir ?? userData, { recursive: true })
    this.dbPath = join(options.dbDir ?? userData, 'document-memory.db')
    this.settingsPath = join(userData, 'document-memory-settings.json')
    this.pdfPagesPath = join(userData, 'document-memory-pdf.json')
    this.pdfMaxPages = readPdfPages(this.pdfPagesPath)
    this.cacheDir = join(userData, 'document-memory-models')
    this.embeddingSettingsPath = join(userData, 'document-memory-embedding.json')
    this.embeddingProfileId = readEmbeddingProfileId(this.embeddingSettingsPath)
    this.pathToWorker = options.workerPath ?? workerPath
    this.workerFactory = options.workerFactory ?? createIndexProcess
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
    this.searchTimeoutMs = options.searchTimeoutMs ?? SEARCH_EMBED_TIMEOUT_MS
    this.workerTimeoutMs = options.workerTimeoutMs ?? WORKER_TIMEOUT_MS
    this.tombstoneGraceMs = options.tombstoneGraceMs ?? TOMBSTONE_GRACE_MS
    this.externalNames = options.externalNames
    this.autoDeferAfterMs = options.autoDeferAfterMs ?? AUTO_DEFER_AFTER_MS
    this.store = new DocumentMemoryStore(this.dbPath)
    this.enabled = readEnabled(this.settingsPath)
    this.store.purgeDiscoveredByName(isIgnoredFileName)
    this.store.requeueNowReadable()
    this.counterBackfill = this.runCounterBackfill()
    this.scheduleFtsMaintenance()

    if (this.enabled) void this.poll()
    this.pollTimer = setInterval(() => void this.poll(), this.pollIntervalMs)
    this.pollTimer.unref?.()
    this.stopPolicyWatch = subscribeIndexingPolicy((policy) => {
      if (!policy.paused) this.drain()
    })
  }

  /** What is being read now, how far embedding has got, and the order of the waiting line. */
  nowStatus(): IndexingNow {
    const embedding: IndexingNow['embedding'] = {}
    for (const job of this.embeds)
      embedding[job.path] = { done: job.startOffset ?? 0, total: job.chunks.length }
    const positions: IndexingNow['positions'] = {}
    this.readingOrder()
      .slice(0, 400)
      .forEach((path, index) => {
        positions[path] = index + 1
      })
    const pages: IndexingNow['pages'] = {}
    for (const [path, progress] of this.readProgress) pages[path] = progress
    return {
      extracting: [...this.activeSince].map(([path, since]) => ({ path, since })),
      embedding,
      positions,
      pages,
      queued: this.queue.length,
      paused: !this.enabled || isIndexingPaused(),
    }
  }

  /** Enroll a document because the user opened it; recent-file retention is irrelevant. */
  remember(path: string): void {
    if (this.stopped) return
    const p = resolve(path)
    this.store.remember(p)
    const document = this.store.documentByPath(p)
    if (!document || document.status === 'excluded' || !this.enabled) return
    // Unfinished documents are queued right away; only a finished one needs its file metadata
    // compared, and that stat is asynchronous (a network or virtual drive can take long).
    if (document.status === 'pending' || document.status === 'text-only') {
      this.enqueue(p, true)
      return
    }
    void statMeta(p).then((current) => {
      if (this.stopped || !this.enabled) return
      const latest = this.store.documentByPath(p)
      if (!latest || latest.status === 'excluded') return
      if (
        !current ||
        latest.status === 'pending' ||
        latest.status === 'text-only' ||
        latest.mtimeMs !== current.mtimeMs ||
        latest.sizeBytes !== current.sizeBytes
      )
        this.enqueue(p, true)
    })
  }

  /**
   * Fill the per-document chunk counters of an older database in short slices (see
   * {@link DocumentMemoryStore.backfillCounters}). Resolves when every document is counted.
   */
  private async runCounterBackfill(): Promise<void> {
    try {
      await yieldToEventLoop()
      while (!this.stopped && this.store.backfillCounters()) await yieldToEventLoop()
    } catch {
      // Counting is an optimisation: aggregates fall back to exact index counts meanwhile.
    }
  }

  /**
   * Merge full-text segments in ~1 ms steps between writes (FTS5's own merge, which runs inside a
   * commit, caused 50-400 ms stalls). At most one run is pending; writes do not postpone it, so
   * the segment count stays far below the point where FTS5 forces a merge on its own.
   */
  private scheduleFtsMaintenance(): void {
    if (this.stopped || this.ftsTimer) return
    this.ftsTimer = setTimeout(() => {
      this.ftsTimer = null
      void this.runFtsMaintenance()
    }, FTS_MAINTENANCE_DELAY_MS)
    this.ftsTimer.unref?.()
  }

  private async runFtsMaintenance(): Promise<void> {
    const started = Date.now()
    try {
      while (!this.stopped && this.store.mergeFtsStep()) {
        await yieldToEventLoop()
        if (Date.now() - started > FTS_MAINTENANCE_RUN_MS) {
          this.scheduleFtsMaintenance()
          return
        }
      }
    } catch {
      // Merging is housekeeping; a locked or closed database is simply retried after a later write.
    }
  }

  /** Resolves once the counter backfill has finished (immediately on an up-to-date database). */
  countersReady(): Promise<void> {
    return this.counterBackfill
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
      this.enqueue(p, false, current.sizeBytes)
    return needsIndex
  }

  isEnabled(): boolean {
    return this.enabled && !this.stopped
  }

  /** Subscribe to pause/resume; returns an unsubscribe function. */
  onEnabledChange(listener: () => void): () => void {
    this.enabledListeners.add(listener)
    return () => this.enabledListeners.delete(listener)
  }

  /** Subscribe to the index being cleared; returns an unsubscribe function. */
  onCleared(listener: () => void): () => void {
    this.clearedListeners.add(listener)
    return () => this.clearedListeners.delete(listener)
  }

  indexIssues(root: string, offset = 0) {
    return this.store.indexIssues(root, offset)
  }

  /**
   * Queue one file again. With `now` (a person pressed the button for this one file) it also
   * takes the reader over: a read of another file is stopped and put back right behind it,
   * because the line is read one file at a time and "read this first" would otherwise wait
   * for however long that other file takes.
   */
  retryDocument(id: number, options: { now?: boolean } = {}): { ok: boolean; error?: string } {
    if (!this.enabled || this.stopped) return { ok: false, error: 'paused' }
    const path = this.store.retryDocument(id)
    if (!path) return { ok: false, error: 'unavailable' }
    // A read already under way is left alone: restarting it would throw its result away and
    // begin again, so "retry" on a large scan would spin for minutes and end where it began.
    if (this.activeExtractions.has(path)) return { ok: true }
    if (options.now) {
      this.deferred.delete(path)
      this.urgent.add(path)
    }
    // a large PDF read in turns needs no interrupting: it gives way at the end of its turn,
    // keeping every page it has read, and the file asked for is next
    const interrupted = options.now
      ? [...this.activeExtractions].filter((other) => !this.slicing.has(other))
      : []
    // put the interrupted files first, then the chosen one in front of them
    for (const other of interrupted) {
      this.invalidatePath(other)
      this.enqueue(other, true)
    }
    this.invalidatePath(path)
    this.enqueue(path, true)
    if (interrupted.length) this.recycleWorker(INTERRUPTED_FOR_USER)
    return { ok: true }
  }

  /**
   * Push one file to the back of the line: it is read after every other waiting file. If it is
   * being read now, that read is cut short so the next file starts at once.
   */
  deferDocument(id: number): { ok: boolean; error?: string } {
    const document = this.store.documentById(id)
    if (!document || document.status !== 'pending') return { ok: false, error: 'unavailable' }
    this.putBehind(document.path)
    return { ok: true }
  }

  private putBehind(path: string): void {
    const reading = this.activeExtractions.has(path)
    if (reading && this.slicing.has(path)) {
      // read in turns: it steps back when its turn ends, with the pages it has already read
      this.urgent.delete(path)
      this.deferred.add(path)
      return
    }
    this.invalidatePath(path)
    this.urgent.delete(path)
    this.deferred.add(path)
    if (reading) this.recycleWorker(DEFERRED_MESSAGE)
    this.enqueue(path)
  }

  /**
   * A heavy file that has held the reader for a while steps back when lighter ones are waiting:
   * once, so a file that is alone at the end is still read through.
   */
  private makeWayForLightFiles(path: string, generation: number): void {
    if (generation !== this.currentGeneration(path) || !this.activeExtractions.has(path)) return
    if (this.urgent.has(path) || this.deferred.has(path) || this.slicing.has(path)) return
    const info = this.queueInfo()
    const bytes = this.activeBytes.get(path) ?? this.store.documentByPath(path)?.sizeBytes ?? 0
    const mine = rankOf(path, { ...info, bytes: new Map([[path, bytes]]) })
    if (mine < 3) return
    if (!this.queue.some((other) => rankOf(other, info) < mine)) return
    this.putBehind(path)
  }

  /**
   * Stop reading one waiting file (cancelling the read if it is running). It is left as a
   * problem the user can retry, rather than silently put back in the line.
   */
  async stopDocument(id: number): Promise<{ ok: boolean; error?: string }> {
    const document = this.store.documentById(id)
    if (!document || document.status !== 'pending') return { ok: false, error: 'unavailable' }
    const { path } = document
    const reading = this.activeExtractions.has(path)
    this.invalidatePath(path)
    if (reading) this.recycleWorker(STOPPED_BY_USER)
    await this.store.markErrorSliced(path, STOPPED_BY_USER, await statMeta(path))
    return { ok: true }
  }

  /** Storage, page rendering (in the index process) and re-indexing for the scanned-PDF reader. */
  ocrHost(): OcrJobHost {
    return createOcrHost({
      store: this.store,
      isEnabled: () => this.isEnabled(),
      renderInWorker: async (path, ocr): Promise<OcrRenderResult | null> => {
        const reply = await this.ask({ type: 'ocr-render', path, ocr }, this.workerTimeoutMs, true)
        if (!reply) return null
        if ('result' in reply) return reply.result as unknown as OcrRenderResult
        return {
          ok: false,
          code: 'render',
          message:
            'error' in reply && typeof reply.error === 'string' ? reply.error : 'Render failed',
        }
      },
      reindex: (path) => {
        this.invalidatePath(path)
        this.enqueue(path, true)
      },
      reindexNow: async (path) => {
        const id = this.store.documentByPath(path)?.id
        if (id === undefined) return
        const outcome = await this.readNowDocument(id)
        if (!outcome.ok && outcome.error) throw new Error(outcome.error)
      },
    })
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
      ...(document.truncated ? { truncated: true } : {}),
    }
    if (document.status === 'excluded') return { ...base, state: 'excluded', percent: null }
    // Queued/extracting work belongs to a new snapshot; stored counters describe the old one.
    const awaitingSnapshot = { ...base, completedChunks: 0, totalChunks: 0, percent: null }
    if (this.activeExtractions.has(p)) return { ...awaitingSnapshot, state: 'extracting' }
    if (this.queued.has(p))
      return { ...awaitingSnapshot, state: isIndexingPaused() ? 'paused' : 'queued' }
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
      if (!this.enabled || isIndexingPaused())
        return { ...base, state: 'paused', percent: progressPercent(progress) }
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
  ): FolderIndexProgress {
    return foldFolderProgress(this.store.folderChunkProgress(root), discoveryComplete, scanErrors)
  }

  /**
   * The stored per-folder counts behind {@link getFolderIndexProgress}. They are read from the
   * per-document counters (milliseconds), and can be cached and folded with
   * {@link foldFolderProgress} once the live scan state is known.
   */
  getFolderIndexCounts(root: string): FolderChunkProgress {
    return this.store.folderChunkProgress(root)
  }

  /** Index the waiting files below `root` before everything else; returns how many were waiting. */
  prioritizeFolder(root: string): number {
    const prefix = root.endsWith(sep) ? root : root + sep
    this.store.boostFolder(root, Date.now() + PRIORITY_BOOST_MS)
    const mine = this.queue.filter((path) => path.startsWith(prefix))
    if (mine.length) {
      const rest = this.queue.filter((path) => !path.startsWith(prefix))
      this.queue.length = 0
      this.queue.push(...mine, ...rest)
    }
    return mine.length
  }

  /** Last error reported by the model or worker (in-memory; no database access). */
  lastIndexError(): string | undefined {
    return this.lastError
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
      errors: this.store.errorCount(),
    }
  }

  /** Keep the "pages without text" list of a PDF in step with what was just indexed. */
  private recordScanInfo(path: string, extracted: ExtractResult): void {
    try {
      this.store.ocr.saveScanInfo(
        path,
        { mtimeMs: extracted.mtimeMs, sizeBytes: extracted.sizeBytes },
        extracted.scan ?? null,
      )
    } catch {
      // OCR planning is best effort; indexing must not fail because of it
    }
  }

  private get embeddingProfile(): EmbeddingProfile {
    return embeddingProfile(this.embeddingProfileId)
  }

  /** The model in use and what the files of the other one would cost. */
  embeddingSettings(): { profile: EmbeddingProfileId; modelState: string } {
    return { profile: this.embeddingProfileId, modelState: this.modelState }
  }

  /**
   * Switch the embedding model. Existing vectors belong to the old model, so every document that
   * has them is queued to be read again; search keeps working on text (FTS) and on whatever
   * vectors of the new model exist while that happens.
   */
  setEmbeddingProfile(id: EmbeddingProfileId): { ok: boolean; requeued: number } {
    if (this.stopped || id === this.embeddingProfileId) return { ok: !this.stopped, requeued: 0 }
    this.embeddingProfileId = id
    writeFileSync(this.embeddingSettingsPath, JSON.stringify({ profile: id }), { mode: 0o600 })
    // the running worker has the old model loaded: a fresh one starts with the new profile
    this.epoch++
    this.queue.length = 0
    this.queued.clear()
    this.embeds.length = 0
    this.modelState = 'not-loaded'
    this.modelProgress = undefined
    this.recycleWorker('Embedding model changed.')
    this.lastError = undefined
    const requeued = this.store.requeueForEmbeddingModel(this.embeddingProfile.embeddingId)
    if (this.enabled) void this.poll()
    this.notify(this.enabledListeners)
    return { ok: true, requeued }
  }

  /** How many pages of each PDF are read and indexed. */
  getPdfMaxPages(): number {
    return this.pdfMaxPages
  }

  /**
   * Choose how many pages of each PDF are read (kept between 1 and 400). Raising it reads the
   * PDFs that were cut short again; lowering it leaves what is indexed as it is.
   */
  setPdfMaxPages(value: number): { pages: number; requeued: number } {
    const pages = clampPdfPages(value)
    if (this.stopped || pages === this.pdfMaxPages) return { pages: this.pdfMaxPages, requeued: 0 }
    const raised = pages > this.pdfMaxPages
    this.pdfMaxPages = pages
    writePdfPages(this.pdfPagesPath, pages)
    const requeued = raised ? this.store.requeueTruncatedPdfs() : 0
    if (requeued && this.enabled) void this.poll()
    return { pages, requeued }
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
    this.notify(this.enabledListeners)
    return this.status()
  }

  private notify(listeners: Set<() => void>): void {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // Lifecycle listeners must never break the manager.
      }
    }
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
    for (const entry of this.missing.values()) clearTimeout(entry.timer)
    this.missing.clear()
    this.store.clear()
    this.notify(this.clearedListeners)
  }

  async search(
    query: string,
    limit = 8,
  ): Promise<{
    hits: FreshDocumentMemoryHit[]
    pending: number
    errors: number
    modelState: string
  }> {
    let vector: number[] | null = null
    // started now so the outside lookup runs while the passages are searched
    const outside = this.searchExternal(query, 5)
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
      { type: 'search', query, vector, limit, embeddingModel: this.embeddingProfile.embeddingId },
      30_000,
    )
    const result =
      reply && 'result' in reply && Array.isArray(reply.result)
        ? (reply.result as DocumentMemoryHit[])
        : this.store.search(query, null, limit)
    // A file with no readable text (a scanned PDF) has no passages to match; its name can still
    // answer, so name matches join the content hits (one entry per document).
    const seen = new Set(result.map((hit) => hit.documentId))
    const named = this.store.searchNames(query, 5).filter((hit) => !seen.has(hit.documentId))
    // A name that fits the question comes first: with a full page of passage hits it would
    // otherwise be cut off by the caller's limit.
    const seenPaths = new Set([...result, ...named].map((hit) => pathKey(hit.path)))
    const elsewhere = (await outside)
      .filter((file) => !seenPaths.has(pathKey(file.path)))
      .slice(0, 3)
      .map((file) => this.externalHit(file))
    const merged = [...named.slice(0, 3), ...elsewhere, ...result]
    return {
      hits: await this.annotateFreshness(merged),
      pending: this.queue.length + this.embeds.length + this.pendingCount,
      errors: this.store.errorCount(),
      modelState: this.modelState,
    }
  }

  /**
   * Compare each hit's file (at most `limit` stat calls, no hashing) with the indexed
   * mtime/size. Changed files are queued for a prioritized re-index; vanished ones are
   * flagged and scheduled for removal (guarded against an unplugged drive).
   */
  private async annotateFreshness(hits: DocumentMemoryHit[]): Promise<FreshDocumentMemoryHit[]> {
    const byPath = new Map<string, Promise<'fresh' | 'stale' | 'missing'>>()
    for (const hit of hits) {
      if (!byPath.has(hit.path)) byPath.set(hit.path, this.checkFreshness(hit))
    }
    const outcomes = new Map<string, 'fresh' | 'stale' | 'missing'>()
    for (const [path, outcome] of byPath) outcomes.set(path, await outcome)
    for (const [path, outcome] of outcomes) {
      if (!this.enabled || this.stopped) break
      if (outcome === 'stale') this.enqueue(path, true)
      else if (outcome === 'missing') this.markMissing(path)
    }
    return hits.map((hit) => {
      const outcome = outcomes.get(hit.path) ?? 'fresh'
      return { ...hit, stale: outcome !== 'fresh', missing: outcome === 'missing' }
    })
  }

  private async checkFreshness(hit: DocumentMemoryHit): Promise<'fresh' | 'stale' | 'missing'> {
    if (hit.mtimeMs === null || hit.sizeBytes === null) return 'fresh'
    const current = await this.statOutcome(hit.path, FRESHNESS_STAT_TIMEOUT_MS)
    if (current.kind === 'gone') return 'missing'
    if (current.kind === 'file')
      return current.mtimeMs !== hit.mtimeMs || current.sizeBytes !== hit.sizeBytes
        ? 'stale'
        : 'fresh'
    return 'fresh'
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
    if ((await this.statOutcome(hit.path)).kind === 'gone') {
      this.markMissing(hit.path)
      return {
        path: hit.path,
        name: hit.name,
        location: hit.location,
        text: '',
        verified: false,
        error: 'The source file no longer exists at its indexed path.',
      }
    }
    const reply = await this.ask(
      { type: 'extract', path: hit.path, interactive: true, maxPdfPages: this.pdfMaxPages },
      this.workerTimeoutMs,
    )
    if (!reply || !('result' in reply) || !isExtractResult(reply.result)) {
      const error =
        reply && 'error' in reply && typeof reply.error === 'string'
          ? reply.error
          : 'Document verification timed out.'
      if (this.isCurrent(hit.path, generation, epoch))
        await this.store.markErrorSliced(hit.path, error, await statMeta(hit.path), {
          shouldContinue: () => this.isCurrent(hit.path, generation, epoch),
        })
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
    const after = await statMeta(hit.path)
    if (
      !after ||
      after.mtimeMs !== fresh.mtimeMs ||
      after.sizeBytes !== fresh.sizeBytes ||
      fresh.hash !== hit.hash
    ) {
      this.invalidatePath(hit.path)
      const freshGeneration = this.currentGeneration(hit.path)
      const replaced = await this.store.replaceDocumentSliced(
        hit.path,
        {
          hash: fresh.hash,
          mtimeMs: fresh.mtimeMs,
          sizeBytes: fresh.sizeBytes,
          chunks: fresh.chunks,
          embeddingModel: null,
          status: extractedStatus(fresh),
          error: fresh.error,
          truncated: fresh.truncated,
        },
        { shouldContinue: () => !this.stopped && epoch === this.epoch },
      )
      if (replaced) this.recordScanInfo(hit.path, fresh)
      if (replaced && fresh.chunks.length && !fresh.skipEmbeddings && this.enabled)
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

  /**
   * Files found by name outside the index (Everything). Each one is remembered as offered: only
   * those can be opened by path afterwards, so a path the assistant makes up opens nothing.
   */
  async searchExternal(
    query: string,
    limit: number,
  ): Promise<Array<{ path: string; name: string }>> {
    const files = (await this.externalNames?.(query, limit).catch(() => undefined)) ?? []
    for (const file of files) {
      this.offeredPaths.add(file.path)
      // one conversation's worth of offers is plenty
      if (this.offeredPaths.size > 500)
        this.offeredPaths.delete(this.offeredPaths.values().next().value!)
    }
    return files
  }

  /** A file found by an outside name search: nothing of it is indexed, only that it exists. */
  private externalHit(file: { path: string; name: string }): DocumentMemoryHit {
    return {
      documentId: 0,
      path: file.path,
      name: file.name,
      chunkId: 0,
      text: 'The file name matches (found on disk, not in the index). Its content has not been read, so what it says is unknown. Open it by `path`.',
      location: 'file name',
      score: 0.5,
      hash: null,
      mtimeMs: null,
      sizeBytes: null,
      indexedAt: null,
      truncated: false,
      contentUnread: true,
    }
  }

  /** The path of a file an outside search offered earlier (and that still exists), else null. */
  openOffered(path: string): string | null {
    return this.offeredPaths.has(path) && safeStat(path) ? path : null
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
    this.stopPolicyWatch()
    this.epoch++
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    if (this.ftsTimer) clearTimeout(this.ftsTimer)
    this.ftsTimer = null
    for (const entry of this.missing.values()) clearTimeout(entry.timer)
    this.missing.clear()
    this.enabledListeners.clear()
    this.clearedListeners.clear()
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

  /**
   * Safety poll. Change detection for folders is the watcher plus the periodic reconcile
   * pass; this only resumes interrupted work (SQL) and, rarely, stats the documents the
   * user opened by hand. It never stats the whole index.
   */
  private async poll(): Promise<void> {
    if (this.stopped || !this.enabled || this.polling) return
    this.polling = true
    try {
      await this.resumeIncomplete()
      if (this.stopped) return
      if (Date.now() - this.lastOpenedCheck >= OPENED_CHECK_INTERVAL_MS) {
        this.lastOpenedCheck = Date.now()
        await this.checkOpenedDocuments()
      }
    } finally {
      this.polling = false
    }
  }

  private async resumeIncomplete(): Promise<void> {
    const idle = !this.embedding && !this.extracting
    const maybeYield = createYielder()
    for (const path of this.store.incompletePaths()) {
      if (this.stopped || !this.enabled) return
      if (this.activeExtractions.has(path)) continue
      const doc = this.store.documentByPath(path)
      if (!doc || doc.status === 'excluded') continue
      if (doc.status === 'text-only' && (!idle || this.embeds.some((job) => job.path === path)))
        continue
      this.enqueue(path)
      await maybeYield()
    }
  }

  private async checkOpenedDocuments(): Promise<void> {
    for (const path of this.store.openedPaths(OPENED_CHECK_LIMIT)) {
      if (this.stopped || !this.enabled) return
      if (this.activeExtractions.has(path)) continue
      const doc = this.store.documentByPath(path)
      if (!doc || doc.status === 'excluded') continue
      const current = await this.statOutcome(path)
      if (this.stopped || !this.enabled) return
      if (current.kind === 'gone') this.markMissing(path)
      else if (
        current.kind === 'file' &&
        (doc.status === 'pending' ||
          doc.mtimeMs !== current.mtimeMs ||
          doc.sizeBytes !== current.sizeBytes)
      )
        this.enqueue(path)
      await yieldToEventLoop()
    }
  }

  // ---- file lifecycle: watcher events, reconcile, tombstones, move detection ----

  /**
   * Apply coalesced watcher events. Removals are noted first (with a grace period) so a file
   * that reappears elsewhere with the same size and hash is recognised as a move instead of
   * being re-extracted and re-embedded.
   */
  async handleFileEvents(paths: string[]): Promise<void> {
    if (this.stopped || !this.enabled) return
    const present: Array<{ path: string; meta: { mtimeMs: number; sizeBytes: number } }> = []
    const maybeYield = createYielder()
    for (const raw of paths) {
      if (this.stopped || !this.enabled) return
      await maybeYield()
      const path = resolve(raw)
      const current = await this.statOutcome(path)
      if (current.kind === 'gone') {
        if (this.store.documentByPath(path)) this.markMissing(path)
      } else if (
        current.kind === 'file' &&
        SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase()) &&
        current.sizeBytes <= MAX_DOCUMENT_BYTES
      )
        present.push({ path, meta: { mtimeMs: current.mtimeMs, sizeBytes: current.sizeBytes } })
    }
    const candidates = new Map<number, MissingCandidate[]>()
    for (const entry of this.missing.values())
      if (entry.candidate) addCandidate(candidates, entry.candidate)
    for (const { path, meta } of present) {
      if (this.stopped || !this.enabled) return
      await maybeYield()
      if (this.store.documentByPath(path)) this.indexDiscoveredFile(path, meta)
      else await this.enrollNew(path, meta, candidates)
    }
  }

  /**
   * Reconcile one scanned root with a fresh metadata-only listing: enroll new files, queue
   * changed ones, turn move pairs (same size + hash) into path updates and forget the rest of
   * the vanished files. Never reads file contents except to hash a move candidate.
   */
  async reconcileFolder(
    root: string,
    files: Map<string, { mtimeMs: number; sizeBytes: number }>,
  ): Promise<{ added: number; changed: number; moved: number; removed: number }> {
    const result = { added: 0, changed: 0, moved: 0, removed: 0 }
    if (this.stopped || !this.enabled) return result
    const seen = new Set<string>()
    for (const path of files.keys()) seen.add(pathKey(path))
    const candidates = new Map<number, MissingCandidate[]>()
    const gone: StoredDocument[] = []
    const maybeYield = createYielder()
    // Read the stored rows a page at a time so a large folder never costs one long SQL call.
    for (let afterId = 0; ;) {
      const page = this.store.documentsUnderPage(root, afterId, 500)
      if (!page.length) break
      afterId = page[page.length - 1]!.id
      for (const row of page) {
        if (seen.has(pathKey(row.path))) continue
        await maybeYield()
        if (this.stopped || !this.enabled) return result
        if (!(await this.isGone(row.path))) continue
        gone.push(row)
        if (row.hash && row.sizeBytes !== null)
          addCandidate(candidates, { path: row.path, sizeBytes: row.sizeBytes, hash: row.hash })
      }
      await maybeYield()
    }
    for (const [path, meta] of files) {
      if (this.stopped || !this.enabled) return result
      await maybeYield()
      if (this.store.documentByPath(path)) {
        if (this.indexDiscoveredFile(path, meta)) result.changed++
        continue
      }
      const outcome = await this.enrollNew(path, meta, candidates)
      if (outcome === 'moved') result.moved++
      else if (outcome === 'indexed') result.added++
    }
    for (const row of gone) {
      if (this.stopped || !this.enabled) return result
      // A moved original already left the table; anything still here is truly gone.
      if (!this.store.documentByPath(row.path)) continue
      await this.tombstone(row.path)
      result.removed++
    }
    return result
  }

  private async enrollNew(
    path: string,
    meta: { mtimeMs: number; sizeBytes: number },
    candidates: Map<number, MissingCandidate[]>,
  ): Promise<'moved' | 'indexed' | 'skipped'> {
    const list = candidates.get(meta.sizeBytes)
    if (list?.length && meta.sizeBytes <= RENAME_HASH_MAX_BYTES) {
      const hash = await hashFile(path).catch(() => null)
      const index = hash ? list.findIndex((candidate) => candidate.hash === hash) : -1
      if (index >= 0 && this.moveIndexed(list[index]!.path, path, meta)) {
        list.splice(index, 1)
        return 'moved'
      }
    }
    return this.indexDiscoveredFile(path, meta) ? 'indexed' : 'skipped'
  }

  /** Carry an indexed document to its new path, keeping chunks, FTS rows and vectors. */
  private moveIndexed(
    oldPath: string,
    newPath: string,
    meta: { mtimeMs: number; sizeBytes: number },
  ): boolean {
    if (this.stopped) return false
    this.invalidatePath(oldPath)
    const pending = this.missing.get(oldPath)
    if (pending) {
      clearTimeout(pending.timer)
      this.missing.delete(oldPath)
    }
    if (this.store.documentByPath(newPath)) return false
    try {
      this.store.move(oldPath, newPath)
    } catch {
      return false
    }
    this.store.touchMetadata(newPath, meta.mtimeMs, meta.sizeBytes)
    const status = this.store.documentByPath(newPath)?.status
    if (this.enabled && (status === 'pending' || status === 'text-only')) this.enqueue(newPath)
    return true
  }

  /** Note a vanished file; its index is dropped after a grace period unless it reappears. */
  private markMissing(path: string): void {
    if (this.stopped || this.missing.has(path)) return
    const doc = this.store.documentByPath(path)
    if (!doc || doc.status === 'excluded') return
    const candidate: MissingCandidate | null =
      doc.hash && doc.sizeBytes !== null ? { path, sizeBytes: doc.sizeBytes, hash: doc.hash } : null
    const timer = setTimeout(() => void this.finalizeMissing(path), this.tombstoneGraceMs)
    timer.unref?.()
    this.missing.set(path, { candidate, timer })
  }

  private async finalizeMissing(path: string): Promise<void> {
    this.missing.delete(path)
    if (this.stopped || !this.enabled) return
    if ((await this.isGone(path)) && !this.stopped) await this.tombstone(path)
  }

  /** Drop chunks, FTS rows and vectors for a deleted file. User exclusions are kept. */
  private async tombstone(path: string): Promise<void> {
    const entry = this.missing.get(path)
    if (entry) {
      clearTimeout(entry.timer)
      this.missing.delete(path)
    }
    this.invalidatePath(path)
    try {
      await this.store.tombstoneSliced(path, { shouldContinue: () => !this.stopped })
      this.scheduleFtsMaintenance()
    } catch (error) {
      if (!this.stopped) this.lastError = safeError(error)
    }
  }

  /** True only when the file is certainly gone, not when its drive or share is unreachable. */
  private async isGone(path: string): Promise<boolean> {
    if ((await this.statOutcome(path)).kind !== 'gone') return false
    const root = await this.statOutcome(volumeRootOf(path))
    return root.kind === 'other' || root.kind === 'file'
  }

  private async statOutcome(path: string, timeoutMs?: number): Promise<StatOutcome> {
    let timer: NodeJS.Timeout | undefined
    const lookup: Promise<StatOutcome> = stat(path).then(
      (value): StatOutcome =>
        value.isFile()
          ? { kind: 'file', mtimeMs: value.mtimeMs, sizeBytes: value.size }
          : { kind: 'other' },
      (error: NodeJS.ErrnoException): StatOutcome =>
        error.code === 'ENOENT' || error.code === 'ENOTDIR'
          ? { kind: 'gone' }
          : { kind: 'unknown' },
    )
    if (!timeoutMs) return lookup
    const timeout = new Promise<StatOutcome>((done) => {
      timer = setTimeout(() => done({ kind: 'unknown' }), timeoutMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([lookup, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  private enqueue(path: string, prioritize = false, sizeBytes?: number): void {
    if (this.stopped || !this.enabled) return
    // being read right now and still valid: its result will be stored; a file that changes after
    // is noticed by the next scan, which compares with what was stored
    if (this.activeGeneration.get(path) === this.currentGeneration(path)) return
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
    const known = sizeBytes ?? doc.sizeBytes
    this.queueBytes.set(path, known ?? 0)
    if (known === null || known === undefined) this.learnSize(path)
    if (prioritize) this.queue.unshift(path)
    else this.queue.push(path)
    // a small file arriving behind a heavy read that has run for a while should not wait for it
    this.reviewHeavyReads()
    void this.drain()
  }

  private reviewHeavyReads(): void {
    const now = Date.now()
    for (const [path, since] of this.activeSince) {
      if (now - since >= this.autoDeferAfterMs) {
        this.makeWayForLightFiles(path, this.currentGeneration(path))
      }
    }
  }

  /**
   * A file enrolled without a size (the index only learns it by reading the file) is measured in
   * the background, one at a time, so a restart does not make every waiting scan look light.
   */
  private learnSize(path: string): void {
    this.sizeLookups.add(path)
    if (this.sizing) return
    this.sizing = true
    void (async () => {
      try {
        for (const next of this.sizeLookups) {
          this.sizeLookups.delete(next)
          if (this.stopped) return
          if (!this.queued.has(next)) continue
          const outcome = await this.statOutcome(next)
          if (outcome.kind === 'file' && this.queued.has(next)) {
            this.queueBytes.set(next, outcome.sizeBytes)
          }
          await yieldToEventLoop()
        }
      } finally {
        this.sizing = false
      }
    })()
  }

  private queueInfo(): QueueInfo {
    return { urgent: this.urgent, deferred: this.deferred, bytes: this.queueBytes }
  }

  /** The waiting line in the order it will be read: asked-for first, light before heavy. */
  private readingOrder(): string[] {
    return orderQueue(this.queue, this.queueInfo())
  }

  private takeNext(): string {
    const path = this.readingOrder()[0]!
    this.queue.splice(this.queue.indexOf(path), 1)
    this.activeBytes.set(path, this.queueBytes.get(path) ?? 0)
    this.queueBytes.delete(path)
    return path
  }

  private drain(): void {
    // The indexing policy (battery, lock, memory...) can pause new work; resume() re-drains.
    if (this.stopped || !this.enabled || isIndexingPaused()) return
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
        !isIndexingPaused() &&
        this.queue.length &&
        this.embeds.length < MAX_PENDING_EMBED_DOCUMENTS
      ) {
        const path = this.takeNext()
        this.queued.delete(path)
        this.activeExtractions.add(path)
        this.activeSince.set(path, Date.now())
        const generation = this.currentGeneration(path)
        const epoch = this.epoch
        this.activeGeneration.set(path, generation)
        this.pendingCount++
        const heavyWatch = setTimeout(
          () => this.makeWayForLightFiles(path, generation),
          this.autoDeferAfterMs,
        )
        try {
          const sliceMs =
            /\.pdf$/i.test(path) && weightOf(this.activeBytes.get(path) ?? 0) >= 2
              ? PDF_SLICE_MS
              : undefined
          if (sliceMs) this.slicing.add(path)
          const reply = await this.ask(
            {
              type: 'extract',
              path,
              maxPdfPages: this.pdfMaxPages,
              ...(sliceMs ? { sliceMs } : {}),
            },
            this.workerTimeoutMs,
            true,
          )
          await this.applyExtractReply(path, reply, generation, epoch)
        } catch (error) {
          if (this.isCurrent(path, generation, epoch)) {
            const message = safeError(error)
            await this.store
              .markErrorSliced(path, message, await statMeta(path), {
                shouldContinue: () => this.isCurrent(path, generation, epoch),
              })
              .catch(() => undefined)
            this.lastError = message
          }
        } finally {
          clearTimeout(heavyWatch)
          if (this.activeGeneration.get(path) === generation) this.activeGeneration.delete(path)
          this.slicing.delete(path)
          this.activeExtractions.delete(path)
          this.activeSince.delete(path)
          this.activeBytes.delete(path)
          this.pendingCount--
          // a read that was cut short and put back keeps the flags it was put back with
          if (generation === this.currentGeneration(path)) {
            this.urgent.delete(path)
            this.deferred.delete(path)
            this.readProgress.delete(path)
          }
        }
      }
    } finally {
      this.extracting = false
      if (!this.stopped && this.enabled) this.drain()
    }
  }

  /**
   * What a finished read of one file does to the index: a turn of a large PDF goes back into the
   * line, an error is recorded on the file, a result replaces its passages and queues its vectors.
   * Shared by the background line and by "read this one now".
   */
  private async applyExtractReply(
    path: string,
    reply: WorkerReply | null,
    generation: number,
    epoch: number,
  ): Promise<void> {
    if (!this.isCurrent(path, generation, epoch)) return
    if (reply && 'result' in reply && isPartialExtract(reply.result)) {
      // one turn of a large PDF: the pages read are kept in the worker, and the file goes
      // back into the line, where lighter files (or anything asked for) go first
      this.readProgress.set(path, {
        done: reply.result.pagesDone,
        total: reply.result.totalPages,
      })
      this.activeGeneration.delete(path)
      this.enqueue(path, false, this.activeBytes.get(path))
      return
    }
    if (!reply || !('result' in reply) || !isExtractResult(reply.result)) {
      const error =
        reply && 'error' in reply && typeof reply.error === 'string'
          ? reply.error
          : 'Document extraction timed out.'
      await this.store.markErrorSliced(path, error, await statMeta(path), {
        shouldContinue: () => this.isCurrent(path, generation, epoch),
      })
      this.lastError = error
      return
    }
    const extracted = reply.result
    const previous = this.store.documentByPath(path)
    const lexicalOnly = !!extracted.skipEmbeddings && extracted.chunks.length > 0
    const resumeOffset =
      !lexicalOnly &&
      previous?.mtimeMs === extracted.mtimeMs &&
      previous.sizeBytes === extracted.sizeBytes
        ? this.store.resumeVectorOffset(path, extracted.hash, this.embeddingProfile.embeddingId)
        : null
    if (resumeOffset === null) {
      // Written in short transactions: a 400-chunk document used to hold the main thread
      // for ~100 ms. Abandoned (and re-extracted later) if the document changes meanwhile.
      const written = await this.store.replaceDocumentSliced(
        path,
        {
          hash: extracted.hash,
          mtimeMs: extracted.mtimeMs,
          sizeBytes: extracted.sizeBytes,
          chunks: extracted.chunks,
          embeddingModel: null,
          status: extractedStatus(extracted),
          error: extracted.error,
          truncated: extracted.truncated,
        },
        { shouldContinue: () => this.isCurrent(path, generation, epoch) },
      )
      if (!written) return
      this.recordScanInfo(path, extracted)
      this.scheduleFtsMaintenance()
    }
    this.lastError = undefined
    if (extracted.chunks.length && !lexicalOnly) {
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
  }

  /**
   * A person pressed "read this one": it is read at once, ahead of the line and whatever the
   * indexing policy (memory, battery, lock) or the vector backlog say, since they asked for this
   * file. Only indexing switched off by the person stops it. The result, or why it failed, is on
   * the file when this returns, so a file that cannot be read says so instead of waiting.
   */
  async readNowDocument(id: number): Promise<{ ok: boolean; error?: string; empty?: boolean }> {
    if (!this.enabled || this.stopped) return { ok: false, error: 'paused' }
    const path = this.store.retryDocument(id)
    if (!path) return { ok: false, error: 'unavailable' }
    if (this.activeExtractions.has(path)) {
      // already being read: it must not be put behind anything now, and the answer is the
      // result of that read, not "started"
      this.deferred.delete(path)
      this.urgent.add(path)
      await this.waitUntilRead(path)
      // that read stored it (or failed with a reason): that is the answer. If it was overtaken
      // and the file is still waiting, it is read below, right now
      if (this.store.documentByPath(path)?.status !== 'pending') return this.readOutcome(path)
    }
    // a large file that cannot be read in turns would hold the worker for minutes: step it aside
    const blocking = [...this.activeExtractions].filter(
      (other) => !this.slicing.has(other) && weightOf(this.activeBytes.get(other) ?? 0) >= 3,
    )
    for (const other of blocking) {
      this.invalidatePath(other)
      this.enqueue(other)
    }
    if (blocking.length) this.recycleWorker(INTERRUPTED_FOR_USER)
    // A read can still be overtaken (the file was replaced, or the person asked for something
    // else in between) and its result then is not stored: read it again, a few times, rather than
    // answer "not finished" for a file that is plainly there.
    for (let attempt = 0; attempt < READ_NOW_ATTEMPTS; attempt++) {
      this.invalidatePath(path)
      this.urgent.delete(path)
      this.deferred.delete(path)
      await this.readOnce(path)
      if (this.store.documentByPath(path)?.status !== 'pending') break
    }
    return this.readOutcome(path)
  }

  /** One interactive read of one file, stored (or its failure recorded) when it comes back. */
  private async readOnce(path: string): Promise<void> {
    const generation = this.currentGeneration(path)
    const epoch = this.epoch
    this.activeGeneration.set(path, generation)
    this.activeExtractions.add(path)
    this.activeSince.set(path, Date.now())
    this.pendingCount++
    try {
      const reply = await this.ask(
        { type: 'extract', path, interactive: true, maxPdfPages: this.pdfMaxPages },
        this.workerTimeoutMs,
        true,
      )
      await this.applyExtractReply(path, reply, generation, epoch)
    } catch (error) {
      if (this.isCurrent(path, generation, epoch)) {
        const message = safeError(error)
        await this.store
          .markErrorSliced(path, message, await statMeta(path), {
            shouldContinue: () => this.isCurrent(path, generation, epoch),
          })
          .catch(() => undefined)
        this.lastError = message
      }
    } finally {
      if (this.activeGeneration.get(path) === generation) this.activeGeneration.delete(path)
      this.activeExtractions.delete(path)
      this.activeSince.delete(path)
      this.pendingCount--
    }
  }

  /** Wait while a file is being read or is waiting its turn (a large PDF is read in turns). */
  private async waitUntilRead(path: string): Promise<void> {
    const deadline = Date.now() + this.workerTimeoutMs * 2
    while (
      !this.stopped &&
      Date.now() < deadline &&
      (this.activeExtractions.has(path) || this.queued.has(path))
    )
      await new Promise((resolve) => setTimeout(resolve, 100))
  }

  /** What a file looks like after it was read: searchable, failed (with why), or still waiting. */
  private readOutcome(path: string): { ok: boolean; error?: string; empty?: boolean } {
    const after = this.store.documentByPath(path)
    if (after?.status === 'error') return { ok: false, error: after.error ?? 'Could not be read' }
    // read fine, but there was no text in it: a scan, which only OCR can make searchable
    if (after?.status === 'empty') return { ok: true, empty: true }
    return after?.status === 'pending' ? { ok: false, error: 'not finished' } : { ok: true }
  }

  private async drainEmbeddings(): Promise<void> {
    if (this.embedding || this.stopped) return
    this.embedding = true
    try {
      while (!this.stopped && this.enabled && !isIndexingPaused() && this.embeds.length) {
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
            this.workerTimeoutMs,
            true,
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
          const current = await statMeta(job.path)
          if (!this.isCurrent(job.path, job.generation, job.epoch)) break
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
            this.embeddingProfile.embeddingId,
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
    this.queueBytes.delete(path)
    for (let i = this.queue.length - 1; i >= 0; i--)
      if (this.queue[i] === path) this.queue.splice(i, 1)
    for (let i = this.embeds.length - 1; i >= 0; i--)
      if (this.embeds[i]?.path === path) this.embeds.splice(i, 1)
  }

  private currentGeneration(path: string): number {
    return this.pathGeneration.get(path) ?? 0
  }
  private isCurrent(path: string, generation: number, epoch: number): boolean {
    if (
      this.stopped ||
      !this.enabled ||
      epoch !== this.epoch ||
      generation !== this.currentGeneration(path)
    )
      return false
    const document = this.store.documentByPath(path)
    return !!document && document.status !== 'excluded'
  }

  /**
   * Replace a worker that stopped answering. Terminating it also frees whatever native call it
   * was stuck in; the next request starts a fresh one and every waiter gets an error.
   */
  private recycleWorker(reason: string): void {
    const worker = this.worker
    if (!worker) return
    this.worker = null
    this.lastError = reason
    void worker.terminate()
    for (const [id, pending] of this.waiting) {
      clearTimeout(pending.timer)
      pending.resolve({ id, error: reason })
      this.waiting.delete(id)
    }
  }

  private ask(
    request: WorkerRequest,
    timeoutMs: number,
    recycleOnTimeout = false,
  ): Promise<WorkerReply | null> {
    if (this.stopped) return Promise.resolve(null)
    const id = this.nextRequestId++
    return new Promise((resolveReply) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        resolveReply(null)
        if (recycleOnTimeout && !this.stopped)
          this.recycleWorker('Indexing stalled and was restarted.')
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
      embeddingProfile: this.embeddingProfileId,
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

function readEmbeddingProfileId(path: string): EmbeddingProfileId {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const id = (value as { profile?: unknown } | null)?.profile
    return isEmbeddingProfileId(id) ? id : DEFAULT_EMBEDDING_PROFILE
  } catch {
    return DEFAULT_EMBEDDING_PROFILE
  }
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
/** Asynchronous {@link safeStat}: never blocks the main thread on a slow or network drive. */
async function statMeta(path: string): Promise<{ mtimeMs: number; sizeBytes: number } | null> {
  try {
    const result = await stat(path)
    return { mtimeMs: result.mtimeMs, sizeBytes: result.size }
  } catch {
    return null
  }
}
function safeStat(path: string): { mtimeMs: number; sizeBytes: number } | null {
  try {
    const result = statSync(path)
    return { mtimeMs: result.mtimeMs, sizeBytes: result.size }
  } catch {
    return null
  }
}
/** Numeric tables skip embedding: they are complete (and FTS-searchable) once stored. */
function extractedStatus(result: ExtractResult): 'text-only' | 'empty' | 'ready' {
  if (!result.chunks.length) return 'empty'
  return result.skipEmbeddings ? 'ready' : 'text-only'
}
function addCandidate(map: Map<number, MissingCandidate[]>, candidate: MissingCandidate): void {
  const list = map.get(candidate.sizeBytes)
  if (list) list.push(candidate)
  else map.set(candidate.sizeBytes, [candidate])
}
/** Windows paths are case-insensitive; compare them that way when matching listings. */
function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}
function hashFile(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}
function safeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Document memory operation failed.'
}
/** One turn of a large PDF that is not finished: the worker kept the pages it read. */
function isPartialExtract(
  value: unknown,
): value is { partial: true; pagesDone: number; totalPages: number } {
  const result = value as { partial?: unknown; pagesDone?: unknown; totalPages?: unknown } | null
  return (
    !!result &&
    result.partial === true &&
    typeof result.pagesDone === 'number' &&
    typeof result.totalPages === 'number'
  )
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
