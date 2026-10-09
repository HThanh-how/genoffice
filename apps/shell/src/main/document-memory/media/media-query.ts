import { nameWords, normalizeDocumentText } from '../normalization'
import type { MediaKind } from './media-kinds'
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from './media-kinds'

/** What a query asks of the media rows. `null` from {@link parseMediaIntent} = the query is about documents. */
export interface MediaIntent {
  kind?: MediaKind
  /** `[from, to)` epoch ms in the user's local time zone. */
  range?: { from: number; to: number; day: boolean; year: number; month: number; dayOfMonth: number }
  /** Name/path words every result must contain (diacritic-insensitive prefix match). */
  words: string[]
  /** Extensions (`.png`) the query named. */
  extensions: string[]
  /** FTS5 `MATCH` over the name projection for the same date written in a file name (IMG_20170316, 2017-03-16 ...). */
  nameDateMatch: string | null
}

const IMAGE_WORDS = new Set(['anh', 'hinh', 'photo', 'photos', 'picture', 'pictures', 'pic', 'pics', 'image', 'images'])
const VIDEO_WORDS = new Set(['video', 'videos', 'phim', 'clip', 'clips', 'film', 'movie', 'movies'])
/** Image-ish words that are also what such files are called: kind = image AND the word must be in the name. */
const IMAGE_NAME_WORDS = new Set(['screenshot', 'screenshots', 'scan', 'scans', 'scanned'])
/** The Vietnamese macOS / Windows screenshot name: "Ảnh chụp màn hình 2024-..." */
const SCREENSHOT_PHRASE = /\b(anh )?chup man hinh\b/

const pad = (n: number): string => String(n).padStart(2, '0')

interface ParsedDate {
  range: NonNullable<MediaIntent['range']>
  /** Phrases as they appear in `name_norm` (accent-free tokens, punctuation split). */
  phrases: string[]
  rest: string
}

/** Day / month forms: 2017-03-16, 16/03/2017, 20170316, "tháng 3 2017", "thang 3/2017", 03/2017, 2017-03. */
export function parseDateIntent(query: string): ParsedDate | null {
  const day = (y: number, m: number, d: number, rest: string): ParsedDate | null => {
    if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null
    const from = new Date(y, m - 1, d)
    if (from.getMonth() !== m - 1) return null
    const to = new Date(y, m - 1, d + 1)
    const [Y, M, D] = [String(y), pad(m), pad(d)]
    return {
      range: { from: from.getTime(), to: to.getTime(), day: true, year: y, month: m, dayOfMonth: d },
      phrases: [`"${Y}${M}${D}"`, `"${Y} ${M} ${D}"`, `"${D} ${M} ${Y}"`],
      rest,
    }
  }
  const month = (y: number, m: number, rest: string): ParsedDate | null => {
    if (y < 1990 || y > 2100 || m < 1 || m > 12) return null
    const [Y, M] = [String(y), pad(m)]
    return {
      range: { from: new Date(y, m - 1, 1).getTime(), to: new Date(y, m, 1).getTime(), day: false, year: y, month: m, dayOfMonth: 0 },
      phrases: [`"${Y}${M}"*`, `"${Y} ${M}"`, `"${M} ${Y}"`],
      rest,
    }
  }
  const cut = (m: RegExpExecArray) => `${query.slice(0, m.index)} ${query.slice(m.index + m[0].length)}`
  let m: RegExpExecArray | null
  if ((m = /(?<!\d)(\d{4})[-/._](\d{1,2})[-/._](\d{1,2})(?!\d)/.exec(query))) return day(+m[1]!, +m[2]!, +m[3]!, cut(m))
  if ((m = /(?<!\d)(\d{1,2})[-/._](\d{1,2})[-/._](\d{4})(?!\d)/.exec(query))) return day(+m[3]!, +m[2]!, +m[1]!, cut(m))
  if ((m = /(?<!\d)((?:19|20)\d{2})(\d{2})(\d{2})(?!\d)/.exec(query))) return day(+m[1]!, +m[2]!, +m[3]!, cut(m))
  if ((m = /(?:th[áa]ng|thang|month)\s*(\d{1,2})\s*(?:[,/-]|n[ăa]m|nam)?\s*((?:19|20)\d{2})(?!\d)/iu.exec(query))) {
    return month(+m[2]!, +m[1]!, cut(m))
  }
  if ((m = /(?<!\d)(\d{1,2})[-/](\d{4})(?!\d)/.exec(query))) return month(+m[2]!, +m[1]!, cut(m))
  if ((m = /(?<!\d)((?:19|20)\d{2})[-/](\d{1,2})(?![\d-])/.exec(query))) return month(+m[1]!, +m[2]!, cut(m))
  return null
}

/**
 * Reads a media request out of a free-text query: a type word (ảnh, hình, photo, video, phim, clip,
 * screenshot, scan ...), an extension (png, mp4 ...) and/or a date. Anything else must be in the file
 * name or folder. Queries with none of these are document queries and return null.
 */
export function parseMediaIntent(query: string): MediaIntent | null {
  const date = parseDateIntent(query)
  const text = date ? date.rest : query
  let normalized = normalizeDocumentText(text)
  let kind: MediaKind | undefined
  const words: string[] = []
  if (SCREENSHOT_PHRASE.test(normalized)) {
    kind = 'image'
    normalized = normalized.replace(SCREENSHOT_PHRASE, ' ')
    words.push('chup', 'man', 'hinh')
  }
  const extensions: string[] = []
  for (const word of nameWords(normalized)) {
    if (IMAGE_WORDS.has(word)) kind ??= 'image'
    else if (VIDEO_WORDS.has(word)) kind ??= 'video'
    else if (IMAGE_NAME_WORDS.has(word)) {
      kind ??= 'image'
      words.push(word)
    } else if (IMAGE_EXTENSIONS.has(`.${word}`)) {
      kind ??= 'image'
      extensions.push(`.${word}`)
    } else if (VIDEO_EXTENSIONS.has(`.${word}`)) {
      kind ??= 'video'
      extensions.push(`.${word}`)
    } else words.push(word)
  }
  if (!kind && !date) return null
  return { kind, range: date?.range, words: [...new Set(words)].slice(0, 6), extensions, nameDateMatch: date ? `name_norm: (${date.phrases.join(' OR ')})` : null }
}
