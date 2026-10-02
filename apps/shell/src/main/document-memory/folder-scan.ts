import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { opendir, stat } from 'node:fs/promises'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, parse, resolve } from 'node:path'
import { FolderWatchManager } from './folder-watch'

export const MAX_DOCUMENT_BYTES = 128 * 1024 * 1024
const MAX_ROOT_LENGTH = 32_768
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
/** Progress counters are persisted at most this often while a scan runs (state changes save at once). */
const MANIFEST_SAVE_INTERVAL_MS = 2_000
export const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.cache',
  '.next',
  '.turbo',
  '.venv',
  'node_modules',
  'build',
  'coverage',
  'dist',
  'venv',
])
export const SUPPORTED_EXTENSIONS = new Set([
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.xlsm',
  '.csv',
  '.tsv',
  '.ppt',
  '.pptx',
  '.pdf',
  '.md',
  '.markdown',
  '.html',
  '.htm',
  '.txt',
])

/** Office/editor lock files and partial downloads never hold indexable content. */
const TEMPORARY_FILE = /\.(tmp|temp|crdownload|partial|part|lock|lck|swp|bak)$/i

/** Hidden files plus lock/temp artifacts (`~$doc.docx`, `x.crdownload`, `.~lock.x#`). */
export function isIgnoredFileName(name: string): boolean {
  return name.startsWith('.') || name.startsWith('~$') || TEMPORARY_FILE.test(name)
}

/** Whether a path below a scanned root is one the scanner would index. */
export function isIndexablePath(root: string, path: string): boolean {
  const relative = path
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean)
  const name = relative.pop()
  if (!name || isIgnoredFileName(name)) return false
  if (relative.some(shouldSkipDirectory)) return false
  return SUPPORTED_EXTENSIONS.has(extname(name).toLowerCase())
}

export interface FolderScanStatus {
  state?: 'running' | 'complete' | 'stopped'
  running: boolean
  root?: string
  startedAt?: number
  discovered: number
  enrolled: number
  skipped: number
  errors: number
  lastError?: string
  reconciledAt?: number
}

export interface DiscoveredDocumentIndexer {
  indexDiscoveredFile(path: string, metadata?: { mtimeMs: number; sizeBytes: number }): boolean
  /** Reconcile a root against a fresh metadata-only listing (adds, changes, moves, deletions). */
  reconcileFolder?(
    root: string,
    files: Map<string, { mtimeMs: number; sizeBytes: number }>,
  ): Promise<unknown>
  /** Put the waiting files below `root` first in the indexing order. */
  prioritizeFolder?(root: string): number
  /** Subscribe to the index being cleared; returns an unsubscribe function. */
  onCleared?(listener: () => void): () => void
  /** Live watching is started when the indexer also provides these three hooks. */
  isEnabled?(): boolean
  onEnabledChange?(listener: () => void): () => void
  handleFileEvents?(paths: string[]): Promise<void>
}

interface TraverseHandlers {
  onSkipped(): void
  onError(error: unknown): void
  /** Return false to stop the traversal. */
  onFile(path: string): Promise<boolean>
  afterDirectory?(): void
}

interface ScanJob {
  root: string
  startedAt?: number
  state: 'running' | 'complete' | 'stopped'
  discovered: number
  enrolled: number
  skipped: number
  errors: number
  lastError?: string
  /** Epoch ms of the last completed metadata-only reconcile pass. */
  reconciledAt?: number
  /** Epoch ms the last full scan finished. */
  completedAt?: number
  /** Index this folder's waiting files before other folders'. */
  priority?: boolean
  /** The most recent scans and refreshes, newest first. */
  history?: ScanRun[]
}

export interface ScanRun {
  kind: 'scan' | 'refresh'
  state: 'complete' | 'stopped' | 'unavailable'
  startedAt: number
  endedAt: number
  discovered: number
  enrolled: number
  skipped: number
  errors: number
}

/** One folder as the settings list shows it. */
export interface FolderSummary {
  root: string
  state: 'running' | 'complete' | 'stopped'
  priority: boolean
  startedAt?: number
  completedAt?: number
  reconciledAt?: number
  discovered: number
  enrolled: number
  skipped: number
  errors: number
  lastError?: string
  history: ScanRun[]
}

