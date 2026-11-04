import { appendFileSync, mkdirSync } from 'node:fs'
import { appendFile, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
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
  truncate(path: string): Promise<void>
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
  truncate: (path) => writeFile(path, ''),
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

/** one queued line with its level, so eviction never has to look inside the text */
interface Entry {
  readonly rank: number
  readonly line: string
}

/**
 * The diagnostic log of the app: one JSON object per line, written asynchronously and in batches so
 * a log call never blocks the main thread. The file is rotated by size; when a rotation step fails,
 * that is reported and the logger moves on instead of going silent (a rotation that threw and so
 * stopped every later line is exactly how `main-lag.log` stayed empty for days). A batch that cannot
 * be written is retried and, if it still fails, put back at the front of the queue.
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
  private readonly yieldTick: () => Promise<void>
  private readonly retryDelays: readonly number[]
  private readonly now: () => Date
  private readonly sleep: (ms: number) => Promise<void>
  private readonly pid: number
  private readonly report: (message: string, error?: unknown) => void

  private queue: Entry[] = []
  private dropped = 0
  private droppedAt: Date | undefined
  private droppedTotal = 0
  private internalErrors = 0
  private timer: NodeJS.Timeout | undefined
  private timerDelay = Infinity
  private chain: Promise<void> = Promise.resolve()
  /** the lines the asynchronous writer has taken out of the queue and may not have finished writing */
  private inflight: { lines: Entry[]; from: number } | undefined
  /** bumped by flushSync: an asynchronous write that started earlier gives up its batch */
  private epoch = 0
  private activePath: string
  private activeSize: number | undefined
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
    this.yieldTick = options.yieldTick ?? (() => new Promise((resolve) => setImmediate(resolve)))
    this.retryDelays = options.retryDelaysMs ?? [50, 200, 1000]
    this.now = options.now ?? (() => new Date())
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.pid = options.pid ?? process.pid
    const report = options.onInternalError ?? reportDiagnosticsProblem
    this.report = (message, error) => {
      this.internalErrors++
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
    } catch (error) {
      this.report(`could not format log line ${cat}/${ev}`, error)
      return
    }
    this.enqueue(LEVEL_RANK[level], line)
  }

  private noteDropped(): void {
    if (this.dropped === 0) this.droppedAt = this.now()
    this.dropped++
  }

  private enqueue(rank: number, line: string): void {
    if (this.queue.length >= this.maxQueue) {
      // Full. Debug goes first, then info; a warning or an error is never pushed out by a lesser
      // line, and only a flood of them (4x the cap) makes the oldest of those go too.
      if (rank === 0) {
        this.noteDropped()
        return
      }
      let at = this.queue.findIndex((e) => e.rank === 0)
      if (at < 0) at = this.queue.findIndex((e) => e.rank === 1)
      if (at >= 0) {
        this.queue.splice(at, 1)
        this.noteDropped()
      } else if (rank === 1) {
        this.noteDropped()
        return
      } else if (this.queue.length >= this.maxQueue * 4) {
        this.queue.shift()
        this.noteDropped()
      }
    }
    this.queue.push({ rank, line })
    this.scheduleFlush(this.queue.length >= this.flushLines ? 0 : this.flushIntervalMs)
  }

  private scheduleFlush(delay: number): void {
    // an earlier timer is never pushed back: re-arming on every line would starve the flush
    // for as long as lines keep arriving
    if (this.timer && delay >= this.timerDelay) return
    if (this.timer) clearTimeout(this.timer)
    this.timerDelay = delay
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.timerDelay = Infinity
      void this.flush()
    }, delay)
    this.timer.unref?.()
  }

  /** Writes what is queued. Resolves when the file has it (or the failure was reported). */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
      this.timerDelay = Infinity
    }
    this.chain = this.chain
      .then(() => this.drain())
      .catch((error) => {
        this.report('flush failed', error)
      })
    return this.chain
  }

  private takeBatch(): Entry[] {
    const entries = this.queue
    this.queue = []
    if (this.dropped > 0) {
      entries.push({
        rank: 2,
        line: JSON.stringify({
          ts: (this.droppedAt ?? this.now()).toISOString(),
          level: 'warn',
          cat: 'logger',
          ev: 'dropped',
          pid: this.pid,
          data: { lines: this.dropped },
        }),
      })
      this.droppedTotal += this.dropped
      this.dropped = 0
      this.droppedAt = undefined
    }
    return entries
  }

  /** Puts a batch that could not be written back in front of what was queued since, within the cap. */
  private requeue(entries: Entry[]): void {
    const merged = [...entries, ...this.queue]
    let over = merged.length - this.maxQueue
    if (over <= 0) {
      this.queue = merged
      return
    }
    // drop the lowest levels first, oldest first within a level
    for (const rank of [0, 1]) {
      for (let i = 0; i < merged.length && over > 0;) {
        if (merged[i]!.rank === rank) {
          merged.splice(i, 1)
          over--
          this.droppedTotal++
        } else {
          i++
        }
      }
    }
    this.queue = merged
  }

  /**
   * Writes a batch in slices of at most `chunkBytes`, with a turn of the event loop between two
   * slices, so a flood is neither written as one huge block (which would push a file far past its
   * size limit) nor joined and handed over in one long step.
   */
  private async drain(): Promise<void> {
    const entries = this.takeBatch()
    if (entries.length === 0) return
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
      if (outcome === 'superseded') return
      if (outcome !== 'ok') {
        this.inflight = undefined
        const rest = entries.slice(inflight.from)
        this.report(
          `could not write ${this.activePath} (${rest.length} lines kept for the next flush)`,
          outcome.error,
        )
        this.requeue(rest)
        // try again later instead of waiting for the next log call
        this.scheduleFlush(Math.max(this.flushIntervalMs, 5000))
        return
      }
      inflight.from = end
      if (end < entries.length) await this.yieldTick()
      if (epoch !== this.epoch) return
    }
    this.inflight = undefined
  }

  private async writeChunk(
    text: string,
    bytes: number,
    epoch: number,
  ): Promise<'ok' | 'superseded' | { error: unknown }> {
    let lastError: unknown
    for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
      if (epoch !== this.epoch) return 'superseded' // flushSync owns the in-flight lines now
      try {
        await this.ensureDir()
        await this.pruneOrphansOnce()
        if (this.activeSize === undefined) this.activeSize = await this.fs.size(this.activePath)
        if (this.activeSize > 0 && this.activeSize + bytes > this.maxBytes) await this.rotate()
        await this.fs.appendFile(this.activePath, text)
        this.activeSize = (this.activeSize ?? 0) + bytes
        return epoch === this.epoch ? 'ok' : 'superseded'
      } catch (error) {
        lastError = error
        // the size may be stale after a failure: read it again next time
        this.activeSize = undefined
        const delay = this.retryDelays[attempt]
        if (delay === undefined) break
        await this.sleep(delay)
      }
    }
    return epoch === this.epoch ? { error: lastError } : 'superseded'
  }

  private async ensureDir(): Promise<void> {
    if (this.dirReady) return
    await this.fs.mkdir(this.dir)
    this.dirReady = true
  }

  private rotated(index: number): string {
    return join(this.dir, `${this.name}.${index}.jsonl`)
  }

  /** `name.<epoch ms>.jsonl`: the file started when the live one could not be moved or emptied. */
  private isOrphan(file: string): boolean {
    const escaped = this.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`^${escaped}\\.\\d{10,}\\.jsonl$`).test(file)
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

  private async pruneOrphansOnce(): Promise<void> {
    if (this.orphansPruned) return
    this.orphansPruned = true
    await this.pruneOrphans(1)
  }

  /**
   * `name.jsonl` -> `name.1.jsonl` -> … Each step is its own try. If the live file cannot be moved
   * the cause is reported, then the file is deleted or emptied so it cannot be found full again at
   * the next start; only when even that fails does the logger start a new file next to it (and the
   * old fallback files are pruned, so they cannot pile up).
   */
  private async rotate(): Promise<void> {
    const oldest = this.files - 1
    await this.removeQuietly(this.rotated(oldest))
    for (let index = oldest - 1; index >= 1; index--) {
      await this.moveQuietly(this.rotated(index), this.rotated(index + 1))
    }
    try {
      await this.removeIfExists(this.rotated(1))
      await this.fs.rename(this.activePath, this.rotated(1))
      this.activeSize = 0
      return
    } catch (error) {
      this.report(`could not rotate ${this.activePath}`, error)
    }
    try {
      await this.removeIfExists(this.activePath)
      this.activeSize = 0
      return
    } catch {
      // locked: try to empty it instead
    }
    try {
      await this.fs.truncate(this.activePath)
      this.activeSize = 0
      return
    } catch (error) {
      const next = join(this.dir, `${this.name}.${this.now().getTime()}.jsonl`)
      this.report(`could not empty ${this.activePath}; continuing in ${next}`, error)
      this.activePath = next
      this.activeSize = 0
      await this.pruneOrphans(2)
    }
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

  private async moveQuietly(from: string, to: string): Promise<void> {
    try {
      await this.removeIfExists(to)
      await this.fs.rename(from, to)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      this.report(`could not move log ${from} to ${to}`, error)
    }
  }

  /**
   * Writes everything still held, synchronously and in order: the batch the asynchronous writer may
   * not have finished (it is written again, behind a marker line, because there is no way to know
   * whether the asynchronous write got through), then the queue. For the moment the process is
   * exiting or has just failed. The asynchronous writer carries on afterwards (a quit can still be
   * cancelled); calling this again writes only what is new.
   */
  flushSync(): void {
    this.epoch++
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
      this.timerDelay = Infinity
    }
    const held = this.inflight
    this.inflight = undefined
    const resend = held ? held.lines.slice(held.from).map((e) => e.line) : []
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
        ...resend,
      )
    }
    lines.push(...this.takeBatch().map((e) => e.line))
    if (lines.length === 0) return
    try {
      this.fs.mkdirSync(dirname(this.activePath))
      const text = `${lines.join('\n')}\n`
      this.fs.appendFileSync(this.activePath, text)
      if (this.activeSize !== undefined) this.activeSize += Buffer.byteLength(text, 'utf8')
    } catch (error) {
      this.report(`could not write ${this.activePath} on exit`, error)
    }
  }

  /** Writes what is queued and stops accepting lines. */
  async close(): Promise<void> {
    await this.flush()
    this.closed = true
  }
}
