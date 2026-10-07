import { DEFAULT_STORAGE_BUDGET } from './storage-budget'

export interface ChunkMetadata {
  pageStart?: number
  pageEnd?: number
  sectionPath?: string[]
  slide?: number
  sheet?: string
}

export interface DocumentChunk {
  text: string
  location: string
  metadata?: ChunkMetadata
}

export interface ExtractResult {
  hash: string
  mtimeMs: number
  sizeBytes: number
  chunks: DocumentChunk[]
  chunkerVersion?: number
  status: 'text-only' | 'empty' | 'ready'
  error?: string
  truncated?: boolean
  skipEmbeddings?: boolean
  scan?: any
}

export const CHUNKER_VERSION = 2

const MAX_CHARS = 500
const OVERLAP_CHARS = 80

/** Split extracted text without discarding content; locations are ordinal, never guessed pages. */
export function chunkDocumentTextV1(input: string): DocumentChunk[] {
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

/** Backward compatibility alias */
export const chunkDocumentText = chunkDocumentTextV1

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

const TARGET_CHARS = 1200
const MAX_CHARS_V2 = 1800
const OVERLAP_CHARS_V2 = 160

function splitLongSentenceV2(text: string): string[] {
  if (text.length <= MAX_CHARS_V2) return [text]
  const parts: string[] = []
  let start = 0
  while (start < text.length) {
    const hardEnd = Math.min(start + MAX_CHARS_V2, text.length)
    let end = hardEnd
    if (hardEnd < text.length) {
      const boundary = Math.max(
        text.lastIndexOf('; ', hardEnd),
        text.lastIndexOf(', ', hardEnd),
        text.lastIndexOf(' ', hardEnd),
      )
      if (boundary > start + Math.floor(MAX_CHARS_V2 * 0.6)) {
        end = boundary + (text[boundary] === ' ' ? 1 : 0)
      }
    }
    parts.push(text.slice(start, end).trim())
    if (end >= text.length) break
    start = Math.max(start + 1, end - OVERLAP_CHARS_V2)
    while (start < text.length && /\s/.test(text[start]!)) start++
  }
  return parts.filter(Boolean)
}

function splitParagraphV2(text: string): string[] {
  if (text.length <= MAX_CHARS_V2) return [text]
  // Sentence boundaries
  const rawSentences = text
    .split(/(?<=[.!?。！？])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)

  const sentences = (rawSentences.length ? rawSentences : [text]).flatMap(splitLongSentenceV2)
  const units: string[] = []
  let current = ''
  for (const s of sentences) {
    if (!current) {
      current = s
    } else if (current.length + 1 + s.length <= MAX_CHARS_V2) {
      current += ` ${s}`
    } else {
      units.push(current)
      current = s
    }
  }
  if (current) units.push(current)
  return units
}

/**
 * Chunker V2: Target ~1200 chars (200-350 tokens), respects paragraph boundaries first,
 * then sentence boundaries, with gentle overlap when splits occur.
 */
export function chunkDocumentTextV2(
  input: string,
  context?: {
    title?: string
    sectionPath?: string[]
  },
): DocumentChunk[] {
  const normalized = input
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\u00a0]+/g, ' ')
    .trim()
  if (!normalized) return []

  const paragraphs = normalized
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean)

  const units = (paragraphs.length ? paragraphs : [normalized]).flatMap(splitParagraphV2)
  const chunks: string[] = []
  let current = ''

  for (const unit of units) {
    const candidate = current ? `${current}\n\n${unit}` : unit
    if (candidate.length <= TARGET_CHARS) {
      current = candidate
      continue
    }
    if (candidate.length <= MAX_CHARS_V2) {
      current = candidate
      chunks.push(current)
      current = ''
      continue
    }

    if (current) {
      chunks.push(current)
      current = ''
    }

    if (unit.length <= MAX_CHARS_V2) {
      current = unit
    } else {
      const parts = splitParagraphV2(unit)
      for (const part of parts) {
        if (current && current.length + 2 + part.length > MAX_CHARS_V2) {
          chunks.push(current)
          current = part
        } else if (current) {
          current = `${current}\n\n${part}`
        } else {
          current = part
        }
      }
    }
  }

  if (current) {
    chunks.push(current)
  }

  const metadata: ChunkMetadata | undefined = context?.sectionPath
    ? { sectionPath: context.sectionPath }
    : undefined

  return chunks.map((text, index) => ({
    text,
    location: `Chunk ${index + 1}`,
    ...(metadata ? { metadata } : {}),
  }))
}

/** Safety ceiling of chunks stored for one file; beyond it the file is truncated and flagged. */
export const MAX_CHUNKS_PER_FILE = DEFAULT_STORAGE_BUDGET.maxChunksPerFile
/**
 * The most pages of one PDF that are ever read and indexed, whatever the setting: reading all of
 * a 4,000-page textbook costs hours of work and a week of quota to make one file searchable.
 */
export const LARGE_PDF_PAGES = 400
/** How many pages of each PDF are read unless the person says otherwise: a book's contents are in them. */
export const DEFAULT_PDF_PAGES = 30

/** A page limit the person typed, kept between 1 and the hard ceiling. */
export function clampPdfPages(value: unknown): number {
  const pages = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : NaN
  return Number.isNaN(pages) ? DEFAULT_PDF_PAGES : Math.min(LARGE_PDF_PAGES, Math.max(1, pages))
}
/** Tabular files keep their header plus sampled rows within this many chunks. */
export const MAX_TABULAR_CHUNKS = 120
const MAX_HEADER_CHARS = 160
const NUMERIC_LETTER_RATIO = 0.2

export type TruncatedReason =
  | 'chunk-limit'
  | 'content-limit'
  | 'pdf-page-limit'
  | 'tabular-sampling'

export interface CappedChunks {
  chunks: DocumentChunk[]
  /** True when content beyond the cap was left out of the index. */
  truncated: boolean
  truncatedReason?: TruncatedReason
}

/** Keep the first `max` chunks and report whether anything was dropped. */
export function capChunks(chunks: DocumentChunk[], max = MAX_CHUNKS_PER_FILE): CappedChunks {
  return chunks.length > max
    ? { chunks: chunks.slice(0, max), truncated: true, truncatedReason: 'chunk-limit' }
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
export function chunkTabularText(input: string, options?: { sheet?: string }): TabularChunks {
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
      ...(options?.sheet ? { metadata: { sheet: options.sheet } } : {}),
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
  if (!chunks.length)
    chunks.push({
      text: header,
      location: 'Header',
      ...(options?.sheet ? { metadata: { sheet: options.sheet } } : {}),
    })
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
    ...(truncated ? { truncatedReason: 'tabular-sampling' } : {}),
    numeric: nonSpace > 0 && letters / nonSpace < NUMERIC_LETTER_RATIO,
  }
}
