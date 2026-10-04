import { Worker } from 'node:worker_threads'
import { stat } from 'node:fs/promises'
import { createYielder } from '../document-memory/yield-budget'
import {
  isIndexingPaused,
  subscribeIndexingPolicy,
  currentIndexingPolicy,
} from '../fork/indexing-policy-bus'
import type { Extracted } from './extract'
import type { WorkerRequest, WorkerResponse } from './extract-worker'
import { isSupportedTreeFile } from '../folder-tree'
import type { ScannedFile } from './scan'
import type { FileIndexStore } from './store'

export interface IndexProgress {
  /** files currently in the index */
  indexed: number
  /** files waiting for extraction */
  pending: number
  scanning: boolean
}

export interface IndexerSources {
  /** the folders walked recursively: the save folder and every added root */
  roots: () => readonly string[]
  /** files outside the roots that should still be searchable (recents, starred) */
  extraPaths: () => readonly string[]
}

const RESCAN_DEBOUNCE_MS = 1500
/**
 * a worker request left unanswered this long means a wedged parse or a stalled
 * walk: the request fails as an extraction error and the worker is recycled,
 * so one bad file cannot stall indexing (and search with it) for good
 */
const WORKER_REQUEST_TIMEOUT_MS = 120_000

/** Slow disks and network paths must never hold Electron's UI thread in statSync. */
async function asyncStatOrNull(path: string): Promise<ScannedFile | null> {
  try {
    const file = await stat(path)
    return file.isFile() ? { path, mtimeMs: file.mtimeMs, sizeBytes: file.size } : null
  } catch {
    return null
  }
}

/**
 * Keeps the store in step with the disk: a scan diffs mtime/size against the
 * index, changed files queue for extraction on the worker one at a time, and
 * vanished files are dropped. Scans coalesce; extraction is sequential so the
 * user's foreground work keeps the CPU.
 */
export class FileIndexer {
  private worker: Worker | null = null
  private nextId = 1
  private readonly waiting = new Map<number, (r: WorkerResponse) => void>()
  private readonly queue: ScannedFile[] = []
  private readonly queued = new Set<string>()
  private draining = false
  private scanning = false
  private scanRequested = false
  private rescanTimer: NodeJS.Timeout | null = null
  private lastScanAt = 0
  private stopped = false
  private readonly stopPolicyWatch: () => void

  constructor(
    private readonly store: FileIndexStore,
    private readonly workerPath: string,
    private readonly sources: IndexerSources,
    private readonly requestTimeoutMs = WORKER_REQUEST_TIMEOUT_MS,
  ) {
    this.stopPolicyWatch = subscribeIndexingPolicy((policy) => {
      if (!policy.paused) void this.drain()
      if (this.worker)
        this.worker.postMessage({ type: 'policy', threads: 1, cpuShare: policy.cpuShare })
    })
  }

  progress(): IndexProgress {
    return { indexed: this.store.count(), pending: this.queue.length, scanning: this.scanning }
  }

