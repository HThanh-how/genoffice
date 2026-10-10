import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IndexIssueReader } from '../src/main/document-memory/issue-reader'
import {
  buildDocumentProjection,
  CREATE_NAME_SEARCH_PROJECTION_SQL,
} from '../src/main/document-memory/name-search-projection'
import { CANONICAL_SCHEMA_V3 } from '../src/main/document-memory/storage/schema-v3'

function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Reference implementation of original matching semantics for testing only.
 * Full-table in-memory scan with fold normalization.
 */
function referenceSearch(
  db: DatabaseSync,
  query: string,
  limit = 40,
): Array<{ id: number; path: string; name: string; status: string }> {
  const words = fold(query).split(' ').filter(Boolean)
  if (words.length === 0) return []
  const rows = db
    .prepare('SELECT id, path, name, status, error FROM documents WHERE excluded = 0')
    .all() as unknown as Array<{ id: number; path: string; name: string; status: string; error: string | null }>
  const hits: typeof rows = []
  for (const row of rows) {
    const haystack = fold(`${row.name} ${row.path}`)
    if (words.every((word) => haystack.includes(word))) hits.push(row)
  }
  hits.sort((a, b) => Number(a.status === 'ready') - Number(b.status === 'ready') || a.id - b.id)
  return hits.slice(0, limit)
}

