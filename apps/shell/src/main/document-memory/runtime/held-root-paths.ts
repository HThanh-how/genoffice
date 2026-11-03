import { rootAvailability } from '../root-availability'

/** How long files on an unreachable root wait before the extraction lane looks at them again. */
export const HELD_ROOT_RETRY_MS = 15_000

/**
 * Paths whose root is offline or not verified yet. The extraction lane neither reads them nor
 * judges them by .genofficeignore rules (unknown for such a root: they come back empty), and it must
 * not drop them. They also must not sit in the line: a line that still has work keeps the extract
 * lane "ready", and it would win lane picks over vectors of healthy files while doing nothing. So they
 * wait here, outside the line, and `wake` puts them back after a pause.
 */
export class HeldRootPaths {
  private readonly held = new Set<string>()
  private timer?: NodeJS.Timeout

  /**
   * @param wake called with the held paths after the pause; it re-enqueues them (and checks
   *   stopped/enabled and the database itself, so a file deleted meanwhile is not revived)
   */
  constructor(
    private readonly wake: (paths: string[]) => void,
    private readonly delayMs = HELD_ROOT_RETRY_MS,
  ) {}

  get size(): number {
    return this.held.size
  }

  /** True when `path` must wait (it is held, outside the line, until the next wake). */
  take(path: string): boolean {
    if (!rootAvailability.shouldDeferSyncIo(path)) return false
    this.held.add(path)
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        const batch = [...this.held]
        this.held.clear()
        if (batch.length > 0) this.wake(batch)
      }, this.delayMs)
      this.timer.unref?.()
    }
    return true
  }

  /** Forget everything held (the manager was stopped or its queue was cleared). */
  clear(): void {
    this.held.clear()
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }
}
