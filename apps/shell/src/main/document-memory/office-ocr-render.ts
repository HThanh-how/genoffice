/**
 * The pictures of a Word, PowerPoint or Excel file as the "pages" of a scan, for the local OCR pass.
 * Runs in the index process next to the PDF renderer (agy-ocr-render.ts) and answers the same request
 * with the same result: page N is the N-th picture in the order of the document (see
 * `loadOfficePictures`), so a file that is read again later gives the same numbers, and the text
 * that is stored under them (`ocr_pages`) is found by the same lookup as the text of a scanned PDF.
 *
 * A picture is handed over as it is in the file (no re-encoding); the engine's own preparation shrinks
 * and flattens it. A picture that must not be handed to an engine (too many pixels to decode safely,
 * or a thumbnail) comes back with NO bytes: the pass stores it as a page without text, so the file
 * can be finished instead of being offered again for ever.
 */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { loadOfficePictures } from '@genoffice/file-parse'
import { planOcrBatch } from '@genoffice/ai-provider/agy-ocr'
import type { OcrRenderedPage, OcrRenderRequest, OcrRenderResult } from './agy-ocr-render'
import { readImageMetadata } from './media/image-headers'
import { classifyOcrSourceError } from './ocr-source-errors'
import { prepareForTesseract, TESSERACT_MAX_PIXELS } from './local-ocr/tesseract-prepare'

/** Pictures with both sides under this are icons and bullets (the same limit as for image files). */
export const OFFICE_MIN_EDGE_PX = 120
/** Files larger than this are not read (the same as for PDFs in the local pass). */
export const OFFICE_MAX_BYTES = 64 * 1024 * 1024
/** The scale the flattening is made for (what a rendered page of the PDF renderer is worth on A4). */
const PREPARE_DPI = 137
/**
 * A picture that cannot be decoded here (interlaced or 16-bit PNG, progressive JPEG) would go to the engine
 * as it is, at its full size; above this many pixels it is not handed over.
 */
const PASSTHROUGH_MAX_PIXELS = 16_000_000
/** The pictures handed over in one answer: one batch is held in memory at once. */
const MAX_BATCH_BYTES = 48 * 1024 * 1024

export interface OfficeRenderDeps {
  probeRoot?(root: string): Promise<boolean>
  readFile(path: string): Promise<Uint8Array>
  stat(path: string): Promise<{ size: number; mtimeMs: number }>
}

const realDeps: OfficeRenderDeps = { readFile, stat }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function dimensions(bytes: Uint8Array): Promise<{ width: number; height: number } | null> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const meta = await readImageMetadata({
    size: buffer.length,
    read: async (offset, length) => buffer.subarray(offset, offset + length),
  })
  return meta.width && meta.height ? { width: meta.width, height: meta.height } : null
}

export async function renderOfficePicturesForOcr(
  path: string,
  request: OcrRenderRequest,
  deps: OfficeRenderDeps = realDeps,
): Promise<OcrRenderResult> {
  const sourceFailure = async (error: unknown): Promise<OcrRenderResult> => ({
    ok: false,
    ...(await classifyOcrSourceError(path, error, deps.probeRoot, request.sourceRoot)),
    message: errorText(error),
  })
  let before: { size: number; mtimeMs: number }
  try {
    before = await deps.stat(path)
  } catch (error) {
    return sourceFailure(error)
  }
  if (before.size > OFFICE_MAX_BYTES)
    return { ok: false, code: 'too-large', message: 'The file is too large to read with OCR' }
  if (typeof request.retryRenderedPage === 'number')
    return {
      ok: false,
      code: 'render',
      message: 'A picture of a document cannot be rendered again',
    }
  let bytes: Uint8Array
  try {
    bytes = await deps.readFile(path)
  } catch (error) {
    return sourceFailure(error)
  }
  const hash = createHash('sha256').update(bytes).digest('hex')
  let pictures: Awaited<ReturnType<typeof loadOfficePictures>>
  try {
    pictures = await loadOfficePictures(bytes)
  } catch (error) {
    return { ok: false, code: 'corrupt', message: `The file cannot be opened: ${errorText(error)}` }
  }
  if (pictures.names.length === 0)
    return { ok: false, code: 'unsupported', message: 'This file has no picture that can be read' }
  let after: { size: number; mtimeMs: number }
  try {
    after = await deps.stat(path)
  } catch (error) {
    return sourceFailure(error)
  }
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
    return { ok: false, code: 'corrupt', message: 'The file changed during render preparation' }

  const count = Number.isSafeInteger(request.count) && request.count > 0 ? request.count : 1
  const maxPages =
    Number.isSafeInteger(request.maxPages) && request.maxPages > 0 ? request.maxPages : 1000
  const wanted = planOcrBatch({
    totalPages: pictures.names.length,
    done: new Set(Array.isArray(request.done) ? request.done : []),
    maxPagesPerFile: maxPages,
    pagesPerCall: count,
    budget: count,
  })
  const pages: OcrRenderedPage[] = []
  let batchBytes = 0
  for (const page of wanted) {
    if (pages.length >= count || batchBytes >= MAX_BATCH_BYTES) break
    let picture: Uint8Array
    try {
      picture = await pictures.read(pictures.names[page - 1]!)
    } catch {
      // a damaged entry: a page without text, so that the rest of the file is read
      pages.push({ page, jpeg: new Uint8Array(0), width: 0, height: 0, source: 'rendered' })
      continue
    }
    const size = await dimensions(picture)
    const tooLarge = size !== null && size.width * size.height > TESSERACT_MAX_PIXELS
    const tiny =
      size !== null && size.width < OFFICE_MIN_EDGE_PX && size.height < OFFICE_MIN_EDGE_PX
    if (tooLarge || tiny) {
      pages.push({
        page,
        jpeg: new Uint8Array(0),
        width: size?.width ?? 0,
        height: size?.height ?? 0,
        source: 'rendered',
      })
      continue
    }
    // The picture is decoded, shrunk and flattened here, in the index process, as the engine would do
    // through a request of its own: what is handed over is small, and one that cannot be handled is found out now.
    const prepared = ((): Uint8Array | null => {
      try {
        return prepareForTesseract(picture, PREPARE_DPI)
      } catch {
        return null
      }
    })()
    const passedThrough = prepared === picture
    if (
      prepared === null ||
      (passedThrough && size !== null && size.width * size.height > PASSTHROUGH_MAX_PIXELS)
    ) {
      pages.push({
        page,
        jpeg: new Uint8Array(0),
        width: size?.width ?? 0,
        height: size?.height ?? 0,
        source: 'rendered',
      })
      continue
    }
    batchBytes += prepared.byteLength
    pages.push({
      page,
      jpeg: prepared,
      width: size?.width ?? 0,
      height: size?.height ?? 0,
      // (not a scan's own JPEG stream: a decoding fault is not retried by another way of rendering)
      source: 'rendered',
    })
  }
  return {
    ok: true,
    hash,
    mtimeMs: after.mtimeMs,
    sizeBytes: after.size,
    totalPages: pictures.names.length,
    pages,
  }
}
