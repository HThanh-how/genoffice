import { findTextRanges, foldText } from '../../shared/text-marks'

const CHUNK = 2048

/** Stream whitespace compaction; only candidate windows need the exact grapheme offset map.
 * A missing/late hit still needs a linear scan, but never a document-sized segmentation or allocation.
 */
export function snippetWindow(
  text: string,
  needles: readonly string[],
  context: number,
  trim = false,
): { compact: string; ranges: Array<[number, number]>; offset: number; more: boolean } {
  const folded = needles.map(foldText).filter(Boolean)
  const overlap = Math.max(256, context, ...needles.map((n) => n.length * 4 + 16))
  let compact = ''
  let offset = 0
  let head = ''
  for (let at = 0; at < text.length || at === 0; at += CHUNK) {
    const eof = at + CHUNK >= text.length
    const next = text.slice(at, at + CHUNK).replace(/\s+/g, ' ')
    compact += compact.endsWith(' ') ? next.replace(/^ /, '') : next
    if (trim && offset === 0) compact = compact.trimStart()
    if (eof && trim) compact = compact.trimEnd()
    if (offset === 0) head = compact.slice(0, context)
    if (!folded.length && (eof || compact.length >= context))
      return { compact: head, ranges: [], offset: 0, more: !eof }
    const hay = foldText(compact)
    if (folded.some((n) => hay.includes(n))) {
      const ranges = findTextRanges(compact, needles).filter(([s]) => offset === 0 || s > 0)
      // Keep enough future text for highlights and needles crossing the next chunk boundary.
      if (ranges.length && (eof || ranges[0]![0] < compact.length - overlap))
        return { compact, ranges, offset, more: !eof }
    }
    if (eof) return { compact: head, ranges: [], offset: 0, more: text.length > head.length }
    const drop = Math.max(0, compact.length - overlap * 2)
    offset += drop
    compact = compact.slice(drop)
  }
  throw new Error('Unreachable snippet window')
}
