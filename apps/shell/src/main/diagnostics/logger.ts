import { appendFileSync, mkdirSync } from 'node:fs'
import { appendFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { reportDiagnosticsProblem } from './fallback-report'
import { describeError, redactValue, type RedactOptions } from './redact'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** The filesystem calls the logger needs: injected so rotation failures can be tested. */
export interface LogFs {
  appendFile(path: string, text: string): Promise<void>
  mkdir(path: string): Promise<void>
  size(path: string): Promise<number>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  list(dir: string): Promise<string[]>
  appendFileSync(path: string, text: string): void
  mkdirSync(path: string): void
}

export const realLogFs: LogFs = {
  appendFile: (path, text) => appendFile(path, text, 'utf8'),
  mkdir: async (path) => void (await mkdir(path, { recursive: true })),
  size: async (path) => {
    try {
      return (await stat(path)).size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
  },
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
  list: (dir) => readdir(dir),
  appendFileSync: (path, text) => appendFileSync(path, text, 'utf8'),
  mkdirSync: (path) => void mkdirSync(path, { recursive: true }),
}

export interface LoggerOptions {
  /** folder of the log files */
  readonly dir: string
  /** base name: `<name>.jsonl`, `<name>.1.jsonl`, … */
  readonly name?: string
  readonly maxBytes?: number
  /** how many files are kept in total (the live one plus the rotated ones) */
  readonly files?: number
  readonly level?: LogLevel
  readonly verbose?: boolean
  readonly version?: string
  readonly commit?: string
  readonly flushIntervalMs?: number
  readonly flushLines?: number
  /** lines held before the lowest levels start to be dropped (warn and error are kept up to 4x this) */
  readonly maxQueue?: number
  /** the most one asynchronous write carries (default 128 KB): a flood is written in slices */
  readonly chunkBytes?: number
  /** pauses before the retries of a failed write (default 50, 200, 1000 ms) */
  readonly retryDelaysMs?: readonly number[]
  /** after a batch could not be written, no new attempt is started before this (default 5 s) */
  readonly retryBackoffMs?: number
  /** the pauses between attempts to move the live file aside (default 50, 200 ms) */
  readonly rotateRetryDelaysMs?: readonly number[]
  /** after this many batches in a row that could not be written, writing moves to a new file (default 3) */
  readonly switchAfterFailures?: number
  /** one attempt to write (including its preparation) is given up after this long (default 30 s) */
  readonly writeTimeoutMs?: number
  /** an operation stuck for this long is no longer counted against new ones (default 2 min) */
  readonly hungForgetMs?: number
  /** the queue holds at most this many characters (default 16 million) */
  readonly maxQueueBytes?: number
  /** a line longer than this is replaced by a short note (default 16 KB) */
  readonly maxLineChars?: number
  readonly fs?: LogFs
  readonly now?: () => Date
  readonly sleep?: (ms: number) => Promise<void>
  /** lets the event loop run between two slices of a large batch */
  readonly yieldTick?: () => Promise<void>
  readonly pid?: number
  /** where the logger reports its own trouble (default: the fallback file next to the logs + console) */
  readonly onInternalError?: (message: string, error?: unknown) => void
}

export interface LogRecord {
  readonly ts: string
  readonly level: LogLevel
  readonly cat: string
  readonly ev: string
  readonly pid: number
  readonly ver?: string
  readonly commit?: string
  readonly reqId?: string
  readonly data?: unknown
}

/** One span: call `end` when the work is done, `fail` when it threw. */
export interface Span {
  end(extra?: Record<string, unknown>): void
  fail(error: unknown, extra?: Record<string, unknown>): void
}

export interface LoggerStats {
  readonly path: string
  /** lines dropped over the lifetime of the logger (queue full) */
  readonly droppedTotal: number
  /** problems of the logger itself (failed writes, failed rotations) */
  readonly internalErrors: number
}

/** one queued line; `seq` restores the arrival order when the per-level queues are merged */
interface Entry {
  readonly seq: number
  readonly rank: number
  readonly line: string
}

/** One try at writing: set to cancelled when it is given up, so that it changes nothing afterwards. */
interface Attempt {
  cancelled: boolean
  appendStarted: boolean
}

class TimeoutError extends Error {}

/** The write was not tried because earlier operations are still stuck: the drive is the problem, not the file. */
class HungError extends Error {}

/** An operation the file system has not answered. */
interface HungOp {
  readonly at: number
}

/** A first-in first-out list whose removal from the front does not move the rest. */
class Fifo {
  private items: Entry[] = []
  private head = 0
  /** characters held */
  bytes = 0

  get length(): number {
    return this.items.length - this.head
  }

  push(entry: Entry): void {
    this.items.push(entry)
    this.bytes += entry.line.length
  }

  shift(): Entry | undefined {
    const entry = this.items[this.head]
    if (entry === undefined) return undefined
    this.items[this.head++] = undefined as unknown as Entry
    this.bytes -= entry.line.length
    // give the memory back from time to time instead of on every removal
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head)
      this.head = 0
    }
    return entry
  }

  /** Takes everything out, oldest first. */
  drain(): Entry[] {
    const all = this.items.slice(this.head)
    this.items = []
    this.head = 0
    this.bytes = 0
    return all
  }

  /** Puts entries back in front (they are older than everything already here). */
  prepend(entries: Entry[]): void {
    this.items = [...entries, ...this.items.slice(this.head)]
    this.head = 0
    for (const entry of entries) this.bytes += entry.line.length
  }
}

