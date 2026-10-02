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

/** Safety ceiling of chunks stored for one file (~25 M characters); beyond it the file is truncated and flagged. */
export const MAX_CHUNKS_PER_FILE = 50_000
/** Tabular files keep their header plus sampled rows within this many chunks. */
export const MAX_TABULAR_CHUNKS = 120
const MAX_HEADER_CHARS = 160
const NUMERIC_LETTER_RATIO = 0.2

export interface CappedChunks {
  chunks: DocumentChunk[]
  /** True when content beyond the cap was left out of the index. */
  truncated: boolean
}

/** Keep the first `max` chunks and report whether anything was dropped. */
export function capChunks(chunks: DocumentChunk[], max = MAX_CHUNKS_PER_FILE): CappedChunks {
  return chunks.length > max
    ? { chunks: chunks.slice(0, max), truncated: true }
    : { chunks, truncated: false }
}

export interface TabularChunks extends CappedChunks {
  /** Mostly digits/symbols: lexical search is kept, but vectors add nothing. */
  numeric: boolean
}

/**
 * Index a CSV/TSV as its header plus evenly sampled rows. Every chunk repeats the header so
 * a matching row stays interpretable; a huge export can no longer produce thousands of chunks.
 */
export function chunkTabularText(input: string): TabularChunks {
  const lines = input
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (!lines.length) return { chunks: [], truncated: false, numeric: false }
  const header = lines[0]!.slice(0, MAX_HEADER_CHARS)
  const rows = lines.slice(1)
  const body = MAX_CHARS - header.length - 1
  const budget = MAX_TABULAR_CHUNKS * body
  const total = rows.reduce((sum, row) => sum + row.length + 1, 0)
  const stride = total > budget ? Math.ceil(total / budget) : 1
  let truncated = stride > 1
  const selected: Array<{ line: number; text: string }> = []
  rows.forEach((row, index) => {
    if (index % stride !== 0) return
    if (row.length > body) truncated = true
    selected.push({ line: index + 2, text: row.slice(0, body) })
  })
  const chunks: DocumentChunk[] = []
  let current: string[] = []
  let currentChars = 0
  let first = 0
  let last = 0
  const flush = () => {
    if (!current.length) return
    const range = first === last ? `${first}` : `${first}-${last}`
    chunks.push({
      text: `${header}\n${current.join('\n')}`,
      location: `${stride > 1 ? 'Sampled rows' : 'Rows'} ${range}`,
    })
    current = []
    currentChars = 0
  }
  for (const row of selected) {
    if (currentChars + row.text.length + 1 > body) flush()
    if (!current.length) first = row.line
    current.push(row.text)
    currentChars += row.text.length + 1
    last = row.line
  }
  flush()
  if (!chunks.length) chunks.push({ text: header, location: 'Header' })
  if (chunks.length > MAX_TABULAR_CHUNKS) {
    chunks.length = MAX_TABULAR_CHUNKS
    truncated = true
  }
  const sample = selected.map((row) => row.text).join(' ')
  const nonSpace = sample.replace(/\s/g, '').length
  const letters = (sample.match(/\p{L}/gu) ?? []).length
  return {
    chunks,
    truncated,
    numeric: nonSpace > 0 && letters / nonSpace < NUMERIC_LETTER_RATIO,
  }
}
