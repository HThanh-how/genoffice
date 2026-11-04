import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeGrayJpeg } from '../src/main/document-memory/jpeg-gray'
import { decodePngGray } from '../src/main/document-memory/local-ocr/gray-image'
import { LocalOcrJob } from '../src/main/document-memory/local-ocr/local-ocr-job'
import {
  declaredPixels,
  prepareForTesseract,
} from '../src/main/document-memory/local-ocr/tesseract-prepare'
import {
  OFFICE_MAX_BYTES,
  renderOfficePicturesForOcr,
} from '../src/main/document-memory/office-ocr-render'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'
import type {
  LocalOcrEngine,
  LocalOcrRecognition,
} from '../src/main/document-memory/runtime/local-ocr-engine'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { extractDocument } from '../src/main/document-memory/worker'
import { testPattern } from './helpers/scanned-pdf'

const PNG = readFileSync(join(__dirname, 'fixtures', 'ocr', 'invoice-synth.png'))
const gray = decodePngGray(PNG)!
const JPEG = Buffer.from(
  encodeGrayJpeg(testPattern(gray.width, gray.height, 3), gray.width, gray.height, 70),
)
const GOOD =
  'HÓA ĐƠN GIÁ TRỊ GIA TĂNG\nSố: 0433 Ngày 15 tháng 09 năm 2025\nĐơn vị bán hàng: Công ty TNHH Viettel Tiền Giang\nMã số thuế: 0101234567'

/** a PNG that only declares a size: enough for the header checks, never decoded */
function hugePng(width: number, height: number): Buffer {
  const head = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head)
  head.write('IHDR', 12, 'latin1')
  head.writeUInt32BE(width, 16)
  head.writeUInt32BE(height, 20)
  return Buffer.concat([head, Buffer.alloc(20_000, 5)])
}

const dirs: string[] = []
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'office-ocr-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