/** Merges lists that are each in `seq` order into one list in `seq` order. */
function mergeBySeq(lists: Entry[][]): Entry[] {
  const out: Entry[] = []
  const at = lists.map(() => 0)
  for (;;) {
    let best = -1
    for (let i = 0; i < lists.length; i++) {
      const entry = lists[i]![at[i]!]
      if (entry && (best < 0 || entry.seq < lists[best]![at[best]!]!.seq)) best = i
    }
    if (best < 0) return out
    out.push(lists[best]![at[best]!++]!)
  }
}

const sleepUnref = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.()
  })

/**
 * The diagnostic log of the app: one JSON object per line, written asynchronously and in batches so
 * a log call never blocks the main thread. The file is rotated by size; when a rotation step fails,
 * that is reported and the logger moves on instead of going silent (a rotation that threw and so
 * stopped every later line is exactly how `main-lag.log` stayed empty for days). A batch that cannot
 * be written is retried and, if it still fails, put back at the front of the queue.
 *
 * Queueing is O(1) per line at every fill level: one list per level (debug, info, warn+error), so
 * making room never scans the queue.
 *
 * Known limit: after `flushSync` (exit, crash) a write that the asynchronous writer had already
 * handed to the operating system may still complete, so a few lines can appear twice; the batch
 * that was re-written is announced by a `flush.resent` line.
 */
export class DiagnosticsLogger {
  private readonly fs: LogFs
  private readonly dir: string
  private readonly name: string
  private readonly maxBytes: number
  private readonly files: number
  private readonly threshold: number
  private readonly redact: RedactOptions
  private readonly flushIntervalMs: number
  private readonly flushLines: number
  private readonly maxQueue: number
  private readonly chunkBytes: number
  private readonly maxLineChars: number
  private readonly maxQueueBytes: number
  private readonly switchAfterFailures: number
  private readonly writeTimeoutMs: number
  private readonly hungForgetMs: number
  private readonly yieldTick: () => Promise<void>
  private readonly retryDelays: readonly number[]
  private readonly retryBackoffMs: number
  private readonly rotateRetryDelays: readonly number[]
  private readonly now: () => Date
  private readonly sleep: (ms: number) => Promise<void>
  private readonly pid: number
  private readonly report: (message: string, error?: unknown) => void

