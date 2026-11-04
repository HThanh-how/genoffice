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
import { issueReason } from '../src/main/document-memory/issues'
import { extractDocument } from '../src/main/document-memory/worker'
import { testPattern } from './helpers/scanned-pdf'

const PNG = readFileSync(join(__dirname, 'fixtures', 'ocr', 'invoice-synth.png'))
const gray = decodePngGray(PNG)!
// (a different size from the PNG, so that the two can be told apart after they have been prepared)
const JPEG = Buffer.from(encodeGrayJpeg(testPattern(640, 480, 3), 640, 480, 70))
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
    expect(all.pages[0]).toMatchObject({ width: gray.width, height: gray.height })
    expect(all.pages[1]).toMatchObject({ width: 640, height: 480 })
    // what is handed over is what the engine is given: a decoded, shrunk, flattened picture
    for (const page of all.pages) expect(page.jpeg.byteLength).toBeGreaterThan(0)

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

/** a PNG that is complete but that this code cannot decode (interlaced), of the size the header says */
function interlacedPng(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_x, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (bytes: Buffer): number => {
    let c = 0xffffffff
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'latin1')
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, tail])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  ihdr[12] = 1 // interlaced
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', Buffer.alloc(20_000, 9)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

describe('a picture that this code cannot decode', () => {
  it('goes to the engine as it is when it is of a size that is safe, and is not handed over above 16 million pixels', async () => {
    const path = await docx('interlaced.docx', [
      { file: 'small.png', bytes: interlacedPng(2000, 1500) }, // 3 MP
      { file: 'large.png', bytes: interlacedPng(5000, 4000) }, // 20 MP
    ])
    const result = await renderOfficePicturesForOcr(path, request())
    if (!result.ok) throw new Error(result.message)
    expect(result.pages.map((p) => [p.page, p.jpeg.byteLength > 0])).toEqual([
      [1, true],
      [2, false],
    ])
  })
})

describe('Word files with text and pictures', () => {
  it('a title and a few scanned pages is a scan; the same words with a few figures is a document', async () => {
    const title = 'BIÊN BẢN BÀN GIAO TÀI SẢN CỦA CÔNG TY. '.repeat(8) // about 300 characters
    const big = Buffer.concat([PNG, Buffer.alloc(120 * 1024, 1)]) // a picture of 100 KB or more, as a page is
    const pages = await docx(
      'pages.docx',
      [
        { file: 'p1.png', bytes: big },
        { file: 'p2.png', bytes: big },
        { file: 'p3.png', bytes: big },
      ],
      title,
    )
    const scan = await extractDocument(pages)
    expect(scan.scan).toEqual({ totalPages: 3, scannedPages: [1, 2, 3] }) // 300 characters for 3 large pictures
    const figures = await docx(
      'figures.docx',
      [
        { file: 'f1.png', bytes: PNG },
        { file: 'f2.png', bytes: PNG },
      ],
      title,
    )
    expect('scan' in (await extractDocument(figures))).toBe(false)
  })
})

describe('a file with more pictures than are read', () => {
  it('reads the first 50 and says that the rest of the file is not in the index', async () => {
    const pictures = Array.from({ length: 60 }, (_x, i) => ({
      file: `p${i + 1}.png`,
      bytes: Buffer.alloc(20_000, i),
    }))
    const result = await extractDocument(await docx('album.docx', pictures))
    expect(result.scan?.totalPages).toBe(50)
    expect(result).toMatchObject({ truncated: true, truncatedReason: 'content-limit' })
    // and it does not say that it is all the file has
    expect(result.error).toBe(
      'No readable text; the first 50 pictures in this file have not been read',
    )
  })
})

