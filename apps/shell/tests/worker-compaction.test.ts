import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import {
  cancelCompaction,
  handleCompactionRequest,
  isCompactionActive,
  resetCompactionLaneForTests,
} from '../src/main/document-memory/runtime/worker-compaction'
import type {
  FreeSpaceWorkerResult,
  OptimizeFtsWorkerResult,
  RetentionWorkerResult,
} from '../src/main/document-memory/runtime/worker-compaction-types'
import { createStorageBudget, hardCapBytes } from '../src/main/document-memory/storage-budget'
import {
  DAY,
  budgetForRatio,
  chunkCount,
  laneContext,
  physicalBytes,
  seedDocuments,
  vectorCount,
  type SeedDoc,
} from './helpers/compaction-fixtures'

/**
 * The storage-compaction lane that runs inside the indexing worker (worker-compaction.ts), driven in-process against
 * a real SQLite file written through the real store path. Budgets are policy-level (below the 500 MB product minimum)
 * because the lane takes the budget from its context; the production handshake enforces the minimum.
 */
let dir: string
let store: DocumentMemoryStore

beforeEach(() => {
  resetCompactionLaneForTests()
  dir = mkdtempSync(join(tmpdir(), 'worker-compaction-'))
  store = new DocumentMemoryStore(join(dir, 'document-memory.db'), { role: 'worker' })
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

/** 16 archive (400 d), 24 recent (100 d), 14 fresh (3 d) normal docs, 4 low, 6 important. */
function mixedLibrary(): SeedDoc[] {
  const docs: SeedDoc[] = []
  for (let i = 0; i < 16; i++) docs.push({ name: `archive-${i}.txt`, ageDays: 400 + i })
  for (let i = 0; i < 24; i++) docs.push({ name: `recent-${i}.txt`, ageDays: 100 + i })
  for (let i = 0; i < 14; i++) docs.push({ name: `fresh-${i}.txt`, ageDays: 3 + (i % 5) })
  for (let i = 0; i < 4; i++) docs.push({ name: `low-${i}.txt`, kind: 'low', ageDays: 200 + i })
  for (let i = 0; i < 6; i++) docs.push({ name: `important-${i}.txt`, kind: 'important', ageDays: 500 + i })
  return docs
}

const retention = (urgency: 'none' | 'normal' | 'urgent', extra: Record<string, unknown> = {}) =>
  ({ type: 'run-retention', runId: `r-${Math.random().toString(36).slice(2)}`, configVersion: 1, urgency, ...extra }) as const

describe('worker compaction lane: retention', () => {
  it('(a) at 93% brings the index to <= 80% in the worker lane; archive first, fresh and important untouched', async () => {
    const docs = seedDocuments(store, dir, mixedLibrary())
    const budget = budgetForRatio(store, 0.93)
    const before = physicalBytes(store)
    const res = (await handleCompactionRequest(
      laneContext(store, budget),
      retention('normal', { usage: { usedBytes: before, limitState: 'warning', isDegraded: false, measurementStatus: 'fresh' } }),
    )) as RetentionWorkerResult

    expect(res.kind).toBe('run-retention')
    expect(res.status).toBe('completed')
    expect(res.report?.error).toBeUndefined()
    expect(res.report?.triggered).toBe(true)
    expect(res.report?.targetReached).toBe(true)
    expect(res.bytesAfter).toBeLessThanOrEqual(budget.maxDatabaseBytes * 0.8)
    expect(physicalBytes(store)).toBeLessThanOrEqual(budget.maxDatabaseBytes * 0.8)
    expect(res.belowSoftQuota).toBe(true)

    const of = (prefix: string) => docs.filter((d) => d.name.startsWith(prefix))
    // protected and fresh documents keep every vector; the archive tier went first
    for (const d of of('important')) expect(vectorCount(store, d.path)).toBe(d.chunks)
    for (const d of of('fresh')) expect(vectorCount(store, d.path)).toBe(d.chunks)
    const archiveEvicted = of('archive').filter((d) => vectorCount(store, d.path) === 0).length
    expect(archiveEvicted).toBe(16)
    // every document keeps its identity; documents newer than the archive threshold also keep their text
    for (const d of docs) {
      expect(store.documentByPath(d.path)).not.toBeNull()
      if (!d.name.startsWith('archive')) expect(chunkCount(store, d.path)).toBeGreaterThan(0)
    }
    // recent (100-day-old) documents were only reached after the whole archive tier, and keep most of their vectors
    expect(of('recent').filter((d) => vectorCount(store, d.path) > 0).length).toBeGreaterThan(0)
    // the report carries the age buckets and the per-stage counters
    expect(res.report?.age?.buckets.archive.documents).toBe(16)
    expect(res.report?.age?.buckets.fresh.documents).toBe(14)
    expect(res.report?.age?.buckets.protectedDocuments).toBe(6)
    expect(res.report?.age?.archiveVectorDocsPruned).toBeGreaterThan(0)
    expect(res.report?.age?.freshVectorDocsPruned).toBe(0)
    // the JSON report survives the process boundary unchanged
    expect(JSON.parse(JSON.stringify(res))).toEqual(res)
    // ANN follow-up is produced (metadata only) for the compacted embedding space
    expect(res.affectedAnnSpaces.length).toBeGreaterThan(0)
    expect(isCompactionActive()).toBe(false)
  }, 60_000)

  it('(b) an urgent run in the grace zone also drops the vectors of fresh documents as the last resort; a normal run never does', async () => {
    // only fresh normal documents exist: nothing but the last resort can reclaim anything
    seedDocuments(store, dir, Array.from({ length: 30 }, (_, i) => ({ name: `new-${i}.txt`, ageDays: 2 + (i % 6) })))
    const budget = budgetForRatio(store, 1.05)
    const usage = { usedBytes: physicalBytes(store), limitState: 'warning', isDegraded: false, measurementStatus: 'fresh' }

    const calm = (await handleCompactionRequest(laneContext(store, budget), retention('normal', { usage }))) as RetentionWorkerResult
    expect(calm.report?.age?.freshVectorDocsPruned).toBe(0)
    expect(calm.bytesAfter).toBeGreaterThan(budget.maxDatabaseBytes * 0.8)

    const urgent = (await handleCompactionRequest(laneContext(store, budget), retention('urgent', { usage }))) as RetentionWorkerResult
    expect(urgent.status).toBe('completed')
    expect(urgent.report?.age?.freshVectorDocsPruned).toBeGreaterThan(0)
    expect(urgent.bytesAfter).toBeLessThan(budget.maxDatabaseBytes) // the grace zone is over
    expect(urgent.belowSoftQuota).toBe(true)
    // text (lexical search) is never touched by the last resort
    expect((store.rawDb.prepare('SELECT count(*) AS c FROM chunks').get() as { c: number }).c).toBe(300)
    expect((store.rawDb.prepare('SELECT count(*) AS c FROM chunk_fts').get() as { c: number }).c).toBe(300)
    expect(
      (store.rawDb.prepare('SELECT count(*) AS c FROM documents WHERE content_evicted = 1').get() as { c: number }).c,
    ).toBe(0)
  }, 60_000)

  it('(e) age policy: year-old documents (big or small) are compacted before week-old ones; fresh and important are protected', async () => {
    const docs = seedDocuments(store, dir, [
      { name: 'old-big.txt', ageDays: 420, chunks: 40, words: 200 },
      { name: 'new-small.txt', ageDays: 7, chunks: 4, words: 60 },
      { name: 'old-small.txt', ageDays: 430, chunks: 4, words: 60 },
      { name: 'new-big.txt', ageDays: 6, chunks: 40, words: 200 },
      { name: 'keep-important.txt', kind: 'important', ageDays: 900, chunks: 10 },
    ])
    const by = (n: string) => docs.find((d) => d.name === n)!
    const budget = budgetForRatio(store, 0.96)
    const res = (await handleCompactionRequest(laneContext(store, budget), {
      type: 'free-space',
      runId: 'fs1',
      configVersion: 1,
      neededBytes: 100_000,
      incomingImportance: 'normal',
    })) as FreeSpaceWorkerResult
    expect(res.status).toBe('completed')
    expect(res.freedBytes).toBeGreaterThanOrEqual(100_000)
    // both year-old documents went first, whatever their size; the week-old ones (even the big one) and the important
    // document keep every vector
    expect(vectorCount(store, by('old-big.txt').path)).toBe(0)
    expect(vectorCount(store, by('old-small.txt').path)).toBe(0)
    expect(vectorCount(store, by('new-small.txt').path)).toBe(4)
    expect(vectorCount(store, by('new-big.txt').path)).toBe(40)
    expect(vectorCount(store, by('keep-important.txt').path)).toBe(10)
    expect(res.agedStage?.age?.archiveVectorDocsPruned).toBe(2)
    expect(res.agedStage?.age?.freshVectorDocsPruned).toBe(0)
  }, 60_000)

  it('release hooks run in the lane when usage is far below the quota (marker released, documents become work again)', async () => {
    const docs = seedDocuments(store, dir, [
      ...Array.from({ length: 6 }, (_, i) => ({ name: `a-${i}.txt`, ageDays: 400 + i })),
      { name: 'keep.txt', kind: 'important' as const, ageDays: 400, vectors: false },
    ])
    const tight = budgetForRatio(store, 0.91)
    const evict = (await handleCompactionRequest(laneContext(store, tight), retention('normal'))) as RetentionWorkerResult
    expect(evict.report?.age?.archiveContentDocsPruned).toBe(0) // vectors were enough
    expect(vectorCount(store, docs[0]!.path)).toBe(0)
    expect(store.incompletePaths()).not.toContain(docs[0]!.path) // marked: poll() does not re-embed it
    // quota raised 12x: usage ~8% -> the marker is released and the documents become work again
    const roomy = createStorageBudget({ maxDatabaseBytes: tight.maxDatabaseBytes * 12, version: 1 })
    const res = (await handleCompactionRequest(laneContext(store, roomy), retention('none', {
      usage: { usedBytes: physicalBytes(store), limitState: 'ok', isDegraded: false, measurementStatus: 'fresh' },
    }))) as RetentionWorkerResult
    expect(res.status).toBe('completed')
    expect(res.release.vectorDocuments).toBeGreaterThan(0)
    expect(store.incompletePaths()).toContain(docs[0]!.path)
    // a degraded measurement never releases anything
    const again = (await handleCompactionRequest(laneContext(store, roomy), retention('none', {
      usage: { usedBytes: 1, limitState: 'ok', isDegraded: true, measurementStatus: 'degraded' },
    }))) as RetentionWorkerResult
    expect(again.release.vectorDocuments).toBe(0)
  }, 60_000)
})

describe('worker compaction lane: admission by displacement', () => {
  it('(c) frees room for a new important document at 108% from old content only', async () => {
    const docs = seedDocuments(store, dir, [
      ...Array.from({ length: 12 }, (_, i) => ({ name: `old-${i}.txt`, ageDays: 500 + i, chunks: 12 })),
      ...Array.from({ length: 12 }, (_, i) => ({ name: `mid-${i}.txt`, ageDays: 90 + i, chunks: 12 })),
      ...Array.from({ length: 6 }, (_, i) => ({ name: `fresh-${i}.txt`, ageDays: 2, chunks: 12 })),
      { name: 'cccd.txt', kind: 'important' as const, ageDays: 800, chunks: 12 },
    ])
    const budget = budgetForRatio(store, 1.08)
    const hard = hardCapBytes(budget)
    const used = physicalBytes(store)
    expect(used).toBeLessThan(hard)
    const needed = Math.round(budget.maxDatabaseBytes * 0.04) // the newcomer needs 4% of the quota
    const res = (await handleCompactionRequest(laneContext(store, budget), {
      type: 'free-space', runId: 'c1', configVersion: 1, neededBytes: needed, incomingImportance: 'important',
    })) as FreeSpaceWorkerResult
    expect(res.status).toBe('completed')
    expect(res.freedBytes).toBeGreaterThanOrEqual(needed)
    expect(res.usedAfter).toBeLessThan(used)
    expect(res.fitsHardCap).toBe(true)
    // the displaced content is old; fresh documents and the important one keep everything
    for (const d of docs.filter((x) => x.name.startsWith('fresh') || x.name === 'cccd.txt')) {
      expect(vectorCount(store, d.path)).toBe(d.chunks)
    }
    expect(docs.filter((d) => d.name.startsWith('old')).some((d) => vectorCount(store, d.path) === 0)).toBe(true)
    expect(physicalBytes(store)).toBeLessThanOrEqual(hard)
  }, 60_000)

  it('(d) nothing evictable (only important documents): the displacement frees nothing -> admission may refuse', async () => {
    seedDocuments(store, dir, Array.from({ length: 10 }, (_, i) => ({ name: `imp-${i}.txt`, kind: 'important' as const, ageDays: 400, chunks: 10 })))
    const budget = budgetForRatio(store, 1.09)
    const res = (await handleCompactionRequest(laneContext(store, budget), {
      type: 'free-space', runId: 'd1', configVersion: 1, neededBytes: 100_000, incomingImportance: 'important',
    })) as FreeSpaceWorkerResult
    expect(res.freedBytes).toBe(0)
    expect(res.fitsHardCap).toBe(false)
    expect(
      (store.rawDb.prepare('SELECT count(*) AS c FROM chunk_embeddings').get() as { c: number }).c,
    ).toBe(100)
  }, 60_000)

  it('a newcomer may still displace the VECTORS of fresh normal documents (never their text) when nothing older exists', async () => {
    const docs = seedDocuments(store, dir, Array.from({ length: 12 }, (_, i) => ({ name: `f-${i}.txt`, ageDays: 1 + i, chunks: 12 })))
    const budget = budgetForRatio(store, 1.08)
    const res = (await handleCompactionRequest(laneContext(store, budget), {
      type: 'free-space', runId: 'e1', configVersion: 1, neededBytes: Math.round(budget.maxDatabaseBytes * 0.03), incomingImportance: 'normal',
    })) as FreeSpaceWorkerResult
    expect(res.freedBytes).toBeGreaterThan(0)
    // oldest fresh first
    expect(vectorCount(store, docs[11]!.path)).toBe(0)
    for (const d of docs) expect(chunkCount(store, d.path)).toBe(12)
    // ...but a LOW newcomer never displaces fresh normal content
    const low = (await handleCompactionRequest(laneContext(store, budget), {
      type: 'free-space', runId: 'e2', configVersion: 1, neededBytes: Math.round(budget.maxDatabaseBytes * 0.03), incomingImportance: 'low',
    })) as FreeSpaceWorkerResult
    expect(low.freedBytes).toBe(0)
  }, 60_000)
})

describe('worker compaction lane: protocol safety', () => {
  it('single flight: a second request answers busy; cancel stops the run; the lane is free afterwards', async () => {
    seedDocuments(store, dir, Array.from({ length: 40 }, (_, i) => ({ name: `d-${i}.txt`, ageDays: 400 + i })))
    const budget = budgetForRatio(store, 0.95)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const slowCtx = { ...laneContext(store, budget), yieldNow: async () => { await gate } }
    const first = handleCompactionRequest(slowCtx, retention('normal', { runId: 'slow' }))
    await new Promise((r) => setImmediate(r))
    expect(isCompactionActive()).toBe(true)
    const second = (await handleCompactionRequest(laneContext(store, budget), retention('normal'))) as RetentionWorkerResult
    expect(second.status).toBe('busy')
    expect(cancelCompaction('other-run')).toBe(false)
    expect(cancelCompaction('slow')).toBe(true)
    release()
    const done = (await first) as RetentionWorkerResult
    expect(done.status).toBe('cancelled')
    expect(done.report?.stoppedReason).toBe('cancelled')
    expect(isCompactionActive()).toBe(false)
    // out-of-band cancel message
    expect(await handleCompactionRequest(laneContext(store, budget), { type: 'cancel-compaction', runId: 'x' })).toEqual({ cancelled: false })
  }, 60_000)

  it('budget handshake gate: a request for another config version is refused (stale-config) and writes nothing', async () => {
    const docs = seedDocuments(store, dir, [{ name: 'a.txt', ageDays: 400 }])
    const budget = budgetForRatio(store, 0.95)
    const res = (await handleCompactionRequest(laneContext(store, budget, 4), retention('normal', { configVersion: 3, force: true }))) as RetentionWorkerResult
    expect(res.status).toBe('stale-config')
    expect(res.report).toBeNull()
    expect(vectorCount(store, docs[0]!.path)).toBe(docs[0]!.chunks)
    // before the first handshake (version null) nothing runs either
    const none = (await handleCompactionRequest(laneContext(store, budget, null), retention('normal', { force: true }))) as RetentionWorkerResult
    expect(none.status).toBe('stale-config')
    // a budget version change DURING a run stops it
    let version = 1
    const ctx = { ...laneContext(store, budget), getConfigVersion: () => version, yieldNow: async () => { version = 2 } }
    const changed = (await handleCompactionRequest(ctx, retention('normal', { force: true }))) as RetentionWorkerResult
    expect(changed.status).toBe('cancelled')
  }, 60_000)

  it('optimize-fts composes with the store merge step and reports through JSON', async () => {
    seedDocuments(store, dir, Array.from({ length: 8 }, (_, i) => ({ name: `f-${i}.txt`, ageDays: 5 })))
    const calls: number[] = []
    const orig = store.mergeFtsStep.bind(store)
    store.mergeFtsStep = (pages?: number) => {
      calls.push(pages ?? 0)
      return orig(pages)
    }
    const res = (await handleCompactionRequest(laneContext(store, createStorageBudget({ maxDatabaseBytes: 10_000_000_000, version: 1 })), {
      type: 'optimize-fts', runId: 'o1', configVersion: 1, maxPages: 64, budgetMs: 2000,
    })) as OptimizeFtsWorkerResult
    expect(res.status).toBe('completed')
    expect(calls.length).toBeGreaterThan(0)
    expect(JSON.parse(JSON.stringify(res)).result.tables.length).toBeGreaterThan(0)
  }, 60_000)

  it('age policy is overridable through the budget object', async () => {
    const docs = seedDocuments(store, dir, [{ name: 'six-months.txt', ageDays: 200 }, { name: 'one-week.txt', ageDays: 7 }])
    // archive after 3 months instead of 12: the 200-day-old document is an archive document and goes first
    const budget = budgetForRatio(store, 0.95, { archiveAfterMonths: 3 })
    const res = (await handleCompactionRequest(laneContext(store, budget), retention('normal', { force: true }))) as RetentionWorkerResult
    expect(res.report?.age?.buckets.archive.documents).toBe(1)
    expect(res.report?.age?.archiveAfterDays ?? res.report?.age?.buckets.archiveAfterDays).toBeLessThan(100)
    expect(vectorCount(store, docs[0]!.path)).toBe(0)
  }, 60_000)
})

void DAY
