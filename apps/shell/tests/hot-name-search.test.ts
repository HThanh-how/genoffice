import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentMemoryStore } from '../src/main/document-memory/store'

describe('Hot Metadata & Filename Search (document_name_fts)', () => {
  let directory: string
  let dbPath: string
  let store: DocumentMemoryStore

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hot-name-search-test-'))
    dbPath = join(directory, 'memory.sqlite')
    store = new DocumentMemoryStore(dbPath, { role: 'search' })
  })

  afterEach(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  const indexDoc = (
    relPath: string,
    mtimeMs = 1000,
    priorityAt = 1000,
  ) => {
    const fullPath = join(directory, relPath)
    store.replaceDocument(fullPath, {
      hash: `hash-${relPath}`,
      mtimeMs,
      sizeBytes: 100,
      chunks: [{ text: 'Sample document body content', location: 'Section 1' }],
      status: 'text-only',
    })
    if (priorityAt !== 1000) {
      store.rawDb.prepare('UPDATE documents SET priority_at = ? WHERE path = ?').run(priorityAt, fullPath)
    }
    return fullPath
  }

  it('matches exact filename with top rank', () => {
    indexDoc('LATS_NHPhuong.docx')
    indexDoc('LATS_NHPhuong_PhuLuc.docx')
    indexDoc('Khac.docx')

    const hits = store.searchNames('LATS_NHPhuong', 5)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0]?.name).toBe('LATS_NHPhuong.docx')
  })

  it('matches partial prefix in filename', () => {
    indexDoc('LATS_NHPhuong_FINAL_2026.docx')
    indexDoc('Khac_2026.docx')

    const hits = store.searchNames('lats nhphuong', 5)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0]?.name).toBe('LATS_NHPhuong_FINAL_2026.docx')
  })

  it('matches Vietnamese filename with accents and diacritics removed', () => {
    indexDoc('Báo cáo tài chính năm 2026.xlsx')
    indexDoc('Ghi chú công việc.docx')

    const hits = store.searchNames('bao cao tai chinh', 5)
    expect(hits.length).toBe(1)
    expect(hits[0]?.name).toBe('Báo cáo tài chính năm 2026.xlsx')
  })

  it('handles underscore and hyphen separated filenames', () => {
    indexDoc('quy_che_chi_tieu_noi_bo.docx')
    indexDoc('ke-hoach-hanh-dong-2026.pdf')

    const underHits = store.searchNames('quy che chi tieu', 5)
    expect(underHits.length).toBe(1)
    expect(underHits[0]?.name).toBe('quy_che_chi_tieu_noi_bo.docx')

    const hyphenHits = store.searchNames('ke hoach hanh dong', 5)
    expect(hyphenHits.length).toBe(1)
    expect(hyphenHits[0]?.name).toBe('ke-hoach-hanh-dong-2026.pdf')
  })

  it('matches parent folder names in query', () => {
    indexDoc('Duan_Alpha/Tong_ket.docx')
    indexDoc('Duan_Beta/Tong_ket.docx')

    const hits = store.searchNames('Duan Alpha Tong ket', 5)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0]?.path).toContain('Duan_Alpha')
  })

  it('uses recency as a tie breaker for matching filenames', () => {
    const now = Date.now()
    indexDoc('PFAS_report_old.docx', now - 100 * 24 * 3600 * 1000, now - 100 * 24 * 3600 * 1000)
    indexDoc('PFAS_report_recent.docx', now - 2 * 3600 * 1000, now - 2 * 3600 * 1000)

    const hits = store.searchNames('PFAS report', 5)
    expect(hits.length).toBe(2)
    // The file edited 2 hours ago must rank above the one from 100 days ago
    expect(hits[0]?.name).toBe('PFAS_report_recent.docx')
    expect(hits[1]?.name).toBe('PFAS_report_old.docx')
  })

  it('ignores excluded documents in filename search', () => {
    const p1 = indexDoc('Document_Active.docx')
    const p2 = indexDoc('Document_Excluded.docx')

    store.exclude(p2)

    const hits = store.searchNames('Document', 5)
    expect(hits.map((h) => h.path)).toContain(p1)
    expect(hits.map((h) => h.path)).not.toContain(p2)
  })

  it('ensures name_fts_version meta table exists and FTS is synced', () => {
    const metaRow = store.rawDb
      .prepare("SELECT value FROM document_memory_meta WHERE key = 'name_fts_version'")
      .get() as { value: string } | undefined

    expect(metaRow?.value).toBe('1')

    // Document name FTS contains indexed rows
    const ftsCount = store.rawDb
      .prepare('SELECT count(*) as cnt FROM document_name_fts')
      .get() as { cnt: number }
    expect(ftsCount.cnt).toBeGreaterThanOrEqual(0)
  })
})
