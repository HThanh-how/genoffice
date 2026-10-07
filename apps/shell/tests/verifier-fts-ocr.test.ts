import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import {
  verifyFtsIntegrity,
  verifyOcrIntegrity,
  verifyLogicalConsistency,
} from '../src/main/document-memory/storage/migration/logical-verifier'

describe('Logical Verifiers: FTS and OCR Integrity Suite (QA-16)', () => {
  let tempDir: string
  let dbPath: string
  let activeStores: DocumentMemoryStore[] = []

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-verifier-fts-ocr-'))
    dbPath = join(tempDir, 'document-memory.db')
    activeStores = []
  })

  afterEach(() => {
    for (const s of activeStores) {
      try {
        s.close()
      } catch {}
    }
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  function createValidV3Db(): DocumentMemoryStore {
    const store = new DocumentMemoryStore(dbPath)
    activeStores.push(store)

    store.rawDb
      .prepare("INSERT OR REPLACE INTO document_memory_meta (key, value) VALUES ('schema_version', '3')")
      .run()

    store.replaceDocument('/workspace/doc1.txt', {
      hash: 'h1',
      mtimeMs: 1000,
      sizeBytes: 1000,
      status: 'ready',
      chunks: [
        { text: 'First chunk of text', location: 'p1' },
        { text: 'Second chunk of text', location: 'p2' },
      ],
    })

    return store
  }

  it('FTSOCR-01: Valid V3 database passes FTS and OCR integrity verification', () => {
    const store = createValidV3Db()

    const fts = verifyFtsIntegrity(store.rawDb)
    expect(fts.ok).toBe(true)
    expect(fts.reasons).toEqual([])
    expect(fts.totalFtsChunks).toBe(2)

    const ocr = verifyOcrIntegrity(store.rawDb)
    expect(ocr.ok).toBe(true)
    expect(ocr.reasons).toEqual([])

    const result = verifyLogicalConsistency(store.rawDb, 1, 2)
    expect(result.ok).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('FTSOCR-02: Missing chunk_fts records fails FTS integrity verification', () => {
    const store = createValidV3Db()

    // Delete one chunk from chunk_fts
    store.rawDb.prepare('DELETE FROM chunk_fts WHERE rowid = 1').run()

    const fts = verifyFtsIntegrity(store.rawDb)
    expect(fts.ok).toBe(false)
    expect(fts.reasons.some((r) => r.includes('[V13] FTS completeness failed'))).toBe(true)

    const consistency = verifyLogicalConsistency(store.rawDb, 1, 2)
    expect(consistency.ok).toBe(false)
    expect(consistency.reasons.some((r) => r.includes('[V13] FTS completeness failed'))).toBe(true)
  })

  it('FTSOCR-03: Orphan chunk_fts records fail FTS integrity verification', () => {
    const store = createValidV3Db()

    // Insert an orphan record into chunk_fts
    store.rawDb.prepare('INSERT INTO chunk_fts(rowid, text) VALUES(999999, ?)').run('orphan text without chunk')

    const fts = verifyFtsIntegrity(store.rawDb)
    expect(fts.ok).toBe(false)
    expect(fts.reasons.some((r) => r.includes('[V13] Orphan FTS rows detected'))).toBe(true)

    const consistency = verifyLogicalConsistency(store.rawDb, 1, 2)
    expect(consistency.ok).toBe(false)
    expect(consistency.reasons.some((r) => r.includes('[V13] Orphan FTS rows detected'))).toBe(true)
  })

  it('FTSOCR-04: Corrupted or missing chunk_fts virtual table fails FTS integrity verification', () => {
    const store = createValidV3Db()

    // Drop the virtual table to simulate corruption/loss
    store.rawDb.prepare('DROP TABLE chunk_fts').run()

    const fts = verifyFtsIntegrity(store.rawDb)
    expect(fts.ok).toBe(false)
    expect(fts.reasons.some((r) => r.includes('[V13] chunk_fts virtual table integrity check failed'))).toBe(true)

    const consistency = verifyLogicalConsistency(store.rawDb, 1, 2)
    expect(consistency.ok).toBe(false)
  })

  it('FTSOCR-05: Invalid OCR page numbers fail OCR integrity verification', () => {
    const store = createValidV3Db()

    // Insert invalid OCR pages (page 0 or page > total_pages)
    store.rawDb
      .prepare(`
        INSERT INTO ocr_pages (path, page, hash, mtime_ms, size_bytes, total_pages, text)
        VALUES ('/workspace/doc1.pdf', 0, 'hash', 1000, 1000, 5, 'text')
      `)
      .run()

    const ocr = verifyOcrIntegrity(store.rawDb)
    expect(ocr.ok).toBe(false)
    expect(ocr.reasons.some((r) => r.includes('[V14] OCR page range violation'))).toBe(true)

    const consistency = verifyLogicalConsistency(store.rawDb, 1, 2)
    expect(consistency.ok).toBe(false)
    expect(consistency.reasons.some((r) => r.includes('[V14] OCR page range violation'))).toBe(true)
  })
})
