import { appendFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { redactString } from './redact'

/**
 * Where the diagnostics report their own trouble. A packaged Windows app has no console, so
 * `console.error` alone means nobody ever learns that the log stopped being written. This writes a
 * short line to a separate plain-text file instead (synchronously, because it is the last resort and
 * is rare by construction): at most one line per `intervalMs`, at most `maxBytes` in total, and the
 * lines it had to skip are counted into the next one.
 */
export const FALLBACK_FILE = 'genoffice-logger-errors.txt'

export interface FallbackFs {
  appendFileSync(path: string, text: string): void
  mkdirSync(path: string): void
  size(path: string): number
}

const realFallbackFs: FallbackFs = {
  appendFileSync: (path, text) => appendFileSync(path, text, 'utf8'),
  mkdirSync: (path) => void mkdirSync(path, { recursive: true }),
  size: (path) => {
    try {
      return statSync(path).size
    } catch {
      return 0
    }
  },
}

export interface FallbackOptions {
  readonly dir: string
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
  readonly path: string
}

export class FallbackReporter {
  private readonly intervalMs: number
  private readonly maxBytes: number
  private readonly fs: FallbackFs
  private readonly now: () => number
  private readonly file: string
  private total = 0
  private written = 0
  private suppressedSinceLast = 0
  private suppressedTotal = 0
  private lastAt = -Infinity
  private bytes: number | undefined

  constructor(private readonly options: FallbackOptions) {
    this.intervalMs = options.intervalMs ?? 10_000
    this.maxBytes = options.maxBytes ?? 64 * 1024
    this.fs = options.fs ?? realFallbackFs
    this.now = options.now ?? Date.now
    this.file = join(options.dir, FALLBACK_FILE)
  }

  get path(): string {
    return this.file
  }

  stats(): FallbackStats {
    return {
      total: this.total,
      written: this.written,
      suppressed: this.suppressedTotal,
      path: this.file,
    }
  }

  /** Never throws: this is the channel of last resort. */
  report = (message: string, error?: unknown): void => {
    this.total++
    const at = this.now()
    if (at - this.lastAt < this.intervalMs) {
      this.suppressedSinceLast++
      this.suppressedTotal++
      return
    }
    if (this.options.echo !== false) console.error(`[diagnostics] ${message}`, error ?? '')
    try {
      if (this.bytes === undefined) this.bytes = this.fs.size(this.file)
      if (this.bytes >= this.maxBytes) {
        this.suppressedTotal++
        return
      }
      const code = (error as { code?: unknown } | undefined)?.code
      const detail =
        error instanceof Error ? error.message : error === undefined ? '' : String(error)
      const skipped = this.suppressedSinceLast > 0 ? ` (+${this.suppressedSinceLast} skipped)` : ''
      const line =
        `${new Date(at).toISOString()} ${redactString(message)}` +
        `${code !== undefined ? ` code=${String(code)}` : ''}` +
        `${detail ? ` ${redactString(detail).slice(0, 300)}` : ''}${skipped}\n`
      this.fs.mkdirSync(dirname(this.file))
      this.fs.appendFileSync(this.file, line)
      this.bytes += Buffer.byteLength(line, 'utf8')
      this.written++
      this.suppressedSinceLast = 0
      this.lastAt = at
    } catch {
      // nothing is left to report to; the console echo above is all there is
    }
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
  if (shared) shared.report(message, error)
  else console.error(`[diagnostics] ${message}`, error ?? '')
}
