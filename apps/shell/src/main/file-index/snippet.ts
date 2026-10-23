import { findRanges, findTextRanges, foldText, type TextMark } from '../../shared/text-marks'
import { snippetWindow } from './snippet-window'

export type SnippetPart = TextMark

const WINDOW = 150
const LEAD = 40

/**
 * A ~150-char excerpt around the first matched needle with every needle
 * occurrence inside it flagged. Returns null when no needle occurs.
 */
export function buildSnippet(text: string, needles: readonly string[]): SnippetPart[] | null {
  if (needles.every((n) => !n) || !text) return null
  const { compact, ranges, offset, more } =
    text.length <= 4096
      ? { compact: text.replace(/\s+/g, ' '), ranges: null, offset: 0, more: false }
      : snippetWindow(text, needles, LEAD + WINDOW)
  const exactRanges = ranges ?? findTextRanges(compact, needles)
  if (exactRanges.length === 0) return null
  const start = Math.max(0, exactRanges[0]![0] - LEAD)
  const end = Math.min(compact.length, start + WINDOW)
  const parts: SnippetPart[] = []
  let cursor = start
  if (start + offset > 0) parts.push({ text: '…', hit: false })
  for (const [s, e] of exactRanges) {
    if (s >= end) break
    if (s > cursor) parts.push({ text: compact.slice(cursor, s), hit: false })
    const stop = Math.min(e, end)
    parts.push({ text: compact.slice(Math.max(s, cursor), stop), hit: true })
    cursor = stop
  }
  if (cursor < end) parts.push({ text: compact.slice(cursor, end), hit: false })
  if (more || end < compact.length) parts.push({ text: '…', hit: false })
  return parts
}

/** up to `chars` of text starting a little before the first needle hit, or the head of the text */
export function excerpt(text: string, needles: readonly string[], chars: number): string {
  const window = text.length > 4096 ? snippetWindow(text, needles, chars * 2, true) : null
  const compact = window?.compact ?? text.replace(/\s+/g, ' ').trim()
  const ranges = window?.ranges ?? findTextRanges(compact, needles)
  const start = ranges.length ? Math.max(0, ranges[0]![0] - Math.floor(chars / 4)) : 0
  return compact.slice(start, start + chars)
}

/** true when any needle occurs in the (folded) text */
export function containsAny(text: string, needles: readonly string[]): boolean {
  const folded = needles.map(foldText).filter(Boolean)
  if (!folded.length) return false
  if (text.length <= 4096) return findRanges(foldText(text), folded).length > 0
  const overlap = Math.max(32, ...needles.map((n) => n.length * 4 + 16))
  for (let at = 0; at < text.length; at += 2048) {
    const start = Math.max(0, at - overlap)
    if (
      findRanges(foldText(text.slice(start, at + 2048 + overlap)), folded).some(
        ([s]) => start === 0 || s > 0,
      )
    )
      return true
  }
  return false
}