/** a Word file whose body shows `pictures` in this order, after `text` */
async function docx(
  name: string,
  pictures: Array<{ file: string; bytes: Uint8Array }>,
  text = '',
): Promise<string> {
  const zip = new JSZip()
  zip.file(
    '_rels/.rels',
    '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/word/document.xml"/></Relationships>',
  )
  const body = pictures
    .map((_p, i) => `<w:p><w:r><a:blip r:embed="rIdP${i + 1}"/></w:r></w:p>`)
    .join('')
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document ${W}><w:body>${
      text ? `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>` : ''
    }${body}</w:body></w:document>`,
  )
  zip.file(
    'word/_rels/document.xml.rels',
    `<Relationships>${pictures
      .map((p, i) => `<Relationship Id="rIdP${i + 1}" Target="media/${p.file}"/>`)
      .join('')}</Relationships>`,
  )
  for (const p of pictures) zip.file(`word/media/${p.file}`, p.bytes)
  const path = join(tmp(), name)
  writeFileSync(path, await zip.generateAsync({ type: 'uint8array' }))
  return path
}

const request = (over: Partial<Parameters<typeof renderOfficePicturesForOcr>[1]> = {}) => ({
  done: [] as number[],
  maxPages: 10,
  count: 5,
  ...over,
})

describe('the pictures of a Word file as the pages of a scan', () => {
  it('hands them over in the order of the document, a few at a time, skipping what is done', async () => {
    const path = await docx('order.docx', [
      { file: 'z-last-by-name.png', bytes: PNG },
      { file: 'a-first-by-name.jpg', bytes: JPEG },
      { file: 'm.png', bytes: PNG },
    ])
    const all = await renderOfficePicturesForOcr(path, request())
    if (!all.ok) throw new Error(all.message)
    expect(all.totalPages).toBe(3)
    expect(all.hash).toBe(createHash('sha256').update(readFileSync(path)).digest('hex'))
    expect(all.pages.map((p) => p.page)).toEqual([1, 2, 3])
    // page 1 is the first picture of the body (a PNG), not the first by name (the JPEG)
    expect(Buffer.from(all.pages[0]!.jpeg).equals(PNG)).toBe(true)
    expect(Buffer.from(all.pages[1]!.jpeg).equals(JPEG)).toBe(true)
    expect(all.pages[0]).toMatchObject({ width: gray.width, height: gray.height })

    const later = await renderOfficePicturesForOcr(path, request({ done: [1], count: 1 }))
    if (!later.ok) throw new Error(later.message)
    expect(later.pages.map((p) => p.page)).toEqual([2])
    const limited = await renderOfficePicturesForOcr(path, request({ maxPages: 2 }))
    if (!limited.ok) throw new Error(limited.message)
    expect(limited.pages.map((p) => p.page)).toEqual([1, 2])
  })

  it('gives a picture that must not reach an engine as a page with no bytes, so the file can be finished', async () => {
    const path = await docx('mixed.docx', [
      { file: 'huge.png', bytes: hugePng(9000, 9000) }, // 81 MP
      { file: 'icon.png', bytes: hugePng(64, 64) }, // a thumbnail
      { file: 'scan.png', bytes: PNG },
    ])
    const result = await renderOfficePicturesForOcr(path, request())
    if (!result.ok) throw new Error(result.message)
    expect(result.pages.map((p) => [p.page, p.jpeg.byteLength > 0])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ])
  })

  it('fails in the words of the PDF renderer: no pictures, a file that is not a package, a changed file, too large', async () => {
    const none = await renderOfficePicturesForOcr(await docx('none.docx', []), request())
    expect(none).toMatchObject({ ok: false, code: 'unsupported' })
    const dir = tmp()
    const junk = join(dir, 'junk.docx')
    writeFileSync(junk, 'not a zip at all')
    expect(await renderOfficePicturesForOcr(junk, request())).toMatchObject({
      ok: false,
      code: 'corrupt',
    })
    const path = await docx('one.docx', [{ file: 'a.png', bytes: PNG }])
    let calls = 0
    expect(
      await renderOfficePicturesForOcr(path, request(), {
        readFile: async (p) => readFileSync(p),
        stat: async () => ({ size: 100, mtimeMs: ++calls }),
      }),
    ).toMatchObject({ ok: false, code: 'corrupt' })
    expect(
      await renderOfficePicturesForOcr(path, request(), {
        readFile: async (p) => readFileSync(p),
        stat: async () => ({ size: OFFICE_MAX_BYTES + 1, mtimeMs: 1 }),
      }),
    ).toMatchObject({ ok: false, code: 'too-large' })
    expect(await renderOfficePicturesForOcr(path, request({ retryRenderedPage: 1 }))).toMatchObject(
      { ok: false, code: 'render' },
    )
    expect(await renderOfficePicturesForOcr(join(dir, 'gone.docx'), request())).toMatchObject({
      ok: false,
    })
  })
})

describe('what Tesseract is handed', () => {
  it('reads the declared size of a PNG or JPEG from its header', () => {
    expect(declaredPixels(hugePng(9000, 9000))).toBe(81_000_000)
    expect(declaredPixels(PNG)).toBe(gray.width * gray.height)
    expect(declaredPixels(JPEG)).toBe(gray.width * gray.height)
    expect(declaredPixels(new Uint8Array([1, 2, 3]))).toBeNull()
  })

  it('does not hand over a picture of more than 40 million pixels as it is, but still prepares a normal one', () => {
    expect(prepareForTesseract(hugePng(9000, 9000), 150)).toBeNull()
    expect(prepareForTesseract(PNG, 150)).not.toBeNull()
    expect(prepareForTesseract(JPEG, 150)).not.toBeNull()
  })
})

describe('a Word file made of pictures, from the index to the text', () => {
  it('lists its pictures as pages to read, and merges the text read from them', async () => {
    const path = await docx('scan.docx', [
      { file: 'p1.png', bytes: PNG },
      { file: 'p2.jpg', bytes: JPEG },
    ])
    const empty = await extractDocument(path)
    expect(empty).toMatchObject({
      status: 'empty',
      error: 'No readable text; the 2 pictures in this file have not been read',
      scan: { totalPages: 2, scannedPages: [1, 2] },
    })

    const withOcr = await extractDocument(path, (_p, hash) =>
      hash === empty.hash
        ? {
            totalPages: 2,
            pages: [
              { page: 1, text: GOOD },
              { page: 2, text: 'Trang hai: biên bản bàn giao' },
            ],
          }
        : null,
    )
    expect(withOcr.status).toBe('text-only')
    expect(withOcr.chunks.map((c) => c.text).join('\n')).toContain('Viettel')
    expect(withOcr.hash).not.toBe(empty.hash) // the text read from the pictures is part of the version
    // when everything is read and holds nothing, the file says so
    const blank = await extractDocument(path, () => ({
      totalPages: 2,
      pages: [
        { page: 1, text: '' },
        { page: 2, text: '' },
      ],
    }))
    expect(blank.error).toBe(
      'No readable text; the pictures in this file were read but contained no text',
    )
  })

  it('is not OCR work when the file has enough text of its own', async () => {
    const text = 'A report with real paragraphs of words. '.repeat(10)
    const result = await extractDocument(
      await docx('report.docx', [{ file: 'p.png', bytes: PNG }], text),
    )
    expect(result.status).toBe('text-only')
    expect('scan' in result).toBe(false)
  })
})

// ---- the local pass over such files, with the real database ---------------------------------

class Engine implements LocalOcrEngine {
  readonly id = 'apple-vision'
  readonly descriptor = {
    id: 'apple-vision',
    name: 'double',
    platforms: 'all' as const,
    minFreeRamMB: 1,
    dpi: 100,
    escalationThreshold: 0.73,
    license: 'test',
    available: true,
    notes: '',
  }
  calls = 0
  isAvailable(): boolean {
    return true
  }
  async recognizePage(): Promise<LocalOcrRecognition> {
    this.calls++
    const tokens = GOOD.split(/\s+/).map((text) => ({ text, confidence: 0.95 }))
    return { text: GOOD, meanConfidence: 0.95, tokens, ms: 5 }
  }
  async dispose(): Promise<void> {}
}

describe('slides and sheets made of pictures', () => {
  it('lists the pictures of a PowerPoint file by slide, and of an Excel file by sheet', async () => {
    const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
    const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
    const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    const pptx = new JSZip()
    pptx.file(
      '_rels/.rels',
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    )
    pptx.file(
      'ppt/presentation.xml',
      `<p:presentation ${P} ${R}><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
    )
    pptx.file(
      'ppt/_rels/presentation.xml.rels',
      '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>',
    )
    for (const [n, file] of [
      [1, 'one.png'],
      [2, 'two.jpg'],
    ] as const) {
      pptx.file(
        `ppt/slides/slide${n}.xml`,
        `<p:sld ${P} ${A} ${R}><p:cSld><p:spTree><p:pic><p:blipFill><a:blip r:embed="rId1"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>`,
      )
      pptx.file(
        `ppt/slides/_rels/slide${n}.xml.rels`,
        `<Relationships><Relationship Id="rId1" Target="../media/${file}"/></Relationships>`,
      )
    }
    pptx.file('ppt/media/one.png', PNG)
    pptx.file('ppt/media/two.jpg', JPEG)
    const dir = tmp()
    const path = join(dir, 'deck.pptx')
    writeFileSync(path, await pptx.generateAsync({ type: 'uint8array' }))
    const result = await extractDocument(path)
    expect(result.status).toBe('empty')
    expect(result.scan).toEqual({ totalPages: 2, scannedPages: [1, 2] })
    const rendered = await renderOfficePicturesForOcr(path, request())
    if (!rendered.ok) throw new Error(rendered.message)
    expect(Buffer.from(rendered.pages[1]!.jpeg).equals(JPEG)).toBe(true)
  })
})

