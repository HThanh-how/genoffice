import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANN_MIN_VECTORS } from '../src/main/document-memory/ann-index'
import { USearchIndex } from '../src/main/document-memory/usearch-index'
import { DocumentMemoryStore } from '../src/main/document-memory/store'

function floatBlob(vector: number[]): Uint8Array {
  const buf = new Float32Array(vector)
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

describe('ANN Cache Coherence & Cross-Process Tests (Audit P0 / Mục 2, 3, 4, 12)', () => {
  let directory: string
  const activeStores: DocumentMemoryStore[] = []

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genoffice-coherence-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    while (activeStores.length > 0) {
      const store = activeStores.pop()
      try {
        store?.close()
      } catch {
        // ignore close error
      }
    }
    rmSync(directory, { recursive: true, force: true })
  })

  // =========================================================================
  // 1. Generation Coherence & Cross-Process Tests (Audit P0 / Mục 2)
  // =========================================================================
  describe('1. Generation Coherence Test', () => {
    it('initializes index, saves generation 1, and synchronizes generation 2 from another process', async () => {
      const indexPath = join(directory, 'cross-process.usearch')
      const index1 = new USearchIndex(4, indexPath)
      await index1.open()

      expect(index1.getLoadedGeneration()).toBe(0)
      expect(index1.size()).toBe(0)
      expect(index1.isHealthy()).toBe(true)

      // Add 20 initial vectors to index1
      const initialChunkIds: number[] = []
      const initialVectors: number[][] = []
      for (let i = 1; i <= 20; i++) {
        initialChunkIds.push(i)
        initialVectors.push([i * 0.05, 0.1, 0.2, 0.3])
      }

      index1.addSync(initialChunkIds, initialVectors)
      index1.saveAtomic(1)

      expect(index1.getLoadedGeneration()).toBe(1)
      expect(index1.size()).toBe(20)
      expect(existsSync(indexPath)).toBe(true)

      // Simulate a separate background worker / process 2 opening the same index
      const process2 = new USearchIndex(4, indexPath)
      await process2.open()
      expect(process2.size()).toBe(20)

      // Process 2 adds 5 new vectors and saves with generation = 2
      const newChunkIds: number[] = [21, 22, 23, 24, 25]
      const newVectors: number[][] = [
        [0.9, 0.0, 0.0, 0.0],
        [0.0, 0.9, 0.0, 0.0],
        [0.0, 0.0, 0.9, 0.0],
        [0.0, 0.0, 0.0, 0.9],
        [0.5, 0.5, 0.5, 0.5],
      ]
      process2.addSync(newChunkIds, newVectors)
      process2.saveAtomic(2)

      expect(process2.getLoadedGeneration()).toBe(2)
      expect(process2.size()).toBe(25)
      await process2.close()

      // In Process 1 (prior to reload), loadedGeneration is still 1 and size is 20
      expect(index1.getLoadedGeneration()).toBe(1)
      expect(index1.size()).toBe(20)

      // Calling reloadSync(2) on index1 reloads the updated file from disk
      const reloadResult = index1.reloadSync(2)
      expect(reloadResult).toBe(true)
      expect(index1.getLoadedGeneration()).toBe(2)
      expect(index1.size()).toBe(25)
      expect(index1.isHealthy()).toBe(true)

      // Verify index1 can now find the new vector (chunkId 25) added by process 2
      const hits = index1.searchSync([0.5, 0.5, 0.5, 0.5], 1)
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0]?.chunkId).toBe(25)

      await index1.close()
    })

    it('transitions to dirty state when reloadSync encounters a corrupted file on disk', async () => {
      const indexPath = join(directory, 'corrupt-reload.usearch')
      const index = new USearchIndex(4, indexPath)
      await index.open()

      index.addSync([1], [[0.1, 0.2, 0.3, 0.4]])
      index.saveAtomic(1)
      expect(index.isHealthy()).toBe(true)

      // Overwrite file with invalid corrupt binary data
      writeFileSync(indexPath, Buffer.from('NOT_A_VALID_USEARCH_INDEX_FILE_CORRUPTED'))

      // reloadSync should catch corruption, transition to dirty, and return false
      const reloadSuccess = index.reloadSync(2)
      expect(reloadSuccess).toBe(false)
      expect(index.getState()).toBe('dirty')
      expect(index.isHealthy()).toBe(false)

      await index.close()
    })
  })

  // =========================================================================
  // 2. Crash Window & Stale Prevention Tests (Audit P0 / Mục 3 & Mục 4)
  // =========================================================================
  describe('2. Crash Window & Stale Prevention Test', () => {
    const spaceId = 'space-audit'

    function createStoreWith20kEmbeddings(): { store: DocumentMemoryStore; dbPath: string } {
      const dbPath = join(directory, 'audit-store.sqlite')
      const store = new DocumentMemoryStore(dbPath)
      activeStores.push(store)

      // Register embedding space
      store.rawDb
        .prepare(
          `INSERT OR IGNORE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
           VALUES (?, 'test-repo', 'v1', 'mean', 2, 'fp32')`,
        )
        .run(spaceId)

      // Insert 1 canonical document
      const docPath = join(directory, 'report.docx')
      store.rawDb
        .prepare(
          `INSERT INTO documents (id, path, name, status, excluded, chunk_counted, priority_at)
           VALUES (1, ?, 'report.docx', 'ready', 0, 1, 1000)`,
        )
        .run(docPath)

      // Insert 20,000 chunks and embeddings in a single atomic transaction
      store.rawDb.exec('BEGIN IMMEDIATE')
      const insertChunk = store.rawDb.prepare(
        'INSERT INTO chunks (id, document_id, text, normalized, location, ordinal) VALUES (?, 1, ?, ?, ?, ?)',
      )
      const insertEmb = store.rawDb.prepare(
        'INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim) VALUES (?, ?, ?, 2)',
      )

      // Chunk 1: [1, 0] (best match for query [1, 0])
      insertChunk.run(1, 'Target Chunk One', 'target chunk one', '1', 0)
      insertEmb.run(1, spaceId, floatBlob([1, 0]))

      // Chunk 2: [0.8, 0.6] (second match)
      insertChunk.run(2, 'Target Chunk Two', 'target chunk two', '2', 1)
      insertEmb.run(2, spaceId, floatBlob([0.8, 0.6]))

      // Chunks 3..20,000: orthogonal vectors [0, 1]
      const otherVectorBlob = floatBlob([0, 1])
      for (let i = 3; i <= ANN_MIN_VECTORS; i++) {
        insertChunk.run(i, `Chunk ${i}`, `chunk ${i}`, String(i), i - 1)
        insertEmb.run(i, spaceId, otherVectorBlob)
      }
      store.rawDb.exec('COMMIT')

      // Pre-populate ann_indexes entry
      store.rawDb
        .prepare(
          `INSERT INTO ann_indexes (space_id, generation, file_path, indexed_count, state, updated_at)
           VALUES (?, 1, ?, ?, 'ready', unixepoch())`,
        )
        .run(spaceId, `ann-${spaceId}.usearch`, ANN_MIN_VECTORS)

      return { store, dbPath }
    }

    it('blocks ANN query and falls back to SQLite exact cosine scan when state is dirty', () => {
      const { store } = createStoreWith20kEmbeddings()

      // Mark SQLite state as 'dirty'
      store.rawDb.prepare("UPDATE ann_indexes SET state = 'dirty' WHERE space_id = ?").run(spaceId)

      const ann = store.getAnnIndex(spaceId, 2)
      const searchSyncSpy = vi.spyOn(ann, 'searchSync')

      // Perform semantic search for query vector [1, 0]
      const results = store.searchSemantic([1, 0], 5, spaceId)

      // Strict contract: ANN must NEVER be queried when state is dirty
      expect(searchSyncSpy).not.toHaveBeenCalled()

      // Verify SQLite exact scan succeeded and returned canonical top hits
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]?.chunkId).toBe(1)
      expect(results[0]?.score).toBeCloseTo(1.0, 3)
      expect(results[1]?.chunkId).toBe(2)
      expect(results[1]?.score).toBeCloseTo(0.8, 3)
    })

    it('blocks ANN query and falls back to SQLite exact cosine scan on indexed_count mismatch', () => {
      const { store } = createStoreWith20kEmbeddings()

      // Simulate a crash window where background indexer was interrupted:
      // Canonical chunk_embeddings has 20,000, but ann_indexes only recorded 19,999
      store.rawDb
        .prepare("UPDATE ann_indexes SET state = 'ready', indexed_count = ? WHERE space_id = ?")
        .run(ANN_MIN_VECTORS - 1, spaceId)

      const ann = store.getAnnIndex(spaceId, 2)
      const searchSyncSpy = vi.spyOn(ann, 'searchSync')

      const results = store.searchSemantic([1, 0], 5, spaceId)

      // Strict contract: indexed_count mismatch must NOT be trusted
      expect(searchSyncSpy).not.toHaveBeenCalled()

      // Exact scan returns the exact top result
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]?.chunkId).toBe(1)
      expect(results[0]?.score).toBeCloseTo(1.0, 3)
    })

    it('blocks ANN query and falls back to SQLite exact cosine scan when in-memory index is unhealthy', () => {
      const { store } = createStoreWith20kEmbeddings()

      // Ensure SQLite metadata looks ready and complete
      store.rawDb
        .prepare("UPDATE ann_indexes SET state = 'ready', indexed_count = ? WHERE space_id = ?")
        .run(ANN_MIN_VECTORS, spaceId)

      const ann = store.getAnnIndex(spaceId, 2)
      // Force in-memory index into dirty / unhealthy state
      ann.addSync([999], [[]])
      expect(ann.isHealthy()).toBe(false)
      expect(ann.getState()).toBe('dirty')

      const searchSyncSpy = vi.spyOn(ann, 'searchSync')

      const results = store.search('', [1, 0], 5, spaceId)

      // Unhealthy index must not execute searchSync
      expect(searchSyncSpy).not.toHaveBeenCalled()
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]?.chunkId).toBe(1)
    })

    it('queries ANN index when state is ready, count matches, and index is healthy', () => {
      const { store } = createStoreWith20kEmbeddings()

      const ann = store.getAnnIndex(spaceId, 2)
      // Populate the ANN index with chunk 1 and 2
      ann.addSync([1, 2], [[1, 0], [0.8, 0.6]])
      ann.saveAtomic(1)
      expect(ann.isHealthy()).toBe(true)

      const searchSyncSpy = vi.spyOn(ann, 'searchSync')

      const results = store.search('', [1, 0], 5, spaceId)

      // Healthy ANN with matching count and ready state MUST be queried
      expect(searchSyncSpy).toHaveBeenCalled()
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]?.chunkId).toBe(1)
    })
  })

  // =========================================================================
  // 3. ANN Search Failure Transition Tests (Audit P0 / Mục 12)
  // =========================================================================
  describe('3. ANN Search Failure Transition Test', () => {
    it('automatically transitions USearchIndex to dirty state on searchSync runtime error', async () => {
      const indexPath = join(directory, 'fail-transition.usearch')
      const index = new USearchIndex(2, indexPath)
      await index.open()

      index.addSync([1], [[1, 0]])
      index.saveAtomic(1)
      expect(index.isHealthy()).toBe(true)
      expect(index.getState()).toBe('ready')

      // Mock native search method throwing an unexpected native exception / memory corruption
      const nativeIndex = (index as unknown as { nativeIndex: { search: () => unknown } }).nativeIndex
      expect(nativeIndex).toBeDefined()

      const originalSearch = nativeIndex.search
      nativeIndex.search = () => {
        throw new Error('Native USearch index corrupted in memory')
      }

      // First search encounters error: must catch, transition to dirty, and return []
      const hits = index.searchSync([1, 0], 1)
      expect(hits).toEqual([])
      expect(index.getState()).toBe('dirty')
      expect(index.isHealthy()).toBe(false)

      nativeIndex.search = originalSearch
      await index.close()
    })

    it('recovers safely in store.search when ANN search fails and falls back without crashing', () => {
      const spaceId = 'space-failure-recovery'
      const dbPath = join(directory, 'failure-recovery.sqlite')
      const store = new DocumentMemoryStore(dbPath)
      activeStores.push(store)

      store.rawDb
        .prepare(
          `INSERT OR IGNORE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
           VALUES (?, 'test-repo', 'v1', 'mean', 2, 'fp32')`,
        )
        .run(spaceId)

      // Insert 1 canonical document
      const docPath = join(directory, 'doc.txt')
      store.rawDb
        .prepare(
          `INSERT INTO documents (id, path, name, status, excluded, chunk_counted, priority_at)
           VALUES (1, ?, 'doc.txt', 'ready', 0, 1, 1000)`,
        )
        .run(docPath)

      // Insert 20,000 vectors
      store.rawDb.exec('BEGIN IMMEDIATE')
      const insertChunk = store.rawDb.prepare(
        'INSERT INTO chunks (id, document_id, text, normalized, location, ordinal) VALUES (?, 1, ?, ?, ?, ?)',
      )
      const insertEmb = store.rawDb.prepare(
        'INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim) VALUES (?, ?, ?, 2)',
      )

      insertChunk.run(1, 'Target Chunk', 'target chunk', '1', 0)
      insertEmb.run(1, spaceId, floatBlob([1, 0]))

      const filler = floatBlob([0, 1])
      for (let i = 2; i <= ANN_MIN_VECTORS; i++) {
        insertChunk.run(i, `Filler ${i}`, `filler ${i}`, String(i), i - 1)
        insertEmb.run(i, spaceId, filler)
      }
      store.rawDb.exec('COMMIT')

      store.rawDb
        .prepare(
          `INSERT INTO ann_indexes (space_id, generation, file_path, indexed_count, state, updated_at)
           VALUES (?, 1, ?, ?, 'ready', unixepoch())`,
        )
        .run(spaceId, `ann-${spaceId}.usearch`, ANN_MIN_VECTORS)

      const ann = store.getAnnIndex(spaceId, 2)
      ann.addSync([1], [[1, 0]])
      ann.saveAtomic(1)
      expect(ann.isHealthy()).toBe(true)

      // Simulate native search corruption
      const nativeIndex = (ann as unknown as { nativeIndex: { search: () => unknown } }).nativeIndex
      expect(nativeIndex).toBeDefined()
      nativeIndex.search = () => {
        throw new Error('USearch internal index fault')
      }

      // First query: native search fails -> store must catch, mark dirty, and fallback to SQLite
      const firstResults = store.searchSemantic([1, 0], 5, spaceId)
      expect(firstResults.length).toBeGreaterThan(0)
      expect(firstResults[0]?.chunkId).toBe(1)
      expect(firstResults[0]?.score).toBeCloseTo(1.0, 3)

      // Verify dirty state transition propagated to both in-memory index and SQLite ann_indexes
      expect(ann.isHealthy()).toBe(false)
      expect(ann.getState()).toBe('dirty')

      const row = store.rawDb
        .prepare('SELECT state FROM ann_indexes WHERE space_id = ?')
        .get(spaceId) as { state: string }
      expect(row.state).toBe('dirty')

      // Second query: ANN is known dirty, so it falls back to SQLite immediately without crashing
      const secondResults = store.searchSemantic([1, 0], 5, spaceId)
      expect(secondResults.length).toBeGreaterThan(0)
      expect(secondResults[0]?.chunkId).toBe(1)
      expect(secondResults[0]?.score).toBeCloseTo(1.0, 3)
    })
  })

  // =========================================================================
  // 4. Cross-Process Auto-Reload in DocumentMemoryStore
  // =========================================================================
  describe('4. Cross-Process Auto-Reload in store.search', () => {
    it('automatically reloads in-memory ANN index when SQLite generation advances', () => {
      const spaceId = 'space-cross-reload'
      const dbPath = join(directory, 'cross-reload.sqlite')
      const store = new DocumentMemoryStore(dbPath)
      activeStores.push(store)

      store.rawDb
        .prepare(
          `INSERT OR IGNORE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
           VALUES (?, 'test-repo', 'v1', 'mean', 2, 'fp32')`,
        )
        .run(spaceId)

      // Setup 20,000 vectors
      const docPath = join(directory, 'test.txt')
      store.rawDb
        .prepare(
          `INSERT INTO documents (id, path, name, status, excluded, chunk_counted, priority_at)
           VALUES (1, ?, 'test.txt', 'ready', 0, 1, 1000)`,
        )
        .run(docPath)

      store.rawDb.exec('BEGIN IMMEDIATE')
      const insertChunk = store.rawDb.prepare(
        'INSERT INTO chunks (id, document_id, text, normalized, location, ordinal) VALUES (?, 1, ?, ?, ?, ?)',
      )
      const insertEmb = store.rawDb.prepare(
        'INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim) VALUES (?, ?, ?, 2)',
      )

      insertChunk.run(1, 'Initial Chunk 1', 'initial chunk 1', '1', 0)
      insertEmb.run(1, spaceId, floatBlob([0.6, 0.8]))

      const filler = floatBlob([0, 1])
      for (let i = 2; i <= ANN_MIN_VECTORS; i++) {
        insertChunk.run(i, `Chunk ${i}`, `chunk ${i}`, String(i), i - 1)
        insertEmb.run(i, spaceId, filler)
      }
      store.rawDb.exec('COMMIT')

      store.rawDb
        .prepare(
          `INSERT INTO ann_indexes (space_id, generation, file_path, indexed_count, state, updated_at)
           VALUES (?, 1, ?, ?, 'ready', unixepoch())`,
        )
        .run(spaceId, `ann-${spaceId}.usearch`, ANN_MIN_VECTORS)

      // Initial store ANN index is generation 1
      const residentAnn = store.getAnnIndex(spaceId, 2)
      residentAnn.addSync([1], [[0.6, 0.8]])
      residentAnn.saveAtomic(1)
      expect(residentAnn.getLoadedGeneration()).toBe(1)

      // Another process (e.g. Worker process) updates the index file to generation 2
      const workerAnn = new USearchIndex(2, (residentAnn as unknown as { indexPath: string }).indexPath)
      workerAnn.openSync()
      workerAnn.addSync([2], [[1, 0]]) // Worker added delta chunk 2: [1, 0]
      workerAnn.saveAtomic(2)
      expect(workerAnn.getLoadedGeneration()).toBe(2)

      // Worker updates SQLite ann_indexes to generation = 2
      store.rawDb
        .prepare('UPDATE ann_indexes SET generation = 2, updated_at = unixepoch() WHERE space_id = ?')
        .run(spaceId)

      // Prior to search, residentAnn still has loadedGeneration = 1
      expect(residentAnn.getLoadedGeneration()).toBe(1)

      const results = store.search('', [1, 0], 5, spaceId)
      expect(residentAnn.getLoadedGeneration()).toBe(2)
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]?.chunkId).toBe(2)
    })
  })
})
