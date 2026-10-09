import { Worker } from 'node:worker_threads'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative } from 'node:path'
import { createYielder } from '../document-memory/yield-budget'
import {
  isIndexingPaused,
  subscribeIndexingPolicy,
  currentIndexingPolicy,
} from '../fork/indexing-policy-bus'
import type { Extracted } from './extract'
import type { WorkerRequest, WorkerResponse } from './extract-worker'
import type { WriterRequest } from './worker-ops'
import { isSupportedIndexFile } from './scan'
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
/** New names per write request to the worker: ~20 ms of insertion there, no message large enough to stall this thread. */
const PENDING_BATCH = 500
/**
 * a worker request left unanswered this long means a wedged parse or a stalled
 * walk: the request fails as an extraction error and the worker is recycled,
 * so one bad file cannot stall indexing (and search with it) for good
 */
const WORKER_REQUEST_TIMEOUT_MS = 120_000
/**
 * heap cap for the extraction worker: without resourceLimits a parse that
 * exhausts V8's heap is a process-wide fatal OOM and takes the whole app down
 * with it; with one, only the worker dies and the file is recorded as an error
 */
const WORKER_HEAP_LIMIT_MB = 1024

/** Slow disks and network paths must never hold Electron's UI thread in statSync. */
type FileStatResult = { kind: 'file'; file: ScannedFile } | { kind: 'missing' | 'unavailable' }

