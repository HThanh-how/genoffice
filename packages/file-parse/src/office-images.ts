import { posix } from 'node:path'
import JSZip from 'jszip'
import { assertZipInflatesWithinLimits } from '@genoffice/docx-engine'

/**
 * The pictures inside a Word, PowerPoint or Excel file (`word/media`, `ppt/media`, `xl/media`).
 *
 * Only the list of the archive is read, nothing is inflated: the size of each picture is the one its
 * entry declares. A document that is made of scanned pages has no text, but it has these; a document
 * with text and a logo has a small one. Used to tell "nothing in this file" from "pictures that
 * nobody has read yet".
 */

/** A picture smaller than this (declared, uncompressed) is a logo, an icon or a rule, not a page. */
export const MIN_SIGNIFICANT_IMAGE_BYTES = 16 * 1024

const MEDIA_IMAGE = /^(?:word|ppt|xl)\/media\/[^/]+\.(?:png|jpe?g|gif|bmp|tiff?|webp)$/i

export interface EmbeddedImages {
  /** pictures big enough to hold text */
  count: number
  /** all pictures, big or small */
  total: number
}

export async function countEmbeddedImages(bytes: Uint8Array): Promise<EmbeddedImages> {
  const zip = await JSZip.loadAsync(bytes)
  let count = 0
  let total = 0
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || !MEDIA_IMAGE.test(name)) continue
    total++
    // (JSZip keeps the size from the central directory on the entry; if it is missing, count the
    // picture: a miscount towards "has pictures" only changes the wording of a message)
    const declared = (entry as unknown as { _data?: { uncompressedSize?: number } })._data
      ?.uncompressedSize
    if (declared === undefined || declared >= MIN_SIGNIFICANT_IMAGE_BYTES) count++
  }
  return { count, total }
}

/** Whether the file is a package that can carry pictures: .docx, .pptx, .xlsx and .xlsm. */
export function mayHoldPictures(path: string): boolean {
  return /\.(?:docx|pptx|xlsx|xlsm)$/i.test(path)
}

// ---- the pictures in the order of the document --------------------------------------------------

/**
 * No more than this many pictures of one file are ever read: the text of later ones is not put in the
 * index (the limit of OCR pages per file), and a photo album is not a scanned file.
 */
export const MAX_OFFICE_IMAGES = 50
/** A picture declared larger than this is not read at all; a package part larger than this is not parsed. */
const MAX_IMAGE_BYTES = 30 * 1024 * 1024
const MAX_XML_BYTES = 64 * 1024 * 1024

type Kind = 'docx' | 'pptx' | 'xlsx'

function declaredBytes(entry: JSZip.JSZipObject): number | undefined {
  return (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize
}

async function xmlOf(zip: JSZip, name: string): Promise<string> {
  const entry = zip.file(name)
  if (!entry) return ''
  const declared = declaredBytes(entry)
  if (declared !== undefined && declared > MAX_XML_BYTES) return ''
  return entry.async('string')
}

const ATTR = (tag: string, name: string): string | undefined =>
  new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag)?.[1]

/** relationship id -> path inside the package, for the relationships of `part` (external targets left out) */
async function relationships(zip: JSZip, part: string): Promise<Map<string, string>> {
  const dir = posix.dirname(part)
  const xml = await xmlOf(zip, `${dir}/_rels/${posix.basename(part)}.rels`)
  const out = new Map<string, string>()
  for (const tag of xml.match(/<Relationship\b[^>]*>/g) ?? []) {
    const id = ATTR(tag, 'Id')
    const target = ATTR(tag, 'Target')
    if (!id || !target || /TargetMode\s*=\s*"External"/i.test(tag)) continue
    const resolved = target.startsWith('/')
      ? target.slice(1)
      : posix.normalize(posix.join(dir, target))
    out.set(id, resolved)
  }
  return out
}

const REL_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/**
 * relationship ids that a part refers to (`r:embed`, `r:id`, `r:pict`...), in the order of the document.
 * Only attributes of the relationships namespace count: a `w:id` of a bookmark or a change is a number of
 * its own and can be the same as the id of a relationship.
 */