const MAX_RUN_HISTORY = 12

interface Manifest {
  version: 1
  jobs: ScanJob[]
}

/** Recursively enroll supported documents found under explicitly selected folders. */
export class FolderScanManager {
  private readonly manifestPath: string
  private readonly memory: DiscoveredDocumentIndexer
  private manifest: Manifest
  private activeRoot: string | null = null
  private stopRequested = false
  private closed = false
  private runner: Promise<void> | null = null
  private reconciling = false
  private watcher: FolderWatchManager | null = null
  private readonly rootListeners = new Set<() => void>()
  private saveTimer: NodeJS.Timeout | null = null
  private saveDirty = false

  constructor(userData: string, memory: DiscoveredDocumentIndexer) {
    mkdirSync(userData, { recursive: true })
    this.manifestPath = resolve(userData, 'document-memory-folders.json')
    this.memory = memory
    this.manifest = readManifest(this.manifestPath)
    memory.onCleared?.(() => this.unregisterAll())
    const interrupted = this.manifest.jobs.find((job) => job.state === 'running')
    if (interrupted) {
      // Traversal restarts at the selected root. Reset traversal counters so they
      // describe this resumed pass instead of counting the same files twice.
      interrupted.discovered = 0
      interrupted.enrolled = 0
      interrupted.skipped = 0
      interrupted.errors = 0
      delete interrupted.lastError
      this.save()
      queueMicrotask(() => this.resume(interrupted.root))
    }
    const { isEnabled, onEnabledChange, handleFileEvents } = memory
    // Live change detection (watcher + periodic reconcile) is owned by the scanner so the
    // app shell needs no extra wiring; it closes with the scanner.
    if (isEnabled && onEnabledChange && handleFileEvents)
      this.watcher = new FolderWatchManager(this, {
        isEnabled: () => isEnabled.call(memory),
        onEnabledChange: (listener) => onEnabledChange.call(memory, listener),
        handleFileEvents: (paths) => handleFileEvents.call(memory, paths),
      })
  }

  /** Roots that should be live-watched: scans that are running or finished (not stopped). */
  watchedRoots(): string[] {
    return this.manifest.jobs
      .filter((job) => job.state === 'running' || job.state === 'complete')
      .map((job) => job.root)
  }

  /** Subscribe to changes of {@link watchedRoots}; returns an unsubscribe function. */
  onRootsChanged(listener: () => void): () => void {
    this.rootListeners.add(listener)
    return () => this.rootListeners.delete(listener)
  }

