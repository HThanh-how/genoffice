export type LegacyConvertMode = 'off' | 'all'
export type LegacyConvertOutcome = 'converted' | 'skipped' | 'failed' | 'busy'

export interface LegacyConverterState {
  running: boolean
  pending: number
  converted: number
  failed: number
}

const EXTENSIONS: Record<Exclude<LegacyConvertMode, 'off'>, readonly string[]> = {
  all: ['.xls', '.doc', '.ppt'],
}

interface Deps {
  mode(): LegacyConvertMode
  /** indexed files with these extensions that are still in the old format */
  list(extensions: readonly string[], limit: number): string[]
  convert(path: string): Promise<LegacyConvertOutcome>
  /** battery, sleep or a locked screen: wait without converting */
  paused(): boolean
  wait(ms: number): Promise<void>
  onState?(state: LegacyConverterState): void
  /** files converted at the same time (default: CONVERT_CONCURRENCY) */
  concurrency?: number
}

const PAUSE_MS = 30_000
/** The service answered "busy" or "limit": every worker waits this long, then the same file is tried again. */
export const BUSY_PAUSE_MS = 60_000
const BATCH = 200
/**
 * People open GenOffice rarely, so the old files have to be converted as fast as the service can
 * take them. The service converts four at a time; asking for four at a time keeps it full without
 * making the computers queue behind each other for long.
 */
export const CONVERT_CONCURRENCY = 4

/**
 * Turns the old-format files of the index (.doc, .xls, .ppt) into .docx/.xlsx/.pptx, several at a
 * time, in the background. Once a file is converted the original goes to the recovery folder, so
 * the index sees only the new file.
 */
export class LegacyConverter {
  private running = false
  private converted = 0
  private readonly failed = new Set<string>()
  /** not ready yet (recently changed): asked again on the next start */
  private readonly skipped = new Set<string>()
  /** converted in this run: the index may still list them until it notices the move */
  private readonly handled = new Set<string>()
  /** being converted right now by one of the workers */
  private readonly inFlight = new Set<string>()
  private queue: string[] = []
  /** while set, no worker starts a file: the service asked for a pause */
  private coolDown: Promise<void> | null = null
  private pending = 0

  constructor(private readonly deps: Deps) {}

  state(): LegacyConverterState {
    return {
      running: this.running,
      pending: this.pending,
      converted: this.converted,
      failed: this.failed.size,
    }
  }

  /** Start (or continue) converting; safe to call as often as wanted. */
  kick(): void {
    if (this.running || this.deps.mode() === 'off') return
    this.running = true
    this.skipped.clear()
    this.queue = []
    const workers = Math.max(1, this.deps.concurrency ?? CONVERT_CONCURRENCY)
    void Promise.all(Array.from({ length: workers }, () => this.worker())).finally(() => {
      this.running = false
      this.publish()
    })
  }

  private publish(): void {
    this.deps.onState?.(this.state())
  }

  private isDone(path: string): boolean {
    return (
      this.failed.has(path) ||
      this.skipped.has(path) ||
      this.handled.has(path) ||
      this.inFlight.has(path)
    )
  }

  /** The next file for a worker, or null when there is nothing left to do. */
  private async next(): Promise<string | null> {
    for (;;) {
      const mode = this.deps.mode()
      if (mode === 'off') return null
      if (this.coolDown) {
        await this.coolDown
        continue
      }
      if (this.queue.length === 0) {
        // no await between looking at the queue and filling it, so two workers never both refill
        // The index keeps listing a file for a while after it was converted and moved, so the
        // newest rows can all be files already done: ask for enough rows to get past them.
        const limit =
          BATCH + this.handled.size + this.failed.size + this.skipped.size + this.inFlight.size
        const todo = this.deps.list(EXTENSIONS[mode], limit).filter((path) => !this.isDone(path))
        this.pending = todo.length + this.inFlight.size
        this.publish()
        if (todo.length === 0) return null
        this.queue = todo
      }
      if (this.deps.paused()) {
        await this.deps.wait(PAUSE_MS)
        continue
      }
      const path = this.queue.shift()
      if (path !== undefined && !this.isDone(path)) {
        // marked at once, before the caller resumes, so another worker refilling the queue
        // cannot hand the same file out again
        this.inFlight.add(path)
        return path
      }
    }
  }

  private async worker(): Promise<void> {
    for (;;) {
      const path = await this.next()
      if (path === null) return
      let outcome: LegacyConvertOutcome
      try {
        outcome = await this.deps.convert(path)
      } catch {
        outcome = 'failed'
      }
      this.inFlight.delete(path)
      if (outcome === 'busy') {
        // not this file's fault: put it back at the front and let everyone wait out the pause
        this.queue.unshift(path)
        this.coolDown ??= this.deps.wait(BUSY_PAUSE_MS).then(() => {
          this.coolDown = null
        })
        continue
      }
      if (outcome === 'converted') {
        this.converted++
        this.handled.add(path)
      } else if (outcome === 'skipped') this.skipped.add(path)
      else this.failed.add(path)
      this.publish()
    }
  }
}
