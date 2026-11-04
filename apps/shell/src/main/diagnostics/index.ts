import { join } from 'node:path'
import { configureFallbackReporter } from './fallback-report'
import { DiagnosticsLogger, type LogLevel, type Span } from './logger'

export { DiagnosticsLogger, type LogLevel, type Span } from './logger'
export { redactString, redactValue, describeError, shortHash } from './redact'
export { installIpcLogging } from './ipc-logging'
export { getFallbackReporter, reportDiagnosticsProblem } from './fallback-report'
export { installLifecycleLogging, startupInfo } from './lifecycle'

const PRE_INIT_LIMIT = 500

interface Pending {
  readonly at: Date
  readonly level: LogLevel
  readonly cat: string
  readonly ev: string
  readonly data?: unknown
}

let logger: DiagnosticsLogger | undefined
let pending: Pending[] = []
let disabled = false

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

export function levelFromEnv(value: string | undefined): LogLevel | undefined {
  const v = value?.trim().toLowerCase()
  return LEVELS.find((l) => l === v)
}

export interface InitOptions {
  /** Electron's `userData`: the logs go to `<userData>/logs` */
  readonly userDataDir: string
  readonly version: string
  readonly commit?: string
  readonly env?: NodeJS.ProcessEnv
}

/**
 * Creates the logger once `userData` is known and replays what was logged before that. Safe to call
 * twice (the second call returns the first logger). `GENOFFICE_NO_DIAG_LOG=1` turns the file off;
 * `GENOFFICE_LOG_VERBOSE=1` also keeps clipped, redacted prompt-like fields; `GENOFFICE_LOG_LEVEL`
 * picks the minimum level (default info).
 */
export function initDiagnostics(options: InitOptions): DiagnosticsLogger | undefined {
  if (logger) return logger
  const env = options.env ?? process.env
  if (env.GENOFFICE_NO_DIAG_LOG === '1') {
    disabled = true
    pending = []
    return undefined
  }
  const verbose = env.GENOFFICE_LOG_VERBOSE === '1'
  configureFallbackReporter({ dir: join(options.userDataDir, 'logs') })
  const commit = options.commit ?? env.GENOFFICE_COMMIT
  logger = new DiagnosticsLogger({
    dir: join(options.userDataDir, 'logs'),
    version: options.version,
    ...(commit ? { commit } : {}),
    level: levelFromEnv(env.GENOFFICE_LOG_LEVEL) ?? (verbose ? 'debug' : 'info'),
    verbose,
  })
  for (const entry of pending) logger.write(entry.level, entry.cat, entry.ev, entry.data, entry.at)
  pending = []
  return logger
}

export function getLogger(): DiagnosticsLogger | undefined {
  return logger
}

function write(level: LogLevel, cat: string, ev: string, data?: unknown): void {
  if (logger) {
    logger.write(level, cat, ev, data)
    return
  }
  if (disabled) return
  // before init (module load, early startup): keep a bounded backlog, newest wins
  if (pending.length >= PRE_INIT_LIMIT) pending.shift()
  pending.push({ at: new Date(), level, cat, ev, data })
}

const noopSpan: Span = { end: () => undefined, fail: () => undefined }

/** `log.info('ai', 'request.start', { reqId })`, usable from any module at any time. */
export const log = {
  debug: (cat: string, ev: string, data?: unknown): void => write('debug', cat, ev, data),
  info: (cat: string, ev: string, data?: unknown): void => write('info', cat, ev, data),
  warn: (cat: string, ev: string, data?: unknown): void => write('warn', cat, ev, data),
  error: (cat: string, ev: string, data?: unknown): void => write('error', cat, ev, data),
  /** Times a piece of work; before init or when disabled the span does nothing. */
  span(cat: string, ev: string, data?: Record<string, unknown>): Span {
    return logger ? logger.span(cat, ev, data) : noopSpan
  },
}

/** Writes everything still queued, synchronously; for the moment the process exits. */
export function flushDiagnosticsSync(): void {
  logger?.flushSync()
}

/** Test seam: forget the singleton. */
export function resetDiagnosticsForTests(): void {
  logger = undefined
  pending = []
  disabled = false
}
