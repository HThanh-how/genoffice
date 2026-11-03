import { pathUnderRoot, rootAvailability } from '../root-availability'

/** How long files on an unreachable root wait before the extraction lane looks at them again. */
export const HELD_ROOT_RETRY_MS = 15_000

/**
 * Paths whose root is offline or not verified yet. The extraction lane neither reads them nor
 * judges them by .genofficeignore rules (unknown for such a root: they come back empty), and it must
 * not drop them. They also must not sit in the line: a line that still has work keeps the extract
 * lane "ready", and it would win lane picks over vectors of healthy files while doing nothing. So they
 * wait here, outside the line, and `wake` puts them back after a pause, or at once when a root is
 * verified (a saved root that was merely "not verified yet" for a few milliseconds at launch).
 */
export class HeldRootPaths {
  private readonly held = new Set<string>()
  private timer?: NodeJS.Timeout
  private readonly stopWatching: () => void
  private disposed = false

  /**
   * @param wake called with the held paths; it re-enqueues them (and checks stopped/enabled and the
   *   database itself, so a file deleted meanwhile is not revived)
   */
  constructor(
    private readonly wake: (paths: string[]) => void,
    private readonly delayMs = HELD_ROOT_RETRY_MS,
  ) {
    // only the paths of the root that was just verified come back; other roots' paths stay held
    this.stopWatching = rootAvailability.onVerified((root) => this.flush(root))
  }

  get size(): number {
    return this.held.size
  }

  /** True when `path` must wait (it is held, outside the line, until the next wake). */
  take(path: string): boolean {
    if (this.disposed || !rootAvailability.shouldDeferSyncIo(path)) return false
    this.held.add(path)
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        this.flush()
      }, this.delayMs)
      this.timer.unref?.()
    }
    return true
  }

  /**
   * Hand held paths back now (those under `root`, or all of them when no root is given); one that
   * is still unreachable is simply held again.
   */
  private flush(root?: string): void {
    const batch = [...this.held].filter((p) => root === undefined || pathUnderRoot(root, p))
    for (const path of batch) this.held.delete(path)
    if (this.held.size === 0 && this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (batch.length === 0) return
    try {
      this.wake(batch)
    } catch (error) {
      console.warn(
        '[document-memory] could not requeue files held for an unreachable folder',
        error,
      )
    }
  }

  /** Forget everything held (indexing was turned off or its queue was cleared). */
  clear(): void {
    this.held.clear()
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Stop watching root changes too (the manager was closed). */
  dispose(): void {
    this.disposed = true
    this.clear()
    this.stopWatching()
  }
}