describe('IndexIssueReader search correctness & performance against reference', () => {
  let tempDir: string
  let dbPath: string
  let db: DatabaseSync
  let reader: IndexIssueReader

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'issue-reader-parity-'))
    dbPath = join(tempDir, 'memory.db')
    db = new DatabaseSync(dbPath)
    db.exec(CANONICAL_SCHEMA_V3)
    db.exec(CREATE_NAME_SEARCH_PROJECTION_SQL)
    reader = new IndexIssueReader(dbPath)
  })

  afterAll(() => {
    reader.close()
    try {
      db.close()
    } catch {
      // closed
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('matches reference across 100 documents with multiple folders and Vietnamese names', () => {
    db.exec('BEGIN TRANSACTION')
    const insertDoc = db.prepare(
      'INSERT INTO documents (id, name, path, status, excluded) VALUES (?, ?, ?, ?, ?)',
    )
    const insertProj = db.prepare(
      'INSERT INTO document_name_projection (document_id, name_norm, path_norm, compact_ngrams) VALUES (?, ?, ?, ?)',
    )

    const fixtures = [
      { id: 1, name: 'BỆNH VIỆN 30-4.pdf', path: '/home/Ba/BỆNH VIỆN 30-4.pdf', status: 'empty' },
      { id: 2, name: 'bệnh viện ghi chú.docx', path: '/home/Ba/bệnh viện ghi chú.docx', status: 'ready' },
      { id: 3, name: 'Hóa đơn tiền điện tháng 10.pdf', path: '/home/Bills/Hóa đơn tiền điện tháng 10.pdf', status: 'error' },
      { id: 4, name: 'hoa_don_nuoc.pdf', path: '/home/Bills/hoa_don_nuoc.pdf', status: 'ready' },
      { id: 5, name: 'Chuyến đi Đà Nẵng 2024.xlsx', path: '/home/Travel/Chuyến đi Đà Nẵng 2024.xlsx', status: 'ready' },
      { id: 6, name: 'Bản vẽ xây dựng nhà xưởng.dwg', path: '/home/Projects/Bản vẽ xây dựng nhà xưởng.dwg', status: 'ready' },
      { id: 7, name: 'Hóa đơn.pdf', path: '/home/Archive/Hóa đơn.pdf', status: 'ready' }, // duplicate name in diff folder
      { id: 8, name: 'Excluded secret.pdf', path: '/home/Vault/Excluded secret.pdf', status: 'ready', excluded: 1 },
    ]

    for (const f of fixtures) {
      insertDoc.run(f.id, f.name, f.path, f.status, f.excluded ?? 0)
      const proj = buildDocumentProjection(f.name, f.path)
      insertProj.run(f.id, proj.nameNorm, proj.pathNorm, proj.compactNgrams)
    }

    for (let i = 10; i <= 100; i++) {
      const name = `file_${i}_${i % 3 === 0 ? 'don' : 'ba'}.txt`
      const path = `/home/folder_${i % 5}/${name}`
      const status = i % 4 === 0 ? 'error' : 'ready'
      insertDoc.run(i, name, path, status, 0)
      const proj = buildDocumentProjection(name, path)
      insertProj.run(i, proj.nameNorm, proj.pathNorm, proj.compactNgrams)
    }
    db.exec('COMMIT')

    const queries = [
      'benh vien',
      'bEnH ViEn',
      'hoa don',
      'HÓA ĐƠN',
      'da nang',
      'Đà Nẵng',
      'folder_2',
      'don',
      '30-4',
      'ghi chú',
      'xay dung',
      'Excluded',
      'nonexistent_query',
    ]

    for (const q of queries) {
      const refHits = referenceSearch(db, q).map((h) => h.id)
      const actualHits = reader.search(q).map((h) => h.id)
      expect(actualHits).toEqual(refHits)
    }
  })

  it('matches reference across 1,000 documents with pagination and partial matches', () => {
    db.exec('BEGIN TRANSACTION')
    const insertDoc = db.prepare(
      'INSERT INTO documents (id, name, path, status, excluded) VALUES (?, ?, ?, ?, ?)',
    )
    const insertProj = db.prepare(
      'INSERT INTO document_name_projection (document_id, name_norm, path_norm, compact_ngrams) VALUES (?, ?, ?, ?)',
    )

    for (let i = 101; i <= 1000; i++) {
      const name = `document_${i}_${i % 7 === 0 ? 'dien' : 'hopdong'}.pdf`
      const path = `/home/contracts_${i % 10}/${name}`
      const status = i % 8 === 0 ? 'empty' : 'ready'
      insertDoc.run(i, name, path, status, 0)
      const proj = buildDocumentProjection(name, path)
      insertProj.run(i, proj.nameNorm, proj.pathNorm, proj.compactNgrams)
    }
    db.exec('COMMIT')

    const queries = [
      'contracts_3',
      'dien',
      'hopdong',
      'document_50',
      'contracts_1 hopdong',
      'contracts_9 dien',
    ]

    for (const q of queries) {
      // test limit = 10 (first page) and limit = 40
      const refPage10 = referenceSearch(db, q, 10).map((h) => h.id)
      const actualPage10 = reader.search(q, 10).map((h) => h.id)
      expect(actualPage10).toEqual(refPage10)

      const refPage40 = referenceSearch(db, q, 40).map((h) => h.id)
      const actualPage40 = reader.search(q, 40).map((h) => h.id)
      expect(actualPage40).toEqual(refPage40)
    }
  })

  it('scales to 10,000 documents with exact parity and sub-250ms latency distribution', () => {
    db.exec('BEGIN TRANSACTION')
    const insertDoc = db.prepare(
      'INSERT INTO documents (id, name, path, status, excluded) VALUES (?, ?, ?, ?, ?)',
    )
    const insertProj = db.prepare(
      'INSERT INTO document_name_projection (document_id, name_norm, path_norm, compact_ngrams) VALUES (?, ?, ?, ?)',
    )

    for (let i = 1001; i <= 10000; i++) {
      const isTarget = i === 5432
      const name = isTarget
        ? 'Biên bản nghiệm thu công trình số 433.docx'
        : `archive_${i}_${i % 11 === 0 ? 'nghiemthu' : 'data'}.bin`
      const path = `/home/dept_${i % 20}/${name}`
      const status = i % 15 === 0 ? 'error' : 'ready'
      insertDoc.run(i, name, path, status, 0)
      const proj = buildDocumentProjection(name, path)
      insertProj.run(i, proj.nameNorm, proj.pathNorm, proj.compactNgrams)
    }
    db.exec('COMMIT')

    // Cold query test
    const coldStart = performance.now()
    const coldHits = reader.search('nghiem thu 433')
    const coldDuration = performance.now() - coldStart

    const refCold = referenceSearch(db, 'nghiem thu 433').map((h) => h.id)
    expect(coldHits.map((h) => h.id)).toEqual(refCold)
    expect(coldHits.some((h) => h.name === 'Biên bản nghiệm thu công trình số 433.docx')).toBe(true)
    expect(coldDuration).toBeLessThan(250) // Strict latency budget

    // Benchmark warm queries and check parity against reference
    const benchmarkQueries = [
      'nghiem thu 433',
      'dept_7',
      'nghiemthu',
      'Hóa đơn',
      'BỆNH VIỆN',
      'Đà Nẵng',
      'archive_5000',
    ]

    const latencies: number[] = []
    for (const q of benchmarkQueries) {
      const ref = referenceSearch(db, q, 40).map((h) => h.id)
      const t0 = performance.now()
      const actual = reader.search(q, 40)
      const elapsed = performance.now() - t0
      latencies.push(elapsed)

      expect(actual.map((h) => h.id)).toEqual(ref)
      expect(elapsed).toBeLessThan(250) // Strict 250ms latency budget
    }

    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length
    const maxLatency = Math.max(...latencies)
    // console.log(`[P1-01 Benchmark] 10k docs -> avg: ${avgLatency.toFixed(2)}ms, max: ${maxLatency.toFixed(2)}ms, cold: ${coldDuration.toFixed(2)}ms`)

    expect(maxLatency).toBeLessThan(100) // Consistently well below 250ms
  })
})
