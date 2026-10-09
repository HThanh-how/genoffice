import { normalizeDocumentText } from '../normalization'

/**
 * Names / folders that suggest identity, legal or credential papers. Matching is diacritic- and
 * case-insensitive on whole words (`atm` does not match `atmosphere`), plus a joined form for long
 * Vietnamese phrases written without spaces (`cancuoc`, `ho_khau`). Only the NAME and PATH are looked
 * at; no file content is read or logged.
 */
const WORD_TERMS = [
  'cccd', 'cmnd', 'cmt', 'cmtnd', 'passport', 'passwd', 'password', 'otp', 'atm', 'stk', 'cvv', 'ssn',
  'can cuoc', 'can cuoc cong dan', 'chung minh', 'chung minh nhan dan', 'ho chieu', 'ho khau', 'so ho khau',
  'so do', 'so hong', 'giay khai sinh', 'khai sinh', 'bang lai', 'bang lai xe', 'giay phep lai xe', 'gplx',
  'the ngan hang', 'the atm', 'the tin dung', 'so tai khoan', 'sao ke', 'mat khau', 'bao hiem y te', 'bhyt',
  'bhxh', 'so bhxh', 'giay ket hon', 'dang ky ket hon', 'identity card', 'id card',
  'driver license', 'driving licence', 'driving license', 'credit card', 'bank statement', 'bank card',
  'social security', 'visa card', 'recovery code', 'seed phrase', 'private key',
]
/** Only phrases this long are matched in their joined (space-less) spelling, so short words never collide. */
const JOINED_MIN_LENGTH = 6

const wordTerms = new Set(WORD_TERMS.map((t) => normalizeDocumentText(t)))
const joinedTerms = [...wordTerms].map((t) => t.replace(/ /g, '')).filter((t) => t.length >= JOINED_MIN_LENGTH)
const MAX_FOLDERS_CONSIDERED = 6
const MAX_NAME_CHARS = 300

function hasTerm(text: string): boolean {
  const norm = normalizeDocumentText(text.slice(0, MAX_NAME_CHARS))
  if (!norm) return false
  const padded = ` ${norm} `
  for (const term of wordTerms) if (padded.includes(` ${term} `)) return true
  const joined = norm.replace(/ /g, '')
  for (const term of joinedTerms) if (joined.includes(term)) return true
  return false
}

/** True when the file name or one of its nearest folders looks like an identity / legal / credential paper. */
export function isSensitiveName(name: string, path?: string): boolean {
  if (hasTerm(name.replace(/\.[^./\\]+$/, ''))) return true
  if (!path) return false
  const folders = path.split(/[\\/]+/).filter(Boolean).slice(0, -1).slice(-MAX_FOLDERS_CONSIDERED)
  return folders.some(hasTerm)
}
