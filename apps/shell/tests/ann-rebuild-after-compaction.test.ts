import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { CacheRetentionRepository } from '../src/main/document-memory/storage/repositories/cache-retention-repository'
import {
  dispatchAnnRebuildRequests,
  scheduleAnnRebuildAfterCompaction,
  type AnnDispatchContext,
} from '../src/main/document-memory/runtime/ann-rebuild-after-compaction'
import { validateAnnPreauthorizedPermit } from '../src/main/document-memory/ann-index'
import { AnnAdmissionTestFixture } from './helpers/ann-admission-fixture'
import { SEED_PROFILE, seedCorpus } from './helpers/storage-optimizer-seed'

/**
 * Metadata / generation / permit contract of the ANN follow-up of a retention run.
 *
 * NOT covered (usearch is not loaded under vitest): building a real ANN file, the worker round trip and the
 * host StorageAdmissionController wiring of AnnHostAdmissionCoordinator.dispatchAnnRebuild (needs a full
 * MaintenanceScheduler); those are covered by the existing ann-* / ann-host-admission suites. Here the
 * dispatcher is exercised with an injected dispatch function and the permit is built with the real fixture.
 */
describe('scheduleAnnRebuildAfterCompaction', () => {
  let dir: string
  let store: DocumentMemoryStore
  let repo: CacheRetentionRepository
  const space = SEED_PROFILE.embeddingId

  const annRow = () =>
    store.rawDb
      .prepare('SELECT generation, desired_generation, state, file_path, indexed_count FROM ann_indexes WHERE space_id = ?')
      .get(space) as { generation: number; desired_generation: number; state: string; file_path: string | null; indexed_count: number } | undefined
  const docIds = (): number[] =>
    (store.rawDb.prepare('SELECT id FROM documents ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ann-after-compaction-'))
    store = new DocumentMemoryStore(join(dir, 'document-memory.db'), { role: 'worker' })
    seedCorpus(store, dir, { targetLogicalMb: 0.15, chunksPerDoc: 6, duplicateDocFraction: 0, boilerplateChunksPerDoc: 0 })
    repo = new CacheRetentionRepository(store.rawDb)
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not bump the generation again when the retention batch already marked the space dirty', () => {
    const ids = docIds()
    const batch = repo.evictEmbeddingsBatch(ids.slice(0, 3))
    expect(batch.affectedSpaces).toHaveLength(1)
    const afterBatch = annRow()!
    expect(afterBatch.desired_generation).toBe(batch.affectedSpaces[0]!.desiredGeneration)
    expect(afterBatch.state).toBe('dirty')

    for (let i = 0; i < 3; i++) {
      const res = scheduleAnnRebuildAfterCompaction(store, batch.affectedSpaces, { minVectors: 1 })
      expect(res.markedDirty).toEqual([])
      expect(res.alreadyDirty).toEqual([space])
      expect(res.requests).toHaveLength(1)
      expect(res.requests[0]).toMatchObject({
        spaceId: space,
        dimensions: SEED_PROFILE.dimensions,
        targetGeneration: afterBatch.desired_generation,
        clearsStaleIndex: false,
      })
      expect(res.requests[0]!.vectorCount).toBe(store.getAnnCanonicalMeta(space).canonicalCount)
      expect(res.requests[0]!.estimatedBytes).toBeGreaterThan(0)
      expect(annRow()!.desired_generation).toBe(afterBatch.desired_generation)
    }
  })

  it('marks dirty exactly once when the row is missing or behind, and is idempotent on retry', () => {
    const batch = repo.evictEmbeddingsBatch(docIds().slice(0, 2))
    const reported = batch.affectedSpaces[0]!.desiredGeneration
    store.rawDb.prepare('DELETE FROM ann_indexes WHERE space_id = ?').run(space)

    const first = scheduleAnnRebuildAfterCompaction(store, batch.affectedSpaces, { minVectors: 1 })
    expect(first.markedDirty).toEqual([space])
    expect(annRow()).toMatchObject({ desired_generation: reported, state: 'dirty', generation: 0 })
    const second = scheduleAnnRebuildAfterCompaction(store, batch.affectedSpaces, { minVectors: 1 })
    expect(second.markedDirty).toEqual([])
    expect(annRow()!.desired_generation).toBe(reported)

    // behind: a row older than the reported generation is raised to it (not incremented past it)
    store.rawDb.prepare("UPDATE ann_indexes SET desired_generation = 1, state = 'ready', generation = 1 WHERE space_id = ?").run(space)
    const behind = scheduleAnnRebuildAfterCompaction(store, [{ spaceId: space, desiredGeneration: reported }], { minVectors: 1 })
    expect(behind.markedDirty).toEqual([space])
    expect(annRow()).toMatchObject({ desired_generation: reported, state: 'dirty' })
    expect(behind.requests[0]!.targetGeneration).toBe(reported)
  })

  it('collapses duplicate specs, skips unknown spaces, small corpora and already rebuilt spaces', () => {
    const batch = repo.evictEmbeddingsBatch(docIds().slice(0, 1))
    const g = batch.affectedSpaces[0]!.desiredGeneration
    const res = scheduleAnnRebuildAfterCompaction(store, [
      { spaceId: space, desiredGeneration: g },
      { spaceId: space, desiredGeneration: g },
      { spaceId: 'no-such-space', desiredGeneration: 3 },
    ])
    expect(res.requests).toEqual([]) // far below ANN_MIN_VECTORS: exact scan is used, no rebuild is worth it
    expect(res.skipped).toEqual(
      expect.arrayContaining([
        { spaceId: space, reason: 'below-ann-min-vectors' },
        { spaceId: 'no-such-space', reason: 'unknown-space' },
      ]),
    )
    expect(res.skipped).toHaveLength(2)
    // still dirty and fenced: the metadata contract holds even when no rebuild is requested
    expect(annRow()).toMatchObject({ state: 'dirty', desired_generation: g })

    store.rawDb.prepare("UPDATE ann_indexes SET state = 'ready', generation = desired_generation WHERE space_id = ?").run(space)
    const done = scheduleAnnRebuildAfterCompaction(store, [{ spaceId: space, desiredGeneration: g }], { minVectors: 1 })
    expect(done.skipped).toEqual([{ spaceId: space, reason: 'already-current' }])
    expect(done.requests).toEqual([])
  })

  it('issues a permit-valid request for a drained space with a stale ANN file (clear path), generation fenced', async () => {
    const batch = repo.evictEmbeddingsBatch(docIds())
    // there is no vector left, but an ANN file from before the compaction is still recorded
    store.rawDb.prepare("UPDATE ann_indexes SET file_path = 'ann-old.usearch', indexed_count = 99 WHERE space_id = ?").run(space)
    expect(store.getAnnCanonicalMeta(space).canonicalCount).toBe(0)

    const res = scheduleAnnRebuildAfterCompaction(store, batch.affectedSpaces)
    expect(res.requests).toHaveLength(1)
    const req = res.requests[0]!
    expect(req).toMatchObject({ vectorCount: 0, clearsStaleIndex: true })

    const fixture = new AnnAdmissionTestFixture({ directory: dir })
    const permit = await fixture.acquireHostPermit(space, {
      dimensions: req.dimensions,
      vectorCount: req.vectorCount,
      targetGeneration: req.targetGeneration,
    })
    expect(validateAnnPreauthorizedPermit(permit, req.dimensions, undefined, undefined, req.targetGeneration)).toBe(true)
    expect(permit.reservedBytes).toBeGreaterThanOrEqual(req.estimatedBytes - 1)

    const ok = await store.rebuildAnnIndex(space, permit)
    expect(ok).toEqual({ ok: true, count: 0 })
    expect(annRow()).toMatchObject({ generation: req.targetGeneration, desired_generation: req.targetGeneration, file_path: null, indexed_count: 0 })
  })

  it('rejects a permit minted for an older fence and the dispatcher refreshes the fence from live metadata', async () => {
    const batch = repo.evictEmbeddingsBatch(docIds().slice(0, 3))
    const sched = scheduleAnnRebuildAfterCompaction(store, batch.affectedSpaces, { minVectors: 1 })
    const stale = sched.requests[0]!

    // a concurrent mutation advances the fence after scheduling
    store.markAnnDirty(space)
    const live = annRow()!.desired_generation
    expect(live).toBe(stale.targetGeneration + 1)

    const fixture = new AnnAdmissionTestFixture({ directory: dir })
    const stalePermit = await fixture.acquireHostPermit(space, {
      dimensions: stale.dimensions,
      vectorCount: stale.vectorCount,
      targetGeneration: stale.targetGeneration,
    })
    const rejected = await store.rebuildAnnIndex(space, stalePermit)
    expect(rejected.ok).toBe(false)
    expect(annRow()!.state).toBe('dirty')

    const seen: Array<{ spaceId: string; dimensions: number; vectorCount: number; targetGeneration?: number }> = []
    const context = { isStopped: () => false } as unknown as AnnDispatchContext
    const outcomes = await dispatchAnnRebuildRequests(store, [stale], context, {
      dispatch: async (o) => {
        seen.push({ spaceId: o.spaceId, dimensions: o.dimensions, vectorCount: o.vectorCount, targetGeneration: o.targetGeneration })
        return { ok: true, count: o.vectorCount }
      },
    })
    const fence = store.getAnnCanonicalMeta(space)
    expect(seen).toEqual([
      { spaceId: space, dimensions: stale.dimensions, vectorCount: fence.canonicalCount, targetGeneration: fence.desiredGeneration },
    ])
    expect(fence.desiredGeneration).toBeGreaterThanOrEqual(live)
    expect(outcomes[0]).toMatchObject({ ok: true, dispatched: true })
  })

  it('stops dispatching on shouldContinue/isStopped without touching metadata', async () => {
    const batch = repo.evictEmbeddingsBatch(docIds().slice(0, 2))
    const sched = scheduleAnnRebuildAfterCompaction(store, batch.affectedSpaces, { minVectors: 1 })
    const before = annRow()
    let called = 0
    const dispatch = async () => {
      called++
      return { ok: true, count: 0 }
    }
    const a = await dispatchAnnRebuildRequests(store, sched.requests, { isStopped: () => false } as unknown as AnnDispatchContext, {
      dispatch,
      shouldContinue: () => false,
    })
    const b = await dispatchAnnRebuildRequests(store, sched.requests, { isStopped: () => true } as unknown as AnnDispatchContext, { dispatch })
    expect(a).toEqual([])
    expect(b).toEqual([])
    expect(called).toBe(0)
    expect(annRow()).toEqual(before)
  })
})