function referencedIds(xml: string): string[] {
  const prefixes = new Set(['r'])
  for (const match of xml.matchAll(/xmlns:([A-Za-z][\w.-]*)\s*=\s*"([^"]*)"/g))
    if (match[2] === REL_NAMESPACE) prefixes.add(match[1]!)
  const names = [...prefixes].map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`\\b(?:${names.join('|')}):(?:embed|id|pict)\\s*=\\s*"([^"]+)"`, 'g')
  const ids: string[] = []
  for (const match of xml.matchAll(pattern)) ids.push(match[1]!)
  return ids
}

const MEDIA_PATH = /(?:^|\/)media\/[^/]+\.(?:png|jpe?g|gif|bmp|tiff?|webp)$/i
/** pictures in a package that no engine here can read */
const UNREADABLE_MEDIA = /(?:^|\/)media\/[^/]+\.(?:emf|wmf|svg|wdp|jxr)$/i

/** the pictures that one part (a page of text, a slide, a drawing) shows, in the order it shows them */
async function picturesOf(
  zip: JSZip,
  part: string,
  entries: ReadonlyMap<string, string>,
): Promise<{ found: string[]; unreadable: number }> {
  const rels = await relationships(zip, part)
  // (the background of a Word page is not a page of the document)
  const xml = (await xmlOf(zip, part)).replace(/<w:background\b[\s\S]*?<\/w:background>/g, '')
  const found: string[] = []
  let unreadable = 0
  for (const id of referencedIds(xml)) {
    const target = rels.get(id)
    if (!target) continue
    // (a package may spell a path in another case than the relationship does)
    const name = entries.get(target.toLowerCase())
    if (name && MEDIA_PATH.test(name)) found.push(name)
    else if (UNREADABLE_MEDIA.test(target)) unreadable++
  }
  return { found, unreadable }
}

async function orderedParts(zip: JSZip, kind: Kind): Promise<string[]> {
  if (kind === 'docx') return ['word/document.xml']
  const book = kind === 'pptx' ? 'ppt/presentation.xml' : 'xl/workbook.xml'
  const rels = await relationships(zip, book)
  const xml = await xmlOf(zip, book)
  const ids =
    (kind === 'pptx' ? xml.match(/<p:sldId\b[^>]*>/g) : xml.match(/<sheet\b[^>]*>/g)) ?? []
  const parts: string[] = []
  for (const tag of ids) {
    const target = rels.get(ATTR(tag, 'r:id') ?? '')
    if (target) parts.push(target)
  }
  if (kind === 'pptx') return parts
  // a worksheet shows its pictures through its drawings
  const drawings: string[] = []
  for (const sheet of parts) {
    for (const target of (await relationships(zip, sheet)).values())
      if (/(?:^|\/)drawings\/[^/]+\.xml$/i.test(target)) drawings.push(target)
  }
  return drawings
}

function kindOf(zip: JSZip): Kind | null {
  if (zip.file('word/document.xml')) return 'docx'
  if (zip.file('ppt/presentation.xml')) return 'pptx'
  if (zip.file('xl/workbook.xml')) return 'xlsx'
  return null
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' })
}

export interface OfficePictures {
  /** the paths inside the package, in the order of the document, each once, big enough to hold text */
  readonly names: readonly string[]
  /** how many of them are large (100 KB or more), as a scan of a page is */
  readonly large: number
  /** pictures the document shows that are left out because they are too large or of a kind nobody here reads */
  readonly unreadable: number
  /** the document shows more pictures than `MAX_OFFICE_IMAGES`: the later ones are not listed */
  readonly more: boolean
  /** the bytes of one of them */
  read(name: string): Promise<Uint8Array>
}

/** A picture of this size or more can be a page of a scan; a smaller one is a figure. */
export const LARGE_PICTURE_BYTES = 100 * 1024

