import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ANN_MIN_VECTORS } from '../src/main/document-memory/ann-index'
import { ExactVectorIndex } from '../src/main/document-memory/exact-vector-index'
import { USearchIndex } from '../src/main/document-memory/usearch-index'

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
  })
})
