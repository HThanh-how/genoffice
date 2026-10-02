import { createHash, randomUUID } from 'node:crypto'
import {
  CLIPBOARD_MAX_CHARS,
  CLIPBOARD_MIN_CHARS,
  CLIPBOARD_PREVIEW_MAX,
  CLIPBOARD_VISIBLE_MS,
} from '../shared/clipboard-suggest-api'
import type {
  ClipboardActionId,
  ClipboardKind,
  ClipboardSuggestion,
} from '../shared/clipboard-suggest-api'

/**
 * Clipboard suggestions (on by default, can be switched off).
 *
 * Privacy contract (see the Settings description):
 *  - ON unless app-settings.json says `clipboardSuggestEnabled: false`.
 *  - The clipboard is read here, in the main process, only while a GenOffice
 *    window is focused (and once on focus gain), and only re-processed when it
 *    changed (SHA-256 compare).
 *  - Nothing is written to disk or logged. At most the last clipboard value is
 *    held in memory, for a bounded time, so the user's click can fetch it.
 *  - Secrets, password-manager content and tiny/huge content are skipped.
 *  - Classification is local heuristics; no AI is involved until the user
 *    clicks an action in the renderer.
 *
 * Everything above `ClipboardWatcher` is pure so it can be unit tested.
 */

export const CLIPBOARD_SUGGEST_ENABLED_KEY = 'clipboardSuggestEnabled'

/** strictly opt-in: anything but a literal `true` means off */
export function clipboardSuggestEnabledFrom(settings: Record<string, unknown>): boolean {
  return settings[CLIPBOARD_SUGGEST_ENABLED_KEY] !== false
}

/** at most one suggestion per this window */
export const SUGGEST_MIN_INTERVAL_MS = 20_000
/** poll cadence while (and only while) a GenOffice window is focused */
export const FOCUSED_POLL_MS = 2_000
/** how long main keeps the last value in memory for the click-to-fetch */
export const CURRENT_TTL_MS = 60_000
/** content beyond this is ignored outright (not even hashed) */
export const CLIPBOARD_HARD_LIMIT_CHARS = 1_000_000

// ---------------------------------------------------------------- secrets

function shannonEntropy(s: string): number {
  const counts = new Map<string, number>()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of counts.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

const KEY_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]+-----/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bxapp-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  /(?<![A-Za-z])(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|token|mật khẩu)\s*[:=]\s*\S{6,}/i,
]

const SECRET_QUERY =
  /[?&](?:token|access_token|api_?key|key|sig|signature|secret|password)=[^&\s]{8,}/i

function hasCardNumber(text: string): boolean {
  const candidates = text.match(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g)
  if (!candidates) return false
  return candidates.some((c) => luhnValid(c.replace(/[ -]/g, '')))
}

function looksLikeSecretToken(token: string): boolean {
  if (token.length < 20 || token.length > 512) return false
  if (!/^[A-Za-z0-9+/=_\-.~]+$/.test(token)) return false
  // dotted identifiers / file names / versions are not tokens
  if (/^[\w-]+(?:\.[\w-]+){1,4}$/.test(token) && token.length < 40 && !/\d/.test(token)) {
    return false
  }
  // semver-ish names (genoffice-1.2.3-beta.4) are identifiers, not credentials
  if (/^[\w-]*?\d+\.\d+\.\d+[\w.+-]*$/.test(token)) return false
  if (/^[0-9a-f]{32,}$/i.test(token)) return true // hex digest or hex-encoded key
  const hasDigit = /\d/.test(token)
  const hasLower = /[a-z]/.test(token)
  const hasUpper = /[A-Z]/.test(token)
  const hasSymbol = /[+/=_\-~]/.test(token)
  const entropy = shannonEntropy(token)
  if (hasDigit && (hasLower || hasUpper) && entropy >= 3.3) return true
  // long base64-looking runs without digits are rare in prose but exist
  return token.length >= 40 && hasLower && hasUpper && hasSymbol && entropy >= 4
}

/** True when the text looks like a credential and must never be suggested on. */
export function looksSecret(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (KEY_PATTERNS.some((re) => re.test(t))) return true
  if (SECRET_QUERY.test(t)) return true
  if (hasCardNumber(t)) return true
  // one-time codes: 4-8 digits, optionally split in two groups
  if (/^\d{4,8}$/.test(t) || /^\d{3}[ -]\d{3}$/.test(t)) return true
  if (!/\s/.test(t) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(t) && looksLikeSecretToken(t)) return true
  return false
}

// ----------------------------------------------------------- classification

