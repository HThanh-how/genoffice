import { tokenize } from '../file-index/tokenize'

/** Accent-insensitive search text with stable spacing for Vietnamese and class codes. */
export function normalizeDocumentText(input: string): string {
  let text = input.normalize('NFKC').toLocaleLowerCase('vi')
  // Class/course codes occur in both joined and separated forms in office files.
  text = text
    .replace(/\b(class|lop)\s*(\d{1,2})\b/giu, '$1 $2')
    .replace(/\b(\d{1,2})\s*[-/]\s*(\d{1,2})\b/gu, '$1 $2')
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

export function documentSearchTokens(input: string): string[] {
  return tokenize(normalizeDocumentText(input)).bi
}

/** Stored `normalized` text and FTS text of a chunk, normalizing once (same values as the helpers above). */
export function documentIndexFields(input: string): { normalized: string; searchText: string } {
  const normalized = normalizeDocumentText(input)
  return { normalized, searchText: tokenize(normalized).bi.join(' ') }
}

const GENERIC_WORDS = new Set([
  'tim',
  'kiem',
  'tìm',
  'kiếm',
  'file',
  'files',
  'document',
  'documents',
  'doc',
  'in',
  'of',
  'the',
  'a',
  'an',
  'to',
  'for',
  'co',
  'có',
  've',
  'về',
  'trong',
  'la',
  'là',
  'noi',
  'dung',
  'nội',
  'dung',
  'giup',
  'giúp',
  'hay',
  'show',
  'find',
  'search',
  'please',
  'me',
  'with',
])

export function queryTokens(input: string): string[] {
  return [...new Set(documentSearchTokens(input).filter((token) => !GENERIC_WORDS.has(token)))]
}