describe('what a file shows and nobody reads', () => {
  it('says so, instead of calling the file blank, when its only pictures are of a kind that cannot be read', async () => {
    const zip = new JSZip()
    zip.file(
      '_rels/.rels',
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/word/document.xml"/></Relationships>',
    )
    zip.file(
      'word/document.xml',
      `<w:document ${W}><w:body><w:p><a:blip r:embed="rId1"/></w:p></w:body></w:document>`,
    )
    zip.file(
      'word/_rels/document.xml.rels',
      '<Relationships><Relationship Id="rId1" Target="media/scan.emf"/></Relationships>',
    )
    zip.file('word/media/scan.emf', Buffer.alloc(40_000, 4))
    const path = join(tmp(), 'vector.docx')
    writeFileSync(path, await zip.generateAsync({ type: 'uint8array' }))
    const result = await extractDocument(path)
    expect(result.error).toBe(
      'No readable text; the 1 picture in this file cannot be read (a vector drawing, or bigger than 30 MB)',
    )
    expect('scan' in result).toBe(false)
    // and the list of problems puts it with the files that wait for OCR, not with the files that are too big
    expect(issueReason(result.error ?? null, result.status)).toBe('no-text')
  })
})

describe('what Tesseract is handed', () => {
  it('reads the declared size of a PNG or JPEG from its header', () => {
    expect(declaredPixels(hugePng(9000, 9000))).toBe(81_000_000)
    expect(declaredPixels(PNG)).toBe(gray.width * gray.height)
    expect(declaredPixels(JPEG)).toBe(640 * 480)
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

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
const NS_P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const NS_R = `xmlns:r="${REL}"`

async function deckOfPictures(slides: Array<{ file: string; bytes: Uint8Array }>): Promise<string> {
  const pptx = new JSZip()
  pptx.file(
    '_rels/.rels',
    `<Relationships><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
  )
  pptx.file(
    'ppt/presentation.xml',
    `<p:presentation ${NS_P} ${NS_R}><p:sldIdLst>${slides
      .map((_s, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`)
      .join('')}</p:sldIdLst></p:presentation>`,
  )
  pptx.file(
    'ppt/_rels/presentation.xml.rels',
    `<Relationships>${slides
      .map(
        (_s, i) =>
          `<Relationship Id="rId${i + 1}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`,
      )
      .join('')}</Relationships>`,
  )
  slides.forEach((slide, i) => {
    pptx.file(
      `ppt/slides/slide${i + 1}.xml`,
      `<p:sld ${NS_P} ${NS_A} ${NS_R}><p:cSld><p:spTree><p:pic><p:blipFill><a:blip r:embed="rId1"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>`,
    )
    pptx.file(
      `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      `<Relationships><Relationship Id="rId1" Type="${REL}/image" Target="../media/${slide.file}"/></Relationships>`,
    )
    pptx.file(`ppt/media/${slide.file}`, slide.bytes)
  })
  const path = join(tmp(), 'deck.pptx')
  writeFileSync(path, await pptx.generateAsync({ type: 'uint8array' }))
  return path
}

async function workbookOfPictures(
  sheets: Array<{ file: string; bytes: Uint8Array }>,
): Promise<string> {
  const xlsx = new JSZip()
  xlsx.file(
    '_rels/.rels',
    `<Relationships><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  )
  xlsx.file(
    'xl/workbook.xml',
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ${NS_R}><sheets>${sheets
      .map((_s, i) => `<sheet name="Sheet${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>`,
  )
  xlsx.file(
    'xl/_rels/workbook.xml.rels',
    `<Relationships>${sheets
      .map(
        (_s, i) =>
          `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join('')}</Relationships>`,
  )
  sheets.forEach((sheet, i) => {
    const n = i + 1
    xlsx.file(
      `xl/worksheets/sheet${n}.xml`,
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ${NS_R}><sheetData/><drawing r:id="rId1"/></worksheet>`,
    )
    xlsx.file(
      `xl/worksheets/_rels/sheet${n}.xml.rels`,
      `<Relationships><Relationship Id="rId1" Type="${REL}/drawing" Target="../drawings/drawing${n}.xml"/></Relationships>`,
    )
    xlsx.file(
      `xl/drawings/drawing${n}.xml`,
      `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ${NS_A} ${NS_R}><xdr:twoCellAnchor><xdr:pic><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill></xdr:pic></xdr:twoCellAnchor></xdr:wsDr>`,
    )
    xlsx.file(
      `xl/drawings/_rels/drawing${n}.xml.rels`,
      `<Relationships><Relationship Id="rId1" Type="${REL}/image" Target="../media/${sheet.file}"/></Relationships>`,
    )
    xlsx.file(`xl/media/${sheet.file}`, sheet.bytes)
  })
  const path = join(tmp(), 'book.xlsx')
  writeFileSync(path, await xlsx.generateAsync({ type: 'uint8array' }))
  return path
}