const URL_RE = /^https?:\/\/[^\s<>"]+$/i
const WIN_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])[^<>"|?*\r\n]+$/
const POSIX_PATH = /^~?(?:\/[\p{L}\p{N}_ .@+~()-]+)+\/?$/u
const FILE_URI = /^file:\/\/\/?[^\s]+$/i
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/
const PHONE_RE = /(?:\+?\d[\d ().-]{7,}\d)/

function nonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
}

function unquote(line: string): string {
  return line.replace(/^["'](.*)["']$/, '$1').trim()
}

function isPathList(lines: string[]): boolean {
  if (lines.length === 0 || lines.length > 20) return false
  return lines.every((raw) => {
    const l = unquote(raw)
    return WIN_PATH.test(l) || POSIX_PATH.test(l) || FILE_URI.test(l)
  })
}

function isTable(lines: string[]): boolean {
  if (lines.length < 2) return false
  const avg = lines.reduce((n, l) => n + l.length, 0) / lines.length
  if (avg > 240) return false
  const tabs = lines.map((l) => (l.match(/\t/g) ?? []).length)
  if (tabs[0] >= 1 && tabs.every((n) => n === tabs[0])) return true
  if (lines.length < 3) return false
  for (const sep of [',', ';', '|']) {
    const counts = lines.map((l) => l.split(sep).length - 1)
    if (counts[0] >= 1 && counts.every((n) => n === counts[0])) {
      // prose with a fixed comma count per line is rare; reject sentences
      const sentencey = lines.filter((l) => /[.!?]$/.test(l)).length > lines.length / 2
      if (!sentencey) return true
    }
  }
  return false
}

function isContactBlock(text: string, lines: string[]): boolean {
  if (text.length > 600 || lines.length > 8) return false
  const words = text.split(/\s+/).filter(Boolean).length
  if (words > 60) return false
  if (EMAIL_RE.test(text)) return true
  return lines.length >= 2 && lines.length <= 6 && words <= 40 && PHONE_RE.test(text)
}

function isCode(text: string, lines: string[]): boolean {
  if (/^```/.test(text.trim()) && lines.length >= 2) return true
  if (lines.length < 2) return false
  let signals = 0
  if (/\b(?:function|const|let|var)\s+[\w$]+\s*(?:=|\()/.test(text)) signals++
  if (/\bdef\s+\w+\s*\(/.test(text)) signals++
  if (/\bclass\s+\w+\s*[:{(]/.test(text)) signals++
  if (/^\s*import\s+.+\s+from\s+['"]/m.test(text) || /^\s*#include\s*[<"]/m.test(text)) signals++
  if (/=>/.test(text) || /^\s*(?:public|private|protected|static)\s+\w/m.test(text)) signals++
  if (/\bSELECT\b[\s\S]+\bFROM\b/.test(text)) signals++
  if (/<\/?[a-z][\w-]*(?:\s[^>]*)?>/.test(text) && /<\/[a-z]/.test(text)) signals++
  const endings = lines.filter((l) => /[;{}]$/.test(l)).length
  if (endings >= 2 && endings >= lines.length / 3) signals++
  return signals >= 2
}

const ACTIONS: Record<ClipboardKind, ClipboardActionId[]> = {
  url: ['summarize', 'ask'],
  longText: ['summarize', 'translate', 'rewrite'],
  shortText: ['ask', 'translate'],
  question: ['ask'],
  paths: ['findRelated', 'ask'],
  table: ['analyze', 'toSheet'],
  contact: ['organize', 'ask'],
  code: ['explainCode', 'ask'],
}

export function actionsFor(kind: ClipboardKind): ClipboardActionId[] {
  return [...ACTIONS[kind]]
}

/** Local, AI-free classification. Returns null when nothing sensible applies. */
export function classifyClipboardText(raw: string): ClipboardKind | null {
  const text = raw.trim()
  if (text.length < CLIPBOARD_MIN_CHARS) return null
  const lines = nonEmptyLines(text)
  if (isPathList(lines)) return 'paths'
  if (lines.length === 1 && URL_RE.test(lines[0])) return 'url'
  if (isTable(lines)) return 'table'
  if (isCode(text, lines)) return 'code'
  if (isContactBlock(text, lines)) return 'contact'
  if (lines.length === 1 && /[?？]$/.test(text) && text.length <= 300) return 'question'
  if (text.length >= 300 || lines.length >= 4) return 'longText'
  return 'shortText'
}

export function makePreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= CLIPBOARD_PREVIEW_MAX
    ? flat
    : `${flat.slice(0, CLIPBOARD_PREVIEW_MAX - 1)}…`
}

export function hashClipboardText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

// ----------------------------------------------------------- rate limiting

export type GateDecision = 'ok' | 'duplicate' | 'rate-limited'

/** Dedup by content hash + at most one suggestion per interval. */
export class SuggestGate {
  private readonly seen: string[] = []
  private lastAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly minIntervalMs = SUGGEST_MIN_INTERVAL_MS,
    private readonly maxSeen = 50,
  ) {}

  evaluate(hash: string, now: number): GateDecision {
    if (this.seen.includes(hash)) return 'duplicate'
    if (now - this.lastAt < this.minIntervalMs) return 'rate-limited'
    return 'ok'
  }

  record(hash: string, now: number): void {
    this.seen.push(hash)
    if (this.seen.length > this.maxSeen) this.seen.shift()
    this.lastAt = now
  }

  /** a suggestion the user dismissed must not come back for the same content */
  markSeen(hash: string): void {
    if (!this.seen.includes(hash)) this.seen.push(hash)
    if (this.seen.length > this.maxSeen) this.seen.shift()
  }

  reset(): void {
    this.seen.length = 0
    this.lastAt = Number.NEGATIVE_INFINITY
  }
}

// ----------------------------------------------------------------- watcher

export interface ClipboardSource {
  /**
   * True when the clipboard owner asked not to be monitored (password
   * managers). Must be answerable WITHOUT reading the text.
   */
  isExcluded(): boolean
  readText(): string
  /** Image on the clipboard (PNG bytes + a small thumbnail), or null. Optional: text-only sources omit it. */
  readImage?(): ClipboardImage | null
}

export interface ClipboardImage {
  png: Buffer
  /** data-URL thumbnail for lists */
  preview: string
  width: number
  height: number
}

/** Formats whose mere presence means "do not process" (Windows / macOS / KDE). */
const EXCLUDE_IF_PRESENT = [
  'ExcludeClipboardContentFromMonitorProcessing',
  'org.nspasteboard.ConcealedType',
  'org.nspasteboard.TransientType',
  'x-kde-passwordManagerHint',
]
/** Windows DWORD formats where a value of 0 means "do not process" */
const EXCLUDE_IF_ZERO = ['CanIncludeInClipboardHistory', 'CanUploadToCloudClipboard']

interface ElectronClipboardLike {
  has(format: string): boolean
  readBuffer(format: string): Buffer
  readText(): string
  availableFormats?(): string[]
  readImage?(): {
    isEmpty(): boolean
    toPNG(): Buffer
    toDataURL(): string
    getSize(): { width: number; height: number }
    resize(options: { width: number; quality?: 'good' | 'better' | 'best' }): {
      toDataURL(): string
    }
  }
}

/**
 * Adapter over Electron's `clipboard`. Exclusion detection is best effort: if
 * the platform refuses an unknown format name we fail open (treat as not
 * excluded) because there is no other signal to go on.
 */
export function electronClipboardSource(clipboard: ElectronClipboardLike): ClipboardSource {
  return {
    isExcluded() {
      for (const format of EXCLUDE_IF_PRESENT) {
        try {
          if (clipboard.has(format)) return true
        } catch {
          // unsupported format name on this platform
        }
      }
      for (const format of EXCLUDE_IF_ZERO) {
        try {
          if (!clipboard.has(format)) continue
          const buf = clipboard.readBuffer(format)
          if (buf.length >= 4 && buf.readUInt32LE(0) === 0) return true
        } catch {
          // unsupported format name on this platform
        }
      }
      return false
    },
    readText: () => clipboard.readText(),
    readImage() {
      if (!clipboard.readImage || !clipboard.availableFormats) return null
      if (!clipboard.availableFormats().some((f) => f.startsWith('image/'))) return null
      const image = clipboard.readImage()
      if (image.isEmpty()) return null
      const { width, height } = image.getSize()
      const thumb =
        width > THUMB_WIDTH ? image.resize({ width: THUMB_WIDTH, quality: 'good' }) : image
      return { png: image.toPNG(), preview: thumb.toDataURL(), width, height }
    },
  }
}

const THUMB_WIDTH = 160

export interface ClipboardWatcherDeps {
  source: ClipboardSource
  isEnabled: () => boolean
  /** called with a new suggestion, or null when the current one is cleared */
  onChange: (suggestion: ClipboardSuggestion | null) => void
}

interface Current {
  suggestion: ClipboardSuggestion
  hash: string
  /** only the value needed for click-to-fetch; dropped on expiry/dismiss */
  fullText: string
  shownAt: number
  ttl: ReturnType<typeof setTimeout>
}

export class ClipboardWatcher {
  private focused = false
  private poll: ReturnType<typeof setInterval> | null = null
  private lastHash: string | null = null
  private current: Current | null = null
  private readonly gate = new SuggestGate()

  constructor(private readonly deps: ClipboardWatcherDeps) {}

  /** Call when GenOffice gains/loses OS focus (any of its windows). */
  setFocused(focused: boolean): void {
    this.focused = focused
    if (!focused) {
      this.stopPoll()
      return
    }
    if (!this.deps.isEnabled()) return
    this.check()
    this.startPoll()
  }

  /** Call after the enabled setting changes (and once at startup). */
  settingsChanged(): void {
    if (!this.deps.isEnabled()) {
      this.stopPoll()
      this.clearCurrent()
      this.lastHash = null
      this.gate.reset()
      return
    }
    // Baseline: whatever is on the clipboard right now predates the opt-in.
    this.lastHash = this.readHashOnly()
    if (this.focused) this.startPoll()
  }

  /** Read the clipboard once if enabled+focused, and offer a suggestion. */
  check(): void {
    if (!this.deps.isEnabled() || !this.focused) return
    if (this.safe(() => this.deps.source.isExcluded(), true)) {
      this.dropStaleCurrent()
      return
    }
    const raw = this.safe(() => this.deps.source.readText(), '')
    if (raw.length > CLIPBOARD_HARD_LIMIT_CHARS) {
      this.lastHash = `huge:${raw.length}`
      this.clearCurrent()
      return
    }
    const hash = hashClipboardText(raw)
    if (hash === this.lastHash) return
    this.lastHash = hash
    this.clearCurrent() // the clipboard moved on; an older chip is now stale
    this.offer(raw, hash)
  }

  getCurrent(): ClipboardSuggestion | null {
    const c = this.current
    if (!c) return null
    if (Date.now() - c.shownAt >= CLIPBOARD_VISIBLE_MS) return null
    return c.suggestion
  }

  getFullText(id: string): string | null {
    return this.current && this.current.suggestion.id === id ? this.current.fullText : null
  }

  dismiss(id: string): void {
    if (!this.current || this.current.suggestion.id !== id) return
    this.gate.markSeen(this.current.hash)
    this.clearCurrent()
  }

  dispose(): void {
    this.stopPoll()
    this.clearCurrent()
    this.lastHash = null
  }

  private offer(raw: string, hash: string): void {
    const truncated = raw.length > CLIPBOARD_MAX_CHARS
    const head = (truncated ? raw.slice(0, CLIPBOARD_MAX_CHARS) : raw).trim()
    if (head.length < CLIPBOARD_MIN_CHARS) return
    if (looksSecret(head)) return
    const kind = classifyClipboardText(head)
    if (!kind) return
    const now = Date.now()
    if (this.gate.evaluate(hash, now) !== 'ok') return
    this.gate.record(hash, now)
    const suggestion: ClipboardSuggestion = {
      id: randomUUID(),
      kind,
      preview: makePreview(head),
      actions: actionsFor(kind),
      truncated,
    }
    const ttl = setTimeout(() => this.clearCurrent(), CURRENT_TTL_MS)
    ttl.unref?.()
    this.current = { suggestion, hash, fullText: head, shownAt: now, ttl }
    this.deps.onChange(suggestion)
  }

  private clearCurrent(): void {
    if (!this.current) return
    clearTimeout(this.current.ttl)
    this.current = null
    this.deps.onChange(null)
  }

  private dropStaleCurrent(): void {
    // an excluded (sensitive) copy replaced whatever the chip was about
    this.lastHash = null
    this.clearCurrent()
  }

  private readHashOnly(): string | null {
    if (this.safe(() => this.deps.source.isExcluded(), true)) return null
    const raw = this.safe(() => this.deps.source.readText(), '')
    return raw.length > CLIPBOARD_HARD_LIMIT_CHARS ? `huge:${raw.length}` : hashClipboardText(raw)
  }

  private startPoll(): void {
    if (this.poll) return
    this.poll = setInterval(() => this.check(), FOCUSED_POLL_MS)
    this.poll.unref?.()
  }

  private stopPoll(): void {
    if (this.poll) clearInterval(this.poll)
    this.poll = null
  }

  private safe<T>(fn: () => T, fallback: T): T {
    try {
      return fn()
    } catch {
      return fallback
    }
  }
}
