import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { redactString } from './redact'

/**
 * Where the diagnostics report their own trouble. A packaged Windows app has no console, so
 * `console.error` alone means nobody ever learns that the log stopped being written. This writes a
 * short line to a separate plain-text file instead: asynchronously (the folder may be on the very
 * drive that is hanging, and a synchronous write there would stall the main thread), at most one
 * line per `intervalMs` (the clock starts when a line is attempted, not when it succeeds), and at
 * most `maxBytes` per run. A file that is already full at the start of the run is moved to `.old`,
 * so the channel never stays silent for good. Lines it had to skip are counted into the next one.
 */
export const FALLBACK_FILE = 'genoffice-logger-errors.txt'

export interface FallbackFs {
  size(path: string): Promise<number>
  mkdir(dir: string): Promise<void>
  append(path: string, text: string): Promise<void>
  /** moves `from` over `to` */
  move(from: string, to: string): Promise<void>
}

const realFallbackFs: FallbackFs = {
  size: async (path) => {
    try {
      return (await stat(path)).size
    } catch {
      return 0
    }
  },
  mkdir: async (dir) => void (await mkdir(dir, { recursive: true })),
  append: (path, text) => appendFile(path, text, 'utf8'),
  move: (from, to) => rename(from, to),
}

export interface FallbackOptions {
  readonly dir: string
  /** used when `dir` cannot be written (a folder that is set but read-only, a drive that is gone) */
  readonly altDir?: string
  readonly fsTimeoutMs?: number
  readonly intervalMs?: number
  readonly maxBytes?: number
  readonly fs?: FallbackFs
  readonly now?: () => number
  /** also print to the console (useful in dev); default true */
  readonly echo?: boolean
}

export interface FallbackStats {
  /** every problem reported, including the ones not written because of the rate limit */
  readonly total: number
  readonly written: number
  readonly suppressed: number
  /** attempts to write the fallback file that failed */
  readonly failed: number
  readonly path: string
}

interface Target {
  readonly dir: string
  readonly file: string
}

export class FallbackReporter {
  private readonly intervalMs: number
  private readonly maxBytes: number
  private readonly fs: FallbackFs
  private readonly now: () => number
  private readonly fsTimeoutMs: number
  /** where lines go now; moves to `alt` for good once the first folder has failed and `alt` works */
  private target: Target
  private alt: Target | undefined
  /** bytes written so far per file, known once the file has been looked at */
  private readonly sizes = new Map<string, number>()
  /** tries that have not finished yet (a try that timed out may still be waiting for the file system) */
  private pending = 0
  private total = 0
  private written = 0
  private failed = 0
  private suppressedSinceLast = 0
  private suppressedTotal = 0
  private lastAt = -Infinity
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly options: FallbackOptions) {
    this.intervalMs = options.intervalMs ?? 10_000
    this.maxBytes = options.maxBytes ?? 64 * 1024
    this.fs = options.fs ?? realFallbackFs
    this.now = options.now ?? Date.now
    this.fsTimeoutMs = options.fsTimeoutMs ?? 10_000
    this.target = { dir: options.dir, file: join(options.dir, FALLBACK_FILE) }
    if (options.altDir && options.altDir !== options.dir) {
      this.alt = { dir: options.altDir, file: join(options.altDir, FALLBACK_FILE) }
    }
  }

  get path(): string {
    return this.target.file
  }

  stats(): FallbackStats {
    return {
      total: this.total,
      written: this.written,
      suppressed: this.suppressedTotal,
      failed: this.failed,
      path: this.target.file,
    }
  }

  /** Resolves when the lines reported so far have been written (or have failed). For tests and exit. */
  idle(): Promise<void> {
    return this.chain
  }

  /** Never throws and never blocks: this is the channel of last resort. */
  report = (message: string, error?: unknown): void => {
    try {
      this.total++
      const at = this.now()
      if (at - this.lastAt < this.intervalMs) {
        this.suppressedSinceLast++
        this.suppressedTotal++
        return
      }
      // the clock starts now: a failing write must not lift the limit
      this.lastAt = at
      if (this.options.echo !== false) console.error(`[diagnostics] ${message}`, error ?? '')
      const code = (error as { code?: unknown } | undefined)?.code
      const detail =
        error instanceof Error ? error.message : error === undefined ? '' : String(error)
      const skipped = this.suppressedSinceLast > 0 ? ` (+${this.suppressedSinceLast} skipped)` : ''
      this.suppressedSinceLast = 0
      const line =
        `${new Date(at).toISOString()} ${redactString(message)}` +
        `${code !== undefined ? ` code=${String(code)}` : ''}` +
        `${detail ? ` ${redactString(detail).slice(0, 300)}` : ''}${skipped}\n`
      this.chain = this.chain.then(() => this.write(line)).catch(() => undefined)
    } catch {
      // nothing is left to report to
    }
  }

  private async write(line: string): Promise<void> {
    if (await this.attempt(this.target, line)) return
    // the first folder failed: try the other one, and stay there if it works
    const alt = this.alt
    if (alt && (await this.attempt(alt, line))) {
      this.target = alt
      this.alt = undefined
    }
  }

  /**
   * One try at one folder, with its own deadline. A try that is given up is told so and does
   * nothing more; and no new try is started while two earlier ones are still waiting for the file
   * system, so a dead drive cannot take the threads other file operations need.
   */
  private async attempt(target: Target, line: string): Promise<boolean> {
    if (this.pending >= 2) {
      this.failed++
      return false
    }
    const job = { cancelled: false }
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        job.cancelled = true
        reject(new Error('no answer from the file system'))
      }, this.fsTimeoutMs)
      timer.unref?.()
    })
    this.pending++
    const work = this.writeTo(target, line, job).finally(() => {
      this.pending--
    })
    try {
      await Promise.race([work, deadline])
      return true
    } catch {
      this.failed++
      return false
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async writeTo(target: Target, line: string, job: { cancelled: boolean }): Promise<void> {
    let size = this.sizes.get(target.file)
    if (size === undefined) {
      const found = await this.fs.size(target.file)
      if (job.cancelled) return
      if (found >= this.maxBytes) {
        // full from an earlier run: keep it as .old and start again
        await this.fs.move(target.file, `${target.file}.old`)
        if (job.cancelled) return
        size = 0
      } else {
        size = found
      }
    }
    if (size >= this.maxBytes) {
      this.sizes.set(target.file, size)
      this.suppressedTotal++
      return
    }
    await this.fs.mkdir(target.dir)
    if (job.cancelled) return
    await this.fs.append(target.file, line)
    this.sizes.set(target.file, size + Buffer.byteLength(line, 'utf8'))
    this.written++
  }
}

let shared: FallbackReporter | undefined

/** Called once the log folder is known. */
export function configureFallbackReporter(options: FallbackOptions): FallbackReporter {
  shared = new FallbackReporter(options)
  return shared
}

export function getFallbackReporter(): FallbackReporter | undefined {
  return shared
}

/** Report a problem of the diagnostics themselves; before the folder is known it only reaches the console. */
export function reportDiagnosticsProblem(message: string, error?: unknown): void {
  if (shared) {
    shared.report(message, error)
    return
  }
  try {
    console.error(`[diagnostics] ${message}`, error ?? '')
  } catch {
    // no console either
  }
}
