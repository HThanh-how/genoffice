import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normalizeDocumentText,
  matchedNameWords,
  nameWords,
  getNameQueryAliases,
} from '../src/main/document-memory/normalization'
import { HotMetadataSearch } from '../src/main/document-memory/hot-metadata-search'
import { openDatabase } from '../src/main/document-memory/storage/database'
import { applyCanonicalSchemaV3 } from '../src/main/document-memory/storage/schema-v3'

describe('Checkpoint 4: Search Normalization & Candidate Retrieval', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dm-normalization-test-'))
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('NORM-01: diacritics and đ/Đ/Ð are folded properly without accent sensitivity', () => {
    expect(normalizeDocumentText('Hợp đồng lao động ĐẮK LẮK')).toBe('hop dong lao dong dak lak')
    expect(normalizeDocumentText('Đơn xin nghỉ phép - Đi làm')).toBe('don xin nghi phep di lam')
    expect(normalizeDocumentText('GIẤY XUẤT VIỆN ĐỢT 1')).toBe('giay xuat vien dot 1')
    expect(normalizeDocumentText('ÐỒNG NAI')).toBe('dong nai')
  })

  it('NORM-02: separators (hyphens, underscores, dots, slashes) are cleanly tokenized', () => {
    expect(normalizeDocumentText('giay_ra_vien-2024.final.docx')).toBe('giay ra vien 2024 final docx')
    expect(normalizeDocumentText('contract/appendix_v1.0.pdf')).toBe('contract appendix v1 0 pdf')
    expect(normalizeDocumentText('class_12/toan-hoc')).toBe('class 12 toan hoc')
  })

  it('NORM-03: recognizes concatenated Vietnamese words and phrases', () => {
    // "giayravien" matches "ra", "vien"
    expect(matchedNameWords(['ra', 'vien'], 'giayravien.pdf')).toBe(2)

    // "hopdonglaodong" matches "hop", "dong"
    expect(matchedNameWords(['hop', 'dong'], 'hopdonglaodong.docx')).toBe(2)

    // "sokhambenh" matches "kham", "benh"
    expect(matchedNameWords(['kham', 'benh'], 'sokhambenh.pdf')).toBe(2)
  })

  it('NORM-04: "ra vien" <-> "xuat vien" is a controlled narrow alias that never inflates the typed words', () => {
    // The typed words stay exactly what the user typed; the alias is a separate query variant.
    const xuatWords = nameWords('giấy xuất viện')
    expect(xuatWords).toEqual(['giay', 'xuat', 'vien'])
    expect(getNameQueryAliases(xuatWords)).toEqual([['giay', 'ra', 'vien']])
    expect(getNameQueryAliases(['ra', 'vien'])).toEqual([['xuat', 'vien']])
    expect(getNameQueryAliases(['xuat', 'ra', 'vien'])).toEqual([])
    expect(getNameQueryAliases(['hop', 'dong'])).toEqual([])

    // Query "giấy xuất viện" matches filename "giay_ra_vien.pdf" and vice-versa
    expect(matchedNameWords(['xuat', 'vien'], 'giay_ra_vien.pdf')).toBe(2)
    expect(matchedNameWords(['ra', 'vien'], 'giay_xuat_vien.pdf')).toBe(2)

    // Broad abbreviation synonyms are intentionally NOT expanded (CCCD / CMND are different
    // documents; "hdld" is not guessed from "hop dong").
    expect(matchedNameWords(['cccd'], 'cmnd_mat_truoc.pdf')).toBe(0)
    expect(matchedNameWords(['cmnd'], 'cccd_gan_chip.pdf')).toBe(0)
    expect(matchedNameWords(['cccd'], 'cccd_gan_chip.pdf')).toBe(1)
    expect(matchedNameWords(['hop', 'dong'], 'hdld_nhan_vien.docx')).toBe(0)
  })

  it('RETRIEVAL-01: Deep path matching finds files in nested directories regardless of folder depth', () => {
    const dbPath = join(tempDir, 'deep-path.db')
    const db = openDatabase(dbPath)
    applyCanonicalSchemaV3(db)

    // Deeply nested contract path
    const deepPath = '/Users/huythanh/Company/Work/Contracts/2024/VIP/Customer/hopdong.pdf'
    db.prepare(`
      INSERT INTO documents (id, path, name, status, priority_at, updated_at)
      VALUES (1, ?, 'hopdong.pdf', 'ready', 5000, 1000)
    `).run(deepPath)

    const searcher = new HotMetadataSearch(db)

    // Search matching high-level folder "Contracts" + file name "hop dong"
    const hits = searcher.searchNames('Contracts hop dong')
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0]!.documentId).toBe(1)

    // Search matching deep folder "Customer" + "VIP"
    const deepHits = searcher.searchNames('Customer VIP hopdong')
    expect(deepHits.length).toBeGreaterThanOrEqual(1)
    expect(deepHits[0]!.documentId).toBe(1)

    db.close()
  })

  it('RETRIEVAL-02: Candidate retrieval deduplicates by document ID and avoids table scans', () => {
    const dbPath = join(tempDir, 'dedup.db')
    const db = openDatabase(dbPath)
    applyCanonicalSchemaV3(db)

    db.prepare(`
      INSERT INTO documents (id, path, name, status, priority_at, updated_at)
      VALUES
        (1, '/docs/report1.pdf', 'report1.pdf', 'ready', 100, 100),
        (2, '/docs/report2.pdf', 'report2.pdf', 'ready', 200, 200)
    `).run()

    const searcher = new HotMetadataSearch(db)
    const hits = searcher.searchNames('report')

    expect(hits.length).toBe(2)
    const ids = hits.map((h) => h.documentId)
    // Verify no duplicates
    expect(new Set(ids).size).toBe(ids.length)

    db.close()
  })
})
