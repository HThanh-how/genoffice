/**
 * Typed failures of the Antigravity CLI (`agy`). Pure and browser-safe: no Node imports, so the
 * parser and the message builders can be unit-tested and shared with renderer code.
 *
 * What the CLI itself tells us (agy 1.3.x, `agy changelog` and a real run on 2026-10):
 *  - a model or agent failure in a headless run prints `AGY_ERROR: {...}` on stderr (canonical
 *    status, HTTP/gRPC code, retryability, error id; the exact keys are not documented, so the
 *    parser below accepts several spellings) and exits with code 3;
 *  - `--print-timeout` expiry is NOT a failure for the CLI: it prints
 *    `[agy] print timeout after 4s with turn in progress; returning partial output` on stderr,
 *    emits a `result` event with status SUCCESS and whatever text it had, and exits 0. Without the
 *    stderr line a cut-off answer is indistinguishable from a finished one;
 *  - running out of credits fails fast with "Your AI credits balance is too low to continue.".
 */

export type AgyErrorKind =
  /** plan quota or AI credits used up (or a daily / billing cap): retrying now cannot help */
  | 'quota'
  /** not signed in, session expired, account blocked or needing verification */
  | 'auth'
  /** the model or agent API failed (rate limit, overload, internal error) */
  | 'model'
  /** the run hit its time limit; any text produced so far is partial */
  | 'timeout'
  /** none of the above: the CLI's own message is passed on */
  | 'unknown'

/** The fields of an `AGY_ERROR:` line, whatever their spelling in the JSON. */
export interface AgyErrorInfo {
  /** canonical status such as RESOURCE_EXHAUSTED */
  status?: string
  /** HTTP or gRPC code */
  code?: number
  retryable?: boolean
  errorId?: string
  message?: string
}

export interface AgyErrorInit {
  kind: AgyErrorKind
  message: string
  retryable?: boolean
  /** epoch ms when the quota is expected back, when the CLI said so */
  resetAt?: number
  exitCode?: number | null
  info?: AgyErrorInfo
  /** text the run produced before it failed (never shown as an answer) */
  partialText?: string
  cause?: unknown
}

export class AgyError extends Error {
  readonly kind: AgyErrorKind
  readonly retryable: boolean
  readonly resetAt?: number
  readonly exitCode?: number | null
  readonly info?: AgyErrorInfo
  readonly partialText?: string

  constructor(init: AgyErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'AgyError'
    this.kind = init.kind
    this.retryable = init.retryable ?? (init.kind === 'timeout' || init.kind === 'model')
    if (init.resetAt !== undefined) this.resetAt = init.resetAt
    if (init.exitCode !== undefined) this.exitCode = init.exitCode
    if (init.info) this.info = init.info
    if (init.partialText) this.partialText = init.partialText
  }
}

export function isAgyError(value: unknown): value is AgyError {
  return value instanceof AgyError
}

/** The kind of a thrown value (an AgyError, possibly wrapped in `cause`), or undefined. */
export function agyErrorKindOf(value: unknown): AgyErrorKind | undefined {
  let current: unknown = value
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof AgyError) return current.kind
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Stderr: the AGY_ERROR line and the print-timeout warning
// ---------------------------------------------------------------------------

const AGY_ERROR_PREFIX = /AGY_ERROR:\s*/
const AGY_ERROR_LINE = /^.*AGY_ERROR:.*$/gm

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function pickString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function pickCode(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && /^\d{1,4}$/.test(value.trim())) return Number(value)
  }
  return undefined
}

function pickBoolean(source: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'boolean') return value
  }
  return undefined
}

/**
 * The last `AGY_ERROR: {...}` line of a stderr capture. Unknown keys are ignored and a line whose
 * JSON cannot be parsed still yields its text as `message`. Undefined when there is no such line.
 */
