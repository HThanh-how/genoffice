import { rootAvailability } from '../root-availability'

/** How long files on an unreachable root wait before the extraction lane looks at them again. */
export const HELD_ROOT_RETRY_MS = 15_000

/**
 * Paths whose root is offline or not verified yet. The extraction lane neither reads them nor
 * judges them by .genofficeignore rules (unknown for such a root: they come back empty), and it must
 * not drop them: they go back into the line and are looked at again after a pause, instead of
 * spinning on them.
 */
export class HeldRootPaths {
  private held: Array<[path: string, textOnly: boolean]> = []
  private timer?: NodeJS.Timeout

  /** @param retry called after the pause to run the lane again (it checks stopped/enabled itself) */
  constructor(
    private readonly retry: () => void,
    private readonly delayMs = HELD_ROOT_RETRY_MS,
  ) {}

  /** True when `path` must wait; it is remembered until release(). */
  take(path: string, textOnly: boolean): boolean {
    if (!rootAvailability.shouldDeferSyncIo(path)) return false
    this.held.push([path, textOnly])
    return true
  }

  /** Hand the held paths back to the line (`requeue`) and schedule the next look. True when any. */
  release(requeue: (path: string, textOnly: boolean) => void): boolean {
    const batch = this.held
    this.held = []
    for (const [path, textOnly] of batch) requeue(path, textOnly)
    if (batch.length > 0 && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        this.retry()
      }, this.delayMs)
      this.timer.unref?.()
    }
    return batch.length > 0
  }
}
