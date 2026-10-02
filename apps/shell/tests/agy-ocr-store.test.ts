import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import {
  OCR_LOCATION_PREFIX,
  isOcrLocation,
  ocrChunksFromPages,
  ocrDocumentHash,
} from '../src/main/document-memory/ocr-sidecar'
import { extractDocument } from '../src/main/document-memory/worker'
import { encodeGrayJpeg } from '../src/main/document-memory/jpeg-gray'
import { buildScannedPdf, testPattern } from './helpers/scanned-pdf'

let dir: string
let dbPath: string
let store: DocumentMemoryStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-ocr-store-'))
  dbPath = join(dir, 'memory.sqlite')
  store = new DocumentMemoryStore(dbPath)
})
afterEach(() => {
  try {
    store.close()
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true })
})

const NO_TEXT = 'No readable text; scanned documents need OCR'
const MODEL = 'test-v1'

function scannedPdf(
  name: string,
  pages = 4,
): { path: string; hash: string; mtimeMs: number; sizeBytes: number } {
  const jpegs = Array.from({ length: pages }, (_, i) =>
    encodeGrayJpeg(testPattern(600, 800, i), 600, 800, 70),
  )
  const bytes = buildScannedPdf(jpegs.map((jpeg) => ({ jpeg, width: 600, height: 800 })))
  const path = join(dir, name)
  writeFileSync(path, bytes)
  const st = statSync(path)
  return {
    path,
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
    mtimeMs: st.mtimeMs,
    sizeBytes: st.size,
  }
}

function enrollEmpty(file: ReturnType<typeof scannedPdf>): void {
  store.replaceDocument(file.path, {
    hash: file.hash,
    mtimeMs: file.mtimeMs,
    sizeBytes: file.sizeBytes,
    chunks: [],
    embeddingModel: null,
    status: 'empty',
    error: NO_TEXT,
  })
}

/** counters exactly as a fresh scan of the chunks would give them */
function mismatches(): unknown[] {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return db
      .prepare(
        `SELECT d.id, d.chunk_total, d.chunk_done,
          (SELECT count(*) FROM chunks c WHERE c.document_id = d.id) AS real_total,
          (SELECT count(*) FROM chunks c WHERE c.document_id = d.id AND c.vector IS NOT NULL) AS real_done
        FROM documents d WHERE d.chunk_total <> real_total OR d.chunk_done <> real_done`,
      )
      .all()
  } finally {
    db.close()
  }
}
function scanStats() {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return db
      .prepare(
        `SELECT (SELECT count(*) FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.excluded = 0) AS chunks,
          (SELECT count(*) FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.excluded = 0 AND c.vector IS NOT NULL) AS vectors`,
      )
      .get() as unknown as { chunks: number; vectors: number }
  } finally {
    db.close()
  }
}

