import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'
import { garbageCollectObsoleteStorage } from '../src/main/document-memory/storage-gc'
import { executeCacheRetentionPolicy } from '../src/main/document-memory/runtime/cache-retention-policy'
import { collectStorageAccountingAsync } from '../src/main/document-memory/runtime/storage-accounting-async'
import { PendingMetadataIntake } from '../src/main/document-memory/runtime/pending-metadata-intake'
import { releaseEvictedVectorsIfRoom } from '../src/main/document-memory/runtime/vector-eviction-release'
import { countVectorEvictions } from '../src/main/document-memory/storage/vector-eviction-marker'
import { storageBudgetAckReply } from './helpers/storage-budget-ack'

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

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'compaction-regress-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Seeds docs x chunksPerDoc real chunks + vectors + (deliberately drifted) counters through raw SQL. */
function seedGcDb(path: string, docs: number, chunksPerDoc: number): DocumentMemoryStore {
  const store = new DocumentMemoryStore(path, { role: 'worker' })
  const db = store.rawDb
  store.ensureEmbeddingSpace(PROFILE)
  const space = PROFILE.embeddingId
  const blob = new Uint8Array(new Float32Array(8).buffer)
  db.exec('BEGIN')
  const insDoc = db.prepare(
    "INSERT INTO documents (id, path, name, status, embedding_model) VALUES (?, ?, ?, 'ready', ?)",
  )
  const insChunk = db.prepare(
    'INSERT INTO chunks (id, document_id, chunk_set_id, ordinal, text, location) VALUES (?, ?, NULL, ?, ?, ?)',
  )
  const insEmb = db.prepare(
    'INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim) VALUES (?, ?, ?, 8)',
  )
  const insCount = db.prepare(
    'INSERT INTO document_embedding_counts (document_id, space_id, completed_chunks) VALUES (?, ?, ?)',
  )
  let chunkId = 1
  for (let d = 1; d <= docs; d++) {
    insDoc.run(d, `/gc/doc-${d}.txt`, `doc-${d}.txt`, space)
    // docs % 7 == 0: no vectors at all but a stale count row; docs % 5 == 0: only half the vectors
    let withVec = 0
    for (let c = 0; c < chunksPerDoc; c++) {
      insChunk.run(chunkId, d, c, `t${d}-${c}`, `Chunk ${c + 1}`)
      const hasVec = d % 7 !== 0 && (d % 5 !== 0 || c % 2 === 0)
      if (hasVec) {
        insEmb.run(chunkId, space, blob)
        withVec++
      }
      chunkId++
    }
    if (d % 7 === 0)
      insCount.run(d, space, 3) // stale: must be deleted
    else if (d % 3 === 0)
      insCount.run(d, space, withVec + 11) // drifted: must be recounted
    else if (d % 11 !== 0) insCount.run(d, space, withVec) // exact; d % 11 == 0 has none: must be inserted? (no: only recount)
  }
  db.exec('COMMIT')
  return store
}

const OLD_COUNT_SQL = `
  DELETE FROM document_embedding_counts
  WHERE NOT EXISTS (
    SELECT 1 FROM chunk_embeddings ce
    JOIN chunks c ON c.id = ce.chunk_id
    WHERE c.document_id = document_embedding_counts.document_id
      AND ce.space_id = document_embedding_counts.space_id
  );
  UPDATE document_embedding_counts
  SET completed_chunks = (
    SELECT count(ce.chunk_id)
    FROM chunk_embeddings ce
    JOIN chunks c ON c.id = ce.chunk_id
    WHERE c.document_id = document_embedding_counts.document_id
      AND ce.space_id = document_embedding_counts.space_id
  );
  UPDATE documents
  SET chunk_total = (SELECT count(*) FROM chunks c WHERE c.document_id = documents.id),
      chunk_done = coalesce(
        (SELECT completed_chunks FROM document_embedding_counts ec
         WHERE ec.document_id = documents.id AND ec.space_id = documents.embedding_model),
        0
      );
`

