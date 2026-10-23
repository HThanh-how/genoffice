import { traceOp } from '../trace-op'
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
import {
  isPathIgnored,
  beginIgnoreRootSnapshot,
  markIgnoreRootUnreachable,
  getIgnorePolicyGeneration,
  getIgnorePolicySnapshot,
  subscribeIgnorePolicyChanges,
  type IgnorePolicySnapshot,
} from '../document-memory/ignore-policy'
import { isIgnorePolicyAckMessage, type IgnorePolicyAckResponse } from './worker-ignore-policy'

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
/** a root that does not answer a stat within this is treated as offline for the scan */
const ROOT_PROBE_TIMEOUT_MS = 3000
/** work done per turn while absorbing a worker's scan slices on the main thread */
const SCAN_PART_SLICE_MS = 8

/** Reachability check that cannot hang the caller: a stalled mount only ties up a pool thread. */
async function probeRoot(root: string, timeoutMs = ROOT_PROBE_TIMEOUT_MS): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      stat(root).then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
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
 * with it; with one, only the worker dies and the file is recorded as an error.
 * 256 MB fits the heaviest extraction measured (a 40 MB, 7.6 M-cell xlsx) and
 * keeps V8 collecting instead of letting a scan's garbage pile up to a gigabyte
 */
const WORKER_HEAP_LIMIT_MB = 256
/**
 * The worker is a thread of the main process, so its heap shows up as the
 * app's memory. Once a scan and its extractions are done nothing is lost by
 * retiring it: the next refresh spawns a fresh one in milliseconds, while an
 * idle worker would have held the scan's heap until V8 got around to shrinking it
 */