describe('OCR sidecar', () => {
  it('lists scanned PDFs that still have pages to read, and nothing else', () => {
    const scanned = scannedPdf('scan.pdf')
    enrollEmpty(scanned)
    const text = scannedPdf('texty.pdf')
    store.replaceDocument(text.path, {
      hash: 'h',
      mtimeMs: text.mtimeMs,
      sizeBytes: text.sizeBytes,
      chunks: [{ text: 'real text', location: 'Chunk 1' }],
      embeddingModel: null,
      status: 'text-only',
    })
    const notPdf = join(dir, 'empty.docx')
    store.replaceDocument(notPdf, {
      hash: 'x',
      mtimeMs: 1,
      sizeBytes: 1,
      chunks: [],
      embeddingModel: null,
      status: 'empty',
      error: NO_TEXT,
    })
    const rows = store.ocr.candidates(10)
    expect(rows.map((r) => r.path)).toEqual([scanned.path])
    expect(rows[0]).toMatchObject({ pagesDone: 0 })
    expect(rows[0]!.totalPages).toBeUndefined()
  })

  it('knows which pages are done, keyed by the file as it is now, and drops rows of an older version', () => {
    const f = scannedPdf('scan.pdf')
    enrollEmpty(f)
    const meta = {
      hash: f.hash,
      mtimeMs: f.mtimeMs,
      sizeBytes: f.sizeBytes,
      totalPages: 4,
      model: MODEL,
    }
    store.ocr.savePages(f.path, meta, [
      { page: 1, text: 'một' },
      { page: 2, text: 'hai' },
    ])
    expect(store.ocr.pagesDone(f.path, f.mtimeMs, f.sizeBytes)).toEqual([1, 2])
    expect(store.ocr.pagesDone(f.path, f.mtimeMs + 1, f.sizeBytes)).toEqual([]) // the file changed
    expect(store.ocr.candidates(10)[0]).toMatchObject({ pagesDone: 2, totalPages: 4 })
    // a file that is complete up to the per-file limit is no longer a candidate
    expect(store.ocr.candidates(2)).toEqual([])
    // saving pages of a newer version removes the older rows
    store.ocr.savePages(f.path, { ...meta, hash: 'newer', mtimeMs: f.mtimeMs + 5 }, [
      { page: 1, text: 'mới' },
    ])
    expect(store.ocr.pages(f.path, f.hash)).toBeNull()
    expect(store.ocr.pages(f.path, 'newer')!.pages).toEqual([{ page: 1, text: 'mới' }])
  })

  it('removes OCR text with the document (excluded, deleted, cleared) and follows a move', () => {
    const f = scannedPdf('scan.pdf')
    enrollEmpty(f)
    const meta = { hash: f.hash, mtimeMs: f.mtimeMs, sizeBytes: f.sizeBytes, totalPages: 1 }
    store.ocr.savePages(f.path, meta, [{ page: 1, text: 'x' }])
    const moved = join(dir, 'moved.pdf')
    store.move(f.path, moved)
    expect(store.ocr.pages(f.path, f.hash)).toBeNull()
    expect(store.ocr.pages(moved, f.hash)!.pages).toHaveLength(1)
    store.exclude(moved)
    expect(store.ocr.pages(moved, f.hash)).toBeNull()

    const g = scannedPdf('g.pdf')
    enrollEmpty(g)
    store.ocr.savePages(g.path, { ...meta, hash: g.hash }, [{ page: 1, text: 'y' }])
    store.tombstone(g.path)
    expect(store.ocr.pages(g.path, g.hash)).toBeNull()

    const h = scannedPdf('h.pdf')
    enrollEmpty(h)
    store.ocr.savePages(h.path, { ...meta, hash: h.hash }, [{ page: 1, text: 'z' }])
    store.clear()
    expect(store.ocr.pages(h.path, h.hash)).toBeNull()
  })
})