describe('slides and sheets made of pictures', () => {
  it('a deck of pictures is a scan however many slides it has: the lines the extractor writes for a picture are not its words', async () => {
    for (const slides of [1, 2, 5]) {
      const path = await deckOfPictures(
        Array.from({ length: slides }, (_x, i) => ({
          file: `s${i + 1}.png`,
          bytes: i % 2 ? JPEG : PNG,
        })),
      )
      const result = await extractDocument(path)
      expect(result.status, `${slides} slides`).toBe('empty')
      expect(result.chunks).toEqual([]) // no chunk of "[picture-only slide: …]"
      expect(result.scan).toEqual({
        totalPages: slides,
        scannedPages: Array.from({ length: slides }, (_x, i) => i + 1),
      })
      expect(result.error).toMatch(/not been read$/)
    }
  })

  it("merges the text read from the slides, and not the extractor's own lines", async () => {
    const path = await deckOfPictures([
      { file: 'a.png', bytes: PNG },
      { file: 'b.jpg', bytes: JPEG },
    ])
    const empty = await extractDocument(path)
    const read = await extractDocument(path, (_p, hash) =>
      hash === empty.hash ? { totalPages: 2, pages: [{ page: 2, text: GOOD }] } : null,
    )
    const all = read.chunks.map((c) => c.text).join('\n')
    expect(all).toContain('Viettel')
    expect(all).not.toContain('picture-only slide')
    expect(all).not.toContain('No extractable text')
  })

  it('lists the pictures of a PowerPoint file by slide, in the order of the deck', async () => {
    const path = await deckOfPictures([
      { file: 'one.png', bytes: PNG },
      { file: 'two.jpg', bytes: JPEG },
    ])
    const rendered = await renderOfficePicturesForOcr(path, request())
    if (!rendered.ok) throw new Error(rendered.message)
    expect(rendered.pages.map((p) => [p.page, p.width])).toEqual([
      [1, gray.width],
      [2, 640],
    ])
  })

  it('an Excel file of pictures is a scan too, one page per picture in the order of the sheets', async () => {
    const path = await workbookOfPictures([
      { file: 'a.png', bytes: PNG },
      { file: 'b.jpg', bytes: JPEG },
      { file: 'c.png', bytes: PNG },
    ])
    const result = await extractDocument(path)
    expect(result.status).toBe('empty')
    expect(result.chunks).toEqual([])
    expect(result.scan).toEqual({ totalPages: 3, scannedPages: [1, 2, 3] })
    const rendered = await renderOfficePicturesForOcr(path, request())
    if (!rendered.ok) throw new Error(rendered.message)
    expect(rendered.pages.map((p) => p.width)).toEqual([gray.width, 640, gray.width])
  })

  it('a deck with real text of its own is not a scan', async () => {
    const path = await deckOfPictures([{ file: 'a.png', bytes: PNG }])
    const zip = await JSZip.loadAsync(readFileSync(path))
    const words = 'Quarterly results and the plan for the next year. '.repeat(8)
    zip.file(
      'ppt/slides/slide1.xml',
      `<p:sld ${NS_P} ${NS_A} ${NS_R}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${words}</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:blipFill><a:blip r:embed="rId1"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>`,
    )
    writeFileSync(path, await zip.generateAsync({ type: 'uint8array' }))
    const result = await extractDocument(path)
    expect(result.status).toBe('text-only')
    expect('scan' in result).toBe(false)
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
