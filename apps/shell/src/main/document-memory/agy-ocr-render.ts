/**
 * Renders PDF pages to small grayscale JPEGs for the scanned-PDF reader. Runs inside the index
 * child process (see worker.ts), never on the Electron main thread: PDFium (WebAssembly, the
 * same engine the PDF app uses) rasterises the page and a pure-TypeScript JPEG encoder shrinks
 * it. Only the pages that are needed are rendered; the page count comes from the PDF's own page
 * tree, so counting never renders anything.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { posix, win32 } from 'node:path'
import {
  OCR_IMAGE_LONG_EDGE_PX,
  OCR_MAX_IMAGE_BYTES,
  OCR_MAX_PDF_BYTES,
  planOcrBatch,
} from '@genoffice/ai-provider/agy-ocr'
import { downscaleGray, encodeGrayJpeg } from './jpeg-gray'

/** The slice of the PDFium WebAssembly module this file calls (names as in @embedpdf/pdfium). */
export interface OcrPdfium {
  HEAPU8: Uint8Array
  HEAPF32?: Float32Array
  _malloc(size: number): number
  _free(ptr: number): void
  _FPDF_LoadMemDocument(ptr: number, size: number, password: number): number
  _FPDF_GetLastError(): number
  _FPDF_CloseDocument(doc: number): void
  _FPDF_GetPageCount(doc: number): number
  _FPDF_LoadPage(doc: number, index: number): number
  _FPDF_ClosePage(page: number): void
  _FPDF_GetPageWidthF(page: number): number
  _FPDF_GetPageHeightF(page: number): number
  // embedded-image shortcut (all optional: feature-detected, the render path needs none of them)
  _FPDFPage_GetRotation?(page: number): number
  _FPDFPage_CountObjects?(page: number): number
  _FPDFPage_GetObject?(page: number, index: number): number
  _FPDFPageObj_GetType?(obj: number): number
  _FPDFPageObj_GetMatrix?(obj: number, matrix: number): number
  _FPDFImageObj_GetImageFilterCount?(image: number): number
  _FPDFImageObj_GetImageFilter?(
    image: number,
    index: number,
    buffer: number,
    buflen: number,
  ): number
  _FPDFImageObj_GetImageDataRaw?(image: number, buffer: number, buflen: number): number
  _FPDFBitmap_Create(width: number, height: number, alpha: number): number
  _FPDFBitmap_FillRect(
    bitmap: number,
    left: number,
    top: number,
    width: number,
    height: number,
    color: number,
  ): number
  _FPDFBitmap_GetBuffer(bitmap: number): number
  _FPDFBitmap_GetStride(bitmap: number): number
  _FPDFBitmap_Destroy(bitmap: number): void
  _FPDF_RenderPageBitmap(
    bitmap: number,
    page: number,
    startX: number,
    startY: number,
    sizeX: number,
    sizeY: number,
    rotate: number,
    flags: number,
  ): void
}

export type OcrRenderFailure =
  'password' | 'corrupt' | 'unsupported' | 'too-large' | 'missing' | 'render'

export interface OcrRenderedPage {
  /** 1-based page number */
  page: number
  jpeg: Uint8Array
  width: number
  height: number
  /** the scan's own JPEG stream (no re-encoding) or a PDFium render */
  source: 'embedded' | 'rendered'
}

export type OcrRenderResult =
  | {
      ok: true
      /** SHA-256 of the PDF bytes that were rendered */
      hash: string
      mtimeMs: number
      sizeBytes: number
      totalPages: number
      pages: OcrRenderedPage[]
    }
  | { ok: false; code: OcrRenderFailure; message: string }

export interface OcrRenderRequest {
  /** pages already transcribed (1-based) */
  done: number[]
  /** only the first N pages of a file are ever read */
  maxPages: number
  /** pages wanted for this call */
  count: number
}

// ---- where the wasm lives (dev: node_modules; packaged: Resources/wasm) -------------------

export interface OcrWasmPathDeps {
  platform: NodeJS.Platform
  /** `require.resolve` of a package file; undefined when it cannot be resolved (packaged app) */
  resolve(specifier: string): string | undefined
  resourcesPath?: string | undefined
  env: Record<string, string | undefined>
  exists(path: string): boolean
}

/** Explicit about every platform: dev checkout, then the packaged Resources/wasm folder. */
export function ocrPdfiumWasmPath(deps: OcrWasmPathDeps): string {
  const join = deps.platform === 'win32' ? win32.join : posix.join
  const candidates: string[] = []
  const resolved = deps.resolve('@embedpdf/pdfium/pdfium.wasm')
  if (resolved) candidates.push(resolved)
  for (const base of [deps.env.GENOFFICE_RESOURCES_PATH, deps.resourcesPath])
    if (base) candidates.push(join(base, 'wasm', 'pdfium.wasm'))
  const found = candidates.find((candidate) => deps.exists(candidate))
  if (!found) throw new Error('The PDF engine (pdfium.wasm) was not found')
  return found
}

