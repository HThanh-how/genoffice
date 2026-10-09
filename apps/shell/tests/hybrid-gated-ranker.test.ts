import { describe, expect, it } from 'vitest'
import {
  fuseHybridResultIds,
  fuseHybridResults,
  isShortOrIdentifierQuery,
  isStrictLexicalStage,
  type RankedCandidate,
} from '../src/main/document-memory/hybrid-ranker'

/**
 * Synthetic exact-token corpus: one chunk holds the code / amount / name the user typed (the only
 * strict lexical hit), plain RRF cannot put it first because a look-alike decoy sits at lexical rank 2
 * (the "any word" stage) while the dense model loves it, and the real chunk is far down the dense list.
 */
function scenario(strictFlag = true) {
  const TARGET = 1
  const DECOY = 2
  const lexical: RankedCandidate[] = [
    { chunkId: TARGET, rank: 1, documentId: 10, ...(strictFlag ? { strict: true } : {}) },
    { chunkId: DECOY, rank: 2, documentId: 20 },
    ...Array.from({ length: 6 }, (_, i) => ({ chunkId: 100 + i, rank: 3 + i, documentId: 100 + i })),
  ]
  const semantic: RankedCandidate[] = [
    { chunkId: DECOY, rank: 1, documentId: 20 },
    ...Array.from({ length: 38 }, (_, i) => ({ chunkId: 200 + i, rank: 2 + i, documentId: 200 + i })),
    { chunkId: TARGET, rank: 40, documentId: 10 },
  ]
  return { TARGET, DECOY, lexical, semantic }
}

describe('gated hybrid', () => {
  it('documents the problem: plain RRF ranks the look-alike decoy above the only exact match', () => {
    const { TARGET, DECOY, lexical, semantic } = scenario()
    const plain = fuseHybridResultIds(lexical, semantic, { limit: 5 })
    expect(plain.indexOf(DECOY)).toBeLessThan(plain.indexOf(TARGET))
  })

  it.each([
    ['a document code', 'HD-2024-00871'],
    ['a bare amount typed without separators', '16432095'],
    ['an amount with thousands separators', '16.432.095'],
    ['a diacritic-less person name', 'nguyen van an'],
    ['a four-word query', 'bien ban nghiem thu'],
    ['a long query that contains a digit', 'tìm hợp đồng thuê nhà số 12 ký năm ngoái cho công ty'],
  ])('puts the single strict lexical hit first for %s', (_label, text) => {
    const { TARGET, lexical, semantic } = scenario()
    const fused = fuseHybridResultIds(lexical, semantic, { limit: 5, query: { text } })
    expect(fused[0]).toBe(TARGET)
    expect(fused).toHaveLength(5)
  })

  it('does not gate a long natural-language query without digits', () => {
    const { lexical, semantic } = scenario()
    const text = 'tìm cho tôi hợp đồng thuê nhà mà chúng ta đã ký năm ngoái'
    expect(isShortOrIdentifierQuery(text)).toBe(false)
    const gated = fuseHybridResultIds(lexical, semantic, { limit: 8, query: { text, tier: 'base' } })
    expect(gated).toEqual(fuseHybridResultIds(lexical, semantic, { limit: 8 }))
  })

  it('does not gate when there is no strict hit or more than three', () => {
    const { lexical, semantic } = scenario()
    const none = lexical.map((c) => ({ ...c, strict: false }))
    expect(fuseHybridResultIds(none, semantic, { limit: 8, query: { text: 'HD-1' } })).toEqual(
      fuseHybridResultIds(none, semantic, { limit: 8 }),
    )
    const four = lexical.map((c, i) => ({ ...c, strict: i < 4 }))
    expect(fuseHybridResultIds(four, semantic, { limit: 8, query: { text: 'HD-1' } })).toEqual(
      fuseHybridResultIds(four, semantic, { limit: 8 }),
    )
  })

  it('pins up to three strict hits in lexical order, then lets RRF fill the rest', () => {
    const { lexical, semantic } = scenario()
    const three = lexical.map((c, i) => ({ ...c, strict: i < 3 })) // chunk 1, 2 (decoy) and 100
    const fused = fuseHybridResultIds(three, semantic, { limit: 6, query: { text: 'HD-2024-00871' } })
    expect(fused.slice(0, 3)).toEqual([1, 2, 100])
    const plain = fuseHybridResultIds(three, semantic, { limit: 12 }).filter((id) => ![1, 2, 100].includes(id))
    expect(fused.slice(3)).toEqual(plain.slice(0, 3))
  })

  it('accepts a bare strict-hit count when candidates carry no flags', () => {
    const { TARGET, lexical, semantic } = scenario(false)
    const fused = fuseHybridResultIds(lexical, semantic, {
      limit: 4,
      query: { text: 'HD-2024-00871', strictLexicalHits: 1 },
    })
    expect(fused[0]).toBe(TARGET)
  })

  it('keeps the per-document cap on gated hits', () => {
    const lexical: RankedCandidate[] = [1, 2, 3].map((id, i) => ({ chunkId: id, rank: i + 1, documentId: 7, strict: true }))
    const semantic: RankedCandidate[] = [50, 51, 52].map((id, i) => ({ chunkId: id, rank: i + 1, documentId: id }))
    const fused = fuseHybridResultIds(lexical, semantic, { limit: 3, maxChunksPerDocument: 2, query: { text: 'ma 123' } })
    expect(fused.slice(0, 2)).toEqual([1, 2])
    expect(fused).not.toContain(3)
    expect(fused).toContain(50)
  })

  it('reports the plain RRF score for gated hits so callers keep the same scale', () => {
    const { TARGET, lexical, semantic } = scenario()
    const plain = fuseHybridResults(lexical, semantic, { limit: 5 })
    const gated = fuseHybridResults(lexical, semantic, { limit: 5, query: { text: 'HD-1' } })
    expect(gated[0]!.chunkId).toBe(TARGET)
    expect(Math.max(...gated.map((h) => h.score))).toBeLessThan(0.1)
    expect(gated.find((h) => h.chunkId === TARGET)!.score).toBe(plain.find((h) => h.chunkId === TARGET)!.score)
  })
})

