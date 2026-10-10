import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OCR_IMAGE_LONG_EDGE_PX, OCR_MAX_IMAGE_BYTES } from '@genoffice/ai-provider/agy-ocr'
import {
  classifyPdfiumError,
  encodeWithinBudget,
  jpegInfo,
  ocrPdfiumWasmPath,
  ocrRenderScale,
  renderPdfPagesForOcr,
  type OcrRenderDeps,
  type OcrWasmPathDeps,
} from '../src/main/document-memory/agy-ocr-render'
import { downscaleGray, encodeGrayJpeg } from '../src/main/document-memory/jpeg-gray'
import { buildScannedPdf, testPattern } from './helpers/scanned-pdf'

describe('grayscale JPEG encoder', () => {
  it('writes a well-formed baseline JPEG that reports its own size', () => {
    const jpeg = encodeGrayJpeg(testPattern(203, 117), 203, 117, 85)
    expect(jpeg[0]).toBe(0xff)
    expect(jpeg[1]).toBe(0xd8)
    expect(jpeg.at(-2)).toBe(0xff)
    expect(jpeg.at(-1)).toBe(0xd9)
    expect(jpegInfo(jpeg)).toEqual({ width: 203, height: 117, components: 1 })
  })

  it('lower quality gives a smaller file, and invalid sizes are refused', () => {
    const px = testPattern(300, 300)
    expect(encodeGrayJpeg(px, 300, 300, 30).length).toBeLessThan(
      encodeGrayJpeg(px, 300, 300, 90).length,
    )
    expect(() => encodeGrayJpeg(px, 0, 10)).toThrow()
    expect(() => encodeGrayJpeg(new Uint8Array(4), 10, 10)).toThrow()
  })

  it('decodes back to (nearly) the same pixels when a system decoder is available', async () => {
    let canvas: typeof import('@napi-rs/canvas') | undefined
    try {
      canvas = await import('@napi-rs/canvas')
    } catch {
      return // no native decoder on this machine: the structure checks above still apply
    }
    const w = 96
    const h = 64
    const px = testPattern(w, h, 3)
    const image = await canvas.loadImage(Buffer.from(encodeGrayJpeg(px, w, h, 92)))
    const c = canvas.createCanvas(w, h)
    const g = c.getContext('2d')
    g.drawImage(image, 0, 0)
    const data = g.getImageData(0, 0, w, h).data
    let err = 0
    for (let i = 0; i < w * h; i++) err += Math.abs(data[i * 4]! - px[i]!)
    expect(err / (w * h)).toBeLessThan(6)
  })

  it('box-downscales and keeps a JPEG under the byte cap', () => {
    const small = downscaleGray(new Uint8Array(100 * 100).fill(200), 100, 100, 50, 50)
    expect(small.length).toBe(2500)
    expect(small.every((v) => v === 200)).toBe(true)
    const noise = new Uint8Array(900 * 900).map((_, i) => (i * 2654435761) % 251)
    const fitted = encodeWithinBudget(noise, 900, 900, 60_000)
    expect(fitted.jpeg.byteLength).toBeLessThanOrEqual(60_000)
    expect(fitted.width).toBeLessThanOrEqual(900)
  })
})

