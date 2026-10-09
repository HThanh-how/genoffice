import { describe, it } from 'vitest'

/** Opt-in measurement run: STORAGE_OPT_BENCH=1 SEED_MB=55 npx vitest run tests/storage-optimizer-bench.test.ts (prints a report). */
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { seedCorpus } from './helpers/storage-optimizer-seed'
import { optimizeFts, inspectFtsStorage, ftsMergeStep } from '../src/main/document-memory/runtime/storage-optimizer'
import { normalizeDocumentText } from '../src/main/document-memory/normalization'
import { runOfflineCompaction } from '../src/main/document-memory/runtime/offline-compaction'

const MB = 1024 * 1024
const out: string[] = []
const log = (s: string): void => {
  out.push(s)
}
const sz = (p: string): number => (existsSync(p) ? statSync(p).size : 0)

function dbstat(db: DatabaseSync): Array<{ name: string; mb: number }> {
  return (
    db
      .prepare('SELECT name, sum(pgsize) AS b FROM dbstat GROUP BY name ORDER BY b DESC LIMIT 14')
      .all() as Array<{ name: string; b: number }>
  ).map((r) => ({ name: r.name, mb: Math.round((r.b / MB) * 100) / 100 }))
}

describe.skipIf(!process.env.STORAGE_OPT_BENCH)('storage optimizer measurements', () => {
  it('runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opt-measure-'))
    const dbPath = join(dir, 'document-memory.db')
    const store = new DocumentMemoryStore(dbPath, { role: 'worker' })
    try {
      const t0 = Date.now()
      const seed = seedCorpus(store, dir, { targetLogicalMb: Number(process.env.SEED_MB ?? 55), duplicateDocFraction: 0.06, boilerplateChunksPerDoc: 1 })
      log(`seed: docs=${seed.documents} chunks=${seed.chunks} logicalMB=${(seed.logicalBytes / MB).toFixed(1)} in ${Date.now() - t0}ms`)
      const db = store.rawDb
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      log(`file after seed: db=${(sz(dbPath) / MB).toFixed(1)}MB wal=${sz(dbPath + '-wal')} freelist=${(db.prepare('pragma freelist_count').get() as any).freelist_count}`)
      log('dbstat top: ' + JSON.stringify(dbstat(db)))
      for (const t of ['chunk_fts', 'document_name_fts'] as const) log(`${t}: ` + JSON.stringify(inspectFtsStorage(db, t)))

      // ---- FTS merge before/after ----
      const queries = seed.queryWords.map((w) => `"${w}"`)
      const fingerprint = (d: DatabaseSync): string => {
        const h = createHash('sha1')
        for (const q of queries) {
          const rows = d.prepare('SELECT rowid, bm25(chunk_fts) AS r FROM chunk_fts WHERE chunk_fts MATCH ? ORDER BY r, rowid LIMIT 500').all(q)
          h.update(JSON.stringify(rows))
        }
        return h.digest('hex')
      }
      const fpBefore = fingerprint(db)
      const tm = Date.now()
      const before = inspectFtsStorage(db, 'chunk_fts').dataBytes
      const res = await optimizeFts(db, { maxPages: 1_000_000, stepPages: 16, integrityCheck: true, reclaim: true })
      log(`optimizeFts (merge only): ${JSON.stringify({ ...res, tables: res.tables.map((t) => ({ ...t })) })} wall=${Date.now() - tm}ms`)
      log(`chunk_fts data bytes ${before} -> ${inspectFtsStorage(db, 'chunk_fts').dataBytes}; fingerprint equal=${fpBefore === fingerprint(db)}`)
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      log(`file after merge+reclaim: db=${(sz(dbPath) / MB).toFixed(2)}MB`)

      // Compare with a full 'optimize' on a copy
      const copyPath = join(dir, 'copy-optimize.db')
      db.exec(`VACUUM INTO '${copyPath}'`)
      const cdb = new DatabaseSync(copyPath)
      const to = Date.now()
      cdb.exec("INSERT INTO chunk_fts(chunk_fts) VALUES('optimize')")
      log(`full optimize on copy: ${Date.now() - to}ms data=${inspectFtsStorage(cdb, 'chunk_fts').dataBytes}`)
      cdb.close()

      // ---- Contentless FTS alternative ----
      const clPath = join(dir, 'copy-contentless.db')
      db.exec(`VACUUM INTO '${clPath}'`)
      const ldb = new DatabaseSync(clPath)
      const cs = Date.now()
      ldb.exec(`CREATE VIRTUAL TABLE chunk_fts_cl USING fts5(text, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2')`)
      ldb.exec('BEGIN')
      ldb.exec('INSERT INTO chunk_fts_cl(rowid, text) SELECT rowid, text FROM chunk_fts')
      ldb.exec('COMMIT')
      const buildMs = Date.now() - cs
      // merge to convergence for a fair comparison
      for (let i = 0; i < 100000; i++) if (!ftsMergeStep(ldb, 'chunk_fts' as any, 16) ) break
      for (let i = 0; i < 100000; i++) {
        const b = (ldb.prepare('SELECT total_changes() n').get() as any).n
        ldb.exec("INSERT INTO chunk_fts_cl(chunk_fts_cl, rank) VALUES('merge', 16)")
        if ((ldb.prepare('SELECT total_changes() n').get() as any).n - b <= 1) break
      }
      const sh = (n: string): number => Number((ldb.prepare('SELECT coalesce(sum(pgsize),0) b FROM dbstat WHERE name = ?').get(n) as any).b)
      log(`contentless build ${buildMs}ms; chunk_fts(regular, merged): data=${sh('chunk_fts_data')} idx=${sh('chunk_fts_idx')} content=${sh('chunk_fts_content')} docsize=${sh('chunk_fts_docsize')}`)
      log(`chunk_fts_cl: data=${sh('chunk_fts_cl_data')} idx=${sh('chunk_fts_cl_idx')} docsize=${sh('chunk_fts_cl_docsize')} content=${sh('chunk_fts_cl_content')} config=${sh('chunk_fts_cl_config')}`)
      // query equality
      let equal = true
      for (const q of queries) {
        const a = JSON.stringify(ldb.prepare('SELECT rowid, bm25(chunk_fts) r FROM chunk_fts WHERE chunk_fts MATCH ? ORDER BY r, rowid LIMIT 500').all(q))
        const b = JSON.stringify(ldb.prepare('SELECT rowid, bm25(chunk_fts_cl) r FROM chunk_fts_cl WHERE chunk_fts_cl MATCH ? ORDER BY r, rowid LIMIT 500').all(q))
        if (a !== b) equal = false
      }
      log(`contentless query+bm25 identical: ${equal}; integrity ok=${(() => { try { ldb.exec("INSERT INTO chunk_fts_cl(chunk_fts_cl) VALUES('integrity-check')"); return true } catch (e) { return String(e) } })()}`)
      // delete test on contentless
      ldb.exec('DELETE FROM chunk_fts_cl WHERE rowid IN (SELECT rowid FROM chunk_fts LIMIT 1000)')
      ldb.close()

      // ---- VACUUM gains: simulate retention (evict 40% of docs' vectors + 15% docs content) ----
      const rdb = db
      const ids = (rdb.prepare('SELECT id FROM documents ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id)
      const vecDocs = ids.filter((_, i) => i % 5 < 2)
      for (let i = 0; i < vecDocs.length; i += 25) {
        const batch = vecDocs.slice(i, i + 25)
        rdb.prepare(`DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id IN (${batch.map(() => '?').join(',')}))`).run(...batch)
      }
      const contentDocs = ids.filter((_, i) => i % 7 === 0)
      for (let i = 0; i < contentDocs.length; i += 25) {
        const batch = contentDocs.slice(i, i + 25)
        const ph = batch.map(() => '?').join(',')
        rdb.prepare(`DELETE FROM chunk_fts WHERE rowid IN (SELECT id FROM chunks WHERE document_id IN (${ph}))`).run(...batch)
        rdb.prepare(`DELETE FROM chunks WHERE document_id IN (${ph})`).run(...batch)
      }
      rdb.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      const fl = rdb.prepare('pragma freelist_count').get() as any
      const ps = (rdb.prepare('pragma page_size').get() as any).page_size
      log(`after simulated retention: db=${(sz(dbPath) / MB).toFixed(1)}MB freelistMB=${((fl.freelist_count * ps) / MB).toFixed(1)} pages=${(rdb.prepare('pragma page_count').get() as any).page_count}`)
      const ivStart = Date.now()
      rdb.exec('PRAGMA incremental_vacuum')
      rdb.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      log(`after incremental_vacuum (all): db=${(sz(dbPath) / MB).toFixed(1)}MB in ${Date.now() - ivStart}ms`)
      const viPath = join(dir, 'vacuum-into.db')
      const vs = Date.now()
      rdb.exec(`VACUUM INTO '${viPath}'`)
      log(`VACUUM INTO: ${(sz(viPath) / MB).toFixed(1)}MB in ${Date.now() - vs}ms (saves ${((sz(dbPath) - sz(viPath)) / MB).toFixed(2)}MB over incremental)`)
      const vdb = new DatabaseSync(viPath)
      log('vacuum-into dbstat top: ' + JSON.stringify(dbstat(vdb)))
      log('live dbstat top: ' + JSON.stringify(dbstat(rdb)))
      vdb.close()

      // ---- int8 + dup measurement on live db ----
      const emb = rdb.prepare("SELECT count(*) n, sum(length(vector)) vb, min(vector_dim) d FROM chunk_embeddings").get() as any
      const embTree = Number((rdb.prepare("SELECT sum(pgsize) b FROM dbstat WHERE name IN ('chunk_embeddings','chunk_embeddings_space') OR name LIKE 'sqlite_autoindex_chunk_embeddings%'").get() as any).b)
      log(`embeddings rows=${emb.n} vectorBytes=${(emb.vb / MB).toFixed(1)}MB treeBytes(incl indexes)=${(embTree / MB).toFixed(1)}MB dim=${emb.d}`)
      const int8Bytes = emb.n * (emb.d + 8)
      log(`int8 (dim + 4B scale + 4B offset) vectors=${(int8Bytes / MB).toFixed(1)}MB => saves ${((emb.vb - int8Bytes) / MB).toFixed(1)}MB (${((100 * (emb.vb - int8Bytes)) / emb.vb).toFixed(0)}% of vector payload)`)
      const rows = rdb.prepare('SELECT id, text, document_id FROM chunks').all() as Array<{ id: number; text: string; document_id: number }>
      const seen = new Map<string, number>()
      let dupRows = 0
      let dupTextBytes = 0
      let dupDocsIntra = 0
      for (const r of rows) {
        const h = createHash('sha1').update(normalizeDocumentText(r.text)).digest('hex')
        if (seen.has(h)) {
          dupRows++
          dupTextBytes += r.text.length
          if (seen.get(h) === r.document_id) dupDocsIntra++
        } else seen.set(h, r.document_id)
      }
      const perChunkOverhead = (Number((rdb.prepare("SELECT sum(pgsize) b FROM dbstat WHERE name IN ('chunks','chunk_fts_content','chunk_fts_data','chunk_fts_idx','chunk_fts_docsize')").get() as any).b) +
        embTree) / Math.max(1, rows.length)
      log(`chunks=${rows.length} exact-dup(normalised hash) chunks=${dupRows} (${((100 * dupRows) / rows.length).toFixed(1)}%), intra-doc dup=${dupDocsIntra}, dup text bytes=${(dupTextBytes / MB).toFixed(2)}MB; avg per-chunk stored footprint (chunks+fts+vec)=${perChunkOverhead.toFixed(0)}B => dedup upper bound ~${((dupRows * perChunkOverhead) / MB).toFixed(1)}MB`)
      store.close()
      const t1 = Date.now()
      const off = runOfflineCompaction(dbPath, { enabled: true, minReclaimBytes: 1, minFreelistRatio: 0, force: true, keepBackup: false })
      log(`offline compaction (after incremental vacuum): ${off.status} ${(off.bytesBefore / MB).toFixed(2)}MB -> ${(off.bytesAfter / MB).toFixed(2)}MB in ${Date.now() - t1}ms ${off.error ?? ''}`)
    } finally {
      try { store.close() } catch { /* already closed */ }
      console.log(out.join('\n'))
      if (process.env.STORAGE_OPT_BENCH_OUT) writeFileSync(process.env.STORAGE_OPT_BENCH_OUT, out.join('\n'))
      rmSync(dir, { recursive: true, force: true })
    }
  }, 900_000)
})