export function parseAgyErrorLine(stderr: string): AgyErrorInfo | undefined {
  const lines = stderr.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    const marker = AGY_ERROR_PREFIX.exec(line)
    if (!marker) continue
    const rest = line.slice(marker.index + marker[0].length).trim()
    let parsed: unknown
    try {
      parsed = JSON.parse(rest)
    } catch {
      return rest ? { message: rest.slice(0, 400) } : {}
    }
    const top = record(parsed)
    if (!top) return rest ? { message: rest.slice(0, 400) } : {}
    // the details may sit at the top level or inside an `error` object
    const nested = record(top.error)
    const sources = nested ? [top, nested] : [top]
    const first = <T>(read: (source: Record<string, unknown>) => T | undefined): T | undefined => {
      for (const source of sources) {
        const value = read(source)
        if (value !== undefined) return value
      }
      return undefined
    }
    const status = first((s) =>
      pickString(s, [
        'status',
        'canonical_status',
        'canonicalStatus',
        'grpc_status',
        'error_status',
      ]),
    )
    const code = first((s) =>
      pickCode(s, ['code', 'http_status', 'httpStatus', 'http_code', 'grpc_code', 'status_code']),
    )
    const retryable = first((s) => pickBoolean(s, ['retryable', 'is_retryable', 'retriable']))
    const errorId = first((s) => pickString(s, ['error_id', 'errorId', 'id']))
    const message = first((s) =>
      pickString(s, ['short_error', 'message', 'error', 'detail', 'details', 'reason']),
    )
    const info: AgyErrorInfo = {
      ...(status === undefined ? {} : { status }),
      ...(code === undefined ? {} : { code }),
      ...(retryable === undefined ? {} : { retryable }),
      ...(errorId === undefined ? {} : { errorId }),
      ...(message === undefined ? {} : { message: message.slice(0, 400) }),
    }
    return info
  }
  return undefined
}

const PRINT_TIMEOUT_WARNING =
  /\[agy\]\s*print timeout after\b|print timeout after .{0,20}with turn in progress/i

/** True when stderr carries the CLI's "print timeout ... returning partial output" warning. */
export function hasAgyPrintTimeoutWarning(stderr: string): boolean {
  return PRINT_TIMEOUT_WARNING.test(stderr)
}

// ---------------------------------------------------------------------------
// Reset time
// ---------------------------------------------------------------------------

const MAX_RESET_AHEAD_MS = 31 * 24 * 3_600_000
const RESET_WORDS = /reset|retry|try again|available again|refresh/i

/** "1h 5m 30s", "90s", "2 hours", "45.5s" -> milliseconds; undefined when nothing parses. */
export function parseAgyDuration(text: string): number | undefined {
  let total = 0
  let found = false
  const unit =
    /(\d+(?:\.\d+)?)\s*(d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)(?![a-z])/gi
  for (const match of text.matchAll(unit)) {
    const value = Number(match[1])
    const u = match[2]!.toLowerCase()
    const factor = u.startsWith('d')
      ? 86_400_000
      : u.startsWith('h')
        ? 3_600_000
        : u.startsWith('m')
          ? 60_000
          : 1000
    total += value * factor
    found = true
  }
  return found && total > 0 ? Math.round(total) : undefined
}

/**
 * When the quota is expected back, read out of agy's text: an ISO timestamp near the word
 * "reset", "resets in 2h 15m", "retry after 3600s", `retry_after: 90`. Undefined when the text
 * carries no usable time, or one that is already past or more than a month away.
 */
