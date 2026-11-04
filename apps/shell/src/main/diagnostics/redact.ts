import { createHash } from 'node:crypto'

/**
 * Everything that reaches the diagnostic log goes through here first. The rules, in order of
 * importance:
 * - never the content of a prompt, an answer or a file (keys that usually carry them are replaced by
 *   their length and a short hash, which is enough to tell two values apart);
 * - never a key, token, cookie or password, wherever it appears inside a string;
 * - never an identity-card style number or an e-mail address.
 * A verbose mode keeps the sensitive fields too, but still passes them through the string rules and
 * clips them hard. Paths stay as they are (the log never leaves the machine); `hashPaths` is for
 * the diagnostic export, which can leave it.
 */

const MAX_STRING = 500
const MAX_VERBOSE_STRING = 200
const MAX_DEPTH = 4
const MAX_ARRAY = 20
const MAX_KEYS = 40
const MAX_STACK_LINES = 12

/** Keys whose value is user content or a credential: replaced by `{ redacted, len, hash }`. */
const SENSITIVE_KEY =
  /^(prompt|text|content|body|payload|input|output|response|answer|query|instruction|transcript|headers?|cookies?|authorization|api[_-]?key|token|secret|password|passwd|credentials?)$/i

export function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

/** `{ redacted: true, len, hash }` for a sensitive value: it can be compared, never read. */
function placeholder(value: unknown): Record<string, unknown> {
  if (typeof value === 'string')
    return { redacted: true, len: value.length, hash: shortHash(value) }
  if (Array.isArray(value)) return { redacted: true, type: 'array', len: value.length }
  if (value && typeof value === 'object') return { redacted: true, type: 'object' }
  return { redacted: true, type: typeof value }
}

const hasLetterCaseAndDigit = (s: string): boolean =>
  /[A-Z]/.test(s) && /[a-z]/.test(s) && /\d/.test(s)

/** Credentials and personal numbers inside free text. */
export function redactString(input: string): string {
  let s = input
  s = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
  s = s.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jwt]')
  s = s.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[key]')
  s = s.replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[key]')
  s = s.replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/g, '[key]')
  s = s.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[key]')
  // key=value and "key": "value" forms for the usual secret names
  s = s.replace(
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|cookie)\b(["']?\s*[:=]\s*["']?)[^\s"',;&]{4,}/gi,
    '$1$2[redacted]',
  )
  // URL query strings: names stay, values go
  s = s.replace(/([?&][^=&\s#"']{1,40}=)[^&\s#"']+/g, '$1[q]')
  s = s.replace(/\b[0-9a-fA-F]{32,}\b/g, (m) => `[hex:${m.length}]`)
  s = s.replace(/\b[A-Za-z0-9+_-]{40,}={0,2}(?![A-Za-z0-9])/g, (m) =>
    hasLetterCaseAndDigit(m) ? `[b64:${m.length}]` : m,
  )
  s = s.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
  // 12-digit citizen id numbers (not part of a longer run of digits)
  s = s.replace(/(?<!\d)\d{12}(?!\d)/g, '[id]')
  return s
}

export interface RedactOptions {
  /** keep sensitive fields, still passed through the string rules and clipped */
  readonly verbose?: boolean
  /** replace every absolute path by a short hash (for the exported diagnostic bundle) */
  readonly hashPaths?: boolean
}

const WINDOWS_PATH = /[A-Za-z]:\\[^\s"'<>|*?]+/g
const POSIX_PATH = /(?<![\w:/])\/(?:Users|home|var|tmp|opt|mnt|Volumes)\/[^\s"'<>|*?]+/g

function hashPathsIn(s: string): string {
  const swap = (m: string): string => `[path:${shortHash(m)}]`
  return s.replace(WINDOWS_PATH, swap).replace(POSIX_PATH, swap)
}

function clip(s: string, limit: number): string {
  return s.length > limit ? `${s.slice(0, limit)}…(${s.length})` : s
}

function cleanString(value: string, options: RedactOptions, limit = MAX_STRING): string {
  let s = redactString(value)
  if (options.hashPaths) s = hashPathsIn(s)
  return clip(s, limit)
}

/** An Error as plain data: name, code, redacted message and a short redacted stack. */
export function describeError(
  error: unknown,
  options: RedactOptions = {},
): Record<string, unknown> {
  if (error instanceof Error) {
    const out: Record<string, unknown> = {
      name: error.name,
      message: cleanString(error.message, options),
    }
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' || typeof code === 'number') out.code = code
    if (error.stack) {
      out.stack = cleanString(
        error.stack.split('\n').slice(0, MAX_STACK_LINES).join('\n'),
        options,
        2000,
      )
    }
    const cause = (error as { cause?: unknown }).cause
    if (cause !== undefined) out.cause = cause instanceof Error ? cause.message : String(cause)
    return out
  }
  return { message: cleanString(typeof error === 'string' ? error : safeJson(error), options) }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** A plain-data copy of `value` that is safe to write: bounded, with sensitive fields replaced. */
export function redactValue(value: unknown, options: RedactOptions = {}, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return cleanString(value, options)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`
  if (value instanceof Error) return describeError(value, options)
  if (depth >= MAX_DEPTH) return '[depth]'
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((v) => redactValue(v, options, depth + 1))
    return value.length > MAX_ARRAY ? [...items, `…(${value.length} items)`] : items
  }
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    let count = 0
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (count++ >= MAX_KEYS) {
        out['…'] = 'more keys'
        break
      }
      if (SENSITIVE_KEY.test(key)) {
        out[key] = options.verbose
          ? typeof inner === 'string'
            ? cleanString(inner, options, MAX_VERBOSE_STRING)
            : placeholder(inner)
          : placeholder(inner)
      } else {
        out[key] = redactValue(inner, options, depth + 1)
      }
    }
    return out
  }
  return String(value)
}
