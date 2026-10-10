import { Worker } from 'node:worker_threads'
import statusWorkerPath from './index-status-worker?modulePath'
import type {
  DocumentMemoryStats,
  FolderChunkProgress,
} from '../storage/repositories/progress-repository'
import type { IndexIssueSummary } from '../issue-reader'
import type { IndexedFileHit } from '../../../shared/fork/document-index-api'
import type { StatusRequest } from './index-status-types'

/** Where the aggregates are computed. Production: a worker thread with its own read-only connection. */
export interface AggregateFetcher {
  call(request: StatusRequest): Promise<unknown>
  close(): void
}

const CALL_TIMEOUT_MS = 60_000

export function createThreadFetcher(dbPath: string): AggregateFetcher {
  let worker: Worker | null = null
  let nextId = 1
  const waiting = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >()
  const failAll = (error: Error): void => {
    for (const [id, p] of waiting) {
      clearTimeout(p.timer)
      p.reject(error)
      waiting.delete(id)
    }
  }
  const ensure = (): Worker => {
    if (worker) return worker
    const w = new Worker(statusWorkerPath, { workerData: { dbPath } })
    w.on('message', (message: { id: number; result?: unknown; error?: string }) => {
      const p = waiting.get(message.id)
      if (!p) return
      waiting.delete(message.id)
      clearTimeout(p.timer)
      if (message.error !== undefined) p.reject(new Error(message.error))
      else p.resolve(message.result)
    })
    const drop = (error: Error): void => {
      if (worker === w) worker = null
      failAll(error)
    }
    w.on('error', (error) => drop(error))
    w.on('exit', () => drop(new Error('status reader exited')))
    w.unref()
    worker = w
    return w
  }
  return {
    call(request) {
      return new Promise((resolve, reject) => {
        const id = nextId++
        const timer = setTimeout(() => {
          waiting.delete(id)
          reject(new Error('status reader timed out'))
        }, CALL_TIMEOUT_MS)
        timer.unref?.()
        waiting.set(id, { resolve, reject, timer })
        try {
          ensure().postMessage({ ...request, id })
        } catch (error) {
          clearTimeout(timer)
          waiting.delete(id)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    close() {
      const w = worker
      worker = null
      failAll(new Error('status reader closed'))
      void w?.terminate()
    },
  }
}

export interface StatusAggregatesOptions {
  /** A value younger than this is served as is. The effective age limit grows with the measured cost (see `dutyFactor`). */
  minTtlMs?: number
  maxTtlMs?: number
  /** Refresh at most every `dutyFactor` x the time the last computation took (about a 10 % duty cycle of the reader). */
  dutyFactor?: number
  now?: () => number
  /** The embedding space the counts are measured against when a read does not name one. */
  activeSpace?: () => string | undefined
}

interface Entry {
  value: unknown
  has: boolean
  fetchedAt: number
  ttlMs: number
  inflight: boolean
}

const EMPTY_FOLDER: FolderChunkProgress = {
  totalFiles: 0,
  readyFiles: 0,
  pendingFiles: 0,
  errorFiles: 0,
  totalChunks: 0,
  completedChunks: 0,
  partialFileProgress: 0,
  truncatedFiles: 0,
}

/**
 * Stale-while-revalidate view of the dashboard aggregates that never computes anything on the calling thread: a
 * read returns the last value at once (a neutral value before the first one arrives) and, when the value is older
 * than its TTL, starts one background computation in the reader thread. The caller is typically an IPC handler on
 * Electron's main thread, polled every couple of seconds while a window shows the index status.
 */
export class StatusAggregates {
  private readonly entries = new Map<string, Entry>()
  private readonly minTtlMs: number
  private readonly maxTtlMs: number
  private readonly dutyFactor: number
  private readonly now: () => number
  private readonly activeSpace: () => string | undefined
  private closed = false
  /** Called whenever a fresh value replaced an older one (lets the owner drop its own derived caches). */
  onUpdate?: () => void

  constructor(
    private readonly fetcher: AggregateFetcher,
    options: StatusAggregatesOptions = {},
  ) {
    this.minTtlMs = options.minTtlMs ?? 3_000
    this.maxTtlMs = options.maxTtlMs ?? 20_000
    this.dutyFactor = options.dutyFactor ?? 10
    this.now = options.now ?? (() => performance.now())
    this.activeSpace = options.activeSpace ?? (() => undefined)
  }

  reset(): void {
    this.entries.clear()
  }

  stats(space = this.activeSpace()): DocumentMemoryStats {
    return this.read('stats', { op: 'stats', space }, { docs: 0, chunks: 0, vectors: 0, errors: 0 })
  }

  folder(root?: string, space = this.activeSpace()): FolderChunkProgress {
    return this.read(
      `folder:${root ?? '*'}:${space ?? ''}`,
      { op: 'folder', root, space },
      EMPTY_FOLDER,
    )
  }

  issues(root: string): IndexIssueSummary {
    return this.read(`issues:${root}`, { op: 'issues', root }, { total: 0, groups: [] })
  }

  /** Indexed files with these extensions (a scan of the whole table), computed in the reader thread; not cached. */
  async legacyPaths(extensions: readonly string[], limit: number): Promise<string[]> {
    return (await this.fetcher.call({ op: 'legacy', extensions, limit })) as string[]
  }

  private searchRunning = false
  private searchWaiting: { query: string; resolve: (hits: IndexedFileHit[]) => void } | null = null

  /**
   * Files of the index whose name or path contain every typed word. Folding the names of the whole table is 0.5-1 s
   * of work per call on a big index, and a person types faster than that: one search runs at a time, and a search that
   * is still waiting when a newer one arrives is answered with nothing (its caller has already moved on).
   */
  searchIndexed(query: string): Promise<IndexedFileHit[]> {
    return new Promise((resolve) => {
      this.searchWaiting?.resolve([])
      this.searchWaiting = { query, resolve }
      void this.pumpSearch()
    })
  }

  private async pumpSearch(): Promise<void> {
    if (this.searchRunning || this.closed) return
    const job = this.searchWaiting
    if (!job) return
    this.searchWaiting = null
    this.searchRunning = true
    try {
      job.resolve((await this.fetcher.call({ op: 'search', query: job.query })) as IndexedFileHit[])
    } catch {
      job.resolve([])
    } finally {
      this.searchRunning = false
      void this.pumpSearch()
    }
  }

  /** The next read of every key refreshes in the background. */
  invalidate(): void {
    for (const entry of this.entries.values()) entry.fetchedAt = Number.NEGATIVE_INFINITY
  }

  /** Whether a first value has arrived for the key (tests, and callers that prefer waiting to a neutral value). */
  settled(): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.closed || [...this.entries.values()].every((e) => !e.inflight)) resolve()
        else setTimeout(check, 5)
      }
      check()
    })
  }

  close(): void {
    this.closed = true
    this.fetcher.close()
  }

  private read<T>(key: string, request: StatusRequest, fallback: T): T {
    let entry = this.entries.get(key)
    if (!entry) {
      entry = {
        value: fallback,
        has: false,
        fetchedAt: Number.NEGATIVE_INFINITY,
        ttlMs: this.minTtlMs,
        inflight: false,
      }
      this.entries.set(key, entry)
    }
    if (!this.closed && !entry.inflight && this.now() - entry.fetchedAt >= entry.ttlMs)
      this.refresh(entry, request)
    return entry.value as T
  }

  private refresh(entry: Entry, request: StatusRequest): void {
    entry.inflight = true
    const started = this.now()
    this.fetcher.call(request).then(
      (value) => {
        const finished = this.now()
        entry.value = value
        entry.has = true
        entry.fetchedAt = finished
        entry.ttlMs = Math.min(
          this.maxTtlMs,
          Math.max(this.minTtlMs, (finished - started) * this.dutyFactor),
        )
        entry.inflight = false
        this.onUpdate?.()
      },
      () => {
        // keep serving the previous value; try again after the minimum TTL
        entry.fetchedAt = this.now()
        entry.ttlMs = this.minTtlMs
        entry.inflight = false
      },
    )
  }
}