/**
 * The pictures of a Word, PowerPoint or Excel file in the order the document shows them (the body
 * of a Word file; the slides in their order; the drawings of the sheets in theirs), so that "page 3"
 * of the scan is the same picture every time the file is read. Pictures that only the headers, the
 * masters or the layouts use, or that nothing uses, are not listed. A package that cannot be walked this
 * way (no main part, or a part that cannot be read) falls back to the media folder in the order of the names.
 * The same picture under two names is listed twice (comparing contents would mean reading every picture).
 * Pictures smaller than `MIN_SIGNIFICANT_IMAGE_BYTES` (logos, icons, rules) are left out, larger ones
 * and kinds nobody here reads are counted in `unreadable`, and at most `MAX_OFFICE_IMAGES`
 * are listed. Only the list of the archive and the XML parts are read here; a picture is inflated
 * by `read`.
 */
export async function loadOfficePictures(bytes: Uint8Array): Promise<OfficePictures> {
  // (a part that declares a small size and inflates to a great one is stopped here, before a picture is read)
  await assertZipInflatesWithinLimits(bytes)
  const zip = await JSZip.loadAsync(bytes)
  const entries = new Map<string, string>()
  for (const [name, entry] of Object.entries(zip.files))
    if (!entry.dir) entries.set(name.toLowerCase(), name)
  const kind = kindOf(zip)
  let found: string[] = []
  let unreadable = 0
  // The media folder in the order of the names is for a package that cannot be walked (no main part, or a
  // part that could not be read). A package that WAS walked and shows no picture has none: the pictures
  // that only a header, a footer or nobody uses are not the pages of a scan.
  let walked = false
  if (kind) {
    try {
      for (const part of await orderedParts(zip, kind)) {
        const shown = await picturesOf(zip, part, entries)
        found.push(...shown.found)
        unreadable += shown.unreadable
      }
      walked = true
    } catch {
      found = []
      unreadable = 0
    }
  }
  if (!walked) {
    found = [...entries.values()]
      .filter((name) => /^(?:word|ppt|xl)\/media\//i.test(name) && MEDIA_PATH.test(name))
      .sort(naturalCompare)
  }
  const names: string[] = []
  let large = 0
  let more = false
  const seen = new Set<string>()
  for (const name of found) {
    const entry = zip.file(name)
    if (!entry || seen.has(name)) continue
    seen.add(name)
    const declared = declaredBytes(entry)
    if (declared !== undefined && declared > MAX_IMAGE_BYTES) {
      unreadable++
      continue
    }
    if (declared !== undefined && declared < MIN_SIGNIFICANT_IMAGE_BYTES) continue
    if (names.length >= MAX_OFFICE_IMAGES) {
      more = true
      break
    }
    names.push(name)
    if (declared === undefined || declared >= LARGE_PICTURE_BYTES) large++
  }
  return {
    names,
    large,
    unreadable,
    more,
    read: async (name) => {
      const entry = zip.file(name)
      if (!entry || !names.includes(name)) throw new Error('No such picture in this file')
      return entry.async('uint8array')
    },
  }
}

const PLACEHOLDER =
  /^\s*\[(?:No extractable text:|picture-only slide:|image-only sheet:)[^\n]*\]\s*$/

/**
 * The text of a Word, PowerPoint or Excel file that is really in it. The extractors of slides and sheets
 * write lines of their own for a slide or a sheet that holds only pictures ("[picture-only slide: ...]",
 * "[No extractable text: ...]") and a heading for each; those are not the words of the document, and
 * counting them would make a deck of pictures look like a deck with text.
 */
export function realOfficeText(text: string, path: string): string {
  const structured = /\.(?:pptx|xlsx|xlsm)$/i.test(path)
  return text
    .split('\n\n')
    .map((block) =>
      block
        .split('\n')
        .filter((line, index) => {
          if (PLACEHOLDER.test(line)) return false
          // the heading of a section is its first line: "## Slide 3", "# Sheet1" (a line of the same look
          // that a person wrote in the middle of a cell or a slide is a word of the document)
          return !(structured && index === 0 && /^#{1,2} .{0,80}$/.test(line))
        })
        .join('\n'),
    )
    .join('\n\n')
}
