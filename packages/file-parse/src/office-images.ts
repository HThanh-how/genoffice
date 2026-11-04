import { posix } from 'node:path'
import JSZip from 'jszip'

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

/** No more than this many pictures of one file are ever read (a photo album is not a scanned file). */
export const MAX_OFFICE_IMAGES = 100
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

/** relationship ids that a part refers to (`r:embed`, `r:id`, `r:pict`...), in the order of the document */
function referencedIds(xml: string): string[] {
  const ids: string[] = []
  for (const match of xml.matchAll(/\b[A-Za-z]+:(?:embed|id|pict)\s*=\s*"([^"]+)"/g))
    ids.push(match[1]!)
  return ids
}

const MEDIA_PATH = /(?:^|\/)media\/[^/]+\.(?:png|jpe?g|gif|bmp|tiff?|webp)$/i

/** the pictures that one part (a page of text, a slide, a drawing) shows, in the order it shows them */
async function picturesOf(zip: JSZip, part: string): Promise<string[]> {
  const rels = await relationships(zip, part)
  const out: string[] = []
  for (const id of referencedIds(await xmlOf(zip, part))) {
    const target = rels.get(id)
    if (target && MEDIA_PATH.test(target)) out.push(target)
  }
  return out
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
  /** the bytes of one of them */
  read(name: string): Promise<Uint8Array>
}

/**
 * The pictures of a Word, PowerPoint or Excel file in the order the document shows them (the body
 * of a Word file; the slides in their order; the drawings of the sheets in theirs), so that "page 3"
 * of the scan is the same picture every time the file is read. Pictures that only the headers, the
 * masters or the layouts use, or that nothing uses, are not listed. A package that cannot be walked this
 * way (no main part, or a part that cannot be read) falls back to the media folder in the order of the names.
 * The same picture under two names is listed twice (comparing contents would mean reading every picture). Pictures smaller than `MIN_SIGNIFICANT_IMAGE_BYTES`
 * (logos, icons, rules) and larger than a sane limit are left out, and at most `MAX_OFFICE_IMAGES`
 * are listed. Only the list of the archive and the XML parts are read here; a picture is inflated
 * by `read`.
 */
export async function loadOfficePictures(bytes: Uint8Array): Promise<OfficePictures> {
  const zip = await JSZip.loadAsync(bytes)
  const kind = kindOf(zip)
  let found: string[] = []
  // The media folder in the order of the names is for a package that cannot be walked (no main part, or a
  // part that could not be read). A package that WAS walked and shows no picture has none: the pictures
  // that only a header, a footer or nobody uses are not the pages of a scan.
  let walked = false
  if (kind) {
    try {
      for (const part of await orderedParts(zip, kind)) found.push(...(await picturesOf(zip, part)))
      walked = true
    } catch {
      found = []
    }
  }
  if (!walked) {
    found = Object.keys(zip.files)
      .filter(
        (name) =>
          !zip.files[name]!.dir && /^(?:word|ppt|xl)\/media\//i.test(name) && MEDIA_PATH.test(name),
      )
      .sort(naturalCompare)
  }
  const names: string[] = []
  const seen = new Set<string>()
  for (const name of found) {
    const entry = zip.file(name)
    if (!entry || seen.has(name)) continue
    seen.add(name)
    const declared = declaredBytes(entry)
    if (
      declared !== undefined &&
      (declared < MIN_SIGNIFICANT_IMAGE_BYTES || declared > MAX_IMAGE_BYTES)
    )
      continue
    names.push(name)
    if (names.length >= MAX_OFFICE_IMAGES) break
  }
  return {
    names,
    read: async (name) => {
      const entry = zip.file(name)
      if (!entry || !names.includes(name)) throw new Error('No such picture in this file')
      return entry.async('uint8array')
    },
  }
}