function realWasmPathDeps(): OcrWasmPathDeps {
  const req = createRequire(import.meta.url)
  return {
    platform: process.platform,
    resolve: (specifier) => {
      try {
        return req.resolve(specifier)
      } catch {
        return undefined
      }
    },
    resourcesPath: (process as { resourcesPath?: string }).resourcesPath,
    env: process.env,
    exists: existsSync,
  }
}

let pdfiumPromise: Promise<OcrPdfium> | undefined

/** One PDFium instance per process, loaded on first use (the wasm is several MB). */
export function loadOcrPdfium(): Promise<OcrPdfium> {
  pdfiumPromise ??= (async () => {
    const { init } = (await import('@embedpdf/pdfium')) as unknown as {
      init(
        overrides: object,
      ): Promise<{ pdfium: OcrPdfium & { _PDFiumExt_Init(): void } } | unknown>
    }
    const raw = await readFile(ocrPdfiumWasmPath(realWasmPathDeps()))
    const wasmBinary = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
    // a fixed ASCII program name: emscripten asserts ASCII for argv[1] (see apps/pdf text-edit.ts)
    const wrapped = (await init({ wasmBinary, thisProgram: 'genoffice-pdf' })) as {
      pdfium?: OcrPdfium & { _PDFiumExt_Init(): void }
    } & OcrPdfium & { _PDFiumExt_Init(): void }
    const module = wrapped.pdfium ?? wrapped
    module._PDFiumExt_Init()
    return module
  })().catch((error: unknown) => {
    pdfiumPromise = undefined // allow a later retry
    throw error
  })
  return pdfiumPromise
}

// ---- rendering ----------------------------------------------------------------------------

/** FPDF_ERR_* (fpdfview.h): 2 file, 3 format, 4 password, 5 security, 6 page */
export function classifyPdfiumError(code: number): OcrRenderFailure {
  if (code === 4 || code === 5) return 'password'
  if (code === 3) return 'corrupt'
  if (code === 2) return 'missing'
  return 'unsupported'
}

/** Longest edge in pixels, and never above 200 dpi for small pages (receipts, cards). */
export function ocrRenderScale(widthPt: number, heightPt: number): number {
  const longest = Math.max(widthPt, heightPt, 1)
  return Math.min(OCR_IMAGE_LONG_EDGE_PX / longest, 200 / 72)
}

export interface JpegInfo {
  width: number
  height: number
  components: number
}

/** Size and component count from a JPEG's SOF marker; null when it is not a plain JPEG. */
export function jpegInfo(bytes: Uint8Array): JpegInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let i = 2
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) {
      i++
      continue
    }
    const marker = bytes[i + 1]!
    if (marker === 0xff) {
      i++
      continue
    }
    i += 2
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (marker === 0xda || marker === 0xd9) return null // scan or end before any frame header
    if (i + 2 > bytes.length) return null
    const length = (bytes[i]! << 8) | bytes[i + 1]!
    // SOF0 baseline, SOF1 extended, SOF2 progressive
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (i + 8 > bytes.length) return null
      return {
        height: (bytes[i + 3]! << 8) | bytes[i + 4]!,
        width: (bytes[i + 5]! << 8) | bytes[i + 6]!,
        components: bytes[i + 7]!,
      }
    }
    i += Math.max(2, length)
  }
  return null
}

/** Pages whose JPEG longest edge is outside this range are rendered instead. */
const EMBEDDED_MIN_EDGE_PX = 400
const EMBEDDED_MAX_EDGE_PX = 6000

/**
 * A scanned page is usually ONE full-page image stored as a JPEG stream (DCTDecode). When the page
 * holds nothing else, is not rotated, and the image is drawn upright over (almost) the whole page,
 * that stream is exactly what a render would approximate, at the scanner's own quality and for no
 * CPU. Anything unusual (stamps, text, vector art, several images, /Rotate, mirrored or rotated
 * placement, CMYK, a huge stream) returns null and the page is rendered as before.
 */