async function asyncFileStat(path: string): Promise<FileStatResult> {
  try {
    const file = await stat(path)
    return file.isFile()
      ? { kind: 'file', file: { path, mtimeMs: file.mtimeMs, sizeBytes: file.size } }
      : { kind: 'missing' }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { kind: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unavailable' }
  }
}

function isInside(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return (
    suffix === '' ||
    (!isAbsolute(suffix) &&
      suffix !== '..' &&
      !suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
  )
}

async function parentConfirmsMissing(path: string): Promise<boolean> {
  try {
    const names = await readdir(dirname(path), { withFileTypes: true })
    const name = basename(path)
    const entry = names.find((entry) =>
      process.platform === 'win32'
        ? entry.name.toLowerCase() === name.toLowerCase()
        : entry.name === name,
    )
    return !entry || !entry.isFile()
  } catch {
    return false
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
  /** slices of a scan arrive before its final answer (see `scan-part`) */
  private readonly partSinks = new Map<number, (files: ScannedFile[]) => void>()
  private readonly queue: ScannedFile[] = []
  private readonly queued = new Set<string>()
  private readonly preserveCachedBody = new Set<string>()
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
    private readonly workerHeapLimitMb = WORKER_HEAP_LIMIT_MB,
    /**
     * The database file the worker thread writes to. When set, every index write (names of new files, parsed text,
     * removals) happens in the worker and the main thread only reads; when unset the writes stay in-process
     * (tests, and callers whose worker cannot reach the database).
     */
    private readonly workerWritesDb?: string,
  ) {
    this.stopPolicyWatch = subscribeIndexingPolicy((policy) => {
      if (!policy.paused) void this.drain()
      if (this.worker)
        this.worker.postMessage({ type: 'policy', threads: 1, cpuShare: policy.cpuShare })
    })
  }

  progress(): IndexProgress {
    return {
      indexed: this.store.countCached(),
      pending: this.queue.length,
      scanning: this.scanning,
    }
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
      const roots = [...this.sources.roots()]
      const completeRoots: string[] = []
      for (const root of roots) {
        const res = await this.ask({ id: 0, type: 'scan', root }, (files) => {
          for (const f of files) seen.set(f.path, f)
        })
        // a crashed worker answers with an extract error; dropping the index on that would empty search
        if (res.type === 'scan') {
          for (const f of res.files) seen.set(f.path, f)
          if (res.complete === true && !res.truncated) completeRoots.push(root)
        }
      }
      await this.diff(seen, roots, completeRoots)
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
  private async diff(
    seen: Map<string, ScannedFile>,
    roots: string[],
    completeRoots: string[],
  ): Promise<void> {
    const yieldIfNeeded = createYielder()
    const extras = new Set(this.sources.extraPaths())
    for (const p of extras) {
      if (this.stopped) return
      if (seen.has(p) || !isSupportedIndexFile(p)) continue
      const st = await asyncFileStat(p)
      if (st.kind === 'file') seen.set(p, st.file)
    }
    const known = await this.store.listAllSliced(yieldIfNeeded)
    const gone: string[] = []
    const reachableRoots = new Map<string, boolean>()
    for (const path of known.keys()) {
      // every iteration may yield (an unchanged path is a `continue`, and a million of those are one long task otherwise)
      await yieldIfNeeded()
      if (seen.has(path)) continue
      // An offline root or a partial walk says nothing about the files omitted from it.
      const configuredRoot = roots
        .filter((root) => isInside(root, path))
        .sort((a, b) => b.length - a.length)[0]
      if (configuredRoot && !completeRoots.includes(configuredRoot)) continue
      const state = await asyncFileStat(path)
      if (state.kind !== 'missing') continue
      if (await parentConfirmsMissing(path)) gone.push(path)
      else if (configuredRoot && completeRoots.includes(configuredRoot)) {
        // Whole subfolders can really be deleted, but the mount root must still be reachable.
        const root = configuredRoot
        if (!reachableRoots.has(root)) {
          try {
            await readdir(root)
            reachableRoots.set(root, true)
          } catch {
            reachableRoots.set(root, false)
          }
        }
        if (reachableRoots.get(root)) gone.push(path)
      }
    }
    for (let offset = 0; offset < gone.length; offset += 100) {
      if (this.stopped) return
      const batch = gone.slice(offset, offset + 100)
      await this.removeRows(batch)
      for (const path of batch) this.preserveCachedBody.delete(path)
      await yieldIfNeeded()
    }
    const fresh: ScannedFile[] = []
    const flushFresh = async (): Promise<void> => {
      if (fresh.length === 0) return
      const batch = fresh.splice(0, fresh.length)
      await this.writePending(batch)
      for (const f of batch) this.enqueue(f)
    }
    for (const f of seen.values()) {
      if (this.stopped) return
      await yieldIfNeeded()
      const k = known.get(f.path)
      // An unchanged file that already failed is not retried: a parse that kills the
      // worker would otherwise be re-run on every scan. Pending rows always resume.
      if (k && k.status !== 'pending' && k.mtimeMs === f.mtimeMs && k.sizeBytes === f.sizeBytes) {
        continue
      }
      // Names and paths become searchable before any parser/model is started. Pending is
      // persisted so an interrupted first pass resumes its content work on the next scan.
      // A refresh must not erase the last searchable body before parsing succeeds. Keeping
      // the old metadata also ensures an interrupted refresh is retried after reconnecting.
      if (k?.status === 'ok') this.preserveCachedBody.add(f.path)
      if (this.workerWritesDb) {
        // new names are written in batches by the worker; files already in the index are queued as they are
        if (!k) {
          fresh.push(f)
          if (fresh.length >= PENDING_BATCH) await flushFresh()
        } else this.enqueue(f)
      } else {
        if (!k) this.store.upsert(f, null, 'pending')
        this.enqueue(f)
      }
    }
    await flushFresh()
    this.lastScanAt = Date.now()
  }

  private async removeRows(paths: string[]): Promise<void> {
    if (this.workerWritesDb) await this.ask({ id: 0, type: 'remove', paths })
    else this.store.remove(paths)
  }

  private async writePending(files: ScannedFile[]): Promise<void> {
    if (this.workerWritesDb) await this.ask({ id: 0, type: 'pending', files })
    else for (const f of files) this.store.upsert(f, null, 'pending')
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
        const state = await asyncFileStat(f.path)
        if (state.kind !== 'file') {
          if (state.kind === 'missing' && (await parentConfirmsMissing(f.path))) {
            this.store.remove([f.path])
            this.preserveCachedBody.delete(f.path)
          }
          continue
        }
        const st = state.file
        if (this.workerWritesDb) {
          await this.indexInWorker(st)
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

  /** Parse and write in the worker; the main thread hears only the outcome. A timeout or crash is recorded like any failed parse. */
  private async indexInWorker(f: ScannedFile): Promise<void> {
    const preserve = this.preserveCachedBody.has(f.path)
    const res = await this.ask({ id: 0, type: 'index', file: f, preserve })
    if (res.type === 'written' && res.status !== undefined) {
      if (res.status !== 'error') this.preserveCachedBody.delete(f.path)
      return
    }
    const error =
      res.type === 'extract' && res.result.kind === 'error'
        ? res.result.error
        : 'index write failed'
    await this.ask({ id: 0, type: 'index-error', file: f, preserve, error })
  }

  private apply(f: ScannedFile, r: Extracted): void {
    try {
      if (r.kind === 'text') {
        this.store.upsert(f, r.text, 'ok')
        this.preserveCachedBody.delete(f.path)
      } else if (r.kind === 'name-only') {
        this.store.upsert(f, null, 'name-only')
        this.preserveCachedBody.delete(f.path)
      } else if (!this.preserveCachedBody.has(f.path)) this.store.upsert(f, null, 'error')
    } catch {
      // a corrupt row must not stall the queue; the next scan retries it
    }
  }

  private ask(
    req: WorkerRequest | WriterRequest,
    onPart?: (files: ScannedFile[]) => void,
  ): Promise<WorkerResponse> {
    const id = this.nextId++
    if (onPart) this.partSinks.set(id, onPart)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // a wedged worker never answers: fail this request the way a crashed
        // worker's requests fail, and retire the worker so later requests get a
        // fresh one instead of hanging too
        this.waiting.delete(id)
        this.partSinks.delete(id)
        this.recycleWorker()
        resolve({
          id,
          type: 'extract',
          result: { kind: 'error', error: 'worker request timed out' },
        })
      }, this.requestTimeoutMs)
      this.waiting.set(id, (r: WorkerResponse) => {
        clearTimeout(timer)
        this.partSinks.delete(id)
        resolve(r)
      })
      try {
        this.ensureWorker().postMessage({ ...req, id })
      } catch (e) {
        // a failed post must not reject into the void-ed callers: answer as an
        // extraction error, exactly like the drop handler does for a crash
        clearTimeout(timer)
        this.waiting.delete(id)
        this.partSinks.delete(id)
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
    this.partSinks.clear()
    for (const [id, callback] of waiting)
      callback({ id, type: 'extract', result: { kind: 'error', error } })
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const w = new Worker(this.workerPath, {
      resourceLimits: { maxOldGenerationSizeMb: this.workerHeapLimitMb },
      ...(this.workerWritesDb ? { workerData: { dbPath: this.workerWritesDb } } : {}),
    })
    w.on('message', (msg: WorkerResponse) => {
      if (this.worker !== w) return
      if (msg.type === 'scan-part') {
        this.partSinks.get(msg.id)?.(msg.files)
        return
      }
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