  /**
   * Cheap metadata-only re-walk of a finished root to catch events the watcher missed. It never
   * reads or hashes file contents and leaves the job's discovery counters untouched, so the UI
   * does not look like the index restarted from zero.
   */
  async reconcile(root: string): Promise<{ ok: boolean; reason?: string; files?: number }> {
    const normalized = resolve(root)
    if (this.closed || this.activeRoot || this.reconciling) return { ok: false, reason: 'busy' }
    const job = this.jobFor(normalized)
    if (!job || job.state !== 'complete') return { ok: false, reason: 'not-complete' }
    if (!this.memory.reconcileFolder) return { ok: false, reason: 'unsupported' }
    this.reconciling = true
    try {
      try {
        if (!(await stat(job.root)).isDirectory()) return { ok: false, reason: 'unavailable' }
      } catch {
        // An unplugged drive or deleted root: never treat its files as deleted.
        return { ok: false, reason: 'unavailable' }
      }
      const files = new Map<string, { mtimeMs: number; sizeBytes: number }>()
      const completed = await this.traverse(
        job.root,
        {
          onSkipped: () => undefined,
          onError: () => undefined,
          onFile: async (path) => {
            try {
              const fileStat = await stat(path)
              if (fileStat.isFile() && fileStat.size <= MAX_DOCUMENT_BYTES)
                files.set(path, { mtimeMs: fileStat.mtimeMs, sizeBytes: fileStat.size })
            } catch {
              // Vanished mid-walk; the next pass sees it.
            }
            return true
          },
        },
        () => this.closed,
      )
      if (!completed) return { ok: false, reason: 'interrupted' }
      await this.memory.reconcileFolder(job.root, files)
      job.reconciledAt = Date.now()
      this.recordRun(job, 'refresh', 'complete', { discovered: files.size })
      if (job.priority) this.memory.prioritizeFolder?.(job.root)
      this.save()
      return { ok: true, files: files.size }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'failed' }
    } finally {
      this.reconciling = false
    }
  }

  /** Start or resume scanning one selected folder. */
  start(root: string): FolderScanStatus {
    const normalizedRoot = validateRoot(root)
    if (this.closed) throw new Error('Folder scanner is closed')
    if (this.activeRoot) {
      if (this.activeRoot === normalizedRoot) return this.status()
      throw new Error('A folder scan is already running')
    }

    let job = this.manifest.jobs.find((entry) => entry.root === normalizedRoot)
    if (!job) {
      job = {
        root: normalizedRoot,
        startedAt: Date.now(),
        state: 'running',
        discovered: 0,
        enrolled: 0,
        skipped: 0,
        errors: 0,
      }
      this.manifest.jobs.push(job)
    } else if (job.state !== 'running') {
      job.state = 'running'
      job.startedAt = Date.now()
      job.discovered = 0
      job.enrolled = 0
      job.skipped = 0
      job.errors = 0
      delete job.lastError
    }
    this.save()
    this.run(job)
    this.emitRootsChanged()
    return this.status()
  }

  /** Alias used by callers that phrase the action as a scan. */
  scan(root: string): FolderScanStatus {
    return this.start(root)
  }

  stop(): FolderScanStatus {
    this.stopRequested = true
    if (this.activeRoot) {
      const job = this.jobFor(this.activeRoot)
      if (job?.state === 'running') {
        job.state = 'stopped'
        this.save()
        this.emitRootsChanged()
      }
    }
    return this.status()
  }

  /** The index was cleared: forget every folder so nothing re-imports it. */
  private unregisterAll(): void {
    this.stopRequested = true
    this.manifest.jobs = []
    this.save()
    this.emitRootsChanged()
  }

  private emitRootsChanged(): void {
    for (const listener of this.rootListeners) {
      try {
        listener()
      } catch {
        // A faulty listener must not break scanning.
      }
    }
  }

  status(): FolderScanStatus {
    const job = this.activeRoot
      ? this.jobFor(this.activeRoot)
      : this.manifest.jobs[this.manifest.jobs.length - 1]
    return {
      state: job?.state,
      running: !!this.activeRoot,
      ...(job ? { root: job.root } : {}),
      ...(job?.startedAt === undefined ? {} : { startedAt: job.startedAt }),
      discovered: job?.discovered ?? 0,
      enrolled: job?.enrolled ?? 0,
      skipped: job?.skipped ?? 0,
      errors: job?.errors ?? 0,
      ...(job?.lastError ? { lastError: job.lastError } : {}),
      ...(job?.reconciledAt ? { reconciledAt: job.reconciledAt } : {}),
    }
  }

  close(): void {
    this.closed = true
    this.stopRequested = true
    if (this.saveDirty) this.save()
    this.watcher?.close()
    this.watcher = null
    this.rootListeners.clear()
  }

  private resume(root: string): void {
    if (this.closed || this.activeRoot) return
    const job = this.jobFor(root)
    if (job?.state !== 'running') return
    try {
      job.root = validateRoot(root)
      this.run(job)
    } catch (error) {
      job.state = 'stopped'
      job.errors++
      job.lastError = error instanceof Error ? error.message : 'The selected folder is unavailable.'
      this.save()
    }
  }

  private run(job: ScanJob): void {
    this.activeRoot = job.root
    this.stopRequested = false
    this.runner = this.walk(job)
      .catch((error: unknown) => {
        job.state = 'stopped'
        job.errors++
        job.lastError = error instanceof Error ? error.message : 'Folder scan failed.'
      })
      .finally(() => {
        this.activeRoot = null
        this.runner = null
        if (job.state === 'complete') job.completedAt = Date.now()
        if (job.state !== 'running') this.recordRun(job, 'scan', job.state)
        if (job.state === 'complete' && job.priority) this.memory.prioritizeFolder?.(job.root)
        this.save()
      })
  }

  private async walk(job: ScanJob): Promise<void> {
    const completed = await this.traverse(
      job.root,
      {
        onSkipped: () => {
          job.skipped++
        },
        onError: (error) => this.recordError(job, error),
        onFile: async (path) => {
          job.discovered++
          try {
            const fileStat = await stat(path)
            if (this.closed || this.stopRequested) return false
            if (!fileStat.isFile()) {
              job.skipped++
            } else if (fileStat.size > MAX_DOCUMENT_BYTES) {
              job.skipped++
            } else if (
              this.memory.indexDiscoveredFile(path, {
                mtimeMs: fileStat.mtimeMs,
                sizeBytes: fileStat.size,
              })
            ) {
              job.enrolled++
            }
          } catch (error) {
            this.recordError(job, error)
          }
          return true
        },
        // Counters are saved after each directory, throttled: a synchronous write + rename per
        // directory used to run thousands of times on Electron's main thread. A restart replays
        // at most a couple of seconds of traversal; enrollment itself is idempotent in SQLite.
        afterDirectory: () => this.saveSoon(),
      },
      () => this.closed || this.stopRequested,
    )
    if (completed) {
      job.state = 'complete'
      this.save()
      this.emitRootsChanged()
    }
  }

  /** Walk supported files below `root`; resolves true when the whole tree was visited. */
  private async traverse(
    root: string,
    handlers: TraverseHandlers,
    shouldStop: () => boolean,
  ): Promise<boolean> {
    const pending = [root]
    const visitedDirectories = new Set<string>()
    while (pending.length && !shouldStop()) {
      const directory = pending.pop()!
      const canonical = resolve(directory)
      if (visitedDirectories.has(canonical)) continue
      visitedDirectories.add(canonical)
      let handle
      try {
        handle = await opendir(canonical)
      } catch (error) {
        handlers.onError(error)
        handlers.afterDirectory?.()
        continue
      }

      try {
        for await (const entry of handle) {
          if (shouldStop()) break
          await yieldToEventLoop()
          const path = resolve(canonical, entry.name)
          if (entry.isSymbolicLink()) {
            handlers.onSkipped()
            continue
          }
          if (entry.isDirectory()) {
            if (shouldSkipDirectory(entry.name)) handlers.onSkipped()
            else pending.push(path)
            continue
          }
          if (!entry.isFile() || isIgnoredFileName(entry.name)) {
            handlers.onSkipped()
            continue
          }
          if (!SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
            handlers.onSkipped()
            continue
          }
          if (!(await handlers.onFile(path))) break
        }
      } catch (error) {
        handlers.onError(error)
      } finally {
        await handle.close().catch(() => undefined)
      }
      handlers.afterDirectory?.()
    }
    return !shouldStop() && pending.length === 0
  }

  private recordRun(
    job: ScanJob,
    kind: ScanRun['kind'],
    state: ScanRun['state'],
    counts?: { discovered: number },
  ): void {
    const now = Date.now()
    const run: ScanRun = {
      kind,
      state,
      startedAt: kind === 'scan' ? (job.startedAt ?? now) : now,
      endedAt: now,
      discovered: counts?.discovered ?? job.discovered,
      enrolled: kind === 'scan' ? job.enrolled : 0,
      skipped: kind === 'scan' ? job.skipped : 0,
      errors: kind === 'scan' ? job.errors : 0,
    }
    job.history = [run, ...(job.history ?? [])].slice(0, MAX_RUN_HISTORY)
  }

  /** Every remembered folder with its scan history, newest scan first. */
  folders(): FolderSummary[] {
    return this.manifest.jobs
      .map((job) => ({
        root: job.root,
        state: job.state,
        priority: job.priority === true,
        ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
        ...(job.completedAt === undefined ? {} : { completedAt: job.completedAt }),
        ...(job.reconciledAt === undefined ? {} : { reconciledAt: job.reconciledAt }),
        discovered: job.discovered,
        enrolled: job.enrolled,
        skipped: job.skipped,
        errors: job.errors,
        ...(job.lastError ? { lastError: job.lastError } : {}),
        history: job.history ?? [],
      }))
      .sort((a, b) => (b.completedAt ?? b.startedAt ?? 0) - (a.completedAt ?? a.startedAt ?? 0))
  }

  /** Toggle "index this folder first"; takes effect on the files already waiting. */
  setPriority(root: string, priority: boolean): boolean {
    const job = this.jobFor(resolve(root))
    if (!job) return false
    job.priority = priority
    this.save()
    if (priority) this.memory.prioritizeFolder?.(job.root)
    return true
  }

  /** Stop watching and forget a folder. Files already indexed stay searchable. */
  forget(root: string): boolean {
    const normalized = resolve(root)
    if (this.activeRoot === normalized) return false
    const before = this.manifest.jobs.length
    this.manifest.jobs = this.manifest.jobs.filter((job) => job.root !== normalized)
    if (this.manifest.jobs.length === before) return false
    this.save()
    this.emitRootsChanged()
    return true
  }

  private recordError(job: ScanJob, error: unknown): void {
    job.errors++
    job.lastError = error instanceof Error ? error.message : 'Unable to read a folder entry.'
  }

  private jobFor(root: string): ScanJob | undefined {
    return this.manifest.jobs.find((job) => job.root === root)
  }

  /** Write the manifest now (atomic temp + rename) and drop any pending throttled write. */
  private save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.saveDirty = false
    saveManifest(this.manifestPath, this.manifest)
  }

  /** Throttled {@link save}: coalesces bursts into one trailing write. */
  private saveSoon(): void {
    this.saveDirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      try {
        if (this.saveDirty) this.save()
      } catch {
        // A transient write failure must not crash the main process; the next save retries.
      }
    }, MANIFEST_SAVE_INTERVAL_MS)
    this.saveTimer.unref?.()
  }
}