  private readonly debugQ = new Fifo()
  private readonly infoQ = new Fifo()
  private readonly urgentQ = new Fifo() // warn and error
  private seq = 0
  private dropped = 0
  private droppedSince: Date | undefined
  private droppedTotal = 0
  private internalErrors = 0
  private timer: NodeJS.Timeout | undefined
  private timerDelay = Infinity
  /** no timer-driven write before this time (epoch ms): the pause after a failed batch */
  private retryNotBefore = 0
  private chain: Promise<void> = Promise.resolve()
  /** the lines the asynchronous writer has taken out of the queue and may not have finished writing */
  private inflight: { lines: Entry[]; from: number } | undefined
  /** bumped by flushSync: an asynchronous write that started earlier gives up its batch */
  private epoch = 0
  private activePath: string
  private activeSize: number | undefined
  /** a write failed half way: the next chunk starts on a fresh line */
  private tornTail = false
  /** batches in a row that could not be written */
  private failedBatches = 0
  private lastOrphanMs = 0
  /** an asynchronous write is running; a new flush waits for it instead of piling up behind it */
  private draining = false
  /** operations the file system has not answered (given up after the timeout, still pending) */
  private readonly hung = new Set<HungOp>()
  /** the last write may have reached the file although it was reported as failed */
  private maybeDuplicate = false
  private pruning = false
  private pruneDone: Promise<void> = Promise.resolve()
  /** a write is already queued behind the previous one but has not started yet */
  private writeQueued = false
  private drainAgain = false
  private dirReady = false
  private orphansPruned = false
  private closed = false

  constructor(private readonly options: LoggerOptions) {
    this.fs = options.fs ?? realLogFs
    this.dir = options.dir
    this.name = options.name ?? 'genoffice'
    this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024
    this.files = Math.max(2, options.files ?? 5)
    this.threshold = LEVEL_RANK[options.level ?? 'info']
    this.redact = options.verbose ? { verbose: true } : {}
    this.flushIntervalMs = options.flushIntervalMs ?? 250
    this.flushLines = options.flushLines ?? 64
    this.maxQueue = options.maxQueue ?? 10_000
    this.chunkBytes = options.chunkBytes ?? 128 * 1024
    this.maxLineChars = options.maxLineChars ?? 16 * 1024
    this.maxQueueBytes = options.maxQueueBytes ?? 16_000_000
    this.switchAfterFailures = options.switchAfterFailures ?? 3
    this.writeTimeoutMs = options.writeTimeoutMs ?? 30_000
    this.hungForgetMs = options.hungForgetMs ?? 120_000
    this.yieldTick = options.yieldTick ?? (() => new Promise((resolve) => setImmediate(resolve)))
    this.retryDelays = options.retryDelaysMs ?? [50, 200, 1000]
    this.retryBackoffMs = options.retryBackoffMs ?? 5000
    this.rotateRetryDelays = options.rotateRetryDelaysMs ?? [50, 200]
    this.now = options.now ?? (() => new Date())
    this.sleep = options.sleep ?? sleepUnref
    this.pid = options.pid ?? process.pid
    const report = options.onInternalError ?? reportDiagnosticsProblem
    const lastReported = new Map<string, number>()
    this.report = (message, error) => {
      this.internalErrors++
      // the same trouble repeats on every attempt: say it once per 10 s
      const at = Date.now()
      const previous = lastReported.get(message)
      if (previous !== undefined && at - previous < 10_000) return
      if (lastReported.size > 100) lastReported.clear()
      lastReported.set(message, at)
      report(message, error)
    }
    this.activePath = join(this.dir, `${this.name}.jsonl`)
  }

  /** Full path of the live log file (it changes if a rotation could not be done). */
  get path(): string {
    return this.activePath
  }

  /** Lines dropped because the queue was full and not yet reported. */
  get droppedCount(): number {
    return this.dropped
  }

  private get queuedBytes(): number {
    return this.debugQ.bytes + this.infoQ.bytes + this.urgentQ.bytes
  }

  /** Lines waiting to be written. */
  get queued(): number {
    return this.debugQ.length + this.infoQ.length + this.urgentQ.length
  }

  get verbose(): boolean {
    return this.options.verbose === true
  }

  stats(): LoggerStats {
    return {
      path: this.activePath,
      droppedTotal: this.droppedTotal + this.dropped,
      internalErrors: this.internalErrors,
    }
  }

  debug(cat: string, ev: string, data?: unknown): void {
    this.write('debug', cat, ev, data)
  }
  info(cat: string, ev: string, data?: unknown): void {
    this.write('info', cat, ev, data)
  }
  warn(cat: string, ev: string, data?: unknown): void {
    this.write('warn', cat, ev, data)
  }
  error(cat: string, ev: string, data?: unknown): void {
    this.write('error', cat, ev, data)
  }