export function embeddedScanJpeg(
  m: OcrPdfium,
  page: number,
  widthPt: number,
  heightPt: number,
): { jpeg: Uint8Array; width: number; height: number } | null {
  if (
    !m._FPDFPage_CountObjects ||
    !m._FPDFPage_GetObject ||
    !m._FPDFPageObj_GetType ||
    !m._FPDFPageObj_GetMatrix ||
    !m._FPDFImageObj_GetImageFilterCount ||
    !m._FPDFImageObj_GetImageFilter ||
    !m._FPDFImageObj_GetImageDataRaw ||
    !m.HEAPF32
  )
    return null
  if (m._FPDFPage_GetRotation && m._FPDFPage_GetRotation(page) !== 0) return null
  if (m._FPDFPage_CountObjects(page) !== 1) return null
  const image = m._FPDFPage_GetObject(page, 0)
  if (!image || m._FPDFPageObj_GetType(image) !== 3 /* FPDF_PAGEOBJ_IMAGE */) return null
  if (m._FPDFImageObj_GetImageFilterCount(image) !== 1) return null
  const nameBuf = m._malloc(32)
  const matrixBuf = m._malloc(24)
  try {
    const length = m._FPDFImageObj_GetImageFilter(image, 0, nameBuf, 32)
    if (length <= 0 || length > 32) return null
    let name = ''
    for (let k = 0; k < length - 1; k++) name += String.fromCharCode(m.HEAPU8[nameBuf + k]!)
    if (name !== 'DCTDecode') return null
    if (!m._FPDFPageObj_GetMatrix(image, matrixBuf)) return null
    const [a, b, c, d] = [0, 1, 2, 3].map((k) => m.HEAPF32![(matrixBuf >> 2) + k]!) as [
      number,
      number,
      number,
      number,
    ]
    // upright (no rotation / shear / mirroring) and covering the page
    if (!(a > 0 && d > 0) || Math.abs(b) > a * 1e-3 || Math.abs(c) > d * 1e-3) return null
    if (a < widthPt * 0.85 || d < heightPt * 0.85) return null
  } finally {
    m._free(nameBuf)
    m._free(matrixBuf)
  }
  const size = m._FPDFImageObj_GetImageDataRaw(image, 0, 0)
  if (!(size > 0) || size > OCR_MAX_IMAGE_BYTES) return null
  const dataBuf = m._malloc(size)
  if (!dataBuf) return null
  try {
    const written = m._FPDFImageObj_GetImageDataRaw(image, dataBuf, size)
    if (written !== size) return null
    const jpeg = m.HEAPU8.slice(dataBuf, dataBuf + size)
    const info = jpegInfo(jpeg)
    if (!info || (info.components !== 1 && info.components !== 3)) return null
    const edge = Math.max(info.width, info.height)
    if (edge < EMBEDDED_MIN_EDGE_PX || edge > EMBEDDED_MAX_EDGE_PX) return null
    return { jpeg, width: info.width, height: info.height }
  } finally {
    m._free(dataBuf)
  }
}

function renderPage(m: OcrPdfium, doc: number, index: number): OcrRenderedPage | null {
  const page = m._FPDF_LoadPage(doc, index)
  if (!page) return null
  try {
    const widthPt = m._FPDF_GetPageWidthF(page)
    const heightPt = m._FPDF_GetPageHeightF(page)
    if (!(widthPt > 0) || !(heightPt > 0)) return null
    const embedded = embeddedScanJpeg(m, page, widthPt, heightPt)
    if (embedded) return { page: index + 1, ...embedded, source: 'embedded' }
    const scale = ocrRenderScale(widthPt, heightPt)
    const width = Math.max(1, Math.min(6000, Math.round(widthPt * scale)))
    const height = Math.max(1, Math.min(6000, Math.round(heightPt * scale)))
    if (width * height > 16_000_000) return null
    const bitmap = m._FPDFBitmap_Create(width, height, 0)
    if (!bitmap) return null
    try {
      m._FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff)
      m._FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 1 /* FPDF_ANNOT */)
      const buffer = m._FPDFBitmap_GetBuffer(bitmap)
      const stride = m._FPDFBitmap_GetStride(bitmap)
      const gray = new Uint8Array(width * height)
      const heap = m.HEAPU8
      for (let y = 0; y < height; y++) {
        let src = buffer + y * stride
        let dst = y * width
        for (let x = 0; x < width; x++, src += 4) {
          // BGRA -> Rec. 601 luma
          gray[dst++] = (heap[src + 2]! * 299 + heap[src + 1]! * 587 + heap[src]! * 114) / 1000
        }
      }
      return { page: index + 1, ...encodeWithinBudget(gray, width, height), source: 'rendered' }
    } finally {
      m._FPDFBitmap_Destroy(bitmap)
    }
  } finally {
    m._FPDF_ClosePage(page)
  }
}

