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
    .replace(/[đĐÐð]/gu, 'd')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
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
    'với trong trên về thì sao nhỉ nhé vậy nè rồi chưa hoặc từ đến ở mà để khi xem ông'
  ).split(' '),
)
const FILLER_PLAIN = new Set(
  (
    'co cai nao la khong cho cua nhung mot cac nay kia duoc gi va voi trong tren thi sao nhi nhe ' +
    'vay ne roi chua hoac xem tim kiem giup hay file files the of in is are any there find show ' +
    'search please which what where a an to for with or and ong'
  ).split(' '),
)
const FILLER_PHRASES = /\b(tài liệu|tai lieu|văn bản|van ban|nội dung|noi dung)\b/giu

/** True for a word that carries no meaning for finding a file ("của", "tìm", "file"...). */
export function isFillerWord(token: string): boolean {
  const word = token.normalize('NFC').toLocaleLowerCase('vi')
  const folded = normalizeDocumentText(word)
  return FILLER_ACCENTED.has(word) || (folded === word && FILLER_PLAIN.has(word))
}

/** The question without phrases that only name the kind of thing sought ("tài liệu", "nội dung"). */
export function stripFillerPhrases(input: string): string {
  return input.normalize('NFC').replace(FILLER_PHRASES, ' ')
}

/**
 * How many of the typed words (already folded, see {@link nameWords}) appear in `text` (a file
 * name with its folders). A word counts when it is a word of the name, or at least four letters
 * long and part of one; two neighbouring typed words also count when the name writes them
 * together ("huucong" for "hữu công").
 */
export function matchedNameWords(words: readonly string[], text: string): number {
  const folded = normalizeDocumentText(text)
  const have = new Set(folded.split(' '))
  const joined = folded.replace(/ /g, '')
  // Invoice-style codes ("HD433" vs "HD0433") match when only their leading zeros differ.
  const haveCodes = new Set<string>()
  for (const token of have) {
    const code = canonicalIdentifier(token)
    if (code !== token) haveCodes.add(code)
  }
  const found = words.map(
    (word) =>
      have.has(word) ||
      (haveCodes.size > 0 && (haveCodes.has(word) || haveCodes.has(canonicalIdentifier(word)))) ||
      (word.length >= 3 && joined.includes(word)),
  )
  for (let i = 0; i + 1 < words.length; i++) {
    if (joined.includes(words[i]! + words[i + 1]!)) found[i] = found[i + 1] = true
  }

  // Controlled narrow alias: "ra vien" <-> "xuat vien"
  // Does not inflate denominator (words.length); satisfies the typed term if alternative is present
  if (words.includes('vien') || have.has('vien') || joined.includes('vien')) {
    if ((have.has('xuat') || joined.includes('xuatvien')) && words.includes('ra')) {
      const idx = words.indexOf('ra')
      if (idx >= 0) found[idx] = true
    } else if ((have.has('ra') || joined.includes('ravien')) && words.includes('xuat')) {
      const idx = words.indexOf('xuat')
      if (idx >= 0) found[idx] = true
    }
  }

  return found.filter(Boolean).length
}

/**
 * Returns alternative word queries for controlled narrow aliases (e.g. 'ra viện' <-> 'xuất viện').
 * Returned as alternative query variants so they are not forced into the typed denominator.
 */
export function getNameQueryAliases(words: readonly string[]): string[][] {
  const aliases: string[][] = []
  if (words.includes('vien')) {
    if (words.includes('ra') && !words.includes('xuat')) {
      aliases.push(words.map((w) => (w === 'ra' ? 'xuat' : w)))
    } else if (words.includes('xuat') && !words.includes('ra')) {
      aliases.push(words.map((w) => (w === 'xuat' ? 'ra' : w)))
    }
  }
  return aliases
}

function typedNameTokens(input: string): string[] {
  return input
    .normalize('NFC')
    .toLocaleLowerCase('vi')
    .replace(FILLER_PHRASES, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/** The words of a question that could appear in a file name, accents and case ignored. */
export function nameWords(input: string): string[] {
  const words = new Set<string>()
  for (const token of typedNameTokens(input)) {
    const folded = normalizeDocumentText(token)
    if (!folded) continue
    const plain = folded === token
    if (FILLER_ACCENTED.has(token) || (plain && FILLER_PLAIN.has(token))) continue
    for (const part of folded.split(' ')) if (part) words.add(part)
  }
  return [...words]
}

/**
 * Like {@link nameWords} but keeps filler words. Used as a fallback when dropping them leaves
 * nothing usable: "cái bè" (a place) would otherwise shrink to the single two-letter word "be".
 */
export function nameWordsKeepingFillers(input: string): string[] {
  const words = new Set<string>()
  for (const token of typedNameTokens(input)) {
    for (const part of normalizeDocumentText(token).split(' ')) if (part) words.add(part)
  }
  return [...words]
}

/** True when the text carries Vietnamese diacritics ("bè", "mỹ", "đỏ") that the folded form loses. */
export function hasDiacritics(input: string): boolean {
  return /[\u0300-\u036f\u0111\u0110]/u.test(input.normalize('NFD'))
}

/** Letters + digits code ("HD0433") reduced to its zero-stripped form ("hd433"); other tokens unchanged. */
export function canonicalIdentifier(token: string): string {
  const m = /^([a-z]+)(\d+)$/.exec(token)
  if (!m) return token
  return m[1]! + m[2]!.replace(/^0+(?=\d)/, '')
}

/** Query-time spellings of a code that differ only in leading zeros ("hd433" -> hd433, hd0433, hd00433, hd000433). */
export function identifierVariants(token: string): string[] {
  const m = /^([a-z]+)(\d+)$/.exec(token)
  if (!m) return [token]
  const digits = m[2]!.replace(/^0+(?=\d)/, '')
  const out = new Set<string>([token, m[1]! + digits])
  for (let zeros = 1; zeros <= 3; zeros++) out.add(m[1]! + '0'.repeat(zeros) + digits)
  return [...out]
}

/**
 * Ordered, non-deduplicated query tokens without generic words. When the generic-word filter
 * would leave nothing, the original tokens are kept so the query is never dropped to nothing.
 */
export function queryTokenSequence(input: string): string[] {
  const all = documentSearchTokens(input)
  const kept = all.filter((token) => !GENERIC_WORDS.has(token))
  return kept.length ? kept : all
}

export function queryTokens(input: string): string[] {
  return [...new Set(queryTokenSequence(input))]
}
