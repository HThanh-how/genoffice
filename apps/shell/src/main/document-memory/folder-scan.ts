import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { opendir, stat } from 'node:fs/promises'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { FolderWatchManager } from './folder-watch-manager'
import {
  DEFAULT_MAX_MEDIA_PER_FOLDER,
  MIN_IMAGE_BYTES,
  SUPPORTED_EXTENSIONS,
  isJunkFileName,
  mediaKindOfExtension,
  mediaKindOfPath,
  mediaRejection,
  shouldSkipDirectory,
} from './scan-policy'
import { isGeneratedArtifactPath } from './artifact-policy'
export { IGNORED_DIRECTORIES, SUPPORTED_EXTENSIONS, shouldSkipDirectory } from './scan-policy'
export { isGeneratedArtifactPath } from './artifact-policy'

export const MAX_DOCUMENT_BYTES = 128 * 1024 * 1024
const MAX_ROOT_LENGTH = 32_768
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
/** Progress counters are persisted at most this often while a scan runs (state changes save at once). */
const MANIFEST_SAVE_INTERVAL_MS = 2_000
/** Hidden files plus lock/temp/backup/partial-download artifacts and OS junk (policy lives in scan-policy.ts). */
export function isIgnoredFileName(name: string): boolean {
  return isJunkFileName(name)
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
  const ext = extname(name).toLowerCase()
  const media = mediaKindOfExtension(ext)
  // Size is unknown here: the size floor / folder cap are applied where the file is stat'ed.
  if (media ? mediaRejection(media, relative) !== null : !SUPPORTED_EXTENSIONS.has(ext))
    return false
  if (isGeneratedArtifactPath(path)) return false
  return true
}

/** Per-folder allowance of media files (a scan, a refresh or a subtree refresh each start from zero). */
export interface MediaBudget {
  max: number
  taken: number
  skipped: number
  truncated: boolean
}

export function newMediaBudget(max: number): MediaBudget {
  return { max, taken: 0, skipped: 0, truncated: false }
}

/**
 * Whether a stat'ed file should be listed. Documents: up to MAX_DOCUMENT_BYTES (they are read). Media is
 * only listed and header-probed: no size cap, but images below the noise floor are dropped and at most
 * `budget.max` media files are taken per folder; the rest is counted and flagged `truncated`, never
 * silently lost.
 */
