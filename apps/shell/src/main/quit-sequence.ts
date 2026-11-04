/**
 * The last seconds of the app. Closing the databases of a large index can take several seconds, on
 * the main thread, and a window that is still on screen while that happens is shown by Windows as
 * "Not Responding". So the order is: hide every window as soon as the quit is confirmed, then do the
 * clean-up one step at a time, timing each step, with an overall deadline after which the process
 * is ended (SQLite recovers what is left of a write-ahead log the next time the database is opened).
 *
 * What the deadline cannot do: a timer does not run inside one long synchronous call, so a step that
 * blocks for good (a database closed while another program holds it) is not cut by anything, and
 * the hidden process keeps the single-instance lock until it is ended from outside; the deadline
 * decides about the steps that wait (`await`) and about the optional steps that have not started.
 */

import { access as fsAccess } from 'node:fs/promises'
import { FOLDER_SCAN_FLAG } from './folder-scan-argv'

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
  /**
   * Closing a database, saving a list: skipping it leaves work for the next start. An essential step
   * is never skipped because the deadline has passed, and the process is not ended while one runs
   * (until `hardDeadlineMs`).
   */
  readonly essential?: boolean
}

export interface QuitLog {
  info(cat: string, ev: string, data?: unknown): void
  warn(cat: string, ev: string, data?: unknown): void
}

export interface QuitSequenceDeps {
  readonly log: QuitLog
  /** ends the process now (writes the log first) */
  readonly forceExit: () => void
  /** the clean-up should take no longer than this (default 25 s): optional steps after it are skipped */
  readonly deadlineMs?: number
  /** the process is ended after this long even in the middle of an essential step (default 60 s) */
  readonly hardDeadlineMs?: number
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
  const hardDeadlineMs = Math.max(deadlineMs, deps.hardDeadlineMs ?? 60_000)
  let essentialRunning = false
  const started = now()
  const skipped: string[] = []
  const failed: string[] = []

  // (a timer only fires while a step is waiting: it cannot run inside one long synchronous call)
  const onDeadline = (): void => {
    const elapsed = now() - started
    if (essentialRunning && elapsed < hardDeadlineMs) {
      // an essential step is on its way: let it finish rather than leave its work for the next start
      deps.log.warn('quit', 'deadline.waiting', { ms: Math.round(elapsed) })
      timer = setTimer(onDeadline, hardDeadlineMs - elapsed)
      ;(timer as { unref?: () => void }).unref?.()
      return
    }
    deps.log.warn('quit', 'deadline', { ms: Math.round(elapsed), essentialRunning })
    deps.forceExit()
  }
  let timer = setTimer(onDeadline, deadlineMs)
  ;(timer as { unref?: () => void }).unref?.()

