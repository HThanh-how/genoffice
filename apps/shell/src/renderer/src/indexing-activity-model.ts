import type { HomeIndexingActivity } from '../../shared/home-api'

/**
 * Pure logic behind the "Document index" popup: which state to show, how often to ask
 * the main process, and an honest ETA. Kept free of React and the DOM so it is unit tested.
 */

export type IndexViewKind =
  'scanning' | 'indexing' | 'downloading' | 'model-error' | 'paused' | 'stopped' | 'done'

export interface IndexView {
  kind: IndexViewKind
  /** 0-100 while the ring can be determinate, otherwise null */
  percent: number | null
  /** files found / total enrolled / finished (ready or failed) / still waiting */
  found: number
  total: number
  finished: number
  ready: number
  pending: number
  /** folders or entries the scan could not read */
  scanErrors: number
  /** files that failed to index, and files that had nothing to read */
  fileErrors: number
  emptyFiles: number
  /** short cause reported by the model, only for 'model-error' */
  modelError: string
  /** something is still running, so the ring should animate */
  active: boolean
}

export function deriveIndexView(activity: HomeIndexingActivity | null): IndexView | null {
  const folder = activity?.folder
  if (!activity || !folder?.root) return null
  const progress = activity.folderProgress
  const pending = progress?.pendingFiles ?? 0
  const total = progress?.totalFiles ?? 0
  const paused = !activity.memory.enabled
  const modelFailure = activity.memory.modelState === 'error' && pending > 0
  const stopped = folder.state === 'stopped'
  let kind: IndexViewKind
  if (paused) kind = 'paused'
  else if (modelFailure) kind = 'model-error'
  else if (folder.running) kind = 'scanning'
  else if (pending > 0)
    kind = activity.memory.modelState === 'downloading' ? 'downloading' : 'indexing'
  else if (stopped) kind = 'stopped'
  else kind = 'done'
  const percent =
    kind === 'done'
      ? 100
      : kind === 'indexing' || kind === 'downloading'
        ? (progress?.percent ?? null)
        : null
  return {
    kind,
    percent,
    found: folder.discovered,
    total,
    finished: Math.max(0, total - pending),
    ready: progress?.readyFiles ?? 0,
    pending,
    scanErrors: folder.errors,
    fileErrors: progress?.errorFiles ?? 0,
    emptyFiles: progress?.emptyFiles ?? 0,
    modelError: kind === 'model-error' ? (activity.memory.lastError ?? '') : '',
    active: kind === 'scanning' || kind === 'indexing' || kind === 'downloading',
  }
}

/** Identity of one scan, so a new scan can be told apart from the same scan updating. */
export function jobKey(activity: HomeIndexingActivity | null): string {
  const folder = activity?.folder
  return folder?.root ? `${folder.root}:${folder.startedAt ?? ''}` : ''
}

/**
 * The panel never opens over the user's work just because indexing started or finished: the
 * small chip is enough for progress. It opens by itself only when a different job begins in
 * the one state that needs the user (the search model failed to load).
 */
export function shouldAutoExpand(
  previousJob: string,
  job: string,
  view: IndexView | null,
): boolean {
  return !!job && job !== previousJob && !!view && view.kind === 'model-error'
}

/** Cheap structural equality for the small activity payload, so ticks that change nothing do not re-render. */
export function activityEqual(
  a: HomeIndexingActivity | null,
  b: HomeIndexingActivity | null,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

export const FAST_POLL_MS = 1000
export const SLOW_POLL_MS = 5000
export const IDLE_POLL_MS = 10_000

/**
 * How long to wait before the next progress request. Fast only while the user can see
 * the numbers move; slow while collapsed; none while the window is hidden.
 */
export function pollDelay(input: {
  expanded: boolean
  visible: boolean
  active: boolean
}): number | null {
  if (!input.visible) return null
  if (input.expanded) return FAST_POLL_MS
  return input.active ? SLOW_POLL_MS : IDLE_POLL_MS
}

export interface AdaptivePoller {
  /** fetch now (unless a request is already in flight) and keep polling */
  kick(): void
  /** re-evaluate the delay after inputs changed, without fetching */
  reschedule(): void
  stop(): void
}

/**
 * A self-rescheduling poll loop: the next request is only scheduled after the previous
 * one settled, so requests never overlap or pile up, and a `null` delay pauses it.
 */
export function createAdaptivePoller(options: {
  fetch: () => Promise<void>
  getDelay: () => number | null
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}): AdaptivePoller {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as number))
  let timer: unknown = null
  let inFlight = false
  let stopped = false
  const clear = () => {
    if (timer !== null) clearTimer(timer)
    timer = null
  }
  const schedule = () => {
    clear()
    if (stopped || inFlight) return
    const delay = options.getDelay()
    if (delay === null) return
    timer = setTimer(() => {
      timer = null
      void run()
    }, delay)
  }
  const run = async () => {
    if (stopped || inFlight) return
    clear()
    inFlight = true
    try {
      await options.fetch()
    } catch {
      // A transient failure keeps the last good state; the next tick retries.
    } finally {
      inFlight = false
      schedule()
    }
  }
  return {
    kick: () => void run(),
    reschedule: schedule,
    stop() {
      stopped = true
      clear()
    },
  }
}

export interface EtaEstimate {
  unit: 'seconds' | 'minutes' | 'hours'
  value: number
}

/**
 * Rolling estimate of time left. It only speaks when the evidence is solid: at least 20 s
 * of samples, a handful of finished files, and a rate that is not swinging (the first and
 * second halves of the window agree within 2x). Otherwise it stays silent rather than guess.
 */
export class EtaTracker {
  private samples: Array<{ at: number; done: number }> = []
  private total = 0

  constructor(
    private readonly windowMs = 120_000,
    private readonly minSpanMs = 20_000,
  ) {}

  reset(): void {
    this.samples = []
    this.total = 0
  }

  record(at: number, done: number, total: number): void {
    const last = this.samples.at(-1)
    if (total !== this.total || (last && (done < last.done || at < last.at))) this.reset()
    this.total = total
    this.samples.push({ at, done })
    const cutoff = at - this.windowMs
    while (this.samples.length > 2 && this.samples[1]!.at < cutoff) this.samples.shift()
  }

  estimate(): EtaEstimate | null {
    const first = this.samples[0]
    const last = this.samples.at(-1)
    if (!first || !last || this.samples.length < 4) return null
    const span = last.at - first.at
    const gained = last.done - first.done
    if (span < this.minSpanMs || gained < 5) return null
    const mid = this.samples[Math.floor(this.samples.length / 2)]!
    const early = (mid.done - first.done) / Math.max(1, mid.at - first.at)
    const late = (last.done - mid.done) / Math.max(1, last.at - mid.at)
    if (early <= 0 || late <= 0) return null
    const ratio = late / early
    if (ratio < 0.5 || ratio > 2) return null
    const rate = gained / span
    const remainingMs = (this.total - last.done) / rate
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null
    const seconds = remainingMs / 1000
    if (seconds > 48 * 3600) return null
    if (seconds < 60) return { unit: 'seconds', value: Math.max(10, Math.round(seconds / 10) * 10) }
    const minutes = seconds / 60
    if (minutes < 90)
      return {
        unit: 'minutes',
        value: minutes < 10 ? Math.round(minutes) : Math.round(minutes / 5) * 5,
      }
    return { unit: 'hours', value: Math.max(2, Math.round(minutes / 60)) }
  }
}
