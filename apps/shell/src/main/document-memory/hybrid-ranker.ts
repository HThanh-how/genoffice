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

export interface FusedHit {
  chunkId: number
  score: number
}

/**
 * Combines lexical and semantic ranks with reciprocal rank fusion (RRF),
 * optional recency weighting, and document diversification (e.g. max 2 chunks per doc).
 */
export function fuseHybridResults(
  lexical: RankedCandidate[],
  semantic: RankedCandidate[],
  options: HybridFuseOptions = {},
): FusedHit[] {
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

  const finalScores = new Map<number, number>()
  for (const [chunkId, rrfScore] of scores) {
    finalScores.set(chunkId, rrfScore + (recency.get(chunkId) ?? 0))
  }

  const sorted = [...scores.keys()].sort((a, b) => {
    const scoreA = finalScores.get(a) ?? 0
    const scoreB = finalScores.get(b) ?? 0
    return scoreB - scoreA || a - b
  })

  // Apply document diversification (max chunks per document)
  const docCounts = new Map<number, number>()
  const selected: FusedHit[] = []

  for (const chunkId of sorted) {
    const docId = chunkToDoc.get(chunkId)
    if (docId !== undefined) {
      const count = docCounts.get(docId) ?? 0
      if (count >= maxPerDoc) continue
      docCounts.set(docId, count + 1)
    }
    selected.push({ chunkId, score: finalScores.get(chunkId) ?? 0 })
    if (selected.length >= limit) break
  }

  // If diversification filtered too aggressively and we have fewer than limit,
  // backfill remaining chunks without exceeding limit
  if (selected.length < limit && selected.length < sorted.length) {
    const selectedSet = new Set(selected.map((s) => s.chunkId))
    for (const chunkId of sorted) {
      if (!selectedSet.has(chunkId)) {
        selected.push({ chunkId, score: finalScores.get(chunkId) ?? 0 })
        if (selected.length >= limit) break
      }
    }
  }

  return selected
}

/** Convenience helper returning only chunk IDs */
export function fuseHybridResultIds(
  lexical: RankedCandidate[],
  semantic: RankedCandidate[],
  options: HybridFuseOptions = {},
): number[] {
  return fuseHybridResults(lexical, semantic, options).map((h) => h.chunkId)
}