  /** Times a piece of work: logs `<ev>` with `ms` on end, or `<ev>.failed` (error) with the cause. */
  span(cat: string, ev: string, data?: Record<string, unknown>, level: LogLevel = 'info'): Span {
    const started = performance.now()
    const ms = (): number => Math.round((performance.now() - started) * 10) / 10
    let finished = false
    return {
      end: (extra) => {
        if (finished) return
        finished = true
        this.write(level, cat, ev, { ...data, ...extra, ms: ms() })
      },
      fail: (error, extra) => {
        if (finished) return
        finished = true
        this.write('error', cat, `${ev}.failed`, {
          ...data,
          ...extra,
          ms: ms(),
          err: describeError(error, this.redact),
        })
      },
    }
  }

  /** `at` keeps the original time of a line that was held back before the logger existed. */
  write(level: LogLevel, cat: string, ev: string, data?: unknown, at?: Date): void {
    if (this.closed || LEVEL_RANK[level] < this.threshold) return
    const rank = level === 'error' ? 2 : LEVEL_RANK[level]
    // a full queue that cannot make room for this line: do not even format it
    if (this.queued >= this.maxQueue && !this.canMakeRoom(rank)) {
      this.noteDropped()
      return
    }
    let line: string
    try {
      const clean = data === undefined ? undefined : redactValue(data, this.redact)
      let reqId: string | undefined
      let body = clean
      if (clean && typeof clean === 'object' && !Array.isArray(clean)) {
        const { reqId: id, ...rest } = clean as Record<string, unknown>
        if (typeof id === 'string') {
          reqId = id
          body = Object.keys(rest).length > 0 ? rest : undefined
        }
      }
      const record: LogRecord = {
        ts: (at ?? this.now()).toISOString(),
        level,
        cat,
        ev,
        pid: this.pid,
        ...(this.options.version ? { ver: this.options.version } : {}),
        ...(this.options.commit ? { commit: this.options.commit } : {}),
        ...(reqId ? { reqId } : {}),
        ...(body !== undefined ? { data: body } : {}),
      }
      line = JSON.stringify(record)
      if (line.length > this.maxLineChars) {
        // a line this long is almost certainly content, and would swamp the file
        line = JSON.stringify({
          ...record,
          data: { truncated: true, chars: line.length },
        })
      }
    } catch (error) {
      this.report(`could not format log line ${cat}/${ev}`, error)
      return
    }
    this.enqueue(rank, line)
  }

  private noteDropped(count = 1): void {
    if (this.dropped === 0) this.droppedSince = this.now()
    this.dropped += count
  }

  /** Whether a full queue can still take a line of this rank (by pushing out a lesser one). */
  private canMakeRoom(rank: number): boolean {
    if (rank === 0) return false
    if (this.debugQ.length > 0 || this.infoQ.length > 0) return true
    // only warnings and errors are queued: an info line waits outside, an urgent one may grow the queue
    return rank === 2
  }

  private enqueue(rank: number, line: string): void {
    for (;;) {
      const overCount = this.queued >= this.maxQueue
      const overBytes = this.queuedBytes + line.length > this.maxQueueBytes
      if (!overCount && !overBytes) break
      // Full. Debug goes first, then info; a warning or an error is never pushed out by a lesser
      // line, and only a flood of them (4x the cap, or the byte cap) makes the oldest of those go too.
      if (rank === 0) {
        this.noteDropped()
        return
      }
      if (this.debugQ.shift() || this.infoQ.shift()) {
        this.noteDropped()
      } else if (rank < 2) {
        this.noteDropped()
        return
      } else if (overBytes || this.urgentQ.length >= this.maxQueue * 4) {
        if (!this.urgentQ.shift()) break
        this.noteDropped()
      } else {
        break
      }
    }
    const entry: Entry = { seq: this.seq++, rank, line }
    ;(rank === 0 ? this.debugQ : rank === 1 ? this.infoQ : this.urgentQ).push(entry)
    this.scheduleFlush(this.queued >= this.flushLines ? 0 : this.flushIntervalMs)
  }

