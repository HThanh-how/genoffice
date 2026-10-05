import type { AnnHit, AnnIndex } from './ann-index'
import { topVectors } from './top-vectors'

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const valA = a[i]!
    const valB = b[i] ?? 0
    dot += valA * valB
    normA += valA * valA
    normB += valB * valB
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  if (!denom) return 0
  return dot / denom
}

export class ExactVectorIndex implements AnnIndex {
  private readonly vectors = new Map<number, number[]>()

  constructor(initial?: Array<{ chunkId: number; vector: number[] }>) {
    if (initial) {
      for (const item of initial) {
        this.vectors.set(item.chunkId, item.vector)
      }
    }
  }

  async open(): Promise<void> {
    // Exact in-memory index is always ready
  }

  async search(vector: number[], limit: number): Promise<AnnHit[]> {
    if (limit <= 0 || !this.vectors.size) return []

    const scored = Array.from(this.vectors.entries()).map(([chunkId, vec]) => {
      const similarity = cosineSimilarity(vector, vec)
      return {
        id: chunkId,
        score: similarity,
      }
    })

    const top = topVectors(scored, limit)
    return top.map((hit) => ({
      chunkId: hit.id,
      distance: 1 - hit.score,
    }))
  }

  async add(chunkIds: number[], vectors: number[][]): Promise<void> {
    for (let i = 0; i < chunkIds.length; i++) {
      const id = chunkIds[i]!
      const vec = vectors[i]
      if (vec) {
        this.vectors.set(id, vec)
      }
    }
  }

  async remove(chunkIds: number[]): Promise<void> {
    for (const id of chunkIds) {
      this.vectors.delete(id)
    }
  }

  async rebuild(): Promise<void> {
    // Exact index is always consistent with its added vectors
  }

  async close(): Promise<void> {
    this.vectors.clear()
  }

  size(): number {
    return this.vectors.size
  }

  getAllEntries(): IterableIterator<[number, number[]]> {
    return this.vectors.entries()
  }
}