export function isListableSize(path: string, sizeBytes: number, budget: MediaBudget): boolean {
  const kind = mediaKindOfPath(path)
  if (!kind) return sizeBytes <= MAX_DOCUMENT_BYTES
  if (kind === 'image' && sizeBytes < MIN_IMAGE_BYTES) return false
  if (budget.taken >= budget.max) {
    budget.truncated = true
    budget.skipped++
    return false
  }
  budget.taken++
  return true
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
  isWriteReady?(): boolean
  waitForWriteReady?(timeoutMs?: number): Promise<boolean>
  /** Reconcile a root against a fresh metadata-only listing (adds, changes, moves, deletions). */
  reconcileFolder?(
    root: string,
    files: Map<string, { mtimeMs: number; sizeBytes: number }>,
  ): Promise<unknown>
  /** Reconcile a specific subtree under a root against a fresh metadata-only listing. */
  reconcileSubtree?(
    root: string,
    subtree: string,
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

export type FolderOwner = 'manual' | 'known:documents' | 'known:downloads' | 'known:desktop'

export function isValidFolderOwner(value: unknown): value is FolderOwner {
  return (
    value === 'manual' ||
    value === 'known:documents' ||
    value === 'known:downloads' ||
    value === 'known:desktop'
  )
}

function recordMediaBudget(job: ScanJob, budget: MediaBudget): void {
  job.media = budget.taken
  if (budget.skipped) job.mediaSkipped = budget.skipped
  if (budget.truncated) job.mediaTruncated = true
}

function resetMediaCounters(job: ScanJob): void {
  delete job.media
  delete job.mediaSkipped
  delete job.mediaTruncated
}

function ownersOf(job: ScanJob): FolderOwner[] {
  return Array.isArray(job.owners) && job.owners.length > 0 ? job.owners : ['manual']
}

function hasManualOwner(job: ScanJob): boolean {
  return ownersOf(job).includes('manual')
}

export interface ScanJob {
  root: string
  owners?: FolderOwner[]
  startedAt?: number
  state: 'running' | 'complete' | 'stopped'
  discovered: number
  enrolled: number
  skipped: number
  errors: number
  lastError?: string
  /** Whether the folder was stopped because it was unavailable/unreachable. */
  unavailable?: boolean
  /** Epoch ms of the last completed metadata-only reconcile pass. */
  reconciledAt?: number
  /** Epoch ms the last full scan finished. */
  completedAt?: number
  /** Index this folder's waiting files before other folders'. */
  priority?: boolean
  /** The most recent scans and refreshes, newest first. */
  history?: ScanRun[]
  /** Images/videos listed in this folder by the last scan (name + metadata only). */
  media?: number
  /** Media files left out because the per-folder cap was reached. */
  mediaSkipped?: number
  /** True when media was left out (cap): the folder's photos/videos are not all indexed. */
  mediaTruncated?: boolean
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
  owners?: FolderOwner[]
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
  unavailable?: boolean
  history: ScanRun[]
  media?: number
  mediaSkipped?: number
  mediaTruncated?: boolean
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
  /** roots asked for while another scan runs: they start, one after another, as each finishes */
  private readonly waiting: string[] = []
  private readonly pendingForgetRoots = new Set<string>()
  private readonly pendingRestartRoots = new Map<string, FolderOwner[]>()
  private registrationEpoch = 0
  private stopRequested = false
  private closed = false
  private runner: Promise<void> | null = null
  private reconciling = false
  private watcher: FolderWatchManager | null = null
  private readonly rootListeners = new Set<() => void>()
  private saveTimer: NodeJS.Timeout | null = null
  private saveDirty = false

  private readonly maxMediaPerFolder: number

  constructor(
    userData: string,
    memory: DiscoveredDocumentIndexer,
    options: { maxMediaPerFolder?: number } = {},
  ) {
    this.maxMediaPerFolder = options.maxMediaPerFolder ?? DEFAULT_MAX_MEDIA_PER_FOLDER
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
      resetMediaCounters(interrupted)
      delete interrupted.lastError
      delete interrupted.unavailable
      if (hasManualOwner(interrupted)) {
        this.save()
        queueMicrotask(() => this.resume(interrupted.root))
      } else {
        interrupted.state = 'stopped'
        this.save()
      }
    } else {
      const hasUnavailable = this.manifest.jobs.some(
        (job) =>
          hasManualOwner(job) &&
          job.state === 'stopped' &&
          (job.unavailable || job.lastError?.includes('unavailable')),
      )
      if (hasUnavailable) {
        queueMicrotask(() => this.retryUnavailable())
      }
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
      const budget = newMediaBudget(this.maxMediaPerFolder)
      let unavailable = false
      const completed = await this.traverse(
        job.root,
        {
          onSkipped: () => undefined,
          onError: () => {
            unavailable = true
          },
          onFile: async (path) => {
            try {
              const fileStat = await stat(path)
              if (fileStat.isFile() && isListableSize(path, fileStat.size, budget))
                files.set(path, { mtimeMs: fileStat.mtimeMs, sizeBytes: fileStat.size })
            } catch {
              // A disconnect midway through traversal is not a complete deletion inventory.
              unavailable = true
            }
            return true
          },
        },
        () => this.closed,
      )
      if (!completed) return { ok: false, reason: 'interrupted' }
      if (unavailable) return { ok: false, reason: 'unavailable' }
      await this.memory.reconcileFolder(job.root, files)
      recordMediaBudget(job, budget)
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

  /**
   * Reconcile only a newly extracted or copied subdirectory below a finished root.
   * Walks only files under `subtree` instead of rescanning the entire root tree.
   */
  async reconcileSubtree(
    root: string,
    subtree: string,
  ): Promise<{ ok: boolean; reason?: string; files?: number }> {
    const normalizedRoot = resolve(root)
    const normalizedSubtree = resolve(subtree)
    const rel = relative(normalizedRoot, normalizedSubtree)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return { ok: false, reason: 'invalid-subtree' }
    }
    if (this.closed || this.activeRoot || this.reconciling) return { ok: false, reason: 'busy' }
    const job = this.jobFor(normalizedRoot)
    if (!job || job.state !== 'complete') return { ok: false, reason: 'not-complete' }
    if (!this.memory.reconcileSubtree && !this.memory.reconcileFolder) {
      return { ok: false, reason: 'unsupported' }
    }
    this.reconciling = true
    try {
      try {
        if (!(await stat(job.root)).isDirectory()) return { ok: false, reason: 'unavailable' }
      } catch {
        // An unplugged drive or deleted root: never treat its files as deleted.
        return { ok: false, reason: 'unavailable' }
      }

      let subtreeIsDir = false
      try {
        const subtreeStat = await stat(normalizedSubtree)
        subtreeIsDir = subtreeStat.isDirectory()
      } catch (err: unknown) {
        const isEnoent =
          typeof err === 'object' &&
          err !== null &&
          'code' in err &&
          (err as { code: string }).code === 'ENOENT'
        if (isEnoent) {
          const files = new Map<string, { mtimeMs: number; sizeBytes: number }>()
          if (this.memory.reconcileSubtree) {
            await this.memory.reconcileSubtree(job.root, normalizedSubtree, files)
          } else if (this.memory.reconcileFolder) {
            await this.memory.reconcileFolder(normalizedSubtree, files)
          }
          job.reconciledAt = Date.now()
          this.recordRun(job, 'refresh', 'complete', { discovered: 0 })
          if (job.priority) this.memory.prioritizeFolder?.(job.root)
          this.save()
          return { ok: true, files: 0 }
        }
        return { ok: false, reason: 'unavailable' }
      }

      if (!subtreeIsDir) {
        return { ok: false, reason: 'not-a-directory' }
      }

      const files = new Map<string, { mtimeMs: number; sizeBytes: number }>()
      const budget = newMediaBudget(this.maxMediaPerFolder)
      let unavailable = false
      const completed = await this.traverse(
        normalizedSubtree,
        {
          onSkipped: () => undefined,
          onError: () => {
            unavailable = true
          },
          onFile: async (path) => {
            try {
              const fileStat = await stat(path)
              if (fileStat.isFile() && isListableSize(path, fileStat.size, budget))
                files.set(path, { mtimeMs: fileStat.mtimeMs, sizeBytes: fileStat.size })
            } catch {
              unavailable = true
            }
            return true
          },
        },
        () => this.closed,
        job.root,
      )
      if (!completed) return { ok: false, reason: 'interrupted' }
      if (unavailable) return { ok: false, reason: 'unavailable' }

      if (this.memory.reconcileSubtree) {
        await this.memory.reconcileSubtree(job.root, normalizedSubtree, files)
      } else if (this.memory.reconcileFolder) {
        await this.memory.reconcileFolder(normalizedSubtree, files)
      }

      if (budget.truncated) job.mediaTruncated = true
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

  /** Whether the given root is currently waiting in the scan queue. */
  isWaiting(root: string): boolean {
    const normalized = resolve(root)
    return this.waiting.some((w) => resolve(w) === normalized)
  }

  private removeFromWaiting(normalizedRoot: string): void {
    let idx: number
    while ((idx = this.waiting.findIndex((w) => resolve(w) === normalizedRoot)) !== -1) {
      this.waiting.splice(idx, 1)
    }
  }

  /** Start or resume scanning one selected folder. */
  start(root: string, owner: FolderOwner = 'manual'): FolderScanStatus {
    const normalizedRoot = validateRoot(root)
    if (this.closed) throw new Error('Folder scanner is closed')

    if (this.activeRoot === normalizedRoot && this.pendingForgetRoots.has(normalizedRoot)) {
      const existingOwners = this.pendingRestartRoots.get(normalizedRoot) ?? []
      if (!existingOwners.includes(owner)) {
        existingOwners.push(owner)
      }
      this.pendingRestartRoots.set(normalizedRoot, existingOwners)

      let job = this.manifest.jobs.find((entry) => entry.root === normalizedRoot)
      if (!job) {
        job = {
          root: normalizedRoot,
          owners: [owner],
          startedAt: Date.now(),
          state: 'stopped',
          discovered: 0,
          enrolled: 0,
          skipped: 0,
          errors: 0,
        }
        this.manifest.jobs.push(job)
      } else {
        if (!job.owners || !Array.isArray(job.owners) || job.owners.length === 0) {
          job.owners = [owner]
        } else if (!job.owners.includes(owner)) {
          job.owners.push(owner)
        }
      }
      this.save()
      return this.status()
    }

    this.pendingForgetRoots.delete(normalizedRoot)
    this.pendingRestartRoots.delete(normalizedRoot)

    let job = this.manifest.jobs.find((entry) => entry.root === normalizedRoot)
    if (!job) {
      job = {
        root: normalizedRoot,
        owners: [owner],
        startedAt: Date.now(),
        state: this.activeRoot ? 'stopped' : 'running',
        discovered: 0,
        enrolled: 0,
        skipped: 0,
        errors: 0,
      }
      this.manifest.jobs.push(job)
    } else {
      if (!job.owners || !Array.isArray(job.owners) || job.owners.length === 0) {
        job.owners = [owner]
      } else if (!job.owners.includes(owner)) {
        job.owners.push(owner)
      }
    }

    if (this.activeRoot) {
      if (
        this.activeRoot !== normalizedRoot &&
        !this.waiting.some((w) => resolve(w) === normalizedRoot)
      )
        this.waiting.push(normalizedRoot)
      this.save()
      return this.status()
    }

    if (job.state !== 'running') {
      job.state = 'running'
      job.startedAt = Date.now()
      job.discovered = 0
      job.enrolled = 0
      job.skipped = 0
      job.errors = 0
      resetMediaCounters(job)
      delete job.lastError
      delete job.unavailable
    }
    this.save()
    this.run(job)
    this.emitRootsChanged()
    return this.status()
  }

  /**
   * Rescan an already registered folder, preserving its existing owners without defaulting to 'manual'.
   */
  async rescanExisting(root: string): Promise<{ ok: boolean; error?: string }> {
    if (this.closed) return { ok: false, error: 'Folder scanner is closed' }
    const normalizedRoot = resolve(root)
    const job = this.jobFor(normalizedRoot)
    if (!job) {
      return { ok: false, error: 'Unknown folder' }
    }

    const existingOwners =
      job.owners && job.owners.length > 0 ? [...job.owners] : (['manual'] as FolderOwner[])
    job.owners = existingOwners

    this.pendingForgetRoots.delete(normalizedRoot)
    this.pendingRestartRoots.delete(normalizedRoot)

    if (this.activeRoot) {
      if (
        this.activeRoot !== normalizedRoot &&
        !this.waiting.some((w) => resolve(w) === normalizedRoot)
      ) {
        this.waiting.push(normalizedRoot)
      }
      this.save()
      return { ok: true }
    }

    job.state = 'running'
    job.startedAt = Date.now()
    job.discovered = 0
    job.enrolled = 0
    job.skipped = 0
    job.errors = 0
    resetMediaCounters(job)
    delete job.lastError

    this.save()
    this.run(job)
    this.emitRootsChanged()
    return { ok: true }
  }

  /** Alias used by callers that phrase the action as a scan. */
  scan(root: string, owner: FolderOwner = 'manual'): FolderScanStatus {
    return this.start(root, owner)
  }

  stop(): FolderScanStatus {
    this.stopRequested = true
    if (this.activeRoot) {
      const job = this.jobFor(this.activeRoot)
      if (job?.state === 'running') {
        job.state = 'stopped'
        delete job.unavailable
        this.save()
        this.emitRootsChanged()
      }
    }
    return this.status()
  }

  /** The index was cleared: forget every folder so nothing re-imports it. */
  private unregisterAll(): void {
    this.registrationEpoch++
    this.stopRequested = true
    this.waiting.length = 0
    this.pendingForgetRoots.clear()
    this.pendingRestartRoots.clear()
    if (this.activeRoot) {
      this.pendingForgetRoots.add(resolve(this.activeRoot))
    }
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
    const currentEpoch = this.registrationEpoch
    this.activeRoot = job.root
    this.stopRequested = false
    this.runner = this.walk(job)
      .catch((error: unknown) => {
        if (currentEpoch !== this.registrationEpoch) return
        job.state = 'stopped'
        job.errors++
        job.lastError = error instanceof Error ? error.message : 'Folder scan failed.'
      })
      .finally(() => {
        this.activeRoot = null
        this.runner = null

        if (this.pendingRestartRoots.has(job.root)) {
          const restartOwners = this.pendingRestartRoots.get(job.root) ?? ['manual']
          this.pendingRestartRoots.delete(job.root)
          this.pendingForgetRoots.delete(job.root)

          let restartJob = this.jobFor(job.root)
          if (!restartJob) {
            restartJob = {
              root: job.root,
              owners: restartOwners,
              startedAt: Date.now(),
              state: 'stopped',
              discovered: 0,
              enrolled: 0,
              skipped: 0,
              errors: 0,
            }
            this.manifest.jobs.push(restartJob)
          } else {
            restartJob.owners = restartOwners
          }
          this.save()

          if (!this.waiting.some((w) => resolve(w) === job.root)) {
            this.waiting.unshift(job.root)
          }
          this.startNextWaiting(this.registrationEpoch)
          return
        }

        if (currentEpoch !== this.registrationEpoch) {
          this.pendingForgetRoots.delete(job.root)
          /*
           * unregisterAll() already removed every old-epoch
           * queued root. Any root remaining in waiting now
           * was registered after the clear.
           */
          this.startNextWaiting(this.registrationEpoch)
          return
        }

        if (this.pendingForgetRoots.has(job.root)) {
          this.pendingForgetRoots.delete(job.root)
          this.manifest.jobs = this.manifest.jobs.filter((j) => j.root !== job.root)
          this.save()
          this.emitRootsChanged()
        } else {
          if (job.state === 'complete') job.completedAt = Date.now()
          if (job.state !== 'running') this.recordRun(job, 'scan', job.state)
          if (job.state === 'complete' && job.priority) this.memory.prioritizeFolder?.(job.root)
          this.save()
        }
        this.startNextWaiting(currentEpoch)
      })
  }

  private startNextWaiting(targetEpoch?: number): void {
    const epoch = targetEpoch ?? this.registrationEpoch
    while (!this.closed && !this.activeRoot && epoch === this.registrationEpoch) {
      if (this.waiting.length === 0) return
      const next = this.waiting.shift()
      if (!next) return
      const normalizedNext = resolve(next)
      if (this.pendingForgetRoots.has(normalizedNext)) {
        this.pendingForgetRoots.delete(normalizedNext)
        continue
      }
      try {
        const job = this.jobFor(normalizedNext)
        const owner = job?.owners?.[0] ?? 'manual'
        this.start(next, owner)
      } catch (error) {
        // gone or unplugged meanwhile: the next start of the app picks it up again
        const job = this.jobFor(normalizedNext)
        if (job) {
          job.state = 'stopped'
          job.unavailable = true
          job.errors++
          job.lastError =
            error instanceof Error ? error.message : 'The selected folder is unavailable.'
          this.recordRun(job, 'scan', 'unavailable')
          this.save()
          this.emitRootsChanged()
        }
      }
    }
  }

  private async walk(job: ScanJob): Promise<void> {
    if (this.memory.waitForWriteReady) {
      await this.memory.waitForWriteReady(10_000)
    }
    const budget = newMediaBudget(this.maxMediaPerFolder)
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
            } else if (!isListableSize(path, fileStat.size, budget)) {
              job.skipped++
              recordMediaBudget(job, budget)
            } else {
              if (this.memory.isWriteReady && !this.memory.isWriteReady()) {
                await this.memory.waitForWriteReady?.(5_000)
              }
              const enrolled = this.memory.indexDiscoveredFile(path, {
                mtimeMs: fileStat.mtimeMs,
                sizeBytes: fileStat.size,
              })
              if (enrolled) {
                job.enrolled++
              } else if (this.memory.isWriteReady && !this.memory.isWriteReady()) {
                await this.memory.waitForWriteReady?.(5_000)
                if (
                  this.memory.indexDiscoveredFile(path, {
                    mtimeMs: fileStat.mtimeMs,
                    sizeBytes: fileStat.size,
                  })
                ) {
                  job.enrolled++
                }
              }
            }
            if (mediaKindOfPath(path)) recordMediaBudget(job, budget)
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
    /** Media noise folders are judged below this folder (the scanned root), not below a refreshed subtree. */
    judgeFrom: string = root,
  ): Promise<boolean> {
    const pending = [root]
    const visitedDirectories = new Set<string>()
    while (pending.length && !shouldStop()) {
      const directory = pending.pop()!
      const canonical = resolve(directory)
      if (visitedDirectories.has(canonical)) continue
      visitedDirectories.add(canonical)
      const dirsBelowRoot = relative(judgeFrom, canonical).split(sep).filter(Boolean)
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
            if (shouldSkipDirectory(entry.name) || isGeneratedArtifactPath(path))
              handlers.onSkipped()
            else pending.push(path)
            continue
          }
          if (!entry.isFile() || isIgnoredFileName(entry.name)) {
            handlers.onSkipped()
            continue
          }
          const extension = extname(entry.name).toLowerCase()
          if (!SUPPORTED_EXTENSIONS.has(extension)) {
            const media = mediaKindOfExtension(extension)
            // Media outside noise folders (thumbnails, caches, app resources ...); size is judged after stat.
            if (!media || mediaRejection(media, dirsBelowRoot) !== null) {
              handlers.onSkipped()
              continue
            }
          }
          if (isGeneratedArtifactPath(path)) {
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
        owners:
          job.owners && job.owners.length > 0 ? [...job.owners] : (['manual'] as FolderOwner[]),
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
        ...(job.unavailable ? { unavailable: true } : {}),
        history: job.history ?? [],
        ...(job.media ? { media: job.media } : {}),
        ...(job.mediaSkipped ? { mediaSkipped: job.mediaSkipped } : {}),
        ...(job.mediaTruncated ? { mediaTruncated: true } : {}),
      }))
      .sort((a, b) => (b.completedAt ?? b.startedAt ?? 0) - (a.completedAt ?? a.startedAt ?? 0))
  }

  /**
   * Retry scanning any registered folders that were marked stopped due to being unavailable,
   * provided the root is now accessible.
   */
  retryUnavailable(): string[] {
    if (this.closed) return []
    const retried: string[] = []
    for (const job of this.manifest.jobs) {
      if (job.state === 'stopped' && (job.unavailable || job.lastError?.includes('unavailable'))) {
        if (!hasManualOwner(job)) {
          continue
        }
        try {
          validateRoot(job.root)
          job.unavailable = false
          delete job.lastError
          this.start(job.root, 'manual')
          retried.push(job.root)
        } catch {
          // Still unavailable
        }
      }
    }
    return retried
  }

  /**
   * Reconcile roots on startup or periodic check: retries any unavailable roots that
   * have become accessible again.
   */
  reconcileStartup(): string[] {
    return this.retryUnavailable()
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
  forget(root: string, owner: FolderOwner = 'manual'): boolean {
    const normalized = resolve(root)
    const job = this.jobFor(normalized)
    if (!job) return false

    if (!job.owners || !Array.isArray(job.owners) || job.owners.length === 0) {
      job.owners = ['manual']
    }
    job.owners = job.owners.filter((o) => o !== owner)

    if (job.owners.length > 0) {
      if (this.pendingRestartRoots.has(normalized)) {
        const remaining = (this.pendingRestartRoots.get(normalized) ?? []).filter(
          (o) => o !== owner,
        )
        if (remaining.length > 0) {
          this.pendingRestartRoots.set(normalized, remaining)
        } else {
          this.pendingRestartRoots.delete(normalized)
        }
      }
      this.save()
      return true
    }

    this.removeFromWaiting(normalized)
    this.pendingRestartRoots.delete(normalized)

    if (this.activeRoot === normalized) {
      this.pendingForgetRoots.add(normalized)
      this.stop()
      return true
    }

    this.manifest.jobs = this.manifest.jobs.filter((j) => j.root !== normalized)
    this.save()
    this.emitRootsChanged()
    return true
  }

  /**
   * Unregisters a root for the specified owner.
   * If other owners remain, root continues to be tracked/watched.
   * If no owners remain:
   * 1. Removes completely from waiting list.
   * 2. If inactive: removes from manifest, emits roots changed.
   * 3. If active: marks pending-forget, requests stop, and waits for runner to exit.
   */
  async unregisterRoot(root: string, owner: FolderOwner = 'manual'): Promise<boolean> {
    const normalized = resolve(root)
    const job = this.jobFor(normalized)
    if (!job) return false

    if (!job.owners || !Array.isArray(job.owners) || job.owners.length === 0) {
      job.owners = ['manual']
    }
    job.owners = job.owners.filter((o) => o !== owner)

    if (job.owners.length > 0) {
      if (this.pendingRestartRoots.has(normalized)) {
        const remaining = (this.pendingRestartRoots.get(normalized) ?? []).filter(
          (o) => o !== owner,
        )
        if (remaining.length > 0) {
          this.pendingRestartRoots.set(normalized, remaining)
        } else {
          this.pendingRestartRoots.delete(normalized)
        }
      }
      this.save()
      return true
    }

    this.removeFromWaiting(normalized)
    this.pendingRestartRoots.delete(normalized)

    if (this.activeRoot === normalized) {
      this.pendingForgetRoots.add(normalized)
      this.stop()
      if (this.runner) {
        try {
          await this.runner
        } catch {
          // runner errors handled in run()
        }
      }
      return true
    }

    this.manifest.jobs = this.manifest.jobs.filter((j) => j.root !== normalized)
    this.save()
    this.emitRootsChanged()
    return true
  }

  /** Whether the given root is currently registered under the specified owner. */
  hasOwner(root: string, owner: FolderOwner): boolean {
    const normalized = resolve(root)
    const job = this.jobFor(normalized)
    return job?.owners?.includes(owner) ?? false
  }

  /**
   * Current registration and execution state of a root for UI and known search source lifecycle.
   */
  registrationState(
    root: string,
    owner?: FolderOwner,
  ): 'none' | 'queued' | 'scanning' | 'watching' | 'stopped' {
    const normalized = resolve(root)
    const job = this.jobFor(normalized)
    if (!job) return 'none'
    if (owner && !job.owners?.includes(owner)) return 'none'
    if (this.activeRoot === normalized) return 'scanning'
    if (this.isWaiting(normalized)) return 'queued'
    if (job.state === 'running' || job.state === 'complete') return 'watching'
    if (job.state === 'stopped') return 'stopped'
    return 'none'
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
  // A data drive may be scanned whole (it is what "add this drive" means); the system drive, or
  // the filesystem root, would walk the operating system.
  const driveRoot = parse(normalized).root
  if (
    normalized === driveRoot &&
    (process.platform !== 'win32' ||
      driveRoot.toLowerCase().startsWith((process.env.SystemDrive ?? 'C:').toLowerCase()))
  )
    throw new Error('Choose a folder below the system drive root')
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
      jobs: jobs.filter(isScanJob).map((job) => ({
        ...job,
        root: resolve(job.root),
        owners:
          Array.isArray(job.owners) && job.owners.length > 0
            ? job.owners.filter(isValidFolderOwner)
            : (['manual'] as FolderOwner[]),
      })),
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

/**
 * Reconcile a specific subtree below a root using a FolderScanManager instance.
 */
export async function reconcileSubtree(
  scanner: FolderScanManager,
  root: string,
  subtree: string,
): Promise<{ ok: boolean; reason?: string; files?: number }> {
  return scanner.reconcileSubtree(root, subtree)
}
