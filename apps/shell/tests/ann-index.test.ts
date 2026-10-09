import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ANN_MIN_VECTORS } from '../src/main/document-memory/ann-index'
import { ExactVectorIndex } from '../src/main/document-memory/exact-vector-index'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { USearchIndex } from '../src/main/document-memory/usearch-index'
import { AnnAdmissionTestFixture } from './helpers/ann-admission-fixture'

describe('ANN Vector Indexing & Exact Search Fallback', () => {
  let directory: string
  let fixture: AnnAdmissionTestFixture

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genoffice-ann-'))
    fixture = new AnnAdmissionTestFixture({ directory })
  })

  afterEach(() => {
    fixture.cleanup()
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

      // Acquire valid preauthorized save permit from owned admission controller
      const permit = await fixture.acquireSavePermit({
        indexPath,
        vectorCount: 2,
        dimensions: 2,
      })
      index.preauthorizeSave(permit)

      await index.add([10, 20], [v1, v2])
      expect(index.isHealthy()).toBe(true)
      expect(index.getState()).toBe('ready')
      expect(existsSync(indexPath)).toBe(true)

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

    it('transitions to dirty when native index lacks remove() support (D-01)', async () => {
      const indexPath = join(directory, 'test-no-remove.usearch')
      const index = new USearchIndex(2, indexPath)
      await index.open()

      expect(index.isHealthy()).toBe(true)
      expect(index.getState()).toBe('ready')

      // Simulate nativeIndex lacking remove function (incompatibility with certain native bindings)
      const rawNativeIndex = (index as unknown as { nativeIndex: Record<string, unknown> | null }).nativeIndex
      if (rawNativeIndex) {
        rawNativeIndex.remove = undefined
      }

      index.removeSync([10])
      expect(index.getState()).toBe('dirty')
      expect(index.isHealthy()).toBe(false)

      await index.close()
    })

    it('performs atomic rebuild successfully without deleting old index prematurely', async () => {
      const indexPath = join(directory, 'test-atomic.usearch')
      const index = new USearchIndex(2, indexPath)
      await index.open()

      const permitAdd = await fixture.acquireSavePermit({
        indexPath,
        vectorCount: 1,
        dimensions: 2,
      })
      index.preauthorizeSave(permitAdd)
      await index.add([100], [[1, 0]])
      expect(existsSync(indexPath)).toBe(true)

      // Calling rebuild() should NOT delete the existing index file on disk
      await index.rebuild()
      expect(existsSync(indexPath)).toBe(true)

      // rebuildAtomic should create new index, swap atomically, and be ready
      const permitRebuild = await fixture.acquireRebuildPermit({
        indexPath,
        vectorCount: 2,
        dimensions: 2,
        generation: 1,
      })
      const hooks = fixture.createRebuildHooks(permitRebuild)
      const success = await index.rebuildAtomic([200, 300], [[0, 1], [1, 0]], 1, {
        permit: permitRebuild,
        ...hooks,
      })
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

      const permitAdd = await fixture.acquireSavePermit({
        indexPath,
        vectorCount: 1,
        dimensions: 2,
      })
      index.preauthorizeSave(permitAdd)
      await index.add([50], [[1, 0]])
      expect(index.isHealthy()).toBe(true)

      // Trigger rebuild failure with invalid vector dimensions
      const permitRebuild = await fixture.acquireRebuildPermit({
        indexPath,
        vectorCount: 1,
        dimensions: 2,
        generation: 1,
      })
      const hooks = fixture.createRebuildHooks(permitRebuild)
      const success = await index.rebuildAtomic([999], [[]], 1, {
        permit: permitRebuild,
        ...hooks,
      })
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

      const permitAdd = await fixture.acquireSavePermit({
        indexPath,
        vectorCount: 2,
        dimensions: 2,
      })
      index.preauthorizeSave(permitAdd)
      await index.add([1, 2], [[1, 0], [0, 1]])
      await index.remove([1])

      expect(existsSync(`${indexPath}.fallback.json`)).toBe(false)
      expect(existsSync(`${indexPath}.fallback.json.tmp`)).toBe(false)

      await index.close()
    })

    it('tracks loadedGeneration initialized at 0, updated by setLoadedGeneration and rebuildAtomic', async () => {
      const indexPath = join(directory, 'test-generation.usearch')
      const index = new USearchIndex(2, indexPath)
      await index.open()

      expect(index.getLoadedGeneration()).toBe(0)

      index.setLoadedGeneration(5)
      expect(index.getLoadedGeneration()).toBe(5)

      // rebuildAtomic without generation increments loadedGeneration
      const permitInc = await fixture.acquireRebuildPermit({
        indexPath,
        vectorCount: 1,
        dimensions: 2,
      })
      const hooksInc = fixture.createRebuildHooks(permitInc)
      await index.rebuildAtomic([1], [[1, 0]], undefined, {
        permit: permitInc,
        ...hooksInc,
      })
      expect(index.getLoadedGeneration()).toBe(6)

      // rebuildAtomic with explicit generation sets loadedGeneration
      const permitExplicit = await fixture.acquireRebuildPermit({
        indexPath,
        vectorCount: 1,
        dimensions: 2,
        generation: 42,
      })
      const hooksExplicit = fixture.createRebuildHooks(permitExplicit)
      await index.rebuildAtomic([2], [[0, 1]], 42, {
        permit: permitExplicit,
        ...hooksExplicit,
      })
      expect(index.getLoadedGeneration()).toBe(42)

      // saveAtomic with explicit generation updates loadedGeneration
      const permitSave = await fixture.acquireSavePermit({
        indexPath,
        dimensions: 2,
        generation: 99,
      })
      index.preauthorizeSave(permitSave)
      index.saveAtomic(99)
      expect(index.getLoadedGeneration()).toBe(99)

      // saveAtomic without generation preserves loadedGeneration
      const permitPreserve = await fixture.acquireSavePermit({
        indexPath,
        dimensions: 2,
      })
      index.preauthorizeSave(permitPreserve)
      index.saveAtomic()
      expect(index.getLoadedGeneration()).toBe(99)

      await index.close()
    })

    it('reloads index from disk and updates loadedGeneration via reloadSync', async () => {
      const indexPath = join(directory, 'test-reload.usearch')
      const index1 = new USearchIndex(2, indexPath)
      await index1.open()

      const permit1 = await fixture.acquireSavePermit({
        indexPath,
        vectorCount: 2,
        dimensions: 2,
      })
      index1.preauthorizeSave(permit1)
      await index1.add([10, 20], [[1, 0], [0, 1]])
      expect(index1.isHealthy()).toBe(true)

      const index2 = new USearchIndex(2, indexPath)
      await index2.open()
      expect(index2.getLoadedGeneration()).toBe(0)

      // Now index1 adds new vector and rebuilds atomic to generation 2
      const permitRebuild = await fixture.acquireRebuildPermit({
        indexPath,
        vectorCount: 3,
        dimensions: 2,
        generation: 2,
      })
      const hooks = fixture.createRebuildHooks(permitRebuild)
      const rebuildOk = await index1.rebuildAtomic(
        [10, 20, 30],
        [[1, 0], [0, 1], [0.707, 0.707]],
        2,
        {
          permit: permitRebuild,
          ...hooks,
        },
      )
      expect(rebuildOk).toBe(true)

      // index2 reloads with generation 2
      const reloadSuccess = index2.reloadSync(2)
      expect(reloadSuccess).toBe(true)
      expect(index2.getLoadedGeneration()).toBe(2)
      expect(index2.isHealthy()).toBe(true)

      // Verify index2 can find the newly added vector from index1
      const hits = index2.searchSync([0.707, 0.707], 1)
      expect(hits).toHaveLength(1)
      expect(hits[0]?.chunkId).toBe(30)

      await index1.close()
      await index2.close()
    })

    it('marks index as dirty and returns empty array when searchSync encounters native index error', async () => {
      const indexPath = join(directory, 'test-search-error.usearch')
      const index = new USearchIndex(2, indexPath)
      await index.open()

      const permit = await fixture.acquireSavePermit({
        indexPath,
        vectorCount: 1,
        dimensions: 2,
      })
      index.preauthorizeSave(permit)
      await index.add([1], [[1, 0]])
      expect(index.isHealthy()).toBe(true)
      expect(index.getState()).toBe('ready')

      // Mock or cause search failure on native index
      const nativeIndex = (index as unknown as { nativeIndex: { search: () => unknown } }).nativeIndex
      if (nativeIndex) {
        const originalSearch = nativeIndex.search
        nativeIndex.search = () => {
          throw new Error('Simulated native search error')
        }

        const hits = index.searchSync([1, 0], 1)
        expect(hits).toEqual([])
        expect(index.getState()).toBe('dirty')
        expect(index.isHealthy()).toBe(false)

        nativeIndex.search = originalSearch
      }

      await index.close()
    })
  })

  describe('Strict write contract & admission denial enforcement', () => {
    it('denies unpermitted rebuildAtomic fail-closed and preserves existing disk index', async () => {
      const indexPath = join(directory, 'denial-no-permit.usearch')
      const index = new USearchIndex(2, indexPath)
      await index.open()

      // Seed valid initial index on disk
      const permitInit = await fixture.acquireSavePermit({
        indexPath,
        vectorCount: 1,
        dimensions: 2,
      })
      index.preauthorizeSave(permitInit)
      await index.add([10], [[1, 0]])
      expect(existsSync(indexPath)).toBe(true)
      expect(index.isHealthy()).toBe(true)

      // Attempt rebuildAtomic with NO permit
      const denied = await index.rebuildAtomic([20, 30], [[0, 1], [0.7, 0.7]], 2)
      expect(denied).toBe(false)
      expect(index.isHealthy()).toBe(false)
      expect(index.getState()).toBe('dirty')

      // Existing index on disk is preserved intact
      expect(existsSync(indexPath)).toBe(true)
      expect(existsSync(`${indexPath}.rebuild.tmp`)).toBe(false)

      await index.close()

      // Reopening verifies the preserved index
      const reopened = new USearchIndex(2, indexPath)
      await reopened.open()
      const hits = reopened.searchSync([1, 0], 1)
      expect(hits).toHaveLength(1)
      expect(hits[0]?.chunkId).toBe(10)
      await reopened.close()
    })

    it('rejects forged empty permit {} fail-closed and preserves existing disk index', async () => {
      const indexPath = join(directory, 'denial-forged.usearch')
      const index = new USearchIndex(2, indexPath)
      await index.open()

      // Seed valid initial index on disk
      const permitInit = await fixture.acquireSavePermit({
        indexPath,
        vectorCount: 1,
        dimensions: 2,
      })
      index.preauthorizeSave(permitInit)
      await index.add([100], [[1, 0]])
      expect(existsSync(indexPath)).toBe(true)

      // Attempt rebuild with forged empty permit {}
      const forgedPermit = fixture.createForgedPermit()
      const denied = await index.rebuildAtomic([200], [[0, 1]], 2, {
        permit: forgedPermit,
      })
      expect(denied).toBe(false)
      expect(index.isHealthy()).toBe(false)
      expect(index.getState()).toBe('dirty')
      expect(existsSync(indexPath)).toBe(true)
      expect(existsSync(`${indexPath}.rebuild.tmp`)).toBe(false)

      // Also verify saveAtomic rejects forged permit {}
      index.preauthorizeSave(forgedPermit)
      index.saveAtomic(3)
      expect(index.getState()).toBe('dirty')

      await index.close()
    })

    it('rejects under-reserved footprint fail-closed and unlinks temporary file', async () => {
      const indexPath = join(directory, 'denial-under-reserved.usearch')
      const index = new USearchIndex(2, indexPath)
      await index.open()

      const validPermit = await fixture.acquireRebuildPermit({
        indexPath,
        vectorCount: 2,
        dimensions: 2,
        generation: 1,
      })
      // Create under-reserved permit where reservedBytes is far below serialized file size
      const underReservedPermit = fixture.createInsufficientPermit(validPermit, 10)
      const hooks = fixture.createRebuildHooks(underReservedPermit)

      const denied = await index.rebuildAtomic([1, 2], [[1, 0], [0, 1]], 1, {
        permit: underReservedPermit,
        ...hooks,
      })
      expect(denied).toBe(false)
      expect(index.isHealthy()).toBe(false)
      expect(index.getState()).toBe('dirty')
      expect(existsSync(`${indexPath}.rebuild.tmp`)).toBe(false)

      await index.close()
    })

    it('rejects expired permit past TTL fail-closed', async () => {
      const indexPath = join(directory, 'denial-expired.usearch')
      const index = new USearchIndex(2, indexPath)
      await index.open()

      const validPermit = await fixture.acquireRebuildPermit({
        indexPath,
        vectorCount: 1,
        dimensions: 2,
        generation: 1,
      })
      const expiredPermit = fixture.createExpiredPermit(validPermit)
      const hooks = fixture.createRebuildHooks(expiredPermit)

      const denied = await index.rebuildAtomic([1], [[1, 0]], 1, {
        permit: expiredPermit,
        ...hooks,
      })
      expect(denied).toBe(false)
      expect(index.isHealthy()).toBe(false)
      expect(index.getState()).toBe('dirty')

      await index.close()
    })

    it('rejects rebuildAtomic when free disk space is unknown fail-closed and preserves existing old cache index', async () => {
      const indexPath = join(directory, 'denial-unknown-disk.usearch')
      const index = new USearchIndex(2, indexPath)
      await index.open()

      // Seed valid initial index on disk with chunk 77
      const permitInit = await fixture.acquireSavePermit({
        indexPath,
        vectorCount: 1,
        dimensions: 2,
      })
      index.preauthorizeSave(permitInit)
      await index.add([77], [[1, 0]])
      expect(existsSync(indexPath)).toBe(true)
      expect(index.isHealthy()).toBe(true)

      // Rebuild with permit but hook encounters unknown disk space (fail-closed)
      const permitRebuild = await fixture.acquireRebuildPermit({
        indexPath,
        vectorCount: 1,
        dimensions: 2,
        generation: 2,
      })
      const unknownDiskHooks = fixture.createRebuildHooks(permitRebuild, { unknownDisk: true })

      const denied = await index.rebuildAtomic([88], [[0, 1]], 2, {
        permit: permitRebuild,
        ...unknownDiskHooks,
      })
      expect(denied).toBe(false)
      expect(index.isHealthy()).toBe(false)
      expect(index.getState()).toBe('dirty')

      // Preserves existing old cache index on disk and cleans up any temp rebuild file
      expect(existsSync(indexPath)).toBe(true)
      expect(existsSync(`${indexPath}.rebuild.tmp`)).toBe(false)

      await index.close()

      // Reopening verifies the preserved old cache
      const reopened = new USearchIndex(2, indexPath)
      await reopened.open()
      const hits = reopened.searchSync([1, 0], 1)
      expect(hits).toHaveLength(1)
      expect(hits[0]?.chunkId).toBe(77)
      await reopened.close()
    })

    it('rejects rebuildAtomic when rebuildAdmissionHook encounters unknown disk fail-closed and preserves existing disk index', async () => {
      const indexPath = join(directory, 'denial-admission-unknown-disk.usearch')
      const rebuildAdmissionHook = fixture.createRebuildAdmissionHook({ unknownDisk: true })
      const index = new USearchIndex(2, indexPath, { rebuildAdmissionHook })
      await index.open()

      // Seed initial index on disk
      const permitInit = await fixture.acquireSavePermit({
        indexPath,
        vectorCount: 1,
        dimensions: 2,
      })
      index.preauthorizeSave(permitInit)
      await index.add([55], [[1, 0]])
      expect(existsSync(indexPath)).toBe(true)

      // Rebuild with valid permit but admission hook encounters unknown disk
      const permitRebuild = await fixture.acquireRebuildPermit({
        indexPath,
        vectorCount: 1,
        dimensions: 2,
        generation: 2,
      })
      const denied = await index.rebuildAtomic([66], [[0, 1]], 2, {
        permit: permitRebuild,
        // precheckedAdmission omitted so rebuildAdmissionHook runs
      })
      expect(denied).toBe(false)
      expect(index.getState()).toBe('dirty')
      expect(existsSync(indexPath)).toBe(true)
      expect(existsSync(`${indexPath}.rebuild.tmp`)).toBe(false)

      await index.close()
    })

    it('invalidates sourcecache (dirty) upon unpermitted manual add and restores readiness via permitted rebuild', async () => {
      const indexPath = join(directory, 'manual-add-dirty.usearch')
      const index = new USearchIndex(2, indexPath)
      await index.open()

      expect(index.isHealthy()).toBe(true)
      expect(index.getState()).toBe('ready')

      // Manual add without permit invalidates sourcecache (transitions to dirty)
      await index.add([10], [[1, 0]])
      expect(index.isHealthy()).toBe(false)
      expect(index.getState()).toBe('dirty')

      // Restoring index requires real permitted rebuild
      const permitRebuild = await fixture.acquireRebuildPermit({
        indexPath,
        vectorCount: 1,
        dimensions: 2,
        generation: 1,
      })
      const hooks = fixture.createRebuildHooks(permitRebuild)
      const restored = await index.rebuildAtomic([10], [[1, 0]], 1, {
        permit: permitRebuild,
        ...hooks,
      })
      expect(restored).toBe(true)
      expect(index.isHealthy()).toBe(true)
      expect(index.getState()).toBe('ready')

      // Search succeeds once restored to ready
      const hits = await index.search([1, 0], 1)
      expect(hits).toHaveLength(1)
      expect(hits[0]?.chunkId).toBe(10)

      await index.close()
    })

    it('aborts rebuildAtomic safely when beforeSaveHook or beforeRenameHook rejects', async () => {
      const indexPath = join(directory, 'hook-denial.usearch')
      const index = new USearchIndex(2, indexPath)
      await index.open()

      // Seed initial index
      const permitSeed = await fixture.acquireSavePermit({
        indexPath,
        vectorCount: 1,
        dimensions: 2,
      })
      index.preauthorizeSave(permitSeed)
      await index.add([5], [[1, 0]])
      expect(existsSync(indexPath)).toBe(true)

      // Test beforeSaveHook rejection
      const permitHook1 = await fixture.acquireRebuildPermit({
        indexPath,
        vectorCount: 1,
        dimensions: 2,
        generation: 2,
      })
      const hooksFailingSave = fixture.createRebuildHooks(permitHook1, { failBeforeSave: true })
      const deniedSave = await index.rebuildAtomic([6], [[0, 1]], 2, {
        permit: permitHook1,
        ...hooksFailingSave,
      })
      expect(deniedSave).toBe(false)
      expect(index.getState()).toBe('dirty')
      expect(existsSync(indexPath)).toBe(true)
      expect(existsSync(`${indexPath}.rebuild.tmp`)).toBe(false)

      // Reopen to restore clean handle
      await index.close()
      const index2 = new USearchIndex(2, indexPath)
      await index2.open()

      // Test beforeRenameHook rejection
      const permitHook2 = await fixture.acquireRebuildPermit({
        indexPath,
        vectorCount: 1,
        dimensions: 2,
        generation: 3,
      })
      const hooksFailingRename = fixture.createRebuildHooks(permitHook2, { failBeforeRename: true })
      const deniedRename = await index2.rebuildAtomic([7], [[0, 1]], 3, {
        permit: permitHook2,
        ...hooksFailingRename,
      })
      expect(deniedRename).toBe(false)
      expect(index2.getState()).toBe('dirty')
      expect(existsSync(indexPath)).toBe(true)
      expect(existsSync(`${indexPath}.rebuild.tmp`)).toBe(false)

      await index2.close()
    })
  })

  describe('DocumentMemoryStore ANN hardening (Audit P0 / P1 / A2 / A3 / B4)', () => {
    it('updates indexed_count in ann_indexes on setChunkEmbeddings and rebuildAnnIndex', async () => {
      const dbPath = join(directory, 'test-store.sqlite')
      const store = new DocumentMemoryStore(dbPath, {
        role: 'worker', getStorageBudget: () => fixture.defaultBudget,
        getConfigVersion: () => fixture.configVersion,
      })
      try {
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

        store.ensureEmbeddingSpace({
          id: 'space-1',
          embeddingId: 'space-1',
          repo: 'space-1',
          revision: 'r1',
          pooling: 'last-token',
          dimensions: 2,
        } as any)

        // Seed initial metadata in ann_indexes and perform initial empty rebuild with required host permit
        store.markAnnDirty('space-1')
        const emptyHostPermit = await fixture.acquireHostPermit('space-1', {
          dimensions: 2,
          vectorCount: 0,
          targetGeneration: 1,
        })
        const emptyRebuild = await store.rebuildAnnIndex('space-1', emptyHostPermit)
        expect(emptyRebuild.ok).toBe(true)
        expect(emptyRebuild.count).toBe(0)

        // Preauthorize save permit on worker ANN instance before adding embeddings
        const annInstance = store.getAnnIndex('space-1', 2)
        const addPermit = await fixture.acquireSavePermit({
          indexPath: annInstance.indexPath,
          vectorCount: 2,
          dimensions: 2,
        })
        annInstance.preauthorizeSave(addPermit)

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

        // Rebuild ANN index with required coordinated host permit
        const rebuildHostPermit = await fixture.acquireHostPermit('space-1', {
          dimensions: 2,
          vectorCount: 2,
          targetGeneration: 1,
        })
        const rebuild = await store.rebuildAnnIndex('space-1', rebuildHostPermit)
        expect(rebuild.ok).toBe(true)
        expect(rebuild.count).toBe(2)

        row = store.rawDb
          .prepare('SELECT generation, indexed_count, state FROM ann_indexes WHERE space_id = ?')
          .get('space-1') as { generation: number; indexed_count: number; state: string }
        expect(row.generation).toBe(1)
        expect(row.indexed_count).toBe(2)
        expect(row.state).toBe('ready')

        // Verify DB indexed_count + real native vector retrieval per strict contract
        const rebuiltAnn = store.getAnnIndex('space-1', 2)
        const nativeHits = rebuiltAnn.searchSync([1, 0], 2)
        expect(nativeHits.length).toBeGreaterThanOrEqual(1)
        expect(nativeHits[0]?.chunkId).toBeDefined()
        expect(nativeHits[0]?.distance).toBeCloseTo(0, 4)

        // Preauthorize save permit for migration embeddings
        const migPermit = await fixture.acquireSavePermit({
          indexPath: annInstance.indexPath,
          vectorCount: 2,
          dimensions: 2,
        })
        annInstance.preauthorizeSave(migPermit)

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
      } finally {
        store.close()
      }
    })
  })
})
