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

/**
 * Filler words of a question that say nothing about a file's name. They are judged on the word
 * AS TYPED: folding accents first made "mỹ" (a name) look like the English "my" and "mẹ" like
 * "me", which dropped real name words. Accented forms are matched only with their accents; a few
 * unambiguous ones are also matched when typed without accents.
 */
const FILLER_ACCENTED = new Set(
  (
    'có cái nào là không cho của những một các tôi mình giúp hãy tìm kiếm này kia được đâu gì và ' +
    'với trong trên về thì sao nhỉ nhé vậy nè rồi chưa hoặc từ đến ở mà để khi xem'
  ).split(' '),
)
const FILLER_PLAIN = new Set(
  (
    'co cai nao la khong cho cua nhung mot cac nay kia duoc gi va voi trong tren thi sao nhi nhe ' +
    'vay ne roi chua hoac xem tim kiem giup hay file files the of in is are any there find show ' +
    'search please which what where a an to for with or and'
  ).split(' '),
)
const FILLER_PHRASES = /\b(tài liệu|tai lieu|văn bản|van ban|nội dung|noi dung)\b/giu

/** The words of a question that could appear in a file name, accents and case ignored. */
export function nameWords(input: string): string[] {
  const typed = input
    .normalize('NFC')
    .toLocaleLowerCase('vi')
    .replace(FILLER_PHRASES, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  const words = new Set<string>()
  for (const token of typed) {
    const folded = normalizeDocumentText(token)
    if (!folded) continue
    const plain = folded === token
    if (FILLER_ACCENTED.has(token) || (plain && FILLER_PLAIN.has(token))) continue
    for (const part of folded.split(' ')) if (part) words.add(part)
  }
  const list = [...words]
  // "xuất viện" and "ra viện" name the same paper
  if (list.includes('vien')) {
    if (list.includes('xuat') && !list.includes('ra')) list.push('ra')
    else if (list.includes('ra') && !list.includes('xuat')) list.push('xuat')
  }
  return list
}

export function queryTokens(input: string): string[] {
  return [...new Set(documentSearchTokens(input).filter((token) => !GENERIC_WORDS.has(token)))]
}
