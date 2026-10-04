import { watch as fsWatch, type FSWatcher } from 'node:fs'
import { basename, extname, relative, resolve, sep } from 'node:path'
import { isIgnoredFileName, isIndexablePath, shouldSkipDirectory } from './folder-scan'

/** What the watcher needs from the folder scanner. */
export interface WatchedFolders {
  /** Roots with a running or completed scan job. */
  watchedRoots(): string[]
  onRootsChanged(listener: () => void): () => void
  /** Cheap metadata-only re-walk of a finished root. */
  reconcile(root: string): Promise<{ ok: boolean; reason?: string } | unknown>
}

/** What the watcher needs from the document-memory manager. */
export interface FolderEventSink {
  isEnabled(): boolean
  onEnabledChange(listener: () => void): () => void
  handleFileEvents(paths: string[]): Promise<void>
}

export interface FolderWatchOptions {
  /** Quiet period that coalesces bursts of events (default 4 s). */
  debounceMs?: number
  /** Longest a continuous burst may delay a flush (default 30 s). */
  maxWaitMs?: number
  /** First reconcile after start / resume (default 45 s). */
  reconcileDelayMs?: number
  /** Reconcile cadence (default 6 h). */
  reconcileIntervalMs?: number
  /** Delay before a folder-level change triggers a reconcile (default 15 s). */
  dirReconcileDelayMs?: number
  /** Minimum spacing between watcher-triggered reconciles of one root (default 5 min). */
  minReconcileGapMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  /** Test seam for `fs.watch`. */
  watch?: typeof fsWatch
}

interface RootState {
  watcher: FSWatcher | null
  retryTimer: NodeJS.Timeout | null
  dirTimer: NodeJS.Timeout | null
  attempt: number
  lastReconcile: number
  /** The watcher was down (or this is a resume): re-check the root once it is back. */
  needsCatchUp: boolean
}

const HOUR_MS = 60 * 60_000

/**
 * Live change detection for every folder with a running or completed scan job.
 *
 * Uses the native recursive `fs.watch` (Windows/macOS; Linux on current Node), coalesces events,
 * filters unsupported/temporary files and hands the rest to the document-memory manager. It is
 * off while memory is paused, survives an unavailable root (unplugged drive) with exponential
 * backoff, and never throws. A periodic metadata-only reconcile catches whatever it missed.
 */
export class FolderWatchManager {
  private readonly roots = new Map<string, RootState>()
  private readonly pending = new Set<string>()
  private readonly unsubscribe: Array<() => void> = []
  private readonly options: Required<Omit<FolderWatchOptions, 'watch'>>
  private readonly watchImpl: typeof fsWatch
  private flushTimer: NodeJS.Timeout | null = null
  private firstEventAt = 0
  private reconcileTimer: NodeJS.Timeout | null = null
  private reconciling = false
  private flushChain: Promise<void> = Promise.resolve()
  private wasEnabled = false
  private closed = false

  constructor(
    private readonly folders: WatchedFolders,
    private readonly sink: FolderEventSink,
    options: FolderWatchOptions = {},
  ) {
    this.options = {
      debounceMs: options.debounceMs ?? 4_000,
      maxWaitMs: options.maxWaitMs ?? 30_000,
      reconcileDelayMs: options.reconcileDelayMs ?? 45_000,
      reconcileIntervalMs: options.reconcileIntervalMs ?? 6 * HOUR_MS,
      dirReconcileDelayMs: options.dirReconcileDelayMs ?? 15_000,
      minReconcileGapMs: options.minReconcileGapMs ?? 5 * 60_000,
      retryBaseMs: options.retryBaseMs ?? 30_000,
      retryMaxMs: options.retryMaxMs ?? 10 * 60_000,
    }
    this.watchImpl = options.watch ?? fsWatch
    this.unsubscribe.push(folders.onRootsChanged(() => this.sync()))
    this.unsubscribe.push(sink.onEnabledChange(() => this.sync()))
    this.sync()
  }

  /** Roots currently being watched (or waiting to retry); for diagnostics and tests. */
  watchedRoots(): string[] {
    return [...this.roots.keys()]
  }

  /** Align live watchers with the scanner's roots and the memory enabled state. */
  sync(): void {
    if (this.closed) return
    const enabled = this.safeEnabled()
    const desired = new Set(enabled ? this.folders.watchedRoots().map((root) => resolve(root)) : [])
    for (const root of [...this.roots.keys()]) if (!desired.has(root)) this.release(root)
    for (const root of desired) {
      if (this.roots.has(root)) continue
      this.roots.set(root, {
        watcher: null,
        retryTimer: null,
        dirTimer: null,
        attempt: 0,
        lastReconcile: 0,
        needsCatchUp: false,
      })
      this.open(root)
    }
    if (!enabled) {
      this.pending.clear()
      this.clearFlush()
      this.clearReconcileTimer()
    } else if (!this.wasEnabled) this.scheduleReconcile(this.options.reconcileDelayMs)
    this.wasEnabled = enabled
  }

  /** Run one reconcile pass over every root now (also what the timer calls). */
  async reconcileAll(): Promise<void> {
    if (this.closed || this.reconciling || !this.safeEnabled()) return
    this.reconciling = true
    try {
      for (const [root, state] of [...this.roots]) {
        if (this.closed || !this.safeEnabled()) break
        try {
          const result = (await this.folders.reconcile(root)) as { ok?: boolean; reason?: string }
          if (result?.ok === false) {
            if (result.reason === 'busy') this.markDirty(root)
            else this.retryAfterReconcileFailure(root, state)
            continue
          }
          state.lastReconcile = Date.now()
          state.attempt = 0
        } catch {
          this.retryAfterReconcileFailure(root, state)
        }
      }
    } finally {
      this.reconciling = false
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const off of this.unsubscribe) off()
    this.unsubscribe.length = 0
    for (const root of [...this.roots.keys()]) this.release(root)
    this.pending.clear()
    this.clearFlush()
    this.clearReconcileTimer()
  }

