/**
 * LRU cache for query vector embeddings.
 * Keyed by embeddingSpaceId and query text to prevent cross-space pollution.
 */
export class QueryEmbeddingCache {
  private readonly maxEntries: number
  private readonly map = new Map<string, number[]>()

  constructor(maxEntries = 64) {
    this.maxEntries = maxEntries
  }

  private makeKey(embeddingSpaceId: string, query: string): string {
    return `${embeddingSpaceId}:${query.trim()}`
  }

  get(embeddingSpaceId: string, query: string): number[] | undefined {
    const key = this.makeKey(embeddingSpaceId, query)
    const val = this.map.get(key)
    if (val !== undefined) {
      // Refresh recency
      this.map.delete(key)
      this.map.set(key, val)
    }
    return val
  }

  set(embeddingSpaceId: string, query: string, vector: number[]): void {
    const key = this.makeKey(embeddingSpaceId, query)
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.maxEntries) {
      const oldestKey = this.map.keys().next().value
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey)
      }
    }
    this.map.set(key, vector)
  }

  clear(): void {
    this.map.clear()
  }

  size(): number {
    return this.map.size
  }
}