describe('D2: storage GC count recompute (join order)', () => {
  it('produces exactly the old SQL result, uses the chunks index and is not O(docs x vectors)', () => {
    const a = seedGcDb(join(dir, 'a.db'), 220, 36)
    const b = seedGcDb(join(dir, 'b.db'), 220, 36)
    try {
      const t0 = performance.now()
      a.rawDb.exec(OLD_COUNT_SQL)
      const oldMs = performance.now() - t0
      const t1 = performance.now()
      garbageCollectObsoleteStorage(b.rawDb)
      const newMs = performance.now() - t1
      console.info(
        `[D2] old SQL ${oldMs.toFixed(0)} ms, new GC ${newMs.toFixed(0)} ms (220 docs / 7920 chunks)`,
      )

      const snap = (s: DocumentMemoryStore): unknown => ({
        counts: s.rawDb
          .prepare(
            'SELECT document_id, space_id, completed_chunks FROM document_embedding_counts ORDER BY 1, 2',
          )
          .all(),
        docs: s.rawDb
          .prepare('SELECT id, chunk_total, chunk_done FROM documents ORDER BY id')
          .all(),
      })
      const expected = snap(a)
      expect(snap(b)).toEqual(expected)
      // sanity: the seed really exercised delete + recount paths
      const counts = (expected as { counts: Array<{ document_id: number }> }).counts
      expect(counts.some((r) => r.document_id % 7 === 0)).toBe(false)
      expect(counts.length).toBeGreaterThan(100)

      expect(newMs).toBeLessThan(1_500)
      expect(newMs).toBeLessThan(oldMs + 250) // never slower than the old statement
    } finally {
      a.close()
      b.close()
    }
  }, 60_000)

  it('plans the count statements as chunks_document_id + primary key probe, never chunk_embeddings_space scans', () => {
    const s = seedGcDb(join(dir, 'p.db'), 30, 10)
    try {
      const plan = (sql: string): string =>
        (s.rawDb.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
          .map((r) => r.detail)
          .join('\n')
      const del = plan(`DELETE FROM document_embedding_counts WHERE NOT EXISTS (
        SELECT 1 FROM chunks c CROSS JOIN chunk_embeddings ce ON ce.chunk_id = c.id
        WHERE c.document_id = document_embedding_counts.document_id AND ce.space_id = document_embedding_counts.space_id)`)
      const upd = plan(`UPDATE document_embedding_counts SET completed_chunks = (
        SELECT count(ce.chunk_id) FROM chunks c CROSS JOIN chunk_embeddings ce ON ce.chunk_id = c.id
        WHERE c.document_id = document_embedding_counts.document_id AND ce.space_id = document_embedding_counts.space_id)`)
      for (const p of [del, upd]) {
        expect(p).toContain('chunks_document_id')
        expect(p).not.toContain('chunk_embeddings_space')
      }
    } finally {
      s.close()
    }
  })
})

/** Real documents with real vectors, then the real retention policy at ~93% of the budget. */
async function seedAndEvict(dbPath: string): Promise<{
  store: DocumentMemoryStore
  paths: string[]
  evicted: string[]
  budget: number
  physical: () => Promise<number>
}> {
  const store = new DocumentMemoryStore(dbPath, { role: 'worker' })
  store.ensureEmbeddingSpace(PROFILE)
  const now = Date.now()
  const paths: string[] = []
  for (let i = 0; i < 40; i++) {
    const path = resolve(dir, `doc-${i}.txt`)
    paths.push(path)
    store.replaceDocument(path, {
      hash: `h${i}`,
      mtimeMs: now - (40 - i) * 86_400_000,
      sizeBytes: 1000,
      chunks: Array.from({ length: 30 }, (_, c) => ({
        text: `body ${'lorem ipsum dolor '.repeat(20)} zmark${i}q c${c}`,
        location: `Chunk ${c + 1}`,
        vector: vec(i * 1000 + c),
      })),
      embeddingModel: PROFILE.embeddingId,
      status: 'ready',
    })
  }
  store.rawDb.exec('PRAGMA wal_checkpoint(TRUNCATE)') // start from a clean file; the policy must keep it honest itself
  // production-like measurement: NO manual checkpoint, the policy itself must make usage reflect reality
  const physical = async (): Promise<number> =>
    (await collectStorageAccountingAsync({ dbPath, db: store.rawDb })).totalManagedBytes
  const before = await physical()
  const budget = Math.round(before / 0.93)
  const rep = await executeCacheRetentionPolicy(store.rawDb, dbPath, budget, {
    allowContentEviction: true,
    measurePhysicalBytes: physical,
  })
  expect(rep.error).toBeUndefined()
  expect(rep.triggered).toBe(true)
  expect(rep.targetReached).toBe(true)
  expect(rep.contentEvictedDocsCount).toBe(0)
  const evicted = paths.filter((p) => store.documentByPath(p)?.status === 'text-only')
  return { store, paths, evicted, budget, physical }
}

const embeddingCount = (s: DocumentMemoryStore): number =>
  (s.rawDb.prepare('SELECT count(*) AS c FROM chunk_embeddings').get() as { c: number }).c

describe('D4: retention compaction keeps the measurement honest', () => {
  it('truncates the WAL and reclaims the freelist so usage is not over-estimated', async () => {
    const { store, budget, physical, evicted } = await seedAndEvict(join(dir, 'document-memory.db'))
    try {
      expect(evicted.length).toBeGreaterThan(0)
      const wal = join(dir, 'document-memory.db-wal')
      expect(!existsSync(wal) || statSync(wal).size === 0).toBe(true)
      const free = store.rawDb.prepare('PRAGMA freelist_count').get() as { freelist_count: number }
      expect(free.freelist_count).toBe(0)
      expect(await physical()).toBeLessThanOrEqual(budget * 0.8)
    } finally {
      store.close()
    }
  }, 60_000)
})

describe('D1: evicted vectors are not re-embedded (evict -> re-embed thrash)', () => {
  it('keeps evicted docs out of incompletePaths / poll / budget callbacks until released', async () => {
    const dbPath = join(dir, 'document-memory.db')
    const { store, evicted, budget } = await seedAndEvict(dbPath)
    const vectorsAfterEviction = embeddingCount(store)
    expect(evicted.length).toBeGreaterThan(0)
    expect(countVectorEvictions(store.rawDb)).toBe(evicted.length)
    expect(store.incompletePaths()).toEqual([])

    // "before": without the marker (old behaviour) every evicted document is queued again
    const markers = store.rawDb
      .prepare('SELECT document_id, evicted_at, hash FROM document_vector_evictions')
      .all() as Array<{
      document_id: number
      evicted_at: number
      hash: string
    }>
    store.rawDb.exec('DELETE FROM document_vector_evictions')
    const oldBehaviour = store.incompletePaths().length
    expect(oldBehaviour).toBe(evicted.length)
    const put = store.rawDb.prepare(
      'INSERT INTO document_vector_evictions (document_id, evicted_at, hash) VALUES (?, ?, ?)',
    )
    for (const m of markers) put.run(m.document_id, m.evicted_at, m.hash)
    console.info(
      `[D1] evicted docs: ${evicted.length}; re-queued by poll before fix: ${oldBehaviour}, after fix: ${store.incompletePaths().length}`,
    )
    store.close()

    // real manager (search role) + hand-written worker: poll() and the budget-state callback must queue nothing
    const requests: Array<{ type: string; path?: string }> = []
    const worker = new (class extends EventEmitter {
      postMessage(message: { id: number; type: string; path?: string }): void {
        const ack = storageBudgetAckReply(message)
        if (ack) return void queueMicrotask(() => this.emit('message', ack))
        requests.push(message)
        queueMicrotask(() =>
          this.emit('message', { id: message.id, error: 'not available in test' }),
        )
      }
      terminate(): Promise<number> {
        return Promise.resolve(0)
      }
    })()
    const manager = new DocumentMemoryManager(dir, {
      workerFactory: () => worker as any,
      pollIntervalMs: 600_000,
      initialEnabled: true,
      budget: { maxDatabaseBytes: budget, version: 1 } as any,
    } as any)
    try {
      const internal = manager as any
      await internal.poll()
      internal.maintScheduler.options.onBudgetStateChange(
        'ok',
        internal.maintScheduler.checkStorageBudget(),
      )
      await new Promise((r) => setTimeout(r, 300))
      expect(requests.filter((r) => r.type === 'extract')).toEqual([])
      expect(internal.queued.size).toBe(0)
      const check = new DocumentMemoryStore(dbPath, { role: 'search' })
      try {
        expect(embeddingCount(check)).toBe(vectorsAfterEviction)
      } finally {
        check.close()
      }
    } finally {
      await manager.closeAsync()
    }
  }, 60_000)

  it('re-embeds an evicted doc only after open / explicit retry, a content change, a release or new vectors', async () => {
    const dbPath = join(dir, 'document-memory.db')
    const { store, evicted, budget } = await seedAndEvict(dbPath)
    try {
      expect(evicted.length).toBeGreaterThanOrEqual(5)
      const [opened, retried, changed, released] = evicted as [
        string,
        string,
        string,
        string,
        string,
      ]

      // user opens it (last_opened_at moves past the eviction) -> eligible again
      store.remember(opened)
      expect(store.incompletePaths()).toContain(opened)

      // explicit retry / read-now by id clears the marker
      store.retryDocument(store.documentByPath(retried)!.id)
      expect(store.incompletePaths()).toContain(retried)

      // the file content changed -> new hash -> normal indexing rules apply
      store.rawDb.prepare('UPDATE documents SET hash = ? WHERE path = ?').run('new-hash', changed)
      expect(store.incompletePaths()).toContain(changed)

      // others stay excluded
      expect(store.incompletePaths()).not.toContain(released)

      // release rule: nothing while warning/full or above 60%, never beyond the projected 75%
      const base = {
        limitState: 'ok',
        budgetBytes: budget,
        isDegraded: false,
        measurementStatus: 'fresh',
      }
      expect(
        releaseEvictedVectorsIfRoom(store.rawDb, { ...base, usedBytes: budget * 0.7 }).documents,
      ).toBe(0)
      expect(
        releaseEvictedVectorsIfRoom(store.rawDb, {
          ...base,
          limitState: 'warning',
          usedBytes: budget * 0.1,
        }).documents,
      ).toBe(0)
      expect(
        releaseEvictedVectorsIfRoom(store.rawDb, {
          ...base,
          usedBytes: budget * 0.1,
          isDegraded: true,
        }).documents,
      ).toBe(0)
      const near = releaseEvictedVectorsIfRoom(store.rawDb, { ...base, usedBytes: budget * 0.59 })
      expect(near.chunks * 4608 + budget * 0.59).toBeLessThanOrEqual(budget * 0.75)
      const ok = releaseEvictedVectorsIfRoom(store.rawDb, { ...base, usedBytes: budget * 0.1 })
      expect(ok.documents).toBeGreaterThan(0)
      // bounded per call; repeated cycles drain the rest
      for (
        let i = 0;
        i < 10 &&
        releaseEvictedVectorsIfRoom(store.rawDb, { ...base, usedBytes: budget * 0.1 }).documents >
          0;
        i++
      );
      expect(countVectorEvictions(store.rawDb)).toBe(0)
      expect(store.incompletePaths()).toContain(released)
    } finally {
      store.close()
    }
  }, 60_000)

  it('clears the marker when vectors are re-created', async () => {
    const dbPath = join(dir, 'document-memory.db')
    const { store, evicted } = await seedAndEvict(dbPath)
    try {
      const path = evicted[0]!
      const before = countVectorEvictions(store.rawDb)
      const doc = store.documentByPath(path)!
      const chunk = store.rawDb
        .prepare('SELECT id FROM chunks WHERE document_id = ? LIMIT 1')
        .get(doc.id) as { id: number }
      store.rawDb
        .prepare(
          'INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim) VALUES (?, ?, ?, 8)',
        )
        .run(chunk.id, PROFILE.embeddingId, new Uint8Array(new Float32Array(8).buffer))
      expect(countVectorEvictions(store.rawDb)).toBe(before - 1)
    } finally {
      store.close()
    }
  }, 60_000)
})

describe('D3: replay retry when leaving full', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function intake(diskReady: () => boolean) {
    const remembered = vi.fn(() => ({ outcome: 'admitted' as const }))
    const q = new PendingMetadataIntake({
      isWriteReady: () => true,
      isAccountingReady: () => true,
      isFreeDiskReady: diskReady,
      isStopped: () => false,
      isEnabled: () => true,
      onRemember: remembered,
      onDiscovered: () => ({ outcome: 'enrolled' as const }),
    })
    return { q, remembered }
  }

  it('retries with backoff until the stale free-disk measurement refreshed, then drains', async () => {
    let calls = 0
    const { q, remembered } = intake(() => ++calls > 8) // stale for the first 8 readiness checks (more than the old 3 disk retries)
    const path = join(dir, 'queued-while-full.txt')
    q.enqueue(path, 'remember')
    await q.triggerReplay() // the single "leaving full" trigger
    expect(remembered).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(remembered).toHaveBeenCalledExactlyOnceWith(path)
    expect(q.size).toBe(0)
    q.close()
  })

  it('stays bounded when the disk never becomes ready', async () => {
    let calls = 0
    const { q, remembered } = intake(() => {
      calls++
      return false
    })
    q.enqueue(join(dir, 'never.txt'), 'remember')
    await q.triggerReplay()
    await vi.advanceTimersByTimeAsync(60_000)
    const settled = calls
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toBe(settled)
    expect(remembered).not.toHaveBeenCalled()
    expect(q.size).toBe(1)
    q.close()
  })
})