  /** schedule a scan soon; repeated calls within the debounce window fold into one */
  refresh(): void {
    if (this.stopped) return
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null
      void this.scan()
    }, RESCAN_DEBOUNCE_MS)
  }

  /** scan now unless one ran within `maxAgeMs` */
  refreshIfStale(maxAgeMs: number): void {
    if (Date.now() - this.lastScanAt >= maxAgeMs) void this.scan()
  }

  async scan(): Promise<void> {
    if (this.stopped) return
    if (this.scanning) {
      this.scanRequested = true
      return
    }
    this.scanning = true
    try {
      const seen = new Map<string, ScannedFile>()
      let walked = true
      for (const root of this.sources.roots()) {
        const res = await this.ask({ id: 0, type: 'scan', root })
        // a crashed worker answers with an extract error; dropping the index on that would empty search
        if (res.type === 'scan') for (const f of res.files) seen.set(f.path, f)
        else walked = false
      }
      if (walked) await this.diff(seen)
    } finally {
      this.scanning = false
      void this.drain()
    }
    // a refresh that arrived mid-scan runs now, whether or not the walk succeeded
    if (this.scanRequested) {
      this.scanRequested = false
      void this.scan()
    }
  }

  /** bring the store in step with what the walk saw; extra paths are stat-ed here */
  private async diff(seen: Map<string, ScannedFile>): Promise<void> {
    const yieldIfNeeded = createYielder()
    for (const p of this.sources.extraPaths()) {
      if (this.stopped) return
      if (seen.has(p) || !isSupportedTreeFile(p)) continue
      const st = await asyncStatOrNull(p)
      if (st) seen.set(p, st)
    }
    const known = this.store.listAll()
    const gone: string[] = []
    for (const path of known.keys()) if (!seen.has(path)) gone.push(path)
    for (let offset = 0; offset < gone.length; offset += 100) {
      if (this.stopped) return
      this.store.remove(gone.slice(offset, offset + 100))
      await yieldIfNeeded()
    }
    for (const f of seen.values()) {
      if (this.stopped) return
      const k = known.get(f.path)
      if (
        k &&
        k.status !== 'error' &&
        k.status !== 'pending' &&
        k.mtimeMs === f.mtimeMs &&
        k.sizeBytes === f.sizeBytes
      ) {
        continue
      }
      // Names and paths become searchable before any parser/model is started. Pending is
      // persisted so an interrupted first pass resumes its content work on the next scan.
      this.store.upsert(f, null, 'pending')
      this.enqueue(f)
      await yieldIfNeeded()
    }
    this.lastScanAt = Date.now()
  }

  private enqueue(f: ScannedFile): void {
    if (this.queued.has(f.path)) return
    this.queued.add(f.path)
    this.queue.push(f)
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.draining || this.scanning || this.stopped || isIndexingPaused()) return
    this.draining = true
    try {
      while (this.queue.length && !this.stopped && !isIndexingPaused()) {
        const f = this.queue.shift()!
        this.queued.delete(f.path)
        // the file may have changed again while queued; index what is on disk now
        const st = await asyncStatOrNull(f.path)
        if (!st) {
          this.store.remove([f.path])
          continue
        }
        const res = await this.ask({ id: 0, type: 'extract', path: st.path })
        if (res.type !== 'extract') continue
        this.apply(st, res.result)
      }
    } finally {
      this.draining = false
    }
  }

  private apply(f: ScannedFile, r: Extracted): void {
    try {
      if (r.kind === 'text') this.store.upsert(f, r.text, 'ok')
      else if (r.kind === 'name-only') this.store.upsert(f, null, 'name-only')
      else this.store.upsert(f, null, 'error')
    } catch {
      // a corrupt row must not stall the queue; the next scan retries it
    }
  }

  private ask(req: WorkerRequest): Promise<WorkerResponse> {
    const id = this.nextId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // a wedged worker never answers: fail this request the way a crashed
        // worker's requests fail, and retire the worker so later requests get a
        // fresh one instead of hanging too
        this.waiting.delete(id)
        this.recycleWorker()
        resolve({
          id,
          type: 'extract',
          result: { kind: 'error', error: 'worker request timed out' },
        })
      }, this.requestTimeoutMs)
      this.waiting.set(id, (r: WorkerResponse) => {
        clearTimeout(timer)
        resolve(r)
      })
      try {
        this.ensureWorker().postMessage({ ...req, id })
      } catch (e) {
        // a failed post must not reject into the void-ed callers: answer as an
        // extraction error, exactly like the drop handler does for a crash
        clearTimeout(timer)
        this.waiting.delete(id)
        resolve({
          id,
          type: 'extract',
          result: { kind: 'error', error: e instanceof Error ? e.message : String(e) },
        })
      }
    })
  }

  /** Retire the worker and settle its requests before a replacement can accept new ones. */
  private recycleWorker(): void {
    const w = this.worker
    if (!w) return
    this.worker = null
    this.failPending('worker restarted')
    void w.terminate()
  }

  private failPending(error: string): void {
    const waiting = [...this.waiting]
    this.waiting.clear()
    for (const [id, callback] of waiting)
      callback({ id, type: 'extract', result: { kind: 'error', error } })
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const w = new Worker(this.workerPath)
    w.on('message', (msg: WorkerResponse) => {
      if (this.worker !== w) return
      const cb = this.waiting.get(msg.id)
      if (!cb) return
      this.waiting.delete(msg.id)
      cb(msg)
    })
    const drop = () => {
      // a crashed worker fails its in-flight request as an extraction error so the queue moves on
      if (this.worker !== w) return
      this.worker = null
      this.failPending('worker exited')
    }
    w.on('error', drop)
    w.on('exit', drop)
    this.worker = w
    const policy = currentIndexingPolicy()
    if (policy) w.postMessage({ type: 'policy', threads: 1, cpuShare: policy.cpuShare })
    return w
  }

  stop(): void {
    this.stopped = true
    this.stopPolicyWatch()
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
    this.queue.length = 0
    this.queued.clear()
    this.failPending('indexer stopped')
    void this.worker?.terminate()
    this.worker = null
  }
}
