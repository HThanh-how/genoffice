import type { EmbeddingTier } from './embedding-profiles'

export interface RankedCandidate {
  chunkId: number
  rank: number
  documentId?: number
  recencyBoost?: number
  /**
   * Lexical candidates only: the hit came from a strict stage of the lexical plan (exact phrase
   * or all words), not from the "any word" fallback. See isStrictLexicalStage().
   */
  strict?: boolean
}

/** What the ranker needs to know about the query to gate exact-token matches (optional). */
export interface HybridQueryInfo {
  /** the raw query text */
  text: string
  /** embedding tier of the active space; enables the adaptive weighting on mid/high only */
  tier?: EmbeddingTier
  /** number of strict lexical hits; defaults to the count of candidates flagged `strict` */
  strictLexicalHits?: number
}

export interface HybridFuseOptions {
  limit?: number
  maxChunksPerDocument?: number
  chunkToDocument?: Map<number, number>
  recencyScores?: Map<number, number>
  /**
   * Turns on the gated hybrid (and, for strong dense tiers, the adaptive weighting). Without it
   * the fusion is exactly the plain lexical 2 : dense 1 RRF, so existing call sites are unchanged.
   */
  query?: HybridQueryInfo
}

/** Strict gate: at most this many strict lexical hits are pinned above the RRF order. */
export const GATE_MAX_STRICT_HITS = 3
/** A query with at most this many word tokens counts as "short". */
export const GATE_MAX_SHORT_TOKENS = 4
/** Tiers whose dense model is strong enough for the long-natural-language 1 : 2 weighting. */
const ADAPTIVE_TIERS: ReadonlySet<EmbeddingTier> = new Set<EmbeddingTier>(['mid', 'high'])

/**
 * Stage `stage` (0-based) of a lexical match plan of `planLength` stages is strict when it is
 * not the final "any word" fallback; a single-stage plan (one word) is strict by definition.
 */
export function isStrictLexicalStage(stage: number, planLength: number): boolean {
  return planLength <= 1 || stage <= planLength - 2
}

const WORD = /[\p{L}\p{N}_]+/gu

/** Short = up to four word tokens, or any token with a digit (codes, amounts, dates). */
export function isShortOrIdentifierQuery(text: string): boolean {
  const tokens = text.match(WORD) ?? []
  return tokens.length <= GATE_MAX_SHORT_TOKENS || tokens.some((token) => /\p{N}/u.test(token))
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

  const query = options.query
  const short = query ? isShortOrIdentifierQuery(query.text) : true
  // Adaptive weighting: long natural-language queries lean on the dense model, but only where the
  // benchmark showed it helps (strong tiers); base/default/legacy keep lexical 2 : dense 1.
  const adaptive = !!query && !short && !!query.tier && ADAPTIVE_TIERS.has(query.tier)
  const lexicalWeight = adaptive ? 1 : 2
  const semanticWeight = adaptive ? 2 : 1

  for (const item of lexical) {
    if (item.documentId !== undefined && !chunkToDoc.has(item.chunkId)) {
      chunkToDoc.set(item.chunkId, item.documentId)
    }
    if (item.recencyBoost !== undefined && !recency.has(item.chunkId)) {
      recency.set(item.chunkId, item.recencyBoost)
    }
    const current = scores.get(item.chunkId) ?? 0
    scores.set(item.chunkId, current + lexicalWeight / (60 + item.rank))
  }

  for (const item of semantic) {
    if (item.documentId !== undefined && !chunkToDoc.has(item.chunkId)) {
      chunkToDoc.set(item.chunkId, item.documentId)
    }
    if (item.recencyBoost !== undefined && !recency.has(item.chunkId)) {
      recency.set(item.chunkId, item.recencyBoost)
    }
    const current = scores.get(item.chunkId) ?? 0
    scores.set(item.chunkId, current + semanticWeight / (60 + item.rank))
  }

  if (!scores.size) return []

  const finalScores = new Map<number, number>()
  for (const [chunkId, rrfScore] of scores) {
    finalScores.set(chunkId, rrfScore + (recency.get(chunkId) ?? 0))
  }

  // Order by this; the reported score stays the plain RRF (+recency) score so callers that show or
  // threshold it see the same scale as before.
  const orderScores = new Map(finalScores)

  // Gated hybrid: a short or identifier-like query with one to three strict lexical hits (a code,
  // an amount, an exact name) puts those hits first, in lexical order; RRF fills the rest.
  if (query && short) {
    const strictHits =
      query.strictLexicalHits ?? lexical.reduce((count, item) => count + (item.strict ? 1 : 0), 0)
    if (strictHits >= 1 && strictHits <= GATE_MAX_STRICT_HITS) {
      // Without per-hit flags the count alone says the first `strictHits` lexical hits are the strict ones.
      const flagged = lexical.filter((item) => item.strict)
      const head = [...(flagged.length ? flagged : lexical)]
        .sort((a, b) => a.rank - b.rank)
        .slice(0, strictHits)
      // Tied lexical ranks get the same bonus, so the plain RRF + recency score still settles a tie.
      for (const item of head) {
        orderScores.set(item.chunkId, (orderScores.get(item.chunkId) ?? 0) + GATE_BONUS - (item.rank - 1) * GATE_STEP)
      }
    }
  }

  const sorted = [...scores.keys()].sort((a, b) => {
    const scoreA = orderScores.get(a) ?? 0
    const scoreB = orderScores.get(b) ?? 0
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

/** Added to a gated hit so it outranks every plain RRF score (below ~0.05 plus recency); one step per lexical rank (<= 200) keeps lexical order among gated hits. */
const GATE_BONUS = 1000
const GATE_STEP = 1

/** Convenience helper returning only chunk IDs */
export function fuseHybridResultIds(
  lexical: RankedCandidate[],
  semantic: RankedCandidate[],
  options: HybridFuseOptions = {},
): number[] {
  return fuseHybridResults(lexical, semantic, options).map((h) => h.chunkId)
}
