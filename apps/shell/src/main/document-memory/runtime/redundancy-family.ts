import { fp53, foldText } from './redundancy-text'

/**
 * Document families from file names, no models: "Giáo án Toán 3 - Tuần 5 - Bài 12.docx" and
 * "Giáo án Toán 3 - Tuần 6 - Bài 13.docx" in the same folder pattern are one family. Names are folded, digits
 * collapsed, week/lesson/period numbers and copy markers removed, and only the first FAMILY_NAME_TOKENS words kept
 * (the lesson TITLE part of a name differs between siblings and must not split the family). Whether a family is
 * really a template family is decided later from content (boilerplate ratio), not from the name.
 */
export const FAMILY_NAME_TOKENS = 3

const COPY_MARKER = /\(\s*\d+\s*\)|\bcopy\b|\bban sao\b|\bfinal\b|\bdraft\b|\bban nhap\b|\bbackup\b|\bbak\b|\bold\b|\bcu\b/
const COPY_MARKER_GLOBAL = new RegExp(COPY_MARKER.source, 'g')
/** Words that introduce a number which differs between siblings ("tuan 5", "bai 12", "lop 3"). */
const COUNTER_WORDS = new Set([
  'tuan', 'bai', 'tiet', 'buoi', 'ngay', 'thang', 'nam', 'week', 'lesson', 'unit', 'chapter', 'lop', 'khoi',
  'so', 'no', 'ver', 'v', 'part', 'phan', 'stt',
])

export interface NameParts {
  tokens: string[]
  ext: string
  hasCopyMarker: boolean
}

function splitExt(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || name.length - dot > 8) return { base: name, ext: '' }
  return { base: name.slice(0, dot), ext: name.slice(dot + 1).toLowerCase() }
}

function patternTokens(folded: string): string[] {
  const tokens = folded
    .replace(COPY_MARKER_GLOBAL, ' ')
    .replace(/\d+/g, ' # ')
    .split(/[^a-z#]+/)
    .filter(Boolean)
  const out: string[] = []
  for (const token of tokens) {
    if (token === '#') {
      if (out.length && COUNTER_WORDS.has(out[out.length - 1]!)) out.pop()
      continue
    }
    out.push(token)
  }
  return out
}

export function parseName(fileName: string): NameParts {
  const { base, ext } = splitExt(fileName)
  const folded = foldText(base)
  return { tokens: patternTokens(folded), ext, hasCopyMarker: COPY_MARKER.test(folded) }
}

function dirPattern(path: string): string {
  const segments = path.split(/[\\/]+/)
  segments.pop()
  return segments
    .map((segment) => patternTokens(foldText(segment)).join(' '))
    .filter(Boolean)
    .join('/')
}

/** Stable family key: short folder-pattern hash + the first name words + extension. */
export function familyKeyFor(path: string, fileName?: string): string {
  const name = fileName ?? path.split(/[\\/]+/).pop() ?? path
  const parts = parseName(name)
  const head = parts.tokens.slice(0, FAMILY_NAME_TOKENS).join(' ') || '(untitled)'
  return `${fp53(dirPattern(path)).toString(36)}:${head}.${parts.ext}`
}

/** Human readable part of a family key (for telemetry). */
export function familyLabel(key: string): string {
  const i = key.indexOf(':')
  return i >= 0 ? key.slice(i + 1) : key
}

/** 1 when the name looks like a copy/draft/backup ("bản sao", "(1)", "final"), else 0. */
export function copyPenalty(fileName: string): number {
  return parseName(fileName).hasCopyMarker ? 1 : 0
}