const WORKER_IDLE_MS = 5_000

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
  if (root.includes('..') || path.includes('..')) {
    const suffix = relative(root, path)
    return (
      suffix === '' ||
      (!isAbsolute(suffix) &&
        suffix !== '..' &&
        !suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
    )
  }

  if (process.platform === 'win32') {
    const r = root.replace(/\//g, '\\').toLowerCase()
    const p = path.replace(/\//g, '\\').toLowerCase()
    if (p === r) return true
    const sep = r.endsWith('\\') ? '' : '\\'
    return p.startsWith(r + sep)
  } else {
    if (path === root) return true
    const sep = root.endsWith('/') ? '' : '/'
    return path.startsWith(root + sep)
  }
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
  private drainTask: Promise<void> | null = null
  private scanning = false
  private scanRequested = false
  private rescanTimer: NodeJS.Timeout | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private lastScanAt = 0
  private stopped = false
  private workerPolicyVersion = 0
  private workerSupportsIgnorePolicyMsg = false
  private policySyncFailures = 0
  private readonly stopPolicyWatch: () => void
  private readonly stopIgnorePolicyWatch: () => void

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
    private readonly workerIdleMs = WORKER_IDLE_MS,
  ) {
    this.stopPolicyWatch = subscribeIndexingPolicy((policy) => {
      if (!policy.paused) void this.drain()
      if (this.worker)
        this.worker.postMessage({ type: 'policy', threads: 1, cpuShare: policy.cpuShare })
    })
    this.stopIgnorePolicyWatch = subscribeIgnorePolicyChanges(() => {
      if (this.stopped) return
      for (let i = this.queue.length - 1; i >= 0; i--) {
        const f = this.queue[i]!
        if (isPathIgnored(f.path)) {
          this.queue.splice(i, 1)
          this.queued.delete(f.path)
          this.preserveCachedBody.delete(f.path)
        }
      }
      if (this.worker && this.workerSupportsIgnorePolicyMsg) {
        try {
          this.worker.postMessage({
            id: this.nextId++,
            type: 'ignore-policy',
            snapshot: getIgnorePolicySnapshot(this.sources.roots()),
          })
        } catch {
          // ignore post errors on a closing worker
        }
      }
    })
  }

  /** Explicitly synchronize the active Ignore policy snapshot with the worker thread and await acknowledgement. */
  async syncWorkerIgnorePolicy(
    snapshot: IgnorePolicySnapshot = getIgnorePolicySnapshot(this.sources.roots()),
  ): Promise<IgnorePolicyAckResponse> {
    const res = await this.ask({ id: 0, type: 'ignore-policy', snapshot })
    if (isIgnorePolicyAckMessage(res)) {
      if (
        !res.applied &&
        res.status !== 'rejected-invalid' &&
        snapshot.version >= getIgnorePolicyGeneration()
      ) {
        this.recycleWorker()
        const retryRes = await this.ask({ id: 0, type: 'ignore-policy', snapshot })
        if (isIgnorePolicyAckMessage(retryRes)) {
          return retryRes
        }
      }
      return res
    }
    return {
      type: 'ignore-policy-ack',
      version: this.workerPolicyVersion,
      applied: false,
      status: 'rejected-invalid',
    }
  }

  /** whether an extraction worker is currently alive (test seam) */
  workerIsRunning(): boolean {
    return this.worker !== null
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
    if (this.stopped) return
    // a running scan stamps lastScanAt only when it ends; asking again would just queue a redundant pass
    if (this.scanning) return
    if (Date.now() - this.lastScanAt >= maxAgeMs) void this.scan()
  }

  scan(): Promise<void> {
    return traceOp('file-index.scan', () => this.scanTraced(), {
      kind: 'indexer',
      source: 'automatic',
    })
  }

  private async scanTraced(): Promise<void> {
    if (this.stopped) return
    if (this.scanning) {
      this.scanRequested = true
      return
    }
    this.scanning = true
    const endRootSnapshot = beginIgnoreRootSnapshot()
    try {
      const startPolicyGen = getIgnorePolicyGeneration()
      if (
        this.worker &&
        this.workerSupportsIgnorePolicyMsg &&
        this.workerPolicyVersion < startPolicyGen
      ) {
        await this.syncWorkerIgnorePolicy(getIgnorePolicySnapshot(this.sources.roots()))
      }
      if (this.drainTask) {
        await this.drainTask
      }
      if (this.stopped) return
      const seen = new Map<string, ScannedFile>()
      const roots = [...this.sources.roots()]
      const completeRoots: string[] = []
      for (const root of roots) {
        if (this.stopped) return
        if (!(await probeRoot(root))) {
          // offline: nothing to walk, and no sync disk check may run against it on the main thread
          markIgnoreRootUnreachable(root)
          continue
        }
        const rootStartGen = getIgnorePolicyGeneration()
        // slices are absorbed one after another in arrival order, each in ~8ms turns
        const yieldIfNeeded = createYielder(SCAN_PART_SLICE_MS)
        const absorb = async (files: readonly ScannedFile[]): Promise<void> => {
          for (const f of files) {
            if (this.stopped) return
            if (!isPathIgnored(f.path, root)) seen.set(f.path, f)
            await yieldIfNeeded()
          }
        }
        let partChain: Promise<void> = Promise.resolve()
        const res = await this.ask({ id: 0, type: 'scan', root }, (files) => {
          partChain = partChain.then(() =>
            traceOp('file-index.scan-part', () => absorb(files), {
              kind: 'indexer',
              source: 'automatic',
            }),
          )
        })
        await partChain
        if (res.type === 'scan') await absorb(res.files)
        if (this.stopped) return
        const afterRootGen = getIgnorePolicyGeneration()
        if (afterRootGen !== rootStartGen || afterRootGen !== startPolicyGen) {
          this.scanRequested = true
        }
        // a crashed worker answers with an extract error; dropping the index on that would empty search
        if (res.type === 'scan') {
          if (
            res.complete === true &&
            !res.truncated &&
            afterRootGen === rootStartGen &&
            afterRootGen === startPolicyGen
          ) {
            completeRoots.push(root)
          }
        }
      }
      if (getIgnorePolicyGeneration() !== startPolicyGen) {
        this.scanRequested = true
      }
      await this.diff(seen, roots, completeRoots)
      if (getIgnorePolicyGeneration() !== startPolicyGen) {
        this.scanRequested = true
      }
    } finally {
      endRootSnapshot()
      this.scanning = false
      this.scheduleIdleRecycle()
      if (!this.stopped) void this.drain()
    }
    // a refresh that arrived mid-scan runs now, whether or not the walk succeeded
    if (!this.stopped && this.scanRequested) {
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
      if (seen.has(p) || !isSupportedIndexFile(p) || isPathIgnored(p)) continue
      const st = await asyncFileStat(p)
      if (st.kind === 'file' && !isPathIgnored(p)) seen.set(p, st.file)
    }
    const known = await this.store.listAllSliced(yieldIfNeeded)
    const gone: string[] = []
    const reachableRoots = new Map<string, boolean>()
    const sortedRoots = [...roots].sort((a, b) => b.length - a.length)
    for (const path of known.keys()) {
      // every iteration may yield (an unchanged path is a `continue`, and a million of those are one long task otherwise)
      await yieldIfNeeded()
      if (isPathIgnored(path)) {
        gone.push(path)
        continue
      }
      if (seen.has(path)) continue
      // An offline root or a partial walk says nothing about the files omitted from it.
      const configuredRoot = sortedRoots.find((root) => isInside(root, path))
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
      const allowed = await this.writePending(batch)
      for (const f of allowed) this.enqueue(f)
    }
    for (const f of seen.values()) {
      if (this.stopped) return
      await yieldIfNeeded()
      const k = known.get(f.path)
      if (isPathIgnored(f.path)) {
        if (k) await this.removeRows([f.path])
        this.preserveCachedBody.delete(f.path)
        continue
      }
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
      // Batch new names in both write modes; one transaction per file stalls slow disks.
      if (!k) {
        fresh.push(f)
        if (fresh.length >= PENDING_BATCH) await flushFresh()
      } else this.enqueue(f)
    }
    await flushFresh()
    this.lastScanAt = Date.now()
  }

  private async removeRows(paths: string[]): Promise<void> {
    if (this.workerWritesDb) await this.ask({ id: 0, type: 'remove', paths })
    else this.store.remove(paths)
  }

  private async writePending(files: ScannedFile[]): Promise<ScannedFile[]> {
    const allowed: ScannedFile[] = []
    const blocked: string[] = []
    for (const f of files) {
      if (isPathIgnored(f.path)) {
        blocked.push(f.path)
        this.preserveCachedBody.delete(f.path)
      } else {
        allowed.push(f)
      }
    }
    if (blocked.length > 0) {
      await this.removeRows(blocked)
    }
    if (allowed.length === 0) return []
    if (this.workerWritesDb) {
      await this.ask({ id: 0, type: 'pending', files: allowed })
      const stillBlocked = allowed.filter((f) => isPathIgnored(f.path)).map((f) => f.path)
      if (stillBlocked.length > 0) {
        await this.removeRows(stillBlocked)
        for (const p of stillBlocked) this.preserveCachedBody.delete(p)
        return allowed.filter((f) => !isPathIgnored(f.path))
      }
    } else {
      const current = allowed.filter((f) => !isPathIgnored(f.path))
      this.store.upsertPendingBatch(current)
      return current
    }
    return allowed
  }

  private enqueue(f: ScannedFile): void {
    if (isPathIgnored(f.path) || this.queued.has(f.path)) return
    this.queued.add(f.path)
    this.queue.push(f)
    void this.drain()
  }

  private drain(): Promise<void> {
    if (this.draining || this.scanning || this.stopped || isIndexingPaused()) {
      return this.drainTask ?? Promise.resolve()
    }
    this.draining = true
    const task = this.runDrainLoop().finally(() => {
      this.draining = false
      if (this.drainTask === task) this.drainTask = null
      this.scheduleIdleRecycle()
    })
    this.drainTask = task
    return task
  }

  private async runDrainLoop(): Promise<void> {
    while (this.queue.length && !this.stopped && !this.scanning && !isIndexingPaused()) {
      const f = this.queue.shift()!
      this.queued.delete(f.path)
      if (isPathIgnored(f.path)) {
        await this.removeRows([f.path])
        this.preserveCachedBody.delete(f.path)
        continue
      }
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
      const startPolicyGen = getIgnorePolicyGeneration()
      if (this.workerWritesDb) {
        await this.indexInWorker(st)
        continue
      }
      const res = await this.ask({ id: 0, type: 'extract', path: st.path })
      if (this.stopped || res.type !== 'extract') continue
      if (
        isPathIgnored(st.path) ||
        (getIgnorePolicyGeneration() !== startPolicyGen && isPathIgnored(st.path))
      ) {
        await this.removeRows([st.path])
        this.preserveCachedBody.delete(st.path)
        continue
      }
      this.apply(st, res.result)
    }
  }

  /** Parse and write in the worker; the main thread hears only the outcome. A timeout or crash is recorded like any failed parse. */
  private indexInWorker(f: ScannedFile): Promise<void> {
    return traceOp('file-index.extract-turn', () => this.indexInWorkerTraced(f), {
      kind: 'indexer',
      source: 'automatic',
    })
  }

  private async indexInWorkerTraced(f: ScannedFile): Promise<void> {
    if (this.stopped) return
    if (isPathIgnored(f.path)) {
      await this.removeRows([f.path])
      this.preserveCachedBody.delete(f.path)
      return
    }
    const startPolicyGen = getIgnorePolicyGeneration()
    const preserve = this.preserveCachedBody.has(f.path)
    const res = await this.ask({ id: 0, type: 'index', file: f, preserve })
    if (this.stopped) return
    if (
      isPathIgnored(f.path) ||
      (getIgnorePolicyGeneration() !== startPolicyGen && isPathIgnored(f.path))
    ) {
      await this.removeRows([f.path])
      this.preserveCachedBody.delete(f.path)
      return
    }
    if (res.type === 'written' && res.status !== undefined) {
      if (res.status !== 'error') this.preserveCachedBody.delete(f.path)
      return
    }
    const error =
      res.type === 'extract' && res.result.kind === 'error'
        ? res.result.error
        : 'index write failed'
    await this.ask({ id: 0, type: 'index-error', file: f, preserve, error })
    if (this.stopped) return
    if (isPathIgnored(f.path)) {
      await this.removeRows([f.path])
      this.preserveCachedBody.delete(f.path)
    }
  }

  private scheduleIdleRecycle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.scanning || this.draining || this.queue.length > 0 || this.waiting.size > 0) return
      this.recycleWorker()
    }, this.workerIdleMs)
    this.idleTimer.unref?.()
  }

  private apply(f: ScannedFile, r: Extracted): void {
    if (isPathIgnored(f.path)) {
      this.store.remove([f.path])
      this.preserveCachedBody.delete(f.path)
      return
    }
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
    if (this.stopped) {
      return Promise.resolve({
        id: this.nextId++,
        type: 'extract',
        result: { kind: 'error', error: 'indexer stopped' },
      })
    }
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
        const payload =
          req.type === 'ignore-policy'
            ? { ...req, id }
            : { ...req, ignorePolicy: getIgnorePolicySnapshot(this.sources.roots()), id }
        this.ensureWorker().postMessage(payload)
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
    this.workerPolicyVersion = 0
    this.workerSupportsIgnorePolicyMsg = false
    this.policySyncFailures = 0
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
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (this.worker) return this.worker
    this.workerPolicyVersion = 0
    this.workerSupportsIgnorePolicyMsg = false
    this.policySyncFailures = 0
    const w = new Worker(this.workerPath, {
      resourceLimits: { maxOldGenerationSizeMb: this.workerHeapLimitMb },
      workerData: {
        ...(this.workerWritesDb ? { dbPath: this.workerWritesDb } : {}),
        ignorePolicy: getIgnorePolicySnapshot(this.sources.roots()),
      },
    })
    w.on('message', (msg: WorkerResponse) => {
      if (this.worker !== w) return
      if (isIgnorePolicyAckMessage(msg)) {
        this.workerSupportsIgnorePolicyMsg = true
        if (msg.applied) {
          this.policySyncFailures = 0
          if (msg.version > this.workerPolicyVersion) {
            this.workerPolicyVersion = msg.version
          }
        } else {
          this.policySyncFailures++
        }
        if (msg.id !== undefined) {
          const cb = this.waiting.get(msg.id)
          if (cb) {
            this.waiting.delete(msg.id)
            cb(msg)
            return
          }
        }
        if (!msg.applied || this.workerPolicyVersion < getIgnorePolicyGeneration()) {
          if (this.policySyncFailures <= 1) {
            try {
              w.postMessage({
                id: this.nextId++,
                type: 'ignore-policy',
                snapshot: getIgnorePolicySnapshot(this.sources.roots()),
              } satisfies WorkerRequest)
            } catch {
              // Worker will resync on next request
            }
          } else {
            this.policySyncFailures = 0
            this.recycleWorker()
          }
        }
        return
      }
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
      this.workerPolicyVersion = 0
      this.workerSupportsIgnorePolicyMsg = false
      this.policySyncFailures = 0
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
    this.stopIgnorePolicyWatch()
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.queue.length = 0
    this.queued.clear()
    this.failPending('indexer stopped')
    void this.worker?.terminate()
    this.worker = null
  }
}
