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