describe('query shape and strict stages', () => {
  it('counts word tokens and digits the way the benchmark did', () => {
    expect(isShortOrIdentifierQuery('hợp đồng thuê nhà')).toBe(true) // 4 tokens
    expect(isShortOrIdentifierQuery('hợp đồng thuê nhà ký')).toBe(false) // 5 tokens
    expect(isShortOrIdentifierQuery('hợp đồng thuê nhà ký ngày 15')).toBe(true) // digit
    expect(isShortOrIdentifierQuery('')).toBe(true)
  })
  it('treats every stage but the last "any word" fallback as strict', () => {
    expect(isStrictLexicalStage(0, 1)).toBe(true)
    expect(isStrictLexicalStage(0, 3)).toBe(true)
    expect(isStrictLexicalStage(1, 3)).toBe(true)
    expect(isStrictLexicalStage(2, 3)).toBe(false)
    expect(isStrictLexicalStage(0, 2)).toBe(true)
    expect(isStrictLexicalStage(1, 2)).toBe(false)
  })
})

describe('adaptive weighting', () => {
  // a long natural-language query where lexical and dense disagree about the best chunk
  const text = 'tìm cho tôi tài liệu hướng dẫn cách đăng nhập vào phần mềm kế toán của công ty'
  const lexical: RankedCandidate[] = [
    { chunkId: 1, rank: 1, documentId: 1 },
    { chunkId: 2, rank: 2, documentId: 2 },
    { chunkId: 3, rank: 3, documentId: 3 },
  ]
  const semantic: RankedCandidate[] = [
    { chunkId: 3, rank: 1, documentId: 3 },
    { chunkId: 2, rank: 2, documentId: 2 },
    { chunkId: 1, rank: 3, documentId: 1 },
  ]
  it('leans toward the dense model on mid and high tiers only', () => {
    expect(fuseHybridResultIds(lexical, semantic, { limit: 3, query: { text, tier: 'mid' } })[0]).toBe(3)
    expect(fuseHybridResultIds(lexical, semantic, { limit: 3, query: { text, tier: 'high' } })[0]).toBe(3)
    for (const tier of ['base', 'default', 'legacy'] as const)
      expect(fuseHybridResultIds(lexical, semantic, { limit: 3, query: { text, tier } })[0]).toBe(1)
    expect(fuseHybridResultIds(lexical, semantic, { limit: 3, query: { text } })[0]).toBe(1)
    expect(fuseHybridResultIds(lexical, semantic, { limit: 3 })[0]).toBe(1)
  })
  it('never applies to short or identifier queries, even on a strong tier', () => {
    expect(fuseHybridResultIds(lexical, semantic, { limit: 3, query: { text: 'đăng nhập', tier: 'high' } })[0]).toBe(1)
  })
})

describe('gate and ties', () => {
  it('keeps the recency / RRF order among strict hits that share a lexical rank', () => {
    const lexical: RankedCandidate[] = [
      { chunkId: 1, rank: 1, documentId: 1, strict: true },
      { chunkId: 2, rank: 1, documentId: 2, strict: true, recencyBoost: 0.00002 },
    ]
    expect(fuseHybridResultIds(lexical, [], { limit: 2, query: { text: 'shared exact tie phrase' } })).toEqual([2, 1])
  })
  it('puts a better lexical rank first even when a worse-ranked strict hit is more similar', () => {
    const lexical: RankedCandidate[] = [
      { chunkId: 1, rank: 1, documentId: 1, strict: true },
      { chunkId: 2, rank: 2, documentId: 2, strict: true },
    ]
    const semantic: RankedCandidate[] = [{ chunkId: 2, rank: 1, documentId: 2 }]
    expect(fuseHybridResultIds(lexical, semantic, { limit: 2, query: { text: 'HD-2024-00871' } })).toEqual([1, 2])
  })
})
