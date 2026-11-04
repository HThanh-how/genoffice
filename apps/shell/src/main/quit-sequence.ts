/**
 * The last seconds of the app. Closing the databases of a large index can take several seconds, on
 * the main thread, and a window that is still on screen while that happens is shown by Windows as
 * "Not Responding". So the order is: hide every window as soon as the quit is confirmed, then do the
 * clean-up one step at a time, timing each step, with an overall deadline after which the process
 * is ended (SQLite recovers what is left of a write-ahead log the next time the database is opened).
 */

export interface QuitWindow {
  isDestroyed(): boolean
  hide(): void
}

/** Hides every window that is still on screen. Returns how many it hid. Never throws. */
export function hideWindowsForQuit(windows: readonly QuitWindow[]): number {
  let hidden = 0
  for (const win of windows) {
    try {
      if (win.isDestroyed()) continue
      win.hide()
      hidden++
    } catch {
      // a window that is going away anyway
    }
  }
  return hidden
}

export interface QuitStep {
  /** a fixed name, written to the log */
  readonly name: string
  readonly run: () => void | Promise<void>
}

export interface QuitLog {
  info(cat: string, ev: string, data?: unknown): void
  warn(cat: string, ev: string, data?: unknown): void
}

export interface QuitSequenceDeps {
  readonly log: QuitLog
  /** ends the process now (writes the log first) */
  readonly forceExit: () => void
  /** the whole clean-up may take this long (default 25 s) */
  readonly deadlineMs?: number
  readonly now?: () => number
  readonly setTimeout?: typeof setTimeout
  readonly clearTimeout?: typeof clearTimeout
}

export interface QuitSequenceResult {
  readonly totalMs: number
  readonly skipped: readonly string[]
  readonly failed: readonly string[]
}

/**
 * Runs the steps in order. Each is timed and logged (name and milliseconds only); a step that throws
 * is logged and the next one still runs. A timer set before the first step ends the process once the
 * deadline has passed: it fires while a step is waiting (an `await`), and, since a timer cannot run
 * while the main thread is inside one long synchronous call, the deadline is also checked before each
 * step, so the steps that remain are skipped instead of making the wait longer.
 */
export async function runQuitSequence(
  steps: readonly QuitStep[],
  deps: QuitSequenceDeps,
): Promise<QuitSequenceResult> {
  const now = deps.now ?? (() => performance.now())
  const setTimer = deps.setTimeout ?? setTimeout
  const clearTimer = deps.clearTimeout ?? clearTimeout
  const deadlineMs = deps.deadlineMs ?? 25_000
  const started = now()
  const skipped: string[] = []
  const failed: string[] = []

  const timer = setTimer(() => {
    deps.log.warn('quit', 'deadline', { ms: Math.round(now() - started) })
    deps.forceExit()
  }, deadlineMs)
  ;(timer as { unref?: () => void }).unref?.()

  try {
    for (const step of steps) {
      if (now() - started >= deadlineMs) {
        skipped.push(step.name)
        continue
      }
      const stepStarted = now()
      try {
        await step.run()
        deps.log.info('quit', 'step', { name: step.name, ms: Math.round(now() - stepStarted) })
      } catch (error) {
        failed.push(step.name)
        deps.log.warn('quit', 'step.failed', {
          name: step.name,
          ms: Math.round(now() - stepStarted),
          err: error instanceof Error ? error.message : String(error),
        })
      }
    }
  } finally {
    clearTimer(timer)
  }
  const totalMs = Math.round(now() - started)
  if (skipped.length > 0) deps.log.warn('quit', 'skipped', { names: skipped })
  deps.log.info('quit', 'done', { ms: totalMs })
  return { totalMs, skipped, failed }
}