describe('OCR text becomes chunks through the normal pipeline', () => {
  it('turns stored pages into `OCR page N` chunks, flags a partial read as truncated and changes the hash', async () => {
    const f = scannedPdf('scan.pdf', 4)
    enrollEmpty(f)
    // before any OCR: unchanged behaviour
    const plain = await extractDocument(f.path, (p, h) => store.ocr.pages(p, h))
    expect(plain.status).toBe('empty')
    expect(plain.error).toBe(NO_TEXT)
    expect(plain.hash).toBe(f.hash)

    store.ocr.savePages(
      f.path,
      { hash: f.hash, mtimeMs: f.mtimeMs, sizeBytes: f.sizeBytes, totalPages: 4, model: MODEL },
      [
        { page: 1, text: 'HÓA ĐƠN GIÁ TRỊ GIA TĂNG\nSố: 0042467' },
        { page: 2, text: '' }, // a blank page is done but adds no chunk
        { page: 3, text: 'Tổng cộng: 4.919.750' },
      ],
    )
    const result = await extractDocument(f.path, (p, h) => store.ocr.pages(p, h))
    expect(result.status).toBe('text-only')
    expect(result.truncated).toBe(true) // 3 of 4 pages read
    expect(result.chunks.map((c) => c.location)).toEqual(['OCR page 1', 'OCR page 3'])
    expect(result.chunks.every((c) => isOcrLocation(c.location))).toBe(true)
    expect(result.hash).not.toBe(f.hash)
    expect(result.hash).toBe(ocrDocumentHash(f.hash, store.ocr.pages(f.path, f.hash)!.pages))
    expect(result.error).toBeUndefined()

    // more pages -> a different hash, so the manager never resumes stale vectors
    store.ocr.savePages(
      f.path,
      { hash: f.hash, mtimeMs: f.mtimeMs, sizeBytes: f.sizeBytes, totalPages: 4 },
      [{ page: 4, text: 'Ký tên' }],
    )
    const complete = await extractDocument(f.path, (p, h) => store.ocr.pages(p, h))
    expect(complete.truncated).toBeUndefined()
    expect(complete.hash).not.toBe(result.hash)
    expect(complete.chunks).toHaveLength(3)
  })

  it('a scanned PDF whose pages were all blank stays empty, with a message that is not a candidate again', async () => {
    const f = scannedPdf('blank.pdf', 2)
    enrollEmpty(f)
    store.ocr.savePages(
      f.path,
      { hash: f.hash, mtimeMs: f.mtimeMs, sizeBytes: f.sizeBytes, totalPages: 2 },
      [
        { page: 1, text: '' },
        { page: 2, text: '' },
      ],
    )
    const result = await extractDocument(f.path, (p, h) => store.ocr.pages(p, h))
    expect(result.status).toBe('empty')
    expect(result.error).toMatch(/^No readable text/)
    expect(store.ocr.candidates(10)).toEqual([]) // pages 1-2 are done: nothing left to read
  })

  it('stores chunks through replaceDocument, keeps the per-document counters exact, and search flags them as OCR', async () => {
    const f = scannedPdf('scan.pdf', 3)
    enrollEmpty(f)
    store.ocr.savePages(
      f.path,
      { hash: f.hash, mtimeMs: f.mtimeMs, sizeBytes: f.sizeBytes, totalPages: 3, model: MODEL },
      [
        { page: 1, text: 'Hóa đơn giá trị gia tăng số 0042467 của Công ty Nguyễn Phúc' },
        { page: 2, text: 'Giấy in A4 Double A, 20 ream' },
      ],
    )
    const extracted = await extractDocument(f.path, (p, h) => store.ocr.pages(p, h))
    store.replaceDocument(f.path, {
      hash: extracted.hash,
      mtimeMs: extracted.mtimeMs,
      sizeBytes: extracted.sizeBytes,
      chunks: extracted.chunks,
      embeddingModel: null,
      status: 'text-only',
      ...(extracted.truncated ? { truncated: true } : {}),
    })
    const document = store.documentByPath(f.path)!
    expect(document.truncated).toBe(true)
    expect(document.status).toBe('text-only')
    expect(mismatches()).toEqual([])
    expect(store.stats().chunks).toBe(scanStats().chunks)
    expect(store.folderChunkProgress(dir)).toMatchObject({
      truncatedFiles: 1,
      pendingFiles: 1,
      totalChunks: 2,
      completedChunks: 0,
    })

    // embeddings continue through the normal batches and finish the document
    store.setChunkVectors(
      f.path,
      extracted.hash,
      0,
      [
        [1, 0],
        [0, 1],
      ],
      MODEL,
      true,
    )
    expect(store.documentByPath(f.path)!.status).toBe('ready')
    expect(mismatches()).toEqual([])
    expect(store.stats().vectors).toBe(scanStats().vectors)
    expect(store.folderChunkProgress(dir)).toMatchObject({
      readyFiles: 1,
      pendingFiles: 0,
      completedChunks: 2,
    })

    const hits = store.search('Nguyễn Phúc 0042467', [1, 0], 5, MODEL)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.ocr).toBe(true)
    expect(hits[0]!.location).toBe('OCR page 1')
    expect(hits[0]!.truncated).toBe(true)
    expect(store.readChunk(hits[0]!.chunkId)!.ocr).toBe(true)
  })

  it('ordinary text hits carry no ocr flag', () => {
    const path = join(dir, 'plain.txt')
    store.replaceDocument(path, {
      hash: 'p',
      mtimeMs: 1,
      sizeBytes: 1,
      chunks: [{ text: 'quarterly budget review notes', location: 'Chunk 1' }],
      embeddingModel: null,
      status: 'text-only',
    })
    const hits = store.search('budget review', null, 5)
    expect(hits[0]!.ocr).toBeUndefined()
  })

  it('re-extraction after the file changed ignores the stale OCR text', async () => {
    const f = scannedPdf('scan.pdf', 2)
    enrollEmpty(f)
    store.ocr.savePages(
      f.path,
      { hash: f.hash, mtimeMs: f.mtimeMs, sizeBytes: f.sizeBytes, totalPages: 2 },
      [{ page: 1, text: 'old text of the old file' }],
    )
    // the file is replaced by a different scan: another hash, so no OCR text applies
    const other = encodeGrayJpeg(testPattern(600, 800, 99), 600, 800, 60)
    writeFileSync(f.path, buildScannedPdf([{ jpeg: other, width: 600, height: 800 }]))
    const result = await extractDocument(f.path, (p, h) => store.ocr.pages(p, h))
    expect(result.status).toBe('empty')
    expect(result.chunks).toEqual([])
  })
})

describe('chunk helpers', () => {
  it('splits a long page into labelled parts and caps the total', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Dòng ${i} ${'chữ '.repeat(30)}`).join('\n\n')
    const { chunks } = ocrChunksFromPages({ totalPages: 1, pages: [{ page: 7, text: long }] })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]!.location).toMatch(
      new RegExp(`^${OCR_LOCATION_PREFIX}7 \\(1/${chunks.length}\\)$`),
    )
    const huge = ocrChunksFromPages({
      totalPages: 50,
      pages: Array.from({ length: 50 }, (_, i) => ({ page: i + 1, text: long })),
    })
    // 50 long pages are no longer cut at the old 400-chunk cap
    expect(huge.chunks.length).toBe(50 * chunks.length)
    expect(huge.truncated).toBe(false)
  })
})
