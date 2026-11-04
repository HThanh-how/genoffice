import { createHmac, randomBytes } from 'node:crypto'

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
 *
 * Every string is cut to `MAX_REGEX_INPUT` characters BEFORE any pattern runs, so a huge blob in an
 * error message (a JSON body, a base64 file) cannot hold the main thread in a slow match.
 */

const MAX_STRING = 500
const MAX_VERBOSE_STRING = 200
const MAX_REGEX_INPUT = 4096
const MAX_KEY = 80
const MAX_DEPTH = 4
const MAX_ARRAY = 20
const MAX_KEYS = 40
const MAX_STACK_LINES = 12
/** shorter values are not hashed at all: a hash of a PIN or an ID number can be reversed by trying them all */
const MIN_HASH_LENGTH = 16
/** how much of a hex digest / base64 digest stays readable (enough to match a commit or an installer hash) */
const DIGEST_KEEP = 12

/** A random salt per process: hashes compare within one run but cannot be looked up in a table. */
const HASH_SALT = randomBytes(16)

export function shortHash(value: string): string {
  return createHmac('sha256', HASH_SALT).update(value).digest('hex').slice(0, 8)
}

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[_\-\s]/g, '')

/** Keys (lower case, without `_`/`-`) that carry a credential: the whole value goes, whatever its type. */
const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  'header',
  'headers',
  'cookie',
  'cookies',
  'setcookie',
  'authorization',
  'proxyauthorization',
  'credential',
  'credentials',
])

/**
 * Keys that usually carry user content. A string under one of them becomes `{ len, hash }`; an
 * object or array is kept as a skeleton (see `inContent` below), so a message list still shows its
 * roles and sizes but none of its text.
 */
const CONTENT_KEYS: ReadonlySet<string> = new Set([
  'prompt',
  'systemprompt',
  'system',
  'instruction',
  'instructions',
  'text',
  'content',
  'contents',
  'body',
  'payload',
  'input',
  'output',
  'response',
  'answer',
  'query',
  'transcript',
  'messages',
  'history',
  'parts',
  'snippet',
  'selection',
  'context',
  'args',
  'params',
  'title',
])

/** key names that end like a secret (`accessToken`, `client_secret`, `githubPassword`, `apiKey`) */
const SECRET_SUFFIX = /(token|secret|password|passwd|passphrase|apikey|privatekey|credential)s?$/

/** Words in a key name that say the number is a personal one (`cccdNumber`, `citizenId`, `phone`). */
const ID_WORDS: ReadonlySet<string> = new Set([
  'cccd',
  'cmnd',
  'cmt',
  'ssn',
  'passport',
  'citizen',
  'identity',
  'phone',
  'tel',
  'mobile',
  'account',
  'tax',
  'nid',
])

/** `cccdNumber`, `citizen_id`, `Phone` → ['cccd','number'], ['citizen','id'], ['phone'] */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** A whole number of 9 to 12 digits under a key named like a personal number. Measures are left alone. */
function isPersonalNumber(key: string, value: unknown): boolean {
  if (typeof value !== 'number' || !Number.isInteger(value)) return false
  const abs = Math.abs(value)
  if (abs < 1e8 || abs >= 1e12) return false
  return keyWords(key).some((w) => ID_WORDS.has(w))
}

/** True when no string occurs anywhere in `value` (numbers and flags only: a usage record, say). */
function holdsNoText(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return false
  if (value === null || typeof value !== 'object') return true
  if (depth > 3) return false
  const items = Array.isArray(value) ? value : Object.values(value as object)
  return items.slice(0, MAX_KEYS).every((v) => holdsNoText(v, depth + 1))
}

type KeyKind = 'credential' | 'content' | undefined

function keyKind(key: string, value: unknown): KeyKind {
  const k = normalizeKey(key)
  // a number or a flag is not content (`maxTokens: 4096`, `input: 12`)
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return undefined
  if (CREDENTIAL_KEYS.has(k)) return 'credential'
  if (CONTENT_KEYS.has(k)) return 'content'
  if (SECRET_SUFFIX.test(k)) {
    // `apiKeys: ['…']`, `secrets: { a: '…' }` go whole; `tokens: { input: 5, output: 7 }` is a count
    return holdsNoText(value) ? undefined : 'credential'
  }
  return undefined
}

/** `{ redacted: true, len, hash }` for a sensitive value: it can be compared, never read. */
function placeholder(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    return value.length < MIN_HASH_LENGTH
      ? { redacted: true, len: value.length }
      : { redacted: true, len: value.length, hash: shortHash(value) }
  }
  if (Array.isArray(value)) return { redacted: true, type: 'array', len: value.length }
  if (value && typeof value === 'object') return { redacted: true, type: 'object' }
  return { redacted: true, type: typeof value }
}

const hasLetterCaseAndDigit = (s: string): boolean =>
  /[A-Z]/.test(s) && /[a-z]/.test(s) && /\d/.test(s)

/** Cut before matching: patterns never see more than this. */
function capInput(input: string): string {
  return input.length > MAX_REGEX_INPUT
    ? `${input.slice(0, MAX_REGEX_INPUT)}…(${input.length})`
    : input
}