function validateRoot(root: string): string {
  if (
    typeof root !== 'string' ||
    !root.trim() ||
    root.length > MAX_ROOT_LENGTH ||
    !isAbsolute(root)
  )
    throw new Error('Choose a valid folder to scan')
  const normalized = resolve(root)
  if (
    normalized === parse(normalized).root ||
    normalized === parse(normalized).root.replace(/\\$/, '')
  )
    throw new Error('Choose a folder below the drive root')
  if (!isAbsolute(normalized)) throw new Error('Choose an absolute folder path')
  try {
    const result = lstatSync(normalized)
    if (result.isSymbolicLink()) throw new Error('Choose a regular folder, not a symbolic link')
    if (!result.isDirectory()) throw new Error('Choose a folder to scan')
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Choose')) throw error
    throw new Error('The selected folder is unavailable', { cause: error })
  }
  return normalized
}

export function shouldSkipDirectory(name: string): boolean {
  return name.startsWith('.') || IGNORED_DIRECTORIES.has(name.toLowerCase())
}

function readManifest(path: string): Manifest {
  try {
    if (!existsSync(path)) return { version: 1, jobs: [] }
    const raw = readFileSync(path)
    if (raw.byteLength > MAX_MANIFEST_BYTES) return { version: 1, jobs: [] }
    const value: unknown = JSON.parse(raw.toString('utf8'))
    if (!value || typeof value !== 'object' || (value as Manifest).version !== 1)
      return { version: 1, jobs: [] }
    const jobs = (value as Manifest).jobs
    if (!Array.isArray(jobs)) return { version: 1, jobs: [] }
    return {
      version: 1,
      jobs: jobs.filter(isScanJob).map((job) => ({ ...job, root: resolve(job.root) })),
    }
  } catch {
    return { version: 1, jobs: [] }
  }
}

function isScanJob(value: unknown): value is ScanJob {
  if (!value || typeof value !== 'object') return false
  const job = value as Partial<ScanJob>
  return (
    typeof job.root === 'string' &&
    (job.state === 'running' || job.state === 'complete' || job.state === 'stopped') &&
    Number.isSafeInteger(job.discovered) &&
    Number.isSafeInteger(job.enrolled) &&
    Number.isSafeInteger(job.skipped) &&
    Number.isSafeInteger(job.errors)
  )
}

function saveManifest(path: string, manifest: Manifest): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, JSON.stringify(manifest), { mode: 0o600 })
  renameSync(temporary, path)
}
