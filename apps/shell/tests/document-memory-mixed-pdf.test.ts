import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { extractDocument } from '../src/main/document-memory/worker'
import { OcrSidecar } from '../src/main/document-memory/ocr-sidecar'

const FIXTURE = join(__dirname, 'fixtures', 'mixed-scan.pdf')
describe('PDFs with some scanned pages', () => {
  it('indexes the text pages locally and reports only the pages without text', async () => {
    const result = await extractDocument(FIXTURE)
    expect(result.status).toBe('text-only')
    expect(result.chunks.map((c) => c.text).join(' ')).toContain('real text layer')
    expect(result.scan).toEqual({ totalPages: 3, scannedPages: [2] })
  })

  it('adds the OCR text of the scanned page next to the local text', async () => {
    const result = await extractDocument(FIXTURE, () => ({
      totalPages: 3,
      pages: [{ page: 2, text: 'Transcribed scan page' }],
    }))
    const text = result.chunks.map((c) => c.text).join(' ')
    expect(text).toContain('real text layer')
    expect(text).toContain('Transcribed scan page')
  })

  it('offers only the scanned pages as OCR work and skips the digital ones', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE documents (id INTEGER PRIMARY KEY, path TEXT, size_bytes INTEGER, mtime_ms REAL,
      last_opened_at INTEGER DEFAULT 0, excluded INTEGER DEFAULT 0, status TEXT, error TEXT,
      truncated INTEGER DEFAULT 0, priority_at INTEGER DEFAULT 0)`)
    OcrSidecar.ensureSchema(db)
    db.prepare(
      "INSERT INTO documents(id, path, size_bytes, mtime_ms, status) VALUES (1, '/a/mixed.pdf', 10, 5, 'text-only')",
    ).run()
    const ocr = new OcrSidecar(db)
    expect(ocr.candidates(50)).toEqual([])
    ocr.saveScanInfo(
      '/a/mixed.pdf',
      { mtimeMs: 5, sizeBytes: 10 },
      { totalPages: 3, scannedPages: [2] },
    )
    expect(ocr.candidates(50)).toMatchObject([
      { path: '/a/mixed.pdf', pagesDone: 0, totalPages: 3, skipPages: [1, 3] },
    ])
    ocr.savePages('/a/mixed.pdf', { hash: 'h', mtimeMs: 5, sizeBytes: 10, totalPages: 3 }, [
      { page: 2, text: 'x' },
    ])
    expect(ocr.candidates(50)).toEqual([])
  })
})