/** Credentials and personal numbers inside free text. */
export function redactString(input: string): string {
  let s = capInput(input)
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
  // "Basic settings" is prose; real Basic credentials are base64 (digits, '=', '+', '/' or long)
  s = s.replace(/\bBasic\s+([A-Za-z0-9+/]{8,}={0,2})/gi, (m, token: string) =>
    /[\d=+/]/.test(token) || token.length >= 16 ? 'Basic [redacted]' : m,
  )
  s = s.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jwt]')
  s = s.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[key]')
  s = s.replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[key]')
  s = s.replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/g, '[key]')
  s = s.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[key]')
  // header values run to the end of the line: "Cookie: a=b; session=…" has several secrets in one value
  s = s.replace(
    /((?:proxy-)?authorization|(?:set-)?cookie)(["']?\s*[:=]\s*)(?:"[^"\r\n]*"?|'[^'\r\n]*'?|[^\r\n]*)/gi,
    '$1$2[redacted]',
  )
  // passwords may contain spaces: take everything up to a delimiter
  s = s.replace(
    /([A-Za-z0-9_-]{0,32}?(?:password|passwd|passphrase|pwd))(["']?\s*[:=]\s*["']?)[^\r\n&;"']{2,}/gi,
    '$1$2[redacted]',
  )
  // the other secret names, also after a prefix (`client_secret`, `id_token`, `session_token`)
  s = s.replace(
    /([A-Za-z0-9_-]{0,32}?(?:api[_-]?key|token|secret|private[_-]?key))(["']?\s*[:=]\s*["']?)(?!\[redacted\])[^\s"',;&]{4,}/gi,
    '$1$2[redacted]',
  )
  // URL query strings: names stay, values go
  s = s.replace(/([?&][^=&\s#"']{1,40}=)[^&\s#"']+/g, '$1[q]')
  // digests keep their start, so a commit or an installer hash can still be matched by eye
  s = s.replace(/\b[0-9a-fA-F]{32,}\b/g, (m) => `${m.slice(0, DIGEST_KEEP)}…[hex:${m.length}]`)
  s = s.replace(/\b[A-Za-z0-9+_-]{40,}={0,2}(?![A-Za-z0-9])/g, (m) =>
    hasLetterCaseAndDigit(m) ? `${m.slice(0, DIGEST_KEEP)}…[b64:${m.length}]` : m,
  )
  s = s.replace(/[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}/g, '[email]')
  // 12-digit citizen id numbers, written together or in groups ("012 345 678 901", "0123.4567.8901")
  s = s.replace(
    /(?<!\d)(?:\d{12}|\d{3}([ .-])\d{3}\1\d{3}\1\d{3}|\d{4}([ .-])\d{4}\2\d{4})(?!\d)/g,
    '[id]',
  )
  // 9-digit numbers are only ids when a word says so (a bare 9-digit run is usually a size or a time)
  s = s.replace(
    /((?<![\p{L}\d_])(?:cmnd|cccd|cmt|ssn|passport|id|số)(?![\p{L}\d_])[\s:#.=-]{0,6})\d{9}(?!\d)/giu,
    '$1[id]',
  )
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
    if (cause !== undefined) {
      out.cause = cleanString(cause instanceof Error ? cause.message : String(cause), options)
    }
    return out
  }
  return { message: cleanString(typeof error === 'string' ? error : safeJson(error), options) }
}

function safeJson(value: unknown): string {
  try {
    // an object can be huge: stringify, then cut (the pattern work is capped separately)
    return (JSON.stringify(value) ?? String(value)).slice(0, MAX_REGEX_INPUT * 2)
  } catch {
    return String(value)
  }
}

const IDENTIFIER = /^[\w.:-]{1,32}$/

/**
 * A plain-data copy of `value` that is safe to write: bounded, with sensitive fields replaced.
 * `inContent` is set below a content key (`messages`, `args`, …): there a short identifier
 * (`"user"`, `"tool_use"`) and every number or flag is kept, and any other text becomes `{ len, hash }`.
 */
export function redactValue(
  value: unknown,
  options: RedactOptions = {},
  depth = 0,
  inContent = false,
): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    if (!inContent) return cleanString(value, options)
    if (IDENTIFIER.test(value)) return cleanString(value, options)
    return options.verbose ? cleanString(value, options, MAX_VERBOSE_STRING) : placeholder(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`
  if (value instanceof Error) return describeError(value, options)
  // binary data is file content: only its size is recorded
  if (ArrayBuffer.isView(value)) return { bytes: value.byteLength }
  if (value instanceof ArrayBuffer) return { bytes: value.byteLength }
  if (value instanceof Map || value instanceof Set) return { size: value.size }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
  }
  if (depth >= MAX_DEPTH) return '[depth]'
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY)
      .map((v) => redactValue(v, options, depth + 1, inContent))
    return value.length > MAX_ARRAY ? [...items, `…(${value.length} items)`] : items
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    let count = 0
    for (const [rawKey, inner] of Object.entries(value as Record<string, unknown>)) {
      if (count++ >= MAX_KEYS) {
        out['…'] = 'more keys'
        break
      }
      // a key can be an e-mail address or a file name too
      const key = cleanString(rawKey, options, MAX_KEY)
      const kind = keyKind(rawKey, inner)
      if (isPersonalNumber(rawKey, inner)) {
        out[key] = { redacted: true, type: 'number' }
      } else if (kind === 'credential') {
        out[key] = placeholder(inner)
      } else if (kind === 'content') {
        if (typeof inner === 'string') {
          out[key] = options.verbose
            ? cleanString(inner, options, MAX_VERBOSE_STRING)
            : placeholder(inner)
        } else {
          out[key] = redactValue(inner, options, depth + 1, true)
        }
      } else {
        out[key] = redactValue(inner, options, depth + 1, inContent)
      }
    }
    return out
  }
  return String(value)
}
