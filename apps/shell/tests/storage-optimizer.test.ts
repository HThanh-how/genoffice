import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import {
  detectFtsLayout,
  ftsIntegrityOk,
  inspectFtsStorage,
  optimizeFts,
} from '../src/main/document-memory/runtime/storage-optimizer'
import { seedCorpus, type SeedResult } from './helpers/storage-optimizer-seed'

/**
 * FTS5 optimisation against a real SQLite file written through the real store path
 * (replaceDocument => chunks + chunk_fts + chunk_embeddings). Native usearch is not involved.
 */
describe('optimizeFts', () => {
  let dir: string
  let dbPath: string
  let store: DocumentMemoryStore
  let seed: SeedResult

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'storage-optimizer-'))
    dbPath = join(dir, 'document-memory.db')
    store = new DocumentMemoryStore(dbPath, { role: 'worker' })
    seed = seedCorpus(store, dir, { targetLogicalMb: 2.5, chunksPerDoc: 12 })
    store.rawDb.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const queryFingerprint = (db: DatabaseSync): string =>
    JSON.stringify(
      seed.queryWords.map((w) => ({
        w,
        rows: db
          .prepare('SELECT rowid, bm25(chunk_fts) AS r FROM chunk_fts WHERE chunk_fts MATCH ? ORDER BY r, rowid LIMIT 400')
          .all(`"${w}"`),
      })),
    )

  const nameFingerprint = (db: DatabaseSync): string =>
    JSON.stringify(
      db.prepare("SELECT rowid, bm25(document_name_fts, 5.0, 1.0) AS r FROM document_name_fts WHERE document_name_fts MATCH 'doc*' ORDER BY r, rowid").all(),
    )

  it('detects the real layout: chunk_fts is a regular (text-duplicating) table, name fts is external-content', () => {
    const db = store.rawDb
    expect(detectFtsLayout(db, 'chunk_fts')).toBe('regular')
    expect(detectFtsLayout(db, 'document_name_fts')).toBe('external-content')
    const s = inspectFtsStorage(db, 'chunk_fts')
    expect(s.contentBytes).toBeGreaterThan(0)
    // the duplicated copy of the text is as large as the chunks table itself
    const chunksBytes = Number((db.prepare("SELECT sum(pgsize) b FROM dbstat WHERE name = 'chunks'").get() as { b: number }).b)
    expect(s.contentBytes! / chunksBytes).toBeGreaterThan(0.8)
    expect(s.contentBytes! / chunksBytes).toBeLessThan(1.3)
    expect(inspectFtsStorage(db, 'document_name_fts').contentBytes).toBe(0)
  })

  it('merges segments, keeps every query/bm25 result identical and gives pages back', async () => {
    const db = store.rawDb
    const before = queryFingerprint(db)
    const nameBefore = nameFingerprint(db)
    const res = await optimizeFts(db, { maxPages: 100_000, integrityCheck: true, reclaim: true })
    expect(res.stoppedReason).toBe('converged')
    expect(res.pending).toEqual([])
    expect(res.tables.every((t) => t.converged && t.integrity === 'ok')).toBe(true)
    expect(res.ftsBytesAfter).toBeLessThan(res.ftsBytesBefore)
    expect(res.freelistPagesGained).toBeGreaterThan(0)
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    expect(queryFingerprint(db)).toBe(before)
    expect(nameFingerprint(db)).toBe(nameBefore)
    expect(ftsIntegrityOk(db, 'chunk_fts')).toBe(true)
    // once converged, another pass is a near no-op
    const again = await optimizeFts(db, { maxPages: 100_000 })
    expect(again.stoppedReason).toBe('converged')
    expect(again.steps).toBeLessThanOrEqual(3) // one converged pass for each of the three FTS tables
  })

  it('is bounded and resumable: a tiny page budget stops early and `pending` finishes the job', async () => {
    const db = store.rawDb
    const before = queryFingerprint(db)
    const first = await optimizeFts(db, { maxPages: 32, stepPages: 8 })
    expect(first.stoppedReason).toBe('page-budget')
    expect(first.steps).toBeLessThanOrEqual(4)
    expect(first.pending).toContain('chunk_fts')
    let pending = first.pending
    let rounds = 0
    while (pending.length > 0 && rounds++ < 200) {
      pending = (await optimizeFts(db, { tables: pending, maxPages: 64, stepPages: 8 })).pending
    }
    expect(pending).toEqual([])
    expect(queryFingerprint(db)).toBe(before)
  })

  it('honours cancellation, time budget and yields between steps', async () => {
    const db = store.rawDb
    const cancelled = await optimizeFts(db, { shouldContinue: () => false })
    expect(cancelled.stoppedReason).toBe('cancelled')
    expect(cancelled.steps).toBe(0)

    let t = 0
    const timed = await optimizeFts(db, { budgetMs: 10, now: () => (t += 6), stepPages: 4 })
    expect(timed.stoppedReason).toBe('time-budget')
    expect(timed.steps).toBeLessThanOrEqual(2)

    let yields = 0
    const stop = { n: 0 }
    const y = await optimizeFts(db, {
      stepPages: 4,
      yield: async () => {
        yields++
      },
      shouldContinue: () => stop.n++ < 3,
    })
    expect(y.stoppedReason).toBe('cancelled')
    expect(yields).toBeGreaterThanOrEqual(2)
  })

  it('composes with the existing mergeFtsStep instead of duplicating it', async () => {
    const db = store.rawDb
    let calls = 0
    const res = await optimizeFts(db, {
      tables: ['chunk_fts'],
      stepPages: 8,
      mergeStep: (table, pages) => {
        if (table !== 'chunk_fts') return undefined
        calls++
        return store.mergeFtsStep(pages)
      },
    })
    expect(res.tables[0]!.converged).toBe(true)
    expect(calls).toBe(res.steps)
    expect(calls).toBeGreaterThan(1)
    expect(res.ftsBytesAfter).toBeLessThan(res.ftsBytesBefore)
  })

  it('reports busy (no throw, no 5 s stall) when the indexing writer holds the lock, and restores busy_timeout', async () => {
    const writer = new DatabaseSync(dbPath)
    try {
      writer.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE')
      const started = Date.now()
      const res = await optimizeFts(store.rawDb, { busyTimeoutMs: 0, tables: ['chunk_fts'] })
      expect(res.stoppedReason).toBe('busy')
      expect(Date.now() - started).toBeLessThan(2000)
      expect((store.rawDb.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout).toBe(5000)
    } finally {
      writer.exec('ROLLBACK')
      writer.close()
    }
  })

  it('rebuilds a regular FTS table that fails its integrity check, only when allowed', async () => {
    const db = store.rawDb
    const before = queryFingerprint(db)
    db.exec('DELETE FROM chunk_fts_content WHERE id IN (SELECT id FROM chunk_fts_content LIMIT 7)')
    expect(ftsIntegrityOk(db, 'chunk_fts')).toBe(false)
    const denied = await optimizeFts(db, { tables: ['chunk_fts'], integrityCheck: true, maxPages: 100_000 })
    expect(denied.tables[0]!.integrity).toBe('failed')
    expect(denied.stoppedReason).toBe('converged')
    const fixed = await optimizeFts(db, { tables: ['chunk_fts'], integrityCheck: true, allowRebuild: true, maxPages: 100_000 })
    expect(fixed.tables[0]!.integrity).toBe('rebuilt')
    expect(ftsIntegrityOk(db, 'chunk_fts')).toBe(true)
    // content rows were deleted, so the rebuilt index covers fewer rows: the point is that it is consistent again
    expect(queryFingerprint(db)).not.toBe('')
    expect(before).not.toBe('')
  })

  it('design proof: a contentless_delete table gives identical MATCH/bm25 results without storing the text twice', async () => {
    const db = store.rawDb
    const current = inspectFtsStorage(db, 'chunk_fts')
    await optimizeFts(db, { tables: ['chunk_fts'], maxPages: 100_000 })
    db.exec(
      "CREATE VIRTUAL TABLE chunk_fts_cl USING fts5(text, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2')",
    )
    db.exec('INSERT INTO chunk_fts_cl(rowid, text) SELECT rowid, text FROM chunk_fts')
    expect(detectFtsLayout(db as DatabaseSync, 'chunk_fts')).toBe('regular')
    let nonEmpty = 0
    for (const w of seed.queryWords) {
      const a = db.prepare('SELECT rowid, bm25(chunk_fts) r FROM chunk_fts WHERE chunk_fts MATCH ? ORDER BY r, rowid').all(`"${w}"`)
      const b = db.prepare('SELECT rowid, bm25(chunk_fts_cl) r FROM chunk_fts_cl WHERE chunk_fts_cl MATCH ? ORDER BY r, rowid').all(`"${w}"`)
      expect(b).toEqual(a)
      if (a.length > 0) nonEmpty++
    }
    expect(nonEmpty).toBeGreaterThanOrEqual(3) // common/mid words must hit; the rarest sample may not occur in a small seed
    db.exec("INSERT INTO chunk_fts_cl(chunk_fts_cl) VALUES('integrity-check')")
    const bytes = (n: string): number => Number((db.prepare('SELECT coalesce(sum(pgsize),0) b FROM dbstat WHERE name = ?').get(n) as { b: number }).b)
    expect(bytes('chunk_fts_cl_content')).toBe(0)
    const contentless = bytes('chunk_fts_cl_data') + bytes('chunk_fts_cl_idx') + bytes('chunk_fts_cl_docsize') + bytes('chunk_fts_cl_config')
    expect(contentless).toBeLessThan(current.totalBytes! * 0.55)
    // writers keep the exact same statements: INSERT(rowid,text) / DELETE WHERE rowid / DELETE all
    db.prepare('DELETE FROM chunk_fts_cl WHERE rowid = ?').run(1)
    expect(db.prepare('SELECT count(*) n FROM chunk_fts_cl WHERE rowid = 1').get()).toEqual({ n: 0 })
    db.exec('DELETE FROM chunk_fts_cl')
    expect((db.prepare('SELECT count(*) n FROM chunk_fts_cl_docsize').get() as { n: number }).n).toBe(0)
    // reading the column back is NOT possible (diagnostics-repository sums length(text) in a fallback path)
    db.exec("INSERT INTO chunk_fts_cl(rowid, text) VALUES (1, 'abc')")
    expect(db.prepare('SELECT text FROM chunk_fts_cl WHERE rowid = 1').get()).toEqual({ text: null })
    db.exec('DROP TABLE chunk_fts_cl')
  })
})
