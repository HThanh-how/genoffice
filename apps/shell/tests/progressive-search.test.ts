import { describe, expect, it } from 'vitest'
import { fuseHybridResultIds } from '../src/main/document-memory/hybrid-ranker'
import { QueryEmbeddingCache } from '../src/main/document-memory/query-embedding-cache'

describe('Progressive Search, RRF Fusion & Query Cache', () => {
  describe('Hybrid Ranker (RRF & Diversification)', () => {
    it('combines lexical and semantic ranks with Reciprocal Rank Fusion', () => {
      // Chunk 1 is top in lexical, Chunk 2 is top in semantic
      const lexical = [
        { chunkId: 1, rank: 1, documentId: 10 },
        { chunkId: 2, rank: 2, documentId: 20 },
      ]
      const semantic = [
        { chunkId: 2, rank: 1, documentId: 20 },
        { chunkId: 3, rank: 2, documentId: 30 },
      ]

      const fused = fuseHybridResultIds(lexical, semantic, { limit: 3 })
      expect(fused).toContain(1)
      expect(fused).toContain(2)
      // Chunk 2 appears in both lexical and semantic, so its fused score is highest
      expect(fused[0]).toBe(2)
    })

    it('enforces diversification: max 2 chunks per document', () => {
      // Document 100 has 4 chunks
      const lexical = [
        { chunkId: 101, rank: 1, documentId: 100 },
        { chunkId: 102, rank: 2, documentId: 100 },
        { chunkId: 103, rank: 3, documentId: 100 },
        { chunkId: 104, rank: 4, documentId: 100 },
        { chunkId: 201, rank: 5, documentId: 200 },
      ]
      const semantic: Array<{ chunkId: number; rank: number; documentId: number }> = []

      const fused = fuseHybridResultIds(lexical, semantic, {
        limit: 3,
        maxChunksPerDocument: 2,
      })

      // Must take at most 2 chunks from doc 100, then take doc 200
      expect(fused).toHaveLength(3)
      const doc100Chunks = fused.filter((id) => [101, 102, 103, 104].includes(id))
      expect(doc100Chunks).toHaveLength(2)
      expect(fused).toContain(201)
    })

    it('applies recency boost to settle ties', () => {
      const lexical = [
        { chunkId: 1, rank: 1, documentId: 10 },
        { chunkId: 2, rank: 1, documentId: 20 },
      ]
      const recencyScores = new Map<number, number>([
        [1, 0.001], // Chunk 1 opened recently
        [2, 0.000],
      ])

      const fused = fuseHybridResultIds(lexical, [], {
        limit: 2,
        recencyScores,
      })
      expect(fused[0]).toBe(1)
    })
  })

  describe('QueryEmbeddingCache', () => {
    it('caches query vectors isolated by embeddingSpaceId', () => {
      const cache = new QueryEmbeddingCache(4)
      const vecF2 = [0.1, 0.2]
      const vecQwen = [0.9, 0.8]

      cache.set('f2-space', 'search query', vecF2)
      cache.set('qwen-space', 'search query', vecQwen)

      expect(cache.get('f2-space', 'search query')).toEqual(vecF2)
      expect(cache.get('qwen-space', 'search query')).toEqual(vecQwen)
      expect(cache.get('other-space', 'search query')).toBeUndefined()
    })

    it('evicts oldest entries when capacity is exceeded', () => {
      const cache = new QueryEmbeddingCache(2)
      cache.set('space', 'q1', [1])
      cache.set('space', 'q2', [2])
      cache.set('space', 'q3', [3])

      expect(cache.get('space', 'q1')).toBeUndefined() // evicted
      expect(cache.get('space', 'q2')).toEqual([2])
      expect(cache.get('space', 'q3')).toEqual([3])
    })
  })
})
