/**
 * Pure text helpers of the redundancy-aware compaction (no I/O, no models, no SQLite).
 *
 * Fingerprints are 53-bit integers (two FNV-1a passes) so they round-trip through SQLite INTEGER and JS numbers.
 */

/** Lowercase, strip combining marks, map the Vietnamese dong-d. */
export function foldText(input: string): string {
  return input
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[đĐ]/gu, 'd')
    .toLowerCase()
}

function fnv1a32(text: string, seed: number): number {
  let h = seed >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

/** 53-bit hash (safe integer). Collision odds are negligible for the corpus sizes involved. */
export function fp53(text: string): number {
  const lo = fnv1a32(text, 0x811c9dc5)
  const hi = fnv1a32(text, 0x9747b28c) & 0x1fffff
  return hi * 4294967296 + lo
}

/** Letters only: lowercase, no diacritics, no digits, no whitespace/punctuation. */
export function normalizeForFingerprint(text: string): string {
  return foldText(text).replace(/[^\p{L}]+/gu, '')
}

const MIN_FINGERPRINT_LETTERS = 8

/** Fingerprint of a whole chunk; null when there are too few letters to be meaningful (tables of numbers...). */
export function chunkFingerprint(text: string): number | null {
  const normalized = normalizeForFingerprint(text)
  return normalized.length < MIN_FINGERPRINT_LETTERS ? null : fp53(normalized)
}

/** Fingerprint of a line ignoring digits (week/lesson numbers differ between siblings, the template does not). */
export function lineKey(line: string): number | null {
  const normalized = normalizeForFingerprint(line)
  return normalized.length < 3 ? null : fp53(normalized)
}

/** Fingerprint of a line that keeps its digits (identifies identical dates/amounts/ids). */
export function exactLineKey(line: string): number | null {
  const normalized = foldText(line).replace(/[^\p{L}\p{N}]+/gu, '')
  return normalized.length < 3 ? null : fp53(normalized)
}

const MAX_LINE_CHARS = 400

/**
 * Split into non-empty trimmed lines. A long paragraph (extractors often return one) is split into its sentences,
 * so template sentences and unique sentences are fingerprinted separately; sentences are capped at MAX_LINE_CHARS.
 */
export function splitLines(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim()
    if (!line) continue
    if (line.length <= 200) {
      out.push(line)
      continue
    }
    for (const sentence of line.split(/(?<=[.!?;])\s+/)) {
      let rest = sentence.trim()
      while (rest.length > MAX_LINE_CHARS) {
        out.push(rest.slice(0, MAX_LINE_CHARS))
        rest = rest.slice(MAX_LINE_CHARS)
      }
      if (rest) out.push(rest)
    }
  }
  return out
}

/**
 * Vocabulary of "locator" words (folded: no diacritics). A line that starts with one of them, or that carries one
 * followed by a number / colon, is what a person searches for ("Tuần 5", "Bài 12", "Môn: Toán", "Điều 3",
 * "Invoice No"). Kept deliberately small and data-only: extend the list, not the code.
 */
export const SKELETON_MARKER_TERMS: readonly string[] = [
  // Vietnamese (folded)
  'tuan', 'bai', 'tiet', 'chu de', 'chuyen de', 'mon', 'lop', 'khoi', 'chuong', 'muc', 'dieu', 'phan', 'buoi',
  'hoc ky', 'nam hoc', 'giao an', 'ke hoach bai day', 'ten bai', 'ngay soan', 'ngay day', 'ngay', 'thang',
  'hoa don', 'so hoa don', 'ma so thue', 'khach hang', 'don vi', 'so hop dong', 'bien ban', 'bao cao',
  // English
  'week', 'lesson', 'unit', 'chapter', 'section', 'module', 'topic', 'subject', 'class', 'grade', 'period',
  'article', 'part', 'invoice', 'title', 'date', 'report', 'agreement', 'contract', 'customer', 'tax',
]

const TERM_ALTERNATION = [...SKELETON_MARKER_TERMS].sort((a, b) => b.length - a.length).join('|')
/** "Tuần 5", "Điều 3.", "Môn: Toán", "Chương IV": the locator word is followed by a number, roman numeral or colon. */
const MARKER_LINE_START = new RegExp(`^(?:${TERM_ALTERNATION})\\s*(?::|#|\\d|[ivxlc]+(?![a-z]))`)
/** Short title-like line that merely starts with a locator word ("Giáo án Toán lớp 3"). */
const MARKER_LINE_TITLE = new RegExp(`^(?:${TERM_ALTERNATION})(?![a-z])`)
const MARKER_LINE_INNER = new RegExp(`(?:^|[^a-z])(?:${TERM_ALTERNATION})\\s*(?::|#|\\d)`)

/** True for locator lines ("Tuần 5", "Bài 12: ...", "Môn: Toán", "Điều 4."). */
export function isMarkerLine(line: string): boolean {
  if (line.length > 200) return false
  const folded = foldText(line).trim()
  if (MARKER_LINE_START.test(folded)) return true
  if (folded.length <= 60 && MARKER_LINE_TITLE.test(folded)) return true
  return folded.length <= 120 && MARKER_LINE_INNER.test(folded)
}

const NUMBERED_HEADING = /^(?:\d+(?:\.\d+)*|[ivxlcdm]+|[a-z])[.)]\s+\S/i

/** Short title-like line: numbered, UPPERCASE, Title Case or ending with a colon. */
export function isHeadingLike(line: string): boolean {
  const text = line.trim()
  if (text.length < 3 || text.length > 100) return false
  if (/[.;,]$/.test(text)) return false
  const words = text.split(/\s+/)
  if (words.length > 14) return false
  if (text.endsWith(':')) return true
  if (NUMBERED_HEADING.test(text)) return true
  // "Hoạt động 2: Khám phá", "Môn: Toán": short label, colon, capitalised value
  if (text.length <= 70 && /^[^:.]{1,40}:\s*\p{Lu}/u.test(text)) return true
  const letters = text.match(/\p{L}/gu) ?? []
  if (letters.length < 3) return false
  const upper = letters.filter((ch) => ch === ch.toUpperCase() && ch !== ch.toLowerCase()).length
  if (upper / letters.length >= 0.8) return true
  if (words.length >= 2) {
    const titled = words.filter((w) => /^\p{Lu}/u.test(w)).length
    if (titled / words.length >= 0.7) return true
  }
  return false
}

const DISTINCTIVE_PATTERNS: readonly RegExp[] = [
  /\d{4,}/, // years, long numbers, phone numbers, invoice numbers
  /\d{1,3}(?:[.,]\d{3})+/, // amounts 1.200.000
  /[A-Za-z]{1,8}[-/_]?\d{3,}/, // ids: HD-0231, INV2026
  /\d{3,}[-/_]?[A-Za-z]{1,8}/,
  /[\w.+-]+@[\w-]+\.[\w.]+/, // e-mail
]

/** Identifier-like content (number, amount, id, e-mail): lines like this are searched by value, never boilerplate. */
export function hasDistinctiveToken(line: string): boolean {
  return DISTINCTIVE_PATTERNS.some((re) => re.test(line))
}