  private safeEnabled(): boolean {
    try {
      return this.sink.isEnabled()
    } catch {
      return false
    }
  }

  private open(root: string): void {
    const state = this.roots.get(root)
    if (!state || this.closed || state.watcher) return
    try {
      const watcher = this.watchImpl(root, { recursive: true, persistent: false }, (_type, name) =>
        this.onEvent(root, name === null || name === undefined ? null : String(name)),
      )
      watcher.on('error', () => this.fail(root, watcher))
      state.watcher = watcher
      if (state.needsCatchUp) {
        state.needsCatchUp = false
        this.markDirty(root)
      }
    } catch {
      // Missing/unavailable root, permissions, or no recursive support: back off and retry.
      this.retry(root)
    }
  }

  private fail(root: string, watcher: FSWatcher): void {
    const state = this.roots.get(root)
    try {
      watcher.close()
    } catch {
      // Already closed.
    }
    if (!state || state.watcher !== watcher) return
    state.watcher = null
    this.retry(root)
  }

  private retry(root: string): void {
    const state = this.roots.get(root)
    if (!state || this.closed) return
    state.needsCatchUp = true
    if (state.retryTimer) clearTimeout(state.retryTimer)
    const delay = Math.min(
      this.options.retryBaseMs * 2 ** Math.min(state.attempt, 16),
      this.options.retryMaxMs,
    )
    state.attempt++
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null
      this.open(root)
    }, delay)
    state.retryTimer.unref?.()
  }

  /** A watcher can remain open but stop delivering events during a mount outage. Reopen it
   * with the same capped backoff as watcher errors, then reconcile as soon as it returns. */
  private retryAfterReconcileFailure(root: string, state: RootState): void {
    if (state.dirTimer) clearTimeout(state.dirTimer)
    state.dirTimer = null
    state.needsCatchUp = true
    if (state.watcher) this.fail(root, state.watcher)
    else this.retry(root)
  }

  private release(root: string): void {
    const state = this.roots.get(root)
    if (!state) return
    this.roots.delete(root)
    if (state.retryTimer) clearTimeout(state.retryTimer)
    if (state.dirTimer) clearTimeout(state.dirTimer)
    try {
      state.watcher?.close()
    } catch {
      // Already closed.
    }
    state.watcher = null
  }

  private onEvent(root: string, name: string | null): void {
    if (this.closed || !this.safeEnabled()) return
    if (!name) {
      this.markDirty(root)
      return
    }
    const full = resolve(root, name)
    if (isIndexablePath(root, full)) {
      this.pending.add(full)
      this.armFlush()
      return
    }
    // Not a file we index. A folder created/renamed/deleted may carry documents with it, which
    // per-file events do not always report, so ask for a (throttled) reconcile instead.
    const parts = relative(root, full).split(sep).filter(Boolean)
    const leaf = parts[parts.length - 1]
    if (!leaf || parts.some((part) => part === '..')) return
    if (isIgnoredFileName(leaf) || parts.slice(0, -1).some(shouldSkipDirectory)) return
    if (shouldSkipDirectory(basename(leaf))) return
    if (extname(leaf) === '') this.markDirty(root)
  }

  private armFlush(): void {
    const now = Date.now()
    if (!this.pending.size) return
    if (!this.flushTimer) this.firstEventAt = now
    else clearTimeout(this.flushTimer)
    const wait = Math.max(
      0,
      Math.min(this.options.debounceMs, this.firstEventAt + this.options.maxWaitMs - now),
    )
    this.flushTimer = setTimeout(() => this.flush(), wait)
    this.flushTimer.unref?.()
  }

  private flush(): void {
    this.flushTimer = null
    if (this.closed || !this.safeEnabled() || !this.pending.size) {
      this.pending.clear()
      return
    }
    const batch = [...this.pending]
    this.pending.clear()
    // Serialized so two bursts never interleave their move detection.
    this.flushChain = this.flushChain
      .then(() => this.sink.handleFileEvents(batch))
      .catch(() => undefined)
  }

  private clearFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
  }

  private markDirty(root: string): void {
    const state = this.roots.get(root)
    if (!state || state.dirTimer || this.closed) return
    const wait = Math.max(
      this.options.dirReconcileDelayMs,
      state.lastReconcile + this.options.minReconcileGapMs - Date.now(),
    )
    state.dirTimer = setTimeout(() => {
      state.dirTimer = null
      void this.reconcileRoot(root)
    }, wait)
    state.dirTimer.unref?.()
  }

  private async reconcileRoot(root: string): Promise<void> {
    const state = this.roots.get(root)
    if (!state || this.closed || !this.safeEnabled()) return
    try {
      const result = (await this.folders.reconcile(root)) as { ok?: boolean; reason?: string }
      if (result?.ok === false && result.reason === 'busy') {
        this.markDirty(root)
        return
      }
      if (result?.ok === false) {
        this.retryAfterReconcileFailure(root, state)
        return
      }
      state.lastReconcile = Date.now()
      state.attempt = 0
    } catch {
      this.retryAfterReconcileFailure(root, state)
    }
  }

  private scheduleReconcile(delay: number): void {
    this.clearReconcileTimer()
    if (this.closed) return
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null
      void this.reconcileAll().finally(() => {
        if (!this.closed && this.safeEnabled())
          this.scheduleReconcile(this.options.reconcileIntervalMs)
      })
    }, delay)
    this.reconcileTimer.unref?.()
  }

  private clearReconcileTimer(): void {
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer)
    this.reconcileTimer = null
  }
}
