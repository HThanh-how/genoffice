import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ANN_MIN_VECTORS } from '../src/main/document-memory/ann-index'
import { ExactVectorIndex } from '../src/main/document-memory/exact-vector-index'
import { USearchIndex } from '../src/main/document-memory/usearch-index'
import { DocumentMemoryStore } from '../src/main/document-memory/store'

describe('ANN Vector Indexing & Exact Search Fallback', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genoffice-ann-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('verifies ANN_MIN_VECTORS threshold is 20,000', () => {
    expect(ANN_MIN_VECTORS).toBe(20_000)
  })

  describe('ExactVectorIndex', () => {
    it('indexes vectors and performs exact cosine similarity search', async () => {
      const index = new ExactVectorIndex()
      await index.open()

      const v1 = [1, 0]
      const v2 = [0.8, 0.6]
      const v3 = [0, 1]

      await index.add([1, 2, 3], [v1, v2, v3])
      expect(index.size()).toBe(3)

      const hits = await index.search([1, 0], 2)
      expect(hits).toHaveLength(2)
      expect(hits[0]?.chunkId).toBe(1)
      expect(hits[0]?.distance).toBeCloseTo(0, 4)
      expect(hits[1]?.chunkId).toBe(2)

      await index.remove([1])
      expect(index.size()).toBe(2)

      const hitsAfterRemove = await index.search([1, 0], 2)
      expect(hitsAfterRemove[0]?.chunkId).toBe(2)
      await index.close()
    })
  })

  describe('USearchIndex with persistent disk support & fallback', () => {
    it('opens, adds vectors, searches and persists to disk safely', async () => {
      const indexPath = join(directory, 'test.usearch')
      const index = new USearchIndex(2, indexPath)
      await index.open()

      const v1 = [1, 0]
      const v2 = [0, 1]
      await index.add([10, 20], [v1, v2])

      const hits = await index.search([1, 0], 1)
      expect(hits).toHaveLength(1)
      expect(hits[0]?.chunkId).toBe(10)

      await index.close()

      // Re-open from disk and verify search continues to work
      const reopened = new USearchIndex(2, indexPath)
      await reopened.open()
      const reopenedHits = await reopened.search([0, 1], 1)
      expect(reopenedHits).toHaveLength(1)
      expect(reopenedHits[0]?.chunkId).toBe(20)
      await reopened.close()
    })

    it('manages health state and transitions to dirty upon write failures', async () => {
      const indexPath = join(directory, 'test-health.usearch')
      const index = new USearchIndex(2, indexPath)
      await index.open()

      expect(index.isHealthy()).toBe(true)
      expect(index.getState()).toBe('ready')

      // Provoke a failure in addSync with mismatched/invalid dimensions
      // USearch will throw when adding invalid vector shape, leading to dirty state
      index.addSync([1], [[]]) // empty vector when dimensions is 2
      expect(index.isHealthy()).toBe(false)
      expect(index.getState()).toBe('dirty')

      await index.close()
    })

    it('performs atomic rebuild successfully without deleting old index prematurely', async () => {
      const indexPath = join(directory, 'test-atomic.usearch')
      const index = new USearchIndex(2, indexPath)
      await index.open()

      await index.add([100], [[1, 0]])
      expect(existsSync(indexPath)).toBe(true)

      // Calling rebuild() should NOT delete the existing index file on disk
      await index.rebuild()
      expect(existsSync(indexPath)).toBe(true)

      // rebuildAtomic should create new index, swap atomically, and be ready
      const success = await index.rebuildAtomic([200, 300], [[0, 1], [1, 0]])
      expect(success).toBe(true)
      expect(index.isHealthy()).toBe(true)
      expect(index.getState()).toBe('ready')

      const hits = await index.search([0, 1], 1)
      expect(hits).toHaveLength(1)
      expect(hits[0]?.chunkId).toBe(200)

      // Verify no temporary rebuild file is left behind
      expect(existsSync(`${indexPath}.rebuild.tmp`)).toBe(false)

      // Verify no fallback json is created on disk
      expect(existsSync(`${indexPath}.fallback.json`)).toBe(false)

      await index.close()
    })

    it('handles rebuildAtomic failure safely by preserving index and marking dirty', async () => {
      const indexPath = join(directory, 'test-fail-atomic.usearch')
      const index = new USearchIndex(2, indexPath)
      await index.open()

      await index.add([50], [[1, 0]])
      expect(index.isHealthy()).toBe(true)

      // Trigger rebuild failure with invalid vector dimensions
      const success = await index.rebuildAtomic([999], [[]])
      expect(success).toBe(false)
      expect(index.isHealthy()).toBe(false)
      expect(index.getState()).toBe('dirty')

      // Temporary file must be cleaned up
      expect(existsSync(`${indexPath}.rebuild.tmp`)).toBe(false)

      // Previous index file on disk is still intact
      expect(existsSync(indexPath)).toBe(true)

      await index.close()
    })

    it('never creates .fallback.json on disk during lifecycle operations', async () => {
      const indexPath = join(directory, 'no-fallback-test.usearch')
      const index = new USearchIndex(2, indexPath)
      await index.open()

      await index.add([1, 2], [[1, 0], [0, 1]])
      await index.remove([1])

      expect(existsSync(`${indexPath}.fallback.json`)).toBe(false)
      expect(existsSync(`${indexPath}.fallback.json.tmp`)).toBe(false)

      await index.close()
    })
  })

  describe('DocumentMemoryStore ANN hardening (Audit P0 / P1 / A2 / A3 / B4)', () => {
    it('updates indexed_count in ann_indexes on setChunkEmbeddings and rebuildAnnIndex', async () => {
      const dbPath = join(directory, 'test-store.sqlite')
      const store = new DocumentMemoryStore(dbPath)

      const docPath = join(directory, 'doc.txt')
      store.replaceDocument(docPath, {
        hash: 'h1',
        mtimeMs: 100,
        sizeBytes: 20,
        chunks: [
          { text: 'chunk one', location: '1' },
          { text: 'chunk two', location: '2' },
        ],
        embeddingModel: null,
        status: 'text-only',
      })

      // Initially rebuild on empty
      const emptyRebuild = await store.rebuildAnnIndex('space-1')
      expect(emptyRebuild.ok).toBe(true)
      expect(emptyRebuild.count).toBe(0)

      // Add vectors via setChunkEmbeddings
      store.setChunkEmbeddings(
        docPath,
        'h1',
        0,
        [
          [1, 0],
          [0, 1],
        ],
        'space-1',
        true,
      )

      let row = store.rawDb
        .prepare('SELECT generation, indexed_count, state FROM ann_indexes WHERE space_id = ?')
        .get('space-1') as { generation: number; indexed_count: number; state: string }
      expect(row.indexed_count).toBe(2)

      // Rebuild ANN index
      const rebuild = await store.rebuildAnnIndex('space-1')
      expect(rebuild.ok).toBe(true)
      expect(rebuild.count).toBe(2)

      row = store.rawDb
        .prepare('SELECT generation, indexed_count, state FROM ann_indexes WHERE space_id = ?')
        .get('space-1') as { generation: number; indexed_count: number; state: string }
      expect(row.generation).toBe(1)
      expect(row.indexed_count).toBe(2)
      expect(row.state).toBe('ready')

      // Record migration embeddings
      store.recordMigrationEmbeddings('space-1', [
        { chunkId: 1, vector: [0.5, 0.5] },
      ])
      row = store.rawDb
        .prepare('SELECT generation, indexed_count, state FROM ann_indexes WHERE space_id = ?')
        .get('space-1') as { generation: number; indexed_count: number; state: string }
      expect(row.indexed_count).toBe(2)

      // Mark dirty when ann becomes unhealthy
      const ann = store.getAnnIndex('space-1', 2)
      ann.addSync([999], [[]]) // force unhealthy / dirty state
      expect(ann.isHealthy()).toBe(false)

      // Calling setChunkEmbeddings with unhealthy ann triggers markAnnDirty
      store.setChunkEmbeddings(
        docPath,
        'h1',
        0,
        [
          [1, 0],
          [0, 1],
        ],
        'space-1',
        true,
      )
      row = store.rawDb
        .prepare('SELECT state FROM ann_indexes WHERE space_id = ?')
        .get('space-1') as { state: string }
      expect(row.state).toBe('dirty')

      store.close()
    })
  })
})
