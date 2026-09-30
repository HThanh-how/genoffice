export interface DocumentChunk {
  text: string
  location: string
}

const MAX_CHARS = 500
const OVERLAP_CHARS = 80

/** Split extracted text without discarding content; locations are ordinal, never guessed pages. */
export function chunkDocumentText(input: string): DocumentChunk[] {
  const normalized = input
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\u00a0]+/g, ' ')
    .trim()
  if (!normalized) return []

  const paragraphs = normalized
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
  const units = (paragraphs.length ? paragraphs : [normalized]).flatMap(splitLongUnit)
  const chunks: string[] = []
  let current = ''
  for (const unit of units) {
    const candidate = current ? `${current}\n${unit}` : unit
    if (candidate.length <= MAX_CHARS) {
      current = candidate
      continue
    }
    if (current) chunks.push(current)
    if (unit.length > MAX_CHARS) {
      const parts = splitLongUnit(unit)
      current = ''
      for (const part of parts) {
        const next = current ? `${current}\n${part}` : part
        if (next.length <= MAX_CHARS) current = next
        else {
          if (current) chunks.push(current)
          current = part
        }
      }
    } else current = unit
  }
  if (current) chunks.push(current)
  return chunks.map((text, index) => ({ text, location: `Chunk ${index + 1}` }))
}

function splitLongUnit(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text]
  const parts: string[] = []
  let start = 0
  while (start < text.length) {
    const hardEnd = Math.min(start + MAX_CHARS, text.length)
    let end = hardEnd
    if (hardEnd < text.length) {
      const boundary = Math.max(
        text.lastIndexOf('\n', hardEnd),
        text.lastIndexOf('. ', hardEnd),
        text.lastIndexOf('; ', hardEnd),
        text.lastIndexOf(' ', hardEnd),
      )
      if (boundary > start + Math.floor(MAX_CHARS * 0.55))
        end = boundary + (text[boundary] === ' ' ? 1 : 0)
    }
    parts.push(text.slice(start, end).trim())
    if (end >= text.length) break
    start = Math.max(start + 1, end - OVERLAP_CHARS)
    while (start < text.length && /\s/.test(text[start]!)) start++
  }
  return parts.filter(Boolean)
}