describe('jpegInfo', () => {
  it('rejects non-JPEG, truncated and CMYK-less data', () => {
    expect(jpegInfo(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull()
    expect(jpegInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull()
    expect(jpegInfo(new Uint8Array(0))).toBeNull()
  })
})

describe('render scale', () => {
  it('fits the long edge to the target and never goes above 200 dpi', () => {
    expect(OCR_IMAGE_LONG_EDGE_PX).toBe(1600)
    expect(ocrRenderScale(595, 842) * 842).toBeCloseTo(1600, 3) // A4: long edge 1600 px
    expect(ocrRenderScale(216, 288)).toBeCloseTo(200 / 72, 6) // a small card page: capped at 200 dpi
    expect(ocrRenderScale(0, 0)).toBeGreaterThan(0)
  })

  it('maps PDFium load errors to the reasons the job understands', () => {
    expect(classifyPdfiumError(4)).toBe('password')
    expect(classifyPdfiumError(5)).toBe('password')
    expect(classifyPdfiumError(3)).toBe('corrupt')
    expect(classifyPdfiumError(2)).toBe('missing')
    expect(classifyPdfiumError(1)).toBe('unsupported')
  })
})

describe('pdfium.wasm lookup on every platform (injected fakes)', () => {
  const base = (over: Partial<OcrWasmPathDeps>): OcrWasmPathDeps => ({
    platform: 'linux',
    resolve: () => undefined,
    env: {},
    exists: () => true,
    ...over,
  })

  it('prefers the development checkout', () => {
    expect(
      ocrPdfiumWasmPath(
        base({ resolve: () => '/repo/node_modules/@embedpdf/pdfium/dist/pdfium.wasm' }),
      ),
    ).toBe('/repo/node_modules/@embedpdf/pdfium/dist/pdfium.wasm')
  })

  it('finds the packaged wasm under Resources/wasm on Windows, macOS and Linux', () => {
    const seen: string[] = []
    const exists = (p: string) => {
      seen.push(p)
      return true
    }
    expect(
      ocrPdfiumWasmPath(
        base({
          platform: 'win32',
          resourcesPath: 'C:\\Program Files\\GenOffice\\resources',
          exists,
        }),
      ),
    ).toBe('C:\\Program Files\\GenOffice\\resources\\wasm\\pdfium.wasm')
    expect(
      ocrPdfiumWasmPath(
        base({
          platform: 'darwin',
          resourcesPath: '/Applications/GenOffice.app/Contents/Resources',
          exists,
        }),
      ),
    ).toBe('/Applications/GenOffice.app/Contents/Resources/wasm/pdfium.wasm')
    expect(
      ocrPdfiumWasmPath(
        base({ platform: 'linux', resourcesPath: '/opt/GenOffice/resources', exists }),
      ),
    ).toBe('/opt/GenOffice/resources/wasm/pdfium.wasm')
  })

  it('uses the resources path handed to the index process through the environment', () => {
    expect(
      ocrPdfiumWasmPath(
        base({ platform: 'win32', env: { GENOFFICE_RESOURCES_PATH: 'D:\\GenOffice\\resources' } }),
      ),
    ).toBe('D:\\GenOffice\\resources\\wasm\\pdfium.wasm')
  })

  it('fails with a clear message when the wasm is nowhere', () => {
    expect(() => ocrPdfiumWasmPath(base({ exists: () => false, resourcesPath: '/x' }))).toThrow(
      /pdfium\.wasm/,
    )
  })
})

// ---- real PDFium -----------------------------------------------------------------------------------

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-ocr-render-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function pdfOf(
  count: number,
  extra: (i: number) => Partial<Parameters<typeof buildScannedPdf>[0][number]> = () => ({}),
): { path: string; jpegs: Uint8Array[] } {
  const w = 800
  const h = 1100
  const jpegs = Array.from({ length: count }, (_, i) =>
    encodeGrayJpeg(testPattern(w, h, i), w, h, 80),
  )
  const bytes = buildScannedPdf(
    jpegs.map((jpeg, i) => ({ jpeg, width: w, height: h, ...extra(i) })),
  )
  const path = join(dir, `scan-${Math.random().toString(36).slice(2)}.pdf`)
  writeFileSync(path, bytes)
  return { path, jpegs }
}

describe('renderPdfPagesForOcr (real PDFium)', () => {
  it("hands over the scan's own JPEG stream untouched when a page is one upright full-page image", async () => {
    const { path, jpegs } = pdfOf(3)
    const result = await renderPdfPagesForOcr(path, { done: [], maxPages: 10, count: 5 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.totalPages).toBe(3)
    expect(result.pages.map((p) => [p.page, p.source])).toEqual([
      [1, 'embedded'],
      [2, 'embedded'],
      [3, 'embedded'],
    ])
    expect(Buffer.from(result.pages[1]!.jpeg).equals(Buffer.from(jpegs[1]!))).toBe(true)
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('renders only the pages that are needed: not done yet, within the per-file limit and the call size', async () => {
    const { path } = pdfOf(9)
    const result = await renderPdfPagesForOcr(path, { done: [1, 2], maxPages: 6, count: 5 })
    expect(result.ok && result.pages.map((p) => p.page)).toEqual([3, 4, 5, 6])
    expect(result.ok && result.totalPages).toBe(9)
    const none = await renderPdfPagesForOcr(path, {
      done: [1, 2, 3, 4, 5, 6],
      maxPages: 6,
      count: 5,
    })
    expect(none.ok && none.pages).toEqual([])
  })

  it('renders (JPEG, long edge <= 1600 px, under the byte cap) when the page has anything besides the image', async () => {
    const { path } = pdfOf(2, (i) => (i === 0 ? { stamp: 'PAID' } : {}))
    const result = await renderPdfPagesForOcr(path, { done: [], maxPages: 10, count: 5 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const stamped = result.pages[0]!
    expect(stamped.source).toBe('rendered')
    expect(result.pages[1]!.source).toBe('embedded')
    const info = jpegInfo(stamped.jpeg)!
    expect(info.components).toBe(1)
    expect(Math.max(info.width, info.height)).toBeLessThanOrEqual(1600)
    expect(Math.max(info.width, info.height)).toBeGreaterThan(1000)
    expect(stamped.jpeg.byteLength).toBeLessThanOrEqual(OCR_MAX_IMAGE_BYTES)
  })

  it('renders pages that are rotated, or whose image is rotated by the page matrix', async () => {
    const rotated = pdfOf(1, () => ({ rotate: 90 }))
    const placed = pdfOf(1, () => ({ rotatedPlacement: true }))
    for (const { path } of [rotated, placed]) {
      const result = await renderPdfPagesForOcr(path, { done: [], maxPages: 5, count: 5 })
      expect(result.ok && result.pages[0]!.source).toBe('rendered')
    }
  })

  it('reports a damaged file as corrupt, a missing one as missing, and an oversized one as too large', async () => {
    const bad = join(dir, 'garbage.pdf')
    writeFileSync(bad, 'this is not a pdf at all')
    expect(await renderPdfPagesForOcr(bad, { done: [], maxPages: 5, count: 5 })).toMatchObject({
      ok: false,
      code: 'corrupt',
    })
    expect(
      await renderPdfPagesForOcr(join(dir, 'nope.pdf'), { done: [], maxPages: 5, count: 5 }),
    ).toMatchObject({
      ok: false,
      code: 'missing',
    })
    const deps: OcrRenderDeps = {
      loadPdfium: () => Promise.reject(new Error('should not load')),
      readFile: () => Promise.reject(new Error('should not read')),
      stat: async () => ({ size: 500 * 1024 * 1024, mtimeMs: 1 }),
    }
    expect(
      await renderPdfPagesForOcr('/x.pdf', { done: [], maxPages: 5, count: 5 }, deps),
    ).toMatchObject({
      ok: false,
      code: 'too-large',
    })
  })

  it('does not block on an engine that cannot start: a render failure, not a throw', async () => {
    const deps: OcrRenderDeps = {
      loadPdfium: () => Promise.reject(new Error('wasm missing')),
      readFile: async () => new Uint8Array([1]),
      stat: async () => ({ size: 1, mtimeMs: 1 }),
    }
    expect(await renderPdfPagesForOcr('/x.pdf', { done: [], maxPages: 5, count: 5 }, deps)).toEqual(
      {
        ok: false,
        code: 'render',
        message: 'wasm missing',
      },
    )
  })

  it('OCR2-PDF-01: Valid embedded JPEG still uses fast path', async () => {
    const { path, jpegs } = pdfOf(1)
    const result = await renderPdfPagesForOcr(path, { done: [], maxPages: 5, count: 5 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.pages).toHaveLength(1)
    expect(result.pages[0]!.source).toBe('embedded')
    expect(Buffer.from(result.pages[0]!.jpeg).equals(Buffer.from(jpegs[0]!))).toBe(true)
  })

  it('OCR2-PDF-02: Damaged embedded JPEG triggers PDFium rasterization fallback', async () => {
    const w = 800
    const h = 1100
    const validJpeg = encodeGrayJpeg(testPattern(w, h, 0), w, h, 80)
    const damagedJpeg = validJpeg.subarray(0, validJpeg.length >> 1)
    const pdfBytes = buildScannedPdf([{ jpeg: damagedJpeg, width: w, height: h }])
    const badPdfPath = join(dir, `damaged-embedded-${Date.now()}.pdf`)
    writeFileSync(badPdfPath, pdfBytes)

    const result = await renderPdfPagesForOcr(badPdfPath, { done: [], maxPages: 5, count: 5 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.pages).toHaveLength(1)
    expect(result.pages[0]!.source).toBe('rendered')
  })

  it('OCR2-PDF-07: retryRenderedPage cannot exceed page/size limits and bypasses embedded fast path', async () => {
    const { path } = pdfOf(3)

    // Valid retry page returns exactly 1 page with source: 'rendered'
    const retryValid = await renderPdfPagesForOcr(path, {
      done: [],
      maxPages: 10,
      count: 1,
      retryRenderedPage: 2,
    })
    expect(retryValid.ok).toBe(true)
    if (!retryValid.ok) return
    expect(retryValid.pages).toHaveLength(1)
    expect(retryValid.pages[0]!.page).toBe(2)
    expect(retryValid.pages[0]!.source).toBe('rendered')

    // Out-of-bounds retry page (0, negative, > totalPages, or > maxPages) returns render failure
    expect(
      await renderPdfPagesForOcr(path, { done: [], maxPages: 10, count: 1, retryRenderedPage: 0 }),
    ).toMatchObject({ ok: false, code: 'render' })
    expect(
      await renderPdfPagesForOcr(path, { done: [], maxPages: 10, count: 1, retryRenderedPage: -1 }),
    ).toMatchObject({ ok: false, code: 'render' })
    expect(
      await renderPdfPagesForOcr(path, { done: [], maxPages: 10, count: 1, retryRenderedPage: 99 }),
    ).toMatchObject({ ok: false, code: 'render' })
    expect(
      await renderPdfPagesForOcr(path, { done: [], maxPages: 2, count: 1, retryRenderedPage: 3 }),
    ).toMatchObject({ ok: false, code: 'render' })
  })
})
