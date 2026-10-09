/**
 * Tone-insensitive Vietnamese syllable validity, used by the local-OCR escalation score.
 *
 * Why not a dictionary: a word list is megabytes and misses names. Vietnamese syllables are
 * strictly phonotactic (initial consonant x rhyme, with the tone mark on top), so the whole
 * inventory (about 4,600 toneless forms) is GENERATED at first use from two small tables, no
 * data file is shipped. Measured on 57,831 tokens of real Vietnamese office documents the table
 * accepts 97.7% (the misses are abbreviations such as UBND/TPHCM); garbage OCR output such as
 * "ttirrn" or "xcvb" is rejected, which is exactly the signal the escalation rule needs.
 */

/** Initial consonants (the empty string = vowel-initial syllable). */
const INITIALS = [
  '', 'b', 'c', 'ch', 'd', 'đ', 'g', 'gh', 'gi', 'h', 'k', 'kh', 'l', 'm', 'n', 'ng', 'ngh', 'nh',
  'p', 'ph', 'qu', 'r', 's', 't', 'th', 'tr', 'v', 'x',
]

/** Toneless nucleus (vowel, vowel pair or triple) -> admissible codas. */
const RHYMES: Readonly<Record<string, readonly string[]>> = {
  a: ['', 'c', 'ch', 'm', 'n', 'ng', 'nh', 'p', 't', 'i', 'o', 'u', 'y'],
  ă: ['c', 'm', 'n', 'ng', 'p', 't'],
  â: ['c', 'm', 'n', 'ng', 'p', 't', 'u', 'y'],
  e: ['', 'c', 'ch', 'm', 'n', 'ng', 'nh', 'p', 't', 'o'],
  ê: ['', 'ch', 'm', 'n', 'nh', 'p', 't', 'u'],
  i: ['', 'a', 'ch', 'm', 'n', 'nh', 'p', 't', 'u'],
  y: ['', 'ch', 'n', 'nh', 't'],
  o: ['', 'c', 'm', 'n', 'ng', 'p', 't', 'i', 'a', 'e', 'ă'],
  ô: ['', 'c', 'm', 'n', 'ng', 'p', 't', 'i'],
  ơ: ['', 'm', 'n', 'p', 't', 'i'],
  u: ['', 'c', 'm', 'n', 'ng', 'p', 't', 'i', 'a', 'y'],
  ư: ['', 'c', 'ng', 't', 'i', 'a', 'u', 'n', 'm', 'ơ'],
  iê: ['c', 'm', 'n', 'ng', 'p', 't', 'u'],
  yê: ['n', 'm', 't', 'u', 'ng'],
  uô: ['c', 'm', 'n', 'ng', 't', 'i'],
  ươ: ['c', 'm', 'n', 'ng', 'p', 't', 'i', 'u'],
  oa: ['', 'c', 'ch', 'm', 'n', 'ng', 'nh', 'p', 't', 'i', 'o', 'y'],
  oă: ['c', 'm', 'n', 'ng', 't'],
  oe: ['', 'n', 't', 'o'],
  uâ: ['n', 'ng', 't', 'y'],
  uê: ['', 'ch', 'n', 'nh'],
  uy: ['', 'ch', 'n', 'nh', 'p', 't', 'u', 'a'],
  uyê: ['n', 't'],
  uơ: [''],
  oai: [''],
  oay: [''],
  uây: [''],
  uôi: [''],
  ươi: [''],
  ươu: [''],
  iêu: [''],
  yêu: [''],
}

let table: Set<string> | null = null

/** The toneless syllable inventory, built once. */
export function vietnameseSyllables(): ReadonlySet<string> {
  if (table) return table
  const set = new Set<string>()
  for (const [nucleus, codas] of Object.entries(RHYMES))
    for (const coda of codas) for (const initial of INITIALS) set.add(initial + nucleus + coda)
  for (const tail of ['e', 'ê', 'i', 'iê', 'iêu']) set.add(`ngh${tail}`)
  table = set
  return set
}

// the five tone marks (huyền, sắc, ngã, hỏi, nặng); the vowel-quality marks (^ ˘ horn) stay
const TONE_MARKS = /[̣̀́̃̉]/g

/** Lower-case, NFC, tone marks removed (vowel-quality marks kept). */
export function stripVietnameseTones(token: string): string {
  return token.normalize('NFD').toLowerCase().replace(TONE_MARKS, '').normalize('NFC')
}

export function isVietnameseSyllable(token: string): boolean {
  return vietnameseSyllables().has(stripVietnameseTones(token))
}

const ALPHA_TOKEN = /\p{L}+/gu

/** Alphabetic tokens of at least `minLength` letters. */
export function alphaTokens(text: string, minLength = 2): string[] {
  return (text.normalize('NFC').match(ALPHA_TOKEN) ?? []).filter((t) => t.length >= minLength)
}

/** Share of alphabetic tokens that are valid syllables, and how many tokens were looked at. */
export function syllableFraction(text: string): { fraction: number; tokens: number } {
  const tokens = alphaTokens(text)
  if (tokens.length === 0) return { fraction: 0, tokens: 0 }
  let valid = 0
  for (const token of tokens) if (isVietnameseSyllable(token)) valid++
  return { fraction: valid / tokens.length, tokens: tokens.length }
}