export function extractAgyResetAt(text: string, now: number = Date.now()): number | undefined {
  if (!text) return undefined
  const accept = (ms: number | undefined): number | undefined =>
    ms !== undefined && Number.isFinite(ms) && ms > now && ms - now <= MAX_RESET_AHEAD_MS
      ? Math.round(ms)
      : undefined

  // 1. an absolute timestamp
  const stamp = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/g
  for (const match of text.matchAll(stamp)) {
    const before = text.slice(Math.max(0, match.index - 60), match.index)
    if (!RESET_WORDS.test(before)) continue
    const raw = match[1]!.replace(' ', 'T')
    const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw}Z`
    const ms = accept(Date.parse(zoned))
    if (ms !== undefined) return ms
  }
  // 2. a bare number of seconds in a retry key: retry_after: 90 / "retryDelay":"45s"
  const keyed =
    /["']?(?:retry[_-]?after|retry[_-]?delay|reset[_-]?in)["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)\s*(s|ms)?\b/i.exec(
      text,
    )
  if (keyed) {
    const seconds = keyed[2]?.toLowerCase() === 'ms' ? Number(keyed[1]) / 1000 : Number(keyed[1])
    const ms = accept(now + seconds * 1000)
    if (ms !== undefined) return ms
  }
  // 3. a relative duration after a reset / retry phrase
  const phrase =
    /(?:resets?|retry(?:ing)?|try again|available again|refreshes?)\s*(?:in|after|within)\s+((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?){1,4})/i.exec(
      text,
    )
  if (phrase) {
    const delta = parseAgyDuration(phrase[1]!)
    const ms = delta === undefined ? undefined : accept(now + delta)
    if (ms !== undefined) return ms
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const AUTH_TEXT =
  /authentication required|not (?:logged|signed)[- ]?in|(?:sign|log)[- ]?in (?:required|again|first)|please (?:sign|log)[- ]?in|\/log(?:in|out)\b|unauthenticated|unauthori[sz]ed|permission[_ ]denied|token (?:has )?(?:expired|been revoked)|invalid (?:credentials|token)|re-?authenticat|verify your account|terms of service/i
const QUOTA_TEXT =
  /credits? balance is too low|out of (?:credits|quota|tokens)|insufficient (?:credits|quota|balance)|credits? (?:have|has) run out|quota (?:is |was |has been )?(?:exhausted|exceeded|used|reached|depleted)|(?:daily|billing|spend|usage) (?:quota|cap|limit)|exhausted (?:your )?(?:daily )?quota|usage limit|plan quota|used up/i
const RATE_TEXT = /rate[- ]?limit|too many requests|throttl|slow down|resource[_ ]exhausted/i
const OVERLOAD_TEXT = /overload|unavailable|capacity|high demand|temporar|try again/i
const AUTH_STATUS = /^(?:UNAUTHENTICATED|PERMISSION_DENIED)$/i
const QUOTA_STATUS = /^(?:RESOURCE_EXHAUSTED|QUOTA_EXCEEDED|OUT_OF_QUOTA)$/i
const DEADLINE_STATUS = /^DEADLINE_EXCEEDED$/i
const TRANSIENT_STATUS = /^(?:UNAVAILABLE|INTERNAL|ABORTED|UNKNOWN|OVERLOADED|CANCELLED)$/i

export interface AgyFailureInput {
  /** the CLI's `result.error`, when a result event arrived */
  resultError?: string | undefined
  /** captured stderr (tail) */
  stderr?: string | undefined
  exitCode?: number | null | undefined
  partialText?: string | undefined
  now?: number | undefined
}

/** Short, single-line detail for messages: no model list echo, no newlines. */
function tidy(text: string): string {
  const head = text.split(/\r?\n(?:Available models:|Usage of )/)[0] ?? text
  const clean = head.replace(/\s+/g, ' ').trim()
  return clean.length > 400 ? `${clean.slice(0, 400)}…` : clean
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).pop() ?? ''
}

/** Reset time as English text for the plain message (renderers localize their own copy). */
export function formatAgyResetAt(resetAt: number, now: number = Date.now()): string {
  const date = new Date(resetAt)
  const sameDay = new Date(now).toDateString() === date.toDateString()
  return date.toLocaleString(
    'en-US',
    sameDay
      ? { hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  )
}

/** The plain English message of a typed failure. */
export function describeAgyError(
  kind: Exclude<AgyErrorKind, 'unknown'>,
  options: {
    resetAt?: number
    detail?: string
    retryable?: boolean
    code?: number
    now?: number
  } = {},
): string {
  switch (kind) {
    case 'quota':
      return (
        'Your Antigravity usage quota is used up' +
        (options.resetAt === undefined
          ? '. '
          : ` and resets at ${formatAgyResetAt(options.resetAt, options.now)}. `) +
        'Wait for it to reset, or switch to another model or provider in Settings.'
      )
    case 'auth':
      return 'Antigravity is not signed in, or its session has expired. Sign in again in Settings → AI Model.'
    case 'timeout':
      return 'Antigravity timed out before it finished, so the partial answer was discarded. Try again, or choose a faster model.'
    case 'model':
      return options.retryable
        ? `The Antigravity model service is temporarily unavailable${options.code ? ` (${options.code})` : ''}. Please retry shortly.`
        : `Antigravity reported a model error${options.detail ? `: ${options.detail}` : '.'}`
  }
}

/**
 * Turn a failed run into a typed error. Only the CLI's own error channels are read (`result.error`,
 * the AGY_ERROR line, stderr); the model's answer text is never searched, so a document that
 * happens to say "quota exceeded" cannot be mistaken for a failure.
 */
export function classifyAgyFailure(input: AgyFailureInput): AgyError {
  const now = input.now ?? Date.now()
  const stderr = input.stderr ?? ''
  const info = parseAgyErrorLine(stderr)
  const rawDetail =
    input.resultError?.trim() || info?.message || lastLine(stderr.replace(AGY_ERROR_LINE, ''))
  const detail = tidy(rawDetail)
  const channels = [input.resultError ?? '', info?.message ?? '', info?.status ?? '', stderr]
    .filter(Boolean)
    .join('\n')
  const status = info?.status ?? ''
  const code = info?.code
  const base = {
    exitCode: input.exitCode ?? null,
    ...(info ? { info } : {}),
    ...(input.partialText ? { partialText: input.partialText } : {}),
  }

  if (AUTH_STATUS.test(status) || code === 401 || code === 403 || AUTH_TEXT.test(channels)) {
    return new AgyError({
      kind: 'auth',
      message: describeAgyError('auth'),
      retryable: false,
      ...base,
    })
  }

  const quotaWords = QUOTA_TEXT.test(channels)
  const rateWords = RATE_TEXT.test(channels)
  const resetAt = extractAgyResetAt(channels, now)
  const exhaustedStatus = QUOTA_STATUS.test(status) || code === 429
  if (quotaWords || (exhaustedStatus && (resetAt !== undefined || info?.retryable === false))) {
    return new AgyError({
      kind: 'quota',
      message: describeAgyError('quota', { ...(resetAt === undefined ? {} : { resetAt }), now }),
      retryable: false,
      ...(resetAt === undefined ? {} : { resetAt }),
      ...base,
    })
  }

  if (DEADLINE_STATUS.test(status) || code === 408) {
    return new AgyError({ kind: 'timeout', message: describeAgyError('timeout'), ...base })
  }

  const transient =
    info?.retryable === true ||
    exhaustedStatus ||
    rateWords ||
    TRANSIENT_STATUS.test(status) ||
    (code !== undefined && (code === 429 || (code >= 500 && code <= 599))) ||
    (info !== undefined && OVERLOAD_TEXT.test(channels))
  if (info || input.exitCode === 3) {
    const retryable = info?.retryable ?? transient
    return new AgyError({
      kind: 'model',
      message: describeAgyError('model', {
        retryable,
        detail,
        ...(code === undefined ? {} : { code }),
      }),
      retryable,
      ...base,
    })
  }

  // The CLI's own words, as before: exit codes other than 3 without a structured line stay generic.
  return new AgyError({
    kind: 'unknown',
    message:
      detail || `Antigravity CLI exited with code ${input.exitCode ?? 'unknown'} without a result`,
    retryable: false,
    ...base,
  })
}

/** The error for a run that hit `--print-timeout`: partial output is never an answer. */
export function agyTruncatedError(partialText: string, exitCode: number | null = 0): AgyError {
  return new AgyError({
    kind: 'timeout',
    message: describeAgyError('timeout'),
    retryable: true,
    exitCode,
    ...(partialText.trim() ? { partialText } : {}),
  })
}