  try {
    for (const step of steps) {
      if (!step.essential && now() - started >= deadlineMs) {
        skipped.push(step.name)
        continue
      }
      const stepStarted = now()
      essentialRunning = step.essential === true
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
    essentialRunning = false
    clearTimer(timer)
  }
  const totalMs = Math.round(now() - started)
  if (skipped.length > 0) deps.log.warn('quit', 'skipped', { names: skipped })
  deps.log.info('quit', 'done', { ms: totalMs })
  return { totalMs, skipped, failed }
}

/** How many windows there are and how many of them can be seen: for the log, to tell where a slow quit stalls. */
export function describeWindows(windows: readonly (QuitWindow & { isVisible?: () => boolean })[]): {
  count: number
  visible: number
} {
  let count = 0
  let visible = 0
  for (const win of windows) {
    try {
      if (win.isDestroyed()) continue
      count++
      if (win.isVisible?.()) visible++
    } catch {
      // going away
    }
  }
  return { count, visible }
}

/**
 * What the copies of the app that were started while this one was closing asked for, kept so that the
 * app can be started again when it has closed: the files to open and the folders to scan, each once.
 * Nothing else of their command lines is kept (a flag such as --inspect, --remote-debugging-port or
 * --user-data-dir must not be handed on to the new process): the caller passes what it has already
 * filtered the same way it filters a second copy that arrives while the app runs.
 */
export class RelaunchRequests {
  private readonly paths = new Set<string>()
  private readonly folders = new Set<string>()
  private requested = false

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  /**
   * Whether the new process would read this as an option: Chromium takes `-x` anywhere, and `/x` as
   * well on Windows (a drive path such as `C:\a.docx` and a network path `\\host\share` are not).
   */
  private looksLikeFlag(value: string): boolean {
    if (value.startsWith('-')) return true
    if (this.platform === 'win32' && value.startsWith('/')) return true
    // a leading space, a quote or a control character could split the value into several arguments
    // (or hide a flag inside it) once the new process's command line is put together
    if (value !== value.trimStart() || value.includes('"')) return true
    for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) < 32) return true
    return false
  }

  private readonly pending = new Set<Promise<unknown>>()

  /** Work that will add to the request (a check of the files); `settled` waits for it. */
  track(work: Promise<unknown>): void {
    this.requested = true
    const done = work.catch(() => undefined).finally(() => this.pending.delete(done))
    this.pending.add(done)
  }

  /** Resolves when the checks have finished, or after `timeoutMs`, whichever comes first. */
  async settled(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    // (a check added while this waits is waited for too, up to the same limit)
    while (this.pending.size > 0) {
      const left = deadline - Date.now()
      if (left <= 0) return
      let timer: NodeJS.Timeout | undefined
      const limit = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, left)
        timer.unref?.()
      })
      await Promise.race([Promise.all([...this.pending]), limit])
      if (timer) clearTimeout(timer)
    }
  }

  add(paths: readonly string[], folders: readonly string[] = []): void {
    this.requested = true
    for (const path of paths) if (path && !this.looksLikeFlag(path)) this.paths.add(path)
    for (const folder of folders)
      if (folder && !this.looksLikeFlag(folder)) this.folders.add(folder)
  }

  get isRequested(): boolean {
    return this.requested
  }

  /** The arguments for `app.relaunch`. */
  toArgs(): string[] {
    return [...this.paths, ...[...this.folders].flatMap((folder) => [FOLDER_SCAN_FLAG, folder])]
  }
}

/**
 * The paths that exist, found without blocking: each is asked of the file system on its own and given
 * `timeoutMs`; a path on a share that does not answer is left out. (`existsSync` on a dead network
 * share holds the main thread for as long as the system waits, which is a long time.)
 */
export async function existingPaths(
  paths: readonly string[],
  timeoutMs = 1500,
  access: (path: string) => Promise<unknown> = (path) => fsAccess(path),
): Promise<string[]> {
  const found = await Promise.all(
    paths.map(async (path) => {
      let timer: NodeJS.Timeout | undefined
      const limit = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
        timer.unref?.()
      })
      try {
        return await Promise.race([access(path).then(() => true as const), limit])
      } catch {
        return false
      } finally {
        if (timer) clearTimeout(timer)
      }
    }),
  )
  return paths.filter((_path, index) => found[index])
}

/**
 * The end of the process, once. The clean-up that finishes and the watchdog that gives up can both
 * get here, one after the other (the watchdog waits a moment for the checks of the files asked for,
 * and the clean-up can finish in that moment): whichever comes first starts the app again if that was
 * asked, and the other does nothing, so the app is not started twice. `exit` runs even if starting
 * the app again throws.
 */
export class ProcessEnd {
  private ended = false

  constructor(
    private readonly requests: RelaunchRequests,
    private readonly actions: {
      relaunch(args: string[]): void
      quit(): void
      exit(): void
    },
  ) {}

  get isEnded(): boolean {
    return this.ended
  }

  end(how: 'quit' | 'exit'): void {
    if (this.ended) return
    this.ended = true
    try {
      if (this.requests.isRequested) this.actions.relaunch(this.requests.toArgs())
    } catch {
      // not starting again must not keep the process from ending
    } finally {
      if (how === 'exit') this.actions.exit()
      else this.actions.quit()
    }
  }
}