  private scheduleFlush(requested: number): void {
    // not before the pause that follows a failed write
    const delay = Math.max(requested, this.retryNotBefore - Date.now())
    // an earlier timer is never pushed back: re-arming on every line would starve the flush
    // for as long as lines keep arriving
    if (this.timer && delay >= this.timerDelay) return
    if (this.timer) clearTimeout(this.timer)
    this.timerDelay = delay
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.timerDelay = Infinity
      void this.flush(false)
    }, delay)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
      this.timerDelay = Infinity
    }
  }

  /**
   * Writes what is queued. Resolves when the file has it (or the failure was reported). While a
   * write is running a second call does not queue another one behind it (that would pile up
   * without end on a drive that never answers): it asks the running write for one more pass.
   */
  flush(force = true): Promise<void> {
    this.clearTimer()
    // the timer does not start a write inside the pause that follows a failed one; a caller that
    // asks for a flush itself (closing, tests) is not held back
    if (!force && Date.now() < this.retryNotBefore) {
      this.scheduleFlush(this.retryNotBefore - Date.now())
      return this.chain
    }
    if (this.draining || this.writeQueued) {
      this.drainAgain = true
      return this.chain
    }
    this.writeQueued = true
    this.chain = this.chain
      .then(async () => {
        this.writeQueued = false
        this.draining = true
        try {
          do {
            this.drainAgain = false
            if (!(await this.drain())) break
          } while (this.drainAgain)
        } finally {
          this.draining = false
        }
      })
      .catch((error) => {
        this.writeQueued = false
        this.draining = false
        this.report('flush failed', error)
      })
    return this.chain
  }

  private takeBatch(): Entry[] {
    const entries = mergeBySeq([this.debugQ.drain(), this.infoQ.drain(), this.urgentQ.drain()])
    if (this.dropped > 0) {
      entries.push({
        seq: this.seq++,
        rank: 2,
        line: JSON.stringify({
          ts: this.now().toISOString(),
          level: 'warn',
          cat: 'logger',
          ev: 'dropped',
          pid: this.pid,
          data: { lines: this.dropped, since: this.droppedSince?.toISOString() },
        }),
      })
      this.droppedTotal += this.dropped
      this.dropped = 0
      this.droppedSince = undefined
    }
    return entries
  }

  /** Puts a batch that could not be written back in front of what was queued since, within the caps. */
  private requeue(entries: Entry[]): void {
    const byRank: Entry[][] = [[], [], []]
    for (const entry of entries) byRank[entry.rank]!.push(entry)
    this.debugQ.prepend(byRank[0]!)
    this.infoQ.prepend(byRank[1]!)
    this.urgentQ.prepend(byRank[2]!)
    let dropped = 0
    while (
      (this.queued > this.maxQueue || this.queuedBytes > this.maxQueueBytes) &&
      (this.debugQ.shift() || this.infoQ.shift())
    ) {
      dropped++
    }
    while (
      (this.urgentQ.length > this.maxQueue * 4 || this.queuedBytes > this.maxQueueBytes) &&
      this.urgentQ.shift()
    ) {
      dropped++
    }
    if (dropped > 0) this.noteDropped(dropped)
  }

  /**
   * Writes a batch in slices of at most `chunkBytes`, with a turn of the event loop between two
   * slices, so a flood is neither written as one huge block (which would push a file far past its
   * size limit) nor joined and handed over in one long step.
   */
  private async drain(): Promise<boolean> {
    const entries = this.takeBatch()
    if (entries.length === 0) return true
    const epoch = this.epoch
    const inflight = { lines: entries, from: 0 }
    this.inflight = inflight
    while (inflight.from < entries.length) {
      let end = inflight.from
      let bytes = 0
      while (end < entries.length) {
        const size = Buffer.byteLength(entries[end]!.line, 'utf8') + 1
        if (bytes > 0 && bytes + size > this.chunkBytes) break
        bytes += size
        end++
      }
      const text = `${entries
        .slice(inflight.from, end)
        .map((e) => e.line)
        .join('\n')}\n`
      const outcome = await this.writeChunk(text, bytes, epoch)
      if (outcome === 'superseded') return true
      if (outcome !== 'ok') {
        this.inflight = undefined
        const rest = entries.slice(inflight.from)
        this.report(
          `could not write ${this.activePath}; ${rest.length > 0 ? 'the lines are' : 'nothing'} kept for the next flush`,
          outcome.error,
        )
        this.requeue(rest)
        // try again later, not at the next log call
        this.retryNotBefore = Date.now() + this.retryBackoffMs
        // a shorter timer set while this write was running must not survive: it would start the
        // next attempt inside the pause
        this.clearTimer()
        this.scheduleFlush(this.retryBackoffMs)
        // a file that refuses every write (held open by another program without the right to write)
        // is given up after a few tries: writing goes on in a new file
        // a drive that does not answer says nothing about this file: only real write errors count
        if (
          !(outcome.error instanceof HungError) &&
          ++this.failedBatches >= this.switchAfterFailures
        ) {
          await this.switchToNewFile()
        }
        return false
      }
      this.failedBatches = 0
      inflight.from = end
      if (end < entries.length) await this.yieldTick()
      if (epoch !== this.epoch) return true
    }
    this.inflight = undefined
    return true
  }

  private async switchToNewFile(): Promise<void> {
    const next = this.orphanPath()
    this.report(`${this.activePath} refuses every write; continuing in ${next}`)
    this.activePath = next
    this.activeSize = 0
    this.tornTail = false
    this.failedBatches = 0
    this.pruneInBackground(this.orphanKeep)
  }

  /**
   * An attempt that does not finish (a dead network drive) is given up, so the writer is not stuck
   * for good. The work cannot be cancelled, but it is told (`attempt.cancelled`) so that it stops
   * before its next step and changes nothing; and the number of operations the file system still
   * has not answered is counted, so that a dead drive cannot take every thread of the pool.
   */
  private withTimeout<T>(work: (attempt: Attempt) => Promise<T>): Promise<T> {
    const attempt: Attempt = { cancelled: false, appendStarted: false }
    return new Promise<T>((resolve, reject) => {
      let settled = false
      let hungOp: HungOp | undefined
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        attempt.cancelled = true
        // the write itself may still go through later
        if (attempt.appendStarted) this.maybeDuplicate = true
        hungOp = { at: Date.now() }
        this.hung.add(hungOp)
        reject(new TimeoutError(`no answer from the file system after ${this.writeTimeoutMs} ms`))
      }, this.writeTimeoutMs)
      timer.unref?.()
      work(attempt).then(
        (value) => {
          clearTimeout(timer)
          if (attempt.cancelled) this.hung.delete(hungOp!)
          else {
            settled = true
            resolve(value)
          }
        },
        (error: unknown) => {
          clearTimeout(timer)
          if (attempt.cancelled) this.hung.delete(hungOp!)
          else {
            settled = true
            reject(error)
          }
        },
      )
    })
  }

  private async writeChunk(
    text: string,
    bytes: number,
    epoch: number,
  ): Promise<'ok' | 'superseded' | { error: unknown }> {
    let lastError: unknown
    for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
      if (epoch !== this.epoch) return 'superseded' // flushSync owns the in-flight lines now
      if (this.hungCount() >= 2) {
        // earlier operations are still stuck in the thread pool: start no new ones
        return {
          error: new HungError(
            `the file system is not answering (${this.hungCount()} operations pending)`,
          ),
        }
      }
      try {
        return await this.withTimeout(async (job) => {
          const stale = (): boolean => job.cancelled || epoch !== this.epoch
          await this.ensureDir()
          if (stale()) return 'superseded' as const
          this.pruneOrphansOnce()
          if (this.activeSize === undefined) this.activeSize = await this.fs.size(this.activePath)
          if (stale()) return 'superseded' as const
          if (this.activeSize > 0 && this.activeSize + bytes > this.maxBytes) {
            await this.rotate(epoch, job)
          }
          // flushSync may have written this very batch, or this attempt may have been given up,
          // while the awaits above were pending
          if (stale()) return 'superseded' as const
          // after a half-written append the file may end in the middle of a line
          let out = this.tornTail ? `\n${text}` : text
          const withMarker = this.maybeDuplicate
          if (withMarker) {
            // an earlier attempt may have reached the file after all: say so, so that a reader can
            // tell a repeated line from a new one
            out = `${this.markerLine('flush.maybeDuplicate')}\n${out}`
          }
          job.appendStarted = true
          await this.fs.appendFile(this.activePath, out)
          if (job.cancelled) return 'superseded' as const
          if (withMarker) this.maybeDuplicate = false
          this.tornTail = false
          this.activeSize = (this.activeSize ?? 0) + Buffer.byteLength(out, 'utf8')
          return epoch === this.epoch ? ('ok' as const) : ('superseded' as const)
        })
      } catch (error) {
        lastError = error
        this.tornTail = true
        // the size may be stale after a failure: read it again next time
        this.activeSize = undefined
        // a drive that does not answer is not asked again at once
        if (error instanceof TimeoutError) break
        const delay = this.retryDelays[attempt]
        if (delay === undefined) break
        await this.sleep(delay)
      }
    }
    return epoch === this.epoch ? { error: lastError } : 'superseded'
  }

  /**
   * How many operations the file system has not answered. One that has been stuck for a long time
   * is forgotten: it may never end, and the logger must be able to try again some day.
   */
  private hungCount(): number {
    const now = Date.now()
    for (const op of this.hung) {
      if (now - op.at > this.hungForgetMs) this.hung.delete(op)
    }
    return this.hung.size
  }

  private markerLine(ev: string): string {
    return JSON.stringify({
      ts: this.now().toISOString(),
      level: 'warn',
      cat: 'logger',
      ev,
      pid: this.pid,
    })
  }

  private async ensureDir(): Promise<void> {
    if (this.dirReady) return
    await this.fs.mkdir(this.dir)
    this.dirReady = true
  }

  private rotated(index: number): string {
    return join(this.dir, `${this.name}.${index}.jsonl`)
  }

  /** `name.<epoch ms>.jsonl`: a file set aside, or started, when the numbered chain could not take it. */
  private isOrphan(file: string): boolean {
    const escaped = this.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`^${escaped}\\.\\d{10,}\\.jsonl$`).test(file)
  }

  private orphanPath(): string {
    // two in the same millisecond would overwrite one another
    this.lastOrphanMs = Math.max(this.now().getTime(), this.lastOrphanMs + 1)
    return join(this.dir, `${this.name}.${this.lastOrphanMs}.jsonl`)
  }

  /**
   * How many `name.<ms>.jsonl` files are kept: as many as the numbered chain has older slots, so the
   * history that survives is the same whether the chain turns or is blocked by a held file.
   */
  private get orphanKeep(): number {
    return Math.max(2, this.files - 1)
  }

  /** Old fallback files are not part of the numbered chain, so they are cleaned up here. */
  private async pruneOrphans(keep: number): Promise<void> {
    let names: string[]
    try {
      names = await this.fs.list(this.dir)
    } catch (error) {
      this.report(`could not list ${this.dir}`, error)
      return
    }
    const orphans = names.filter((n) => this.isOrphan(n)).sort() // epoch ms sorts as text
    for (const old of orphans.slice(0, Math.max(0, orphans.length - keep))) {
      await this.removeQuietly(join(this.dir, old))
    }
  }

  private pruneOrphansOnce(): void {
    if (this.orphansPruned) return
    this.orphansPruned = true
    this.pruneInBackground(this.orphanKeep)
  }

  /**
   * Pruning only tidies up: it runs beside the writer and never holds it (listing a folder on a
   * hanging drive must not stop the log for good), one at a time, and gives up after the timeout.
   */
  private pruneInBackground(keep: number): void {
    // tidying is the first thing to give way: never add to operations the drive has not answered
    if (this.pruning || this.hungCount() >= 1) return
    this.pruning = true
    this.pruneDone = this.withTimeout(() => this.pruneOrphans(keep))
      .catch((error: unknown) => this.report('could not prune old log files', error))
      .finally(() => {
        this.pruning = false
      })
  }

  /** Resolves when the writing and the tidying that are running now are over. For tests and shutdown. */
  async settled(): Promise<void> {
    await this.chain
    await this.pruneDone
  }

  /** A rename that is tried again after short pauses: a scanner may hold the file for a moment. */
  private async renameWithRetry(from: string, to: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.fs.rename(from, to)
        return
      } catch (error) {
        const delay = this.rotateRetryDelays[attempt]
        if (delay === undefined) throw error
        await this.sleep(delay)
      }
    }
  }

  /**
   * `name.jsonl` -> `name.1.jsonl` -> … The live file is moved aside FIRST (with retries): if it
   * cannot be moved the numbered chain is left exactly as it is (shifting it first would wear away
   * the older files at every start while the live one stays stuck), the logger continues in a new
   * file next to it and the old fallback files are pruned. The live file itself is never deleted or
   * emptied: the lines in it are worth more than the space. Once it is aside, the chain is shifted
   * and the file takes the first slot; if that slot is held by someone else the file stays where it
   * is, as a `name.<ms>.jsonl` file.
   */
  private async rotate(epoch: number, job: Attempt): Promise<void> {
    if (epoch !== this.epoch || job.cancelled) return
    const aside = this.orphanPath()
    try {
      await this.renameWithRetry(this.activePath, aside)
    } catch (error) {
      // an attempt that was given up changes nothing any more
      if (job.cancelled || epoch !== this.epoch) return
      const next = this.orphanPath()
      this.report(`could not move ${this.activePath} aside; continuing in ${next}`, error)
      this.activePath = next
      this.activeSize = 0
      this.tornTail = false
      this.pruneInBackground(this.orphanKeep)
      return
    }
    if (!job.cancelled) this.activeSize = 0
    const oldest = this.files - 1
    let shifted = true
    for (let index = oldest - 1; index >= 1; index--) {
      if (job.cancelled) return // the file stays where it is, as a set-aside file
      if (!(await this.moveQuietly(this.rotated(index), this.rotated(index + 1)))) {
        // a slot is held by someone else: stop here, the files below it stay where they are
        shifted = false
        break
      }
    }
    if (shifted && !job.cancelled) {
      try {
        await this.fs.rename(aside, this.rotated(1))
        return
      } catch (error) {
        this.report(`could not put ${aside} in the first slot`, error)
      }
    }
    // the file stays where it is, as a `name.<ms>.jsonl` file
    this.pruneInBackground(this.orphanKeep)
  }

  private async removeIfExists(path: string): Promise<void> {
    try {
      await this.fs.unlink(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async removeQuietly(path: string): Promise<void> {
    try {
      await this.removeIfExists(path)
    } catch (error) {
      this.report(`could not remove old log ${path}`, error)
    }
  }

  /**
   * Moves `from` over `to` (a rename replaces the target, so nothing is deleted first: a target
   * that cannot be replaced stays as it is). Returns false when it could not; the caller then stops
   * shifting the chain, since going on would leave a hole and lose a file.
   */
  private async moveQuietly(from: string, to: string): Promise<boolean> {
    try {
      await this.fs.rename(from, to)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true // nothing to move
      this.report(`could not move log ${from} to ${to}`, error)
      return false
    }
  }

  /**
   * Writes everything still held, synchronously and in order: the batch the asynchronous writer may
   * not have finished (it is written again, behind a marker line, because there is no way to know
   * whether the asynchronous write got through), then the queue. For the moment the process is
   * exiting or has just failed. The asynchronous writer carries on afterwards (a quit can still be
   * cancelled); calling this again writes only what is new. If the write fails the lines go back to
   * the queue.
   */
  flushSync(): void {
    this.epoch++
    this.clearTimer()
    const held = this.inflight
    this.inflight = undefined
    const resend = held ? held.lines.slice(held.from) : []
    const fresh = this.takeBatch()
    const entries = [...resend, ...fresh]
    if (entries.length === 0) return
    if (this.hungCount() > 0) {
      // the drive is not answering: a synchronous write would hold the main thread for as long
      this.report('the file system is not answering; the last lines are not written on exit')
      this.requeue(entries)
      return
    }
    const lines: string[] = []
    if (resend.length > 0) {
      lines.push(
        JSON.stringify({
          ts: this.now().toISOString(),
          level: 'warn',
          cat: 'logger',
          ev: 'flush.resent',
          pid: this.pid,
          data: { lines: resend.length },
        }),
      )
    }
    for (const entry of entries) lines.push(entry.line)
    try {
      this.fs.mkdirSync(dirname(this.activePath))
      const text = `${this.tornTail ? '\n' : ''}${lines.join('\n')}\n`
      this.fs.appendFileSync(this.activePath, text)
      this.tornTail = false
      if (this.activeSize !== undefined) this.activeSize += Buffer.byteLength(text, 'utf8')
    } catch (error) {
      this.tornTail = true
      this.report(`could not write ${this.activePath} on exit`, error)
      this.requeue(entries)
    }
  }

  /** Writes what is queued and stops accepting lines. */
  async close(): Promise<void> {
    // lines that arrive while the last write runs are written too
    for (let pass = 0; pass < 3; pass++) {
      await this.flush()
      if (this.queued === 0) break
    }
    this.closed = true
  }
}
