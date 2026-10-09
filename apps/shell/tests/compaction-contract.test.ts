import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'
import { executeCacheRetentionPolicy } from '../src/main/document-memory/runtime/cache-retention-policy'
import { collectStorageAccountingAsync } from '../src/main/document-memory/runtime/storage-accounting-async'

/**
 * Contract of the cache-retention (compaction) policy at ~93% of a small budget, executed against a real
 * SQLite file written through the real store path:
 * - low-importance docs lose vectors first, then oldest normal docs; important docs are never touched
 * - identity (name/path) + chunk text + FTS stay, so name and keyword search keep working
 * - FTS / embeddings / counters stay consistent; hysteresis: a second pass is a no-op
 */
const PROFILE = EMBEDDING_PROFILES.standard

function vec(seed: number): number[] {
  let a = seed >>> 0
  const v: number[] = []
  let n = 0
  for (let i = 0; i < PROFILE.dimensions; i++) {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0
    const x = a / 4294967296 - 0.5
    v.push(x)
    n += x * x
  }
  return v.map((x) => x / Math.sqrt(n))
}

describe('cache retention contract', () => {
  it('evicts low then oldest-normal vectors, keeps identity/text/important, stays consistent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'compaction-contract-'))
    const dbPath = join(dir, 'document-memory.db')
    const store = new DocumentMemoryStore(dbPath, { role: 'worker' })
    try {
      store.ensureEmbeddingSpace(PROFILE)
      const now = Date.now()
      const kinds = ['important', 'low', 'normal', 'normal', 'normal', 'normal'] as const
      const docs: Array<{ idx: number; path: string; kind: (typeof kinds)[number]; mtime: number }> = []
      // Production-like accounting (db + wal + shm, no manual checkpoint): the policy itself truncates the WAL
      // and vacuums the freelist after every batch (compactAfterRetentionBatch), so the measurement is honest and
      // it no longer over-evicts. Only the seeded WAL is flushed once, as the app's own idle checkpoint would.
      const physical = async (): Promise<number> =>
        (await collectStorageAccountingAsync({ dbPath, db: store.rawDb })).totalManagedBytes
      for (let i = 0; i < 60; i++) {
        const kind = kinds[i % kinds.length]!
        const path = resolve(dir, `doc-${i}-${kind}.txt`)
        const mtime = now - (60 - i) * 86_400_000 // higher i = more recent
        const chunks = Array.from({ length: 40 }, (_, c) => ({
          text: `body ${'lorem ipsum dolor '.repeat(20)} zmark${i}q c${c}`,
          location: `Chunk ${c + 1}`,
          vector: vec(i * 1000 + c),
        }))
        store.replaceDocument(path, {
          hash: `h${i}`,
          mtimeMs: mtime,
          sizeBytes: 1000,
          chunks,
          embeddingModel: PROFILE.embeddingId,
          status: 'ready',
        })
        if (kind === 'important') store.setImportanceOverride(path, 'important')
        if (kind === 'low') store.setImportanceOverride(path, 'low')
        docs.push({ idx: i, path, kind, mtime })
      }
      store.rawDb.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      const before = await physical()
      const budget = Math.round(before / 0.93)
      const rep = await executeCacheRetentionPolicy(store.rawDb, dbPath, budget, {
        allowContentEviction: true,
        measurePhysicalBytes: physical,
        onPostCommitAnnInvalidation: (s) => s.forEach((x) => store.invalidateAnnInMemory(x.spaceId)),
      })
      expect(rep.error).toBeUndefined()
      expect(rep.triggered).toBe(true)
      expect(rep.targetReached).toBe(true)
      expect(rep.bytesAfter).toBeLessThanOrEqual(budget * 0.8)
      expect(rep.tier4ImportantDocsPruned).toBe(0)
      expect(rep.contentEvictedDocsCount).toBe(0) // vectors alone were enough

      const db = store.rawDb
      const vecCount = (path: string): number =>
        (
          db
            .prepare(
              'SELECT count(*) AS c FROM chunk_embeddings e JOIN chunks c ON c.id=e.chunk_id JOIN documents d ON d.id=c.document_id WHERE d.path=?',
            )
            .get(path) as { c: number }
        ).c
      // important docs untouched
      for (const d of docs.filter((x) => x.kind === 'important')) expect(vecCount(d.path)).toBe(40)
      // every low doc evicted before any normal doc
      const lowEvicted = docs.filter((x) => x.kind === 'low').every((d) => vecCount(d.path) === 0)
      expect(lowEvicted).toBe(true)
      // evicted normal docs are the oldest ones (LRU): no kept normal doc is older than an evicted one
      const normals = docs.filter((x) => x.kind === 'normal')
      const evictedN = normals.filter((d) => vecCount(d.path) === 0)
      const keptN = normals.filter((d) => vecCount(d.path) > 0)
      expect(evictedN.length).toBeGreaterThan(0)
      expect(Math.max(...evictedN.map((d) => d.mtime))).toBeLessThan(Math.min(...keptN.map((d) => d.mtime)))

      // identity + lexical content survive for every document (nothing lost for keyword/name search)
      for (const d of docs) {
        expect(store.documentByPath(d.path)).not.toBeNull()
        expect(store.searchLexical(`zmark${d.idx}q`, 3).length).toBeGreaterThan(0)
        expect(store.searchNames(`doc-${d.idx}-${d.kind}`, 3).some((h) => h.path === d.path)).toBe(true)
      }

      // consistency
      const one = (sql: string): number => (db.prepare(sql).get() as { c: number }).c
      expect((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
      expect(one('SELECT count(*) AS c FROM chunk_fts WHERE rowid NOT IN (SELECT id FROM chunks)')).toBe(0)
      expect(one('SELECT count(*) AS c FROM chunk_embeddings WHERE chunk_id NOT IN (SELECT id FROM chunks)')).toBe(0)
      expect(
        one(
          'SELECT count(*) AS c FROM documents d WHERE chunk_done <> coalesce((SELECT completed_chunks FROM document_embedding_counts e WHERE e.document_id=d.id AND e.space_id=d.embedding_model),0)',
        ),
      ).toBe(0)
      // ANN is marked dirty exactly once per batch commit and never "ready" with a stale count
      const ann = db.prepare('SELECT state FROM ann_indexes WHERE space_id = ?').get(PROFILE.embeddingId) as {
        state: string
      }
      expect(ann.state).toBe('dirty')

      // hysteresis: below the 90% trigger, a second pass does nothing
      const rep2 = await executeCacheRetentionPolicy(store.rawDb, dbPath, budget, { measurePhysicalBytes: physical })
      expect(rep2.triggered).toBe(false)
      expect(rep2.stoppedReason).toBe('not-triggered')
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
