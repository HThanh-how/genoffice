import { appendFileSync, mkdirSync } from 'node:fs'
import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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
  readonly maxQueue?: number
  readonly fs?: LogFs
  readonly now?: () => Date
  readonly pid?: number
  /** where the logger reports its own trouble (default: stderr). Never swallowed silently. */
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

/**
 * The diagnostic log of the app: one JSON object per line, written asynchronously and in batches so
 * a log call never blocks the main thread. The file is rotated by size; when a rotation step fails,
 * that is reported and the logger moves on to a fresh file instead of going silent (a rotation that
 * threw and so stopped every later line is exactly how `main-lag.log` stayed empty for days).
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
  private readonly now: () => Date
  private readonly pid: number
  private readonly report: (message: string, error?: unknown) => void

  private queue: string[] = []
  private dropped = 0
  private timer: NodeJS.Timeout | undefined
  private chain: Promise<void> = Promise.resolve()
  private activePath: string
  private activeSize: number | undefined
  private dirReady = false
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
    this.maxQueue = options.maxQueue ?? 2000
    this.now = options.now ?? (() => new Date())
    this.pid = options.pid ?? process.pid
    this.report =
      options.onInternalError ??
      ((message, error) => console.error(`[diagnostics] ${message}`, error ?? ''))
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

  write(level: LogLevel, cat: string, ev: string, data?: unknown): void {
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
        ts: this.now().toISOString(),
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
    this.enqueue(level, line)
  }

  private enqueue(level: LogLevel, line: string): void {
    if (this.queue.length >= this.maxQueue) {
      // full: debug lines go first, then the oldest line, so errors survive a flood
      if (level === 'debug') {
        this.dropped++
        return
      }
      const debugAt = this.queue.findIndex((l) => l.includes('"level":"debug"'))
      this.queue.splice(debugAt >= 0 ? debugAt : 0, 1)
      this.dropped++
    }
    this.queue.push(line)
    if (this.queue.length >= this.flushLines) {
      this.scheduleFlush(0)
    } else {
      this.scheduleFlush(this.flushIntervalMs)
    }
  }

  private scheduleFlush(delay: number): void {
    if (this.timer && delay > 0) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, delay)
    this.timer.unref?.()
  }

  /** Writes what is queued. Resolves when the file has it (or the failure was reported). */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.chain = this.chain
      .then(() => this.drain())
      .catch((error) => {
        this.report('flush failed', error)
      })
    return this.chain
  }

  private takeBatch(): string | undefined {
    if (this.queue.length === 0 && this.dropped === 0) return undefined
    const lines = this.queue
    this.queue = []
    if (this.dropped > 0) {
      lines.push(
        JSON.stringify({
          ts: this.now().toISOString(),
          level: 'warn',
          cat: 'logger',
          ev: 'dropped',
          pid: this.pid,
          data: { lines: this.dropped },
        }),
      )
      this.dropped = 0
    }
    return `${lines.join('\n')}\n`
  }

  private async drain(): Promise<void> {
    const text = this.takeBatch()
    if (text === undefined) return
    try {
      await this.ensureDir()
      const bytes = Buffer.byteLength(text, 'utf8')
      if (this.activeSize === undefined) this.activeSize = await this.fs.size(this.activePath)
      if (this.activeSize > 0 && this.activeSize + bytes > this.maxBytes) await this.rotate()
      await this.fs.appendFile(this.activePath, text)
      this.activeSize = (this.activeSize ?? 0) + bytes
    } catch (error) {
      this.report(`could not write ${this.activePath}`, error)
    }
  }

  private async ensureDir(): Promise<void> {
    if (this.dirReady) return
    await this.fs.mkdir(this.dir)
    this.dirReady = true
  }

  private rotated(index: number): string {
    return join(this.dir, `${this.name}.${index}.jsonl`)
  }

  /**
   * `name.jsonl` -> `name.1.jsonl` -> … Each step is its own try: a step that fails is reported, and
   * if the live file itself cannot be moved the logger starts a new file next to it, so lines keep
   * being written.
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
    } catch (error) {
      const next = join(this.dir, `${this.name}.${this.now().getTime()}.jsonl`)
      this.report(`could not rotate ${this.activePath}; continuing in ${next}`, error)
      this.activePath = next
      this.activeSize = 0
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
   * Last-chance write for the moment the process is exiting: synchronous, no rotation. Only used
   * once, on quit; everything else goes through the asynchronous path.
   */
  flushSync(): void {
    const text = this.takeBatch()
    if (text === undefined) return
    try {
      this.fs.mkdirSync(dirname(this.activePath))
      this.fs.appendFileSync(this.activePath, text)
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
