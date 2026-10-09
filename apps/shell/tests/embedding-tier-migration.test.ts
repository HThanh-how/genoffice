import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { EmbeddingMigration } from '../src/main/document-memory/embedding-migration'
import { EmbeddingCoordinator } from '../src/main/document-memory/runtime/embedding-coordinator'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'
import { roundTripInt8 } from '../src/main/document-memory/embedding/vector-codec'
import { l2Normalize } from '../src/main/document-memory/embedding/pipeline'

/** Deterministic unit vector pointing mostly along axis `axis`. */
function vec(dimensions: number, axis: number): number[] {
  return l2Normalize(Array.from({ length: dimensions }, (_, i) => (i === axis ? 1 : 0.01 * Math.sin(i + axis))))
}

describe('migrating a legacy vector space to a new tier (real SQLite)', () => {
  let dir: string
  let store: DocumentMemoryStore
  let db: DatabaseSync
  const { standard, base, mid, plus } = EMBEDDING_PROFILES

  const addDocument = (name: string, texts: string[], profile = standard) => {
    const path = join(dir, name)
    store.replaceDocument(path, {
      hash: `h-${name}`,
      mtimeMs: 1000,
      sizeBytes: 10,
      chunks: texts.map((text, i) => ({ text, location: `p.${i + 1}` })),
      embeddingModel: profile.embeddingId,
      status: 'ready',
    })
    store.setChunkEmbeddings(path, `h-${name}`, 0, texts.map((_, i) => vec(profile.dimensions, i)), profile.embeddingId, true)
    return path
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-tier-migration-'))
    store = new DocumentMemoryStore(join(dir, 'document-memory.db'))
    db = (store as unknown as { db: DatabaseSync }).db
    store.ensureEmbeddingSpace(standard)
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps the legacy space searchable while the new tier fills in, chunk by chunk', () => {
    const a = addDocument('a.txt', ['Hóa đơn HD-2024-00871', 'Hợp đồng thuê nhà'])
    addDocument('b.txt', ['Biên bản nghiệm thu'])

    store.ensureEmbeddingSpace(base)
    const migration = new EmbeddingMigration(db)
    migration.setTarget(base.embeddingId)
    expect(migration.progress()).toMatchObject({ targetSpaceId: base.embeddingId, totalChunks: 3, completedChunks: 0, state: 'pending' })

    const first = migration.nextBatch(2)
    expect(first.chunks).toHaveLength(2)

    // the old space still answers while the migration is half way
    const legacyHits = store.searchSemantic(vec(standard.dimensions, 0), 5, standard.embeddingId)
    expect(legacyHits.length).toBeGreaterThan(0)

    // commit the first batch in the new space (384d, rounded through the int8 grid as embedTexts does)
    const byDoc = new Map<number, number[]>()
    first.chunks.forEach((chunk, i) => byDoc.set(chunk.chunkId, roundTripInt8(vec(base.dimensions, i))))
    store.setChunkEmbeddings(a, 'h-a.txt', 0, [byDoc.get(first.chunks[0]!.chunkId)!, byDoc.get(first.chunks[1]!.chunkId)!], base.embeddingId, true)
    migration.markCompleted(first.chunks.map((c) => c.chunkId))
    expect(migration.progress()).toMatchObject({ completedChunks: 2, totalChunks: 3 })

    const rest = migration.nextBatch(10)
    expect(rest.chunks).toHaveLength(1)
    store.setChunkEmbeddings(join(dir, 'b.txt'), 'h-b.txt', 0, [roundTripInt8(vec(base.dimensions, 5))], base.embeddingId, true)
    migration.markCompleted(rest.chunks.map((c) => c.chunkId))
    expect(migration.nextBatch(10).chunks).toHaveLength(0)
    expect(migration.isComplete()).toBe(true)

    // both spaces keep their own dimension and remain searchable
    expect(store.searchSemantic(vec(base.dimensions, 0), 5, base.embeddingId).length).toBeGreaterThan(0)
    expect(store.searchSemantic(vec(standard.dimensions, 0), 5, standard.embeddingId).length).toBeGreaterThan(0)
    const rows = db
      .prepare('SELECT space_id, vector_dim, count(*) AS n FROM chunk_embeddings GROUP BY space_id, vector_dim ORDER BY vector_dim')
      .all() as Array<{ space_id: string; vector_dim: number; n: number }>
    expect(rows).toEqual([
      { space_id: standard.embeddingId, vector_dim: 320, n: 3 },
      { space_id: base.embeddingId, vector_dim: 384, n: 3 },
    ])
  })

  it('refuses vectors of the old width in the new space (canonical dimension invariant)', () => {
    const path = addDocument('c.txt', ['Một đoạn văn'])
    store.ensureEmbeddingSpace(base)
    expect(() => store.setChunkEmbeddings(path, 'h-c.txt', 0, [vec(320, 0)], base.embeddingId, true)).toThrow(/dimension/i)
  })

  it('registers the new spaces with their pinned model and the stored dimension', () => {
    for (const profile of [base, EMBEDDING_PROFILES.balanced, mid]) store.ensureEmbeddingSpace(profile)
    store.ensureEmbeddingSpace(plus) // same space as mid: idempotent
    const spaces = Object.fromEntries(store.getEmbeddingSpaces().map((s) => [s.id, s]))
    expect(spaces[base.embeddingId]).toMatchObject({ modelRepo: base.repo, modelRevision: base.revision, dimensions: 384, pooling: 'mean' })
    expect(spaces[mid.embeddingId]).toMatchObject({ modelRepo: mid.repo, modelRevision: mid.revision, dimensions: 512, pooling: 'sentence' })
    expect(Object.keys(spaces).filter((id) => id === plus.embeddingId)).toHaveLength(1)
  })

  it('switching from the legacy profile through the coordinator re-queues documents and keeps old vectors', () => {
    addDocument('d.txt', ['Báo cáo', 'Kế hoạch'])
    const coordinator = new EmbeddingCoordinator({ store, initialProfileId: 'standard' })
    expect(coordinator.setEmbeddingProfile('base')).toEqual({ changed: true, requeued: 1 })
    expect(coordinator.currentProfile.id).toBe('base')
    // the legacy rows are untouched; they are collected by the normal space GC, not by the switch
    const legacyRows = db.prepare('SELECT count(*) AS n FROM chunk_embeddings WHERE space_id = ?').get(standard.embeddingId) as { n: number }
    expect(legacyRows.n).toBe(2)
  })

  it('moving between mid and plus never re-embeds: they are the same vector space', () => {
    store.ensureEmbeddingSpace(mid)
    addDocument('e.txt', ['Biên lai thu tiền'], mid)
    const coordinator = new EmbeddingCoordinator({ store, initialProfileId: 'mid' })
    expect(coordinator.setEmbeddingProfile('plus')).toEqual({ changed: true, requeued: 0 })
    expect(coordinator.setEmbeddingProfile('mid')).toEqual({ changed: true, requeued: 0 })
    expect(store.searchSemantic(vec(512, 0), 3, mid.embeddingId)).toHaveLength(1)
  })
})
