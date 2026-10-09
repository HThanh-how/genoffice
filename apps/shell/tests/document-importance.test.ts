import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { migrateDocumentImportance } from '../src/main/document-memory/storage/migration/document-importance'
import {
  inferDocumentImportance,
} from '../src/main/document-memory/document-importance'

describe('Checkpoint 1: File Importance & Retention Hierarchy', () => {
  let tempDir: string
  let dbPath: string
  let stores: DocumentMemoryStore[]

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-importance-test-'))
    dbPath = join(tempDir, 'document-memory.db')
    stores = []
  })

  afterEach(() => {
    for (const s of stores) {
      try {
        s.close()
      } catch {}
    }
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  function createStore(): DocumentMemoryStore {
    const s = new DocumentMemoryStore(dbPath)
    stores.push(s)
    return s
  }

  it('IMPORTANCE-01: Pure inference correctly classifies ID docs, discharge papers, medical records, contracts', () => {
    // ID documents
    const idResult = inferDocumentImportance({ name: 'cccd_nguyen_van_a.pdf', path: '/docs/cccd_nguyen_van_a.pdf' })
    expect(idResult.suggestion).toBe('important')
    expect(idResult.reason).toContain('CCCD')

    // Discharge papers (giay ra vien / xuat vien)
    const dischargeResult1 = inferDocumentImportance({ name: 'giay_ra_vien_bv_cho_ray.docx', path: '/medical/giay_ra_vien.docx' })
    expect(dischargeResult1.suggestion).toBe('important')
    expect(dischargeResult1.reason).toContain('giấy ra viện')

    const dischargeResult2 = inferDocumentImportance({ name: 'scan_discharge.pdf', path: '/files/scan.pdf', content: 'Cộng hòa xã hội chủ nghĩa Việt Nam - Giấy xuất viện' })
    expect(dischargeResult2.suggestion).toBe('important')
    expect(dischargeResult2.reason).toContain('giấy xuất viện')

    // Medical records
    const medResult = inferDocumentImportance({ name: 'so_kham_benh_2026.pdf', path: '/medical/so_kham_benh.pdf' })
    expect(medResult.suggestion).toBe('important')
    expect(medResult.reason).toContain('hồ sơ y tế')

    // Contracts
    const contractResult = inferDocumentImportance({ name: 'hop_dong_lao_dong_2026.pdf', path: '/work/hdld.pdf' })
    expect(contractResult.suggestion).toBe('important')
    expect(contractResult.reason).toContain('hợp đồng')

    // Normal files without keywords
    const normalResult = inferDocumentImportance({ name: 'presentation_deck.pptx', path: '/work/deck.pptx' })
    expect(normalResult.suggestion).toBe('normal')
    expect(normalResult.reason).toBeNull()

    // Downloads folder is not junk and does not infer low
    const downloadsResult = inferDocumentImportance({ name: 'notes.txt', path: '/Users/test/Downloads/notes.txt' })
    expect(downloadsResult.suggestion).toBe('normal')
  })

  it('IMPORTANCE-02: Unopened ID doc is marked important on enrollment and survives restart', () => {
    const store1 = createStore()
    const filePath = '/Users/test/Documents/cccd_chip_2026.pdf'

    // Enroll unopened document
    const enrolled = store1.enrollDiscovered(filePath, 1000, 2048)
    expect(enrolled).toBe(true)

    const doc1 = store1.documentByPath(filePath)
    expect(doc1).not.toBeNull()
    const importance1 = store1.getImportance(doc1!.id)
    expect(importance1).not.toBeNull()
    expect(importance1!.suggestion).toBe('important')
    expect(importance1!.override).toBe('auto')
    expect(importance1!.effective).toBe('important')
    expect(importance1!.reason).toContain('CCCD')

    // Close store and reopen from disk (simulating restart)
    store1.close()

    const store2 = createStore()
    const doc2 = store2.documentByPath(filePath)
    expect(doc2).not.toBeNull()
    const importance2 = store2.getImportance(doc2!.id)
    expect(importance2).not.toBeNull()
    expect(importance2!.suggestion).toBe('important')
    expect(importance2!.override).toBe('auto')
    expect(importance2!.effective).toBe('important')
    expect(importance2!.reason).toContain('CCCD')
  })

  it('IMPORTANCE-03: User override to low is never overridden by auto inference', () => {
    const store = createStore()
    const filePath = '/Users/test/medical/giay_ra_vien_sample.pdf'

    store.enrollDiscovered(filePath, 1000, 4096)
    const doc = store.documentByPath(filePath)!
    expect(store.getImportance(doc.id)?.effective).toBe('important')

    // User explicitly overrides to 'low'
    const success = store.setImportanceOverride(doc.id, 'low')
    expect(success).toBe(true)

    const updated = store.getImportance(doc.id)!
    expect(updated.override).toBe('low')
    expect(updated.effective).toBe('low')
    // Suggestion remains preserved for user transparency
    expect(updated.suggestion).toBe('important')

    // Auto replacement with newly extracted content containing "giấy ra viện"
    store.replaceDocument(filePath, {
      hash: 'hash-abc',
      mtimeMs: 2000,
      sizeBytes: 4096,
      chunks: [{ text: 'Bệnh viện Chợ Rẫy - Giấy ra viện của bệnh nhân', location: 'p1' }],
      embeddingModel: 'test-model',
      status: 'ready',
    })

    // User choice MUST NOT be overwritten
    const afterReplaced = store.getImportance(doc.id)!
    expect(afterReplaced.override).toBe('low')
    expect(afterReplaced.effective).toBe('low')
  })

  it('IMPORTANCE-04: Rename and move retains user importance override under same document identity', () => {
    const store = createStore()
    const oldPath = '/Users/test/contracts/hop_dong_thue_nha.docx'
    const newPath = '/Users/test/archive/contracts_2026/hop_dong_thue_nha_final.docx'

    store.enrollDiscovered(oldPath, 1000, 5000)
    const doc = store.documentByPath(oldPath)!

    // User sets override to 'important'
    store.setImportanceOverride(doc.id, 'important')
    expect(store.getImportance(doc.id)?.override).toBe('important')

    // Move file
    store.move(oldPath, newPath)

    // Old path is gone, new path has same id and same importance override
    expect(store.documentByPath(oldPath)).toBeNull()
    const movedDoc = store.documentByPath(newPath)!
    expect(movedDoc.id).toBe(doc.id)

    const importanceAfterMove = store.getImportance(movedDoc.id)!
    expect(importanceAfterMove.override).toBe('important')
    expect(importanceAfterMove.effective).toBe('important')
  })

  it('IMPORTANCE-05: Downloads folder file is NOT auto-marked low and open frequency does not decide importance', () => {
    const store = createStore()
    const downloadsPath = '/Users/test/Downloads/sample_report.xlsx'

    store.enrollDiscovered(downloadsPath, 1000, 3000)
    const doc = store.documentByPath(downloadsPath)!
    const initialImportance = store.getImportance(doc.id)!
    expect(initialImportance.suggestion).toBe('normal')
    expect(initialImportance.override).toBe('auto')
    expect(initialImportance.effective).toBe('normal')

    // Open file multiple times
    store.remember(downloadsPath)
    store.remember(downloadsPath)
    store.remember(downloadsPath)

    const afterOpens = store.getImportance(doc.id)!
    expect(afterOpens.override).toBe('auto')
    expect(afterOpens.suggestion).toBe('normal')
    expect(afterOpens.effective).toBe('normal')
  })

  it('IMPORTANCE-06: Idempotent migration twice loses nothing and preserves existing rows', () => {
    // 1. Create a DB handle and manually simulate an older V3 schema without importance columns
    const rawDb = new DatabaseSync(dbPath)
    rawDb.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        mtime_ms REAL,
        size_bytes INTEGER,
        hash TEXT,
        embedding_model TEXT,
        active_chunk_set_id INTEGER,
        error TEXT,
        excluded INTEGER NOT NULL DEFAULT 0,
        truncated INTEGER NOT NULL DEFAULT 0,
        truncated_reason TEXT,
        last_opened_at INTEGER NOT NULL DEFAULT 0,
        priority_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        chunk_total INTEGER NOT NULL DEFAULT 0,
        chunk_done INTEGER NOT NULL DEFAULT 0,
        chunk_counted INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO documents (id, path, name, status, mtime_ms, size_bytes)
      VALUES (1, '/docs/legacy.pdf', 'legacy.pdf', 'ready', 1000, 500);
    `)

    // Verify columns before migration
    const colsBefore = (rawDb.prepare('PRAGMA table_info(documents)').all() as any[]).map((c) => c.name)
    expect(colsBefore.includes('importance_override')).toBe(false)

    // 2. First migration run
    const altered1 = migrateDocumentImportance(rawDb)
    expect(altered1).toBe(true)

    const colsAfter1 = (rawDb.prepare('PRAGMA table_info(documents)').all() as any[]).map((c) => c.name)
    expect(colsAfter1.includes('importance_override')).toBe(true)
    expect(colsAfter1.includes('importance_suggestion')).toBe(true)
    expect(colsAfter1.includes('importance_reason')).toBe(true)
    expect(colsAfter1.includes('importance_updated_at')).toBe(true)

    // Existing row preserved
    const row1 = rawDb.prepare('SELECT * FROM documents WHERE id = 1').get() as any
    expect(row1.path).toBe('/docs/legacy.pdf')
    expect(row1.importance_override).toBe('auto')
    expect(row1.importance_suggestion).toBe('unknown')

    // 3. Second migration run immediately (idempotent)
    const altered2 = migrateDocumentImportance(rawDb)
    expect(altered2).toBe(false)

    const row2 = rawDb.prepare('SELECT * FROM documents WHERE id = 1').get() as any
    expect(row2.path).toBe('/docs/legacy.pdf')
    expect(row2.importance_override).toBe('auto')

    rawDb.close()
  })

  it('IMPORTANCE-07: Input validation rejects invalid override or suggestion values', () => {
    const store = createStore()
    const filePath = '/test/doc.txt'
    store.enrollDiscovered(filePath, 1000, 100)
    const doc = store.documentByPath(filePath)!

    expect(() => store.setImportanceOverride(doc.id, 'invalid' as any)).toThrow('Invalid importance override')
    expect(() => store.setImportanceOverride(-1, 'important')).toThrow('Invalid document id')
    expect(() => store.setImportanceSuggestion(doc.id, 'super-high' as any, null)).toThrow('Invalid importance suggestion')
  })
})
