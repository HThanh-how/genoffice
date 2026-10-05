export interface RankedCandidate {
  chunkId: number
  rank: number
  documentId?: number
  recencyBoost?: number
}

export interface HybridFuseOptions {
  limit?: number
  maxChunksPerDocument?: number
  chunkToDocument?: Map<number, number>
  recencyScores?: Map<number, number>
}

/**
 * Combines lexical and semantic ranks with reciprocal rank fusion (RRF),
 * optional recency weighting, and document diversification (e.g. max 2 chunks per doc).
 */
export function fuseHybridResults(
  lexical: RankedCandidate[],
  semantic: RankedCandidate[],
  options: HybridFuseOptions = {},
): number[] {
  const limit = options.limit ?? 8
  const maxPerDoc = options.maxChunksPerDocument ?? 2
  const chunkToDoc = options.chunkToDocument ?? new Map<number, number>()
  const recency = options.recencyScores ?? new Map<number, number>()

  const scores = new Map<number, number>()

  for (const item of lexical) {
    if (item.documentId !== undefined && !chunkToDoc.has(item.chunkId)) {
      chunkToDoc.set(item.chunkId, item.documentId)
    }
    if (item.recencyBoost !== undefined && !recency.has(item.chunkId)) {
      recency.set(item.chunkId, item.recencyBoost)
    }
    const current = scores.get(item.chunkId) ?? 0
    scores.set(item.chunkId, current + 2 / (60 + item.rank))
  }

  for (const item of semantic) {
    if (item.documentId !== undefined && !chunkToDoc.has(item.chunkId)) {
      chunkToDoc.set(item.chunkId, item.documentId)
    }
    if (item.recencyBoost !== undefined && !recency.has(item.chunkId)) {
      recency.set(item.chunkId, item.recencyBoost)
    }
    const current = scores.get(item.chunkId) ?? 0
    scores.set(item.chunkId, current + 1 / (60 + item.rank))
  }

  if (!scores.size) return []

  const sorted = [...scores.entries()].sort((a, b) => {
    const scoreA = a[1] + (recency.get(a[0]) ?? 0)
    const scoreB = b[1] + (recency.get(b[0]) ?? 0)
    return scoreB - scoreA || a[0] - b[0]
  })

  // Apply document diversification (max chunks per document)
  const docCounts = new Map<number, number>()
  const selected: number[] = []

  for (const [chunkId] of sorted) {
    const docId = chunkToDoc.get(chunkId)
    if (docId !== undefined) {
      const count = docCounts.get(docId) ?? 0
      if (count >= maxPerDoc) continue
      docCounts.set(docId, count + 1)
    }
    selected.push(chunkId)
    if (selected.length >= limit) break
  }

  // If diversification filtered too aggressively and we have fewer than limit,
  // backfill remaining chunks without exceeding limit
  if (selected.length < limit && selected.length < sorted.length) {
    const selectedSet = new Set(selected)
    for (const [chunkId] of sorted) {
      if (!selectedSet.has(chunkId)) {
        selected.push(chunkId)
        if (selected.length >= limit) break
      }
    }
  }

  return selected
}