/** JPEG at quality 85; lower quality, then a smaller image, until it fits the byte cap. */
export function encodeWithinBudget(
  gray: Uint8Array,
  width: number,
  height: number,
  maxBytes = OCR_MAX_IMAGE_BYTES,
): { jpeg: Uint8Array; width: number; height: number } {
  let pixels = gray
  let w = width
  let h = height
  for (let shrink = 0; shrink < 4; shrink++) {
    for (const quality of [85, 70, 55, 40]) {
      const jpeg = encodeGrayJpeg(pixels, w, h, quality)
      if (jpeg.byteLength <= maxBytes) return { jpeg, width: w, height: h }
    }
    const nextW = Math.max(1, Math.round(w * 0.75))
    const nextH = Math.max(1, Math.round(h * 0.75))
    pixels = downscaleGray(pixels, w, h, nextW, nextH)
    w = nextW
    h = nextH
  }
  return { jpeg: encodeGrayJpeg(pixels, w, h, 40), width: w, height: h }
}

export interface OcrRenderDeps {
  loadPdfium(): Promise<OcrPdfium>
  readFile(path: string): Promise<Uint8Array>
  stat(path: string): Promise<{ size: number; mtimeMs: number }>
}

const realRenderDeps: OcrRenderDeps = { loadPdfium: loadOcrPdfium, readFile, stat }

/**
 * Open the PDF, learn its page count, and render the next `count` pages that are not done yet
 * (never beyond `maxPages`). Encrypted or damaged files come back as a failure code, not a throw,
 * so the caller can mark them non-retryable.
 */
export async function renderPdfPagesForOcr(
  path: string,
  request: OcrRenderRequest,
  deps: OcrRenderDeps = realRenderDeps,
): Promise<OcrRenderResult> {
  let before: { size: number; mtimeMs: number }
  try {
    before = await deps.stat(path)
  } catch (error) {
    return { ok: false, code: 'missing', message: errorText(error) }
  }
  if (before.size > OCR_MAX_PDF_BYTES)
    return { ok: false, code: 'too-large', message: 'The PDF is too large to read with OCR' }
  let bytes: Uint8Array
  try {
    bytes = await deps.readFile(path)
  } catch (error) {
    return { ok: false, code: 'missing', message: errorText(error) }
  }
  const hash = createHash('sha256').update(bytes).digest('hex')
  let m: OcrPdfium
  try {
    m = await deps.loadPdfium()
  } catch (error) {
    return { ok: false, code: 'render', message: errorText(error) }
  }
  let currentStat: { size: number; mtimeMs: number }
  try {
    currentStat = await deps.stat(path)
  } catch (error) {
    return { ok: false, code: 'missing', message: errorText(error) }
  }
  if (currentStat.size !== before.size || currentStat.mtimeMs !== before.mtimeMs) {
    return { ok: false, code: 'corrupt', message: 'PDF file changed during render preparation' }
  }
  const ptr = m._malloc(bytes.length)
  if (!ptr) return { ok: false, code: 'render', message: 'Not enough memory to open the PDF' }
  try {
    m.HEAPU8.set(bytes, ptr)
    const doc = m._FPDF_LoadMemDocument(ptr, bytes.length, 0)
    if (!doc) {
      const code = classifyPdfiumError(m._FPDF_GetLastError())
      return {
        ok: false,
        code,
        message:
          code === 'password'
            ? 'The PDF is password-protected'
            : code === 'corrupt'
              ? 'The PDF is damaged'
              : 'The PDF cannot be opened',
      }
    }
    try {
      const totalPages = m._FPDF_GetPageCount(doc)
      if (!(totalPages > 0)) return { ok: false, code: 'corrupt', message: 'The PDF has no pages' }
      const safeCount =
        typeof request.count === 'number' && Number.isSafeInteger(request.count) && request.count > 0
          ? Math.min(request.count, 50)
          : 1
      const safeMaxPages =
        typeof request.maxPages === 'number' && Number.isSafeInteger(request.maxPages) && request.maxPages > 0
          ? request.maxPages
          : 1000
      const wanted = planOcrBatch({
        totalPages,
        done: new Set(Array.isArray(request.done) ? request.done : []),
        maxPagesPerFile: safeMaxPages,
        pagesPerCall: safeCount,
        budget: safeCount,
      })
      const pages: OcrRenderedPage[] = []
      let totalBatchBytes = 0
      const maxBatchBytes = OCR_MAX_IMAGE_BYTES * safeCount
      for (const page of wanted) {
        if (pages.length >= safeCount || totalBatchBytes >= maxBatchBytes) break
        const rendered = renderPage(m, doc, page - 1)
        if (rendered) {
          totalBatchBytes += rendered.jpeg.byteLength
          pages.push(rendered)
        }
      }
      if (wanted.length > 0 && pages.length === 0)
        return { ok: false, code: 'render', message: 'No page of the PDF could be rendered' }
      return { ok: true, hash, mtimeMs: currentStat.mtimeMs, sizeBytes: currentStat.size, totalPages, pages }
    } finally {
      m._FPDF_CloseDocument(doc)
    }
  } finally {
    m._free(ptr)
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