describe('the local pass over Word files made of pictures', () => {
  let dir: string
  let store: DocumentMemoryStore
  beforeEach(() => {
    dir = tmp()
    store = new DocumentMemoryStore(join(dir, 'memory.sqlite'))
    store.ensureEmbeddingSpace(EMBEDDING_PROFILES.standard)
  })
  afterEach(() => store.close())

  const stat = (path: string) => ({
    mtimeMs: statSync(path).mtimeMs,
    sizeBytes: statSync(path).size,
  })

  /** what the index does with a file: extract it and keep the scan info, the way the app does */
  async function index(path: string): Promise<void> {
    const extracted = await extractDocument(path, (p, h) => store.ocr.pages(p, h))
    store.replaceDocument(path, {
      hash: extracted.hash,
      mtimeMs: extracted.mtimeMs,
      sizeBytes: extracted.sizeBytes,
      chunks: extracted.chunks,
      embeddingModel: null,
      status: extracted.status as 'text-only' | 'empty',
      ...(extracted.error ? { error: extracted.error } : {}),
      ...(extracted.truncated ? { truncated: true } : {}),
    })
    if (extracted.scan)
      store.ocr.saveScanInfo(
        path,
        { mtimeMs: extracted.mtimeMs, sizeBytes: extracted.sizeBytes },
        extracted.scan,
      )
  }

  function job(engine: Engine, over: { light?: number; maxPages?: number } = {}) {
    const reindexed: string[] = []
    const { light = 2, maxPages = 6 } = over
    return {
      reindexed,
      job: new LocalOcrJob({
        db: store.rawDb,
        settings: () => ({ enabled: true, lightPages: light, maxPages, engine: 'auto' }),
        registry: { select: () => ({ engine, skipped: [] }) },
        // what the index process does with a request to render pages
        render: (path, req) => renderOfficePicturesForOcr(path, req),
        savePages: (path, meta, pages) => {
          store.ocr.savePages(path, meta, pages)
        },
        reindex: (path) => void reindexed.push(path),
        gate: () => ({ ok: true }),
        coolDown: async () => undefined,
        totalRamMB: () => 16_000,
      }),
    }
  }

  it('reads the first pictures, then the rest in the slow pass, and the text becomes searchable', async () => {
    const path = await docx('hoa don.docx', [
      { file: 'a.png', bytes: PNG },
      { file: 'b.jpg', bytes: JPEG },
      { file: 'c.png', bytes: PNG },
      { file: 'd.png', bytes: PNG },
    ])
    await index(path)
    expect(store.documentByPath(path)!.status).toBe('empty')
    const engine = new Engine()
    const { job: pass, reindexed } = job(engine)

    expect(await pass.runOnce()).toMatchObject({ files: 1, pages: 2, failed: 0 })
    expect(store.ocr.pagesPresent(path, stat(path).mtimeMs, stat(path).sizeBytes)).toEqual([1, 2])
    expect(reindexed).toEqual([path])
    await index(path)
    expect(store.searchLexical('0433 Viettel').length).toBeGreaterThan(0)

    // the slow pass takes the other two
    expect(await pass.runOnce()).toMatchObject({ files: 1, pages: 2, failed: 0 })
    expect(store.ocr.pagesPresent(path, stat(path).mtimeMs, stat(path).sizeBytes)).toEqual([
      1, 2, 3, 4,
    ])
    await index(path)
    expect(await pass.runOnce()).toMatchObject({ files: 0, pages: 0 })
    expect(engine.calls).toBe(4)
  })

  it('stores a picture that must not reach the engine as a page without text, and finishes the file', async () => {
    const path = await docx('mixed.docx', [
      { file: 'huge.png', bytes: hugePng(9000, 9000) },
      { file: 'scan.png', bytes: PNG },
    ])
    await index(path)
    const engine = new Engine()
    const { job: pass } = job(engine)
    expect(await pass.runOnce()).toMatchObject({ pages: 2, failed: 0 })
    expect(engine.calls).toBe(1) // the huge one never reached it
    expect(store.ocr.pagesPresent(path, stat(path).mtimeMs, stat(path).sizeBytes)).toEqual([1, 2])
    await index(path)
    expect(await pass.runOnce()).toMatchObject({ files: 0, pages: 0 })
  })

  it('gives up for good on an old "empty" file that has no picture, and does not come back to it', async () => {
    const path = await docx('really empty.docx', [])
    store.replaceDocument(path, {
      hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
      ...stat(path),
      chunks: [],
      embeddingModel: null,
      status: 'empty',
      error: 'No readable text in this file; there is nothing to search',
    })
    const { job: pass } = job(new Engine())
    expect(await pass.runOnce()).toMatchObject({ files: 1, pages: 0, failed: 1 })
    expect(await pass.runOnce()).toMatchObject({ files: 0, failed: 0 })
    expect(store.ocr.localFailure(path)).toMatchObject({ code: 'unsupported' })
  })

  it('is local work only: the cloud lists never offer a Word file, whatever its state', async () => {
    const path = await docx('cloud.docx', [{ file: 'a.png', bytes: PNG }])
    await index(path)
    expect(store.ocr.candidates(40)).toEqual([])
    expect(store.ocr.candidates(40, { mode: 'cloud-all', includeSensitive: true })).toEqual([])
    expect(store.ocr.candidates(40, { mode: 'local', includeSensitive: true })).toHaveLength(1)
    const { job: pass } = job(new Engine())
    await pass.runOnce()
    await index(path)
    expect(store.ocr.candidates(40)).toEqual([])
  })
})
