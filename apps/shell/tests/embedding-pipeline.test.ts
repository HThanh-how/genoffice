import { describe, expect, it } from 'vitest'
import { EMBEDDING_PROFILES, type EmbeddingProfile } from '../src/main/document-memory/embedding-profiles'
import { HARRIER_270M } from '../src/main/document-memory/embedding/model-specs'
import {
  buildFeeds,
  finishVector,
  formatEmbeddingInput,
  l2Normalize,
  mergeHalves,
  poolOutput,
  truncateAndNormalize,
} from '../src/main/document-memory/embedding/pipeline'
import { roundTripInt8 } from '../src/main/document-memory/embedding/vector-codec'

const norm = (v: ArrayLike<number>) => Math.sqrt(Array.from(v).reduce((s, n) => s + n * n, 0))

describe('prefixes and templates', () => {
  it('Bekko takes the raw text for both kinds', () => {
    for (const id of ['base', 'balanced'] as const) {
      expect(formatEmbeddingInput(EMBEDDING_PROFILES[id], 'query', 'hóa đơn HD-1')).toBe('hóa đơn HD-1')
      expect(formatEmbeddingInput(EMBEDDING_PROFILES[id], 'passage', 'nội dung')).toBe('nội dung')
    }
  })
  it('EmbeddingGemma-2 uses the search-result query template and the untitled document template', () => {
    for (const id of ['mid', 'plus'] as const) {
      expect(formatEmbeddingInput(EMBEDDING_PROFILES[id], 'query', 'tiền thuê nhà')).toBe(
        'task: search result | query: tiền thuê nhà',
      )
      expect(formatEmbeddingInput(EMBEDDING_PROFILES[id], 'passage', 'Hợp đồng')).toBe('title: none | text: Hợp đồng')
    }
  })
  it('the legacy and Harrier instruction wrapper only touches queries', () => {
    expect(formatEmbeddingInput(EMBEDDING_PROFILES.standard, 'query', 'x')).toMatch(/^Instruct: Given a user query.*\nQuery: x$/s)
    expect(formatEmbeddingInput(EMBEDDING_PROFILES.standard, 'passage', 'x')).toBe('x')
    const harrier = { ...EMBEDDING_PROFILES.mid, queryInstruction: HARRIER_270M.queryInstruction, queryPrefix: '', passagePrefix: '' }
    expect(formatEmbeddingInput(harrier, 'query', 'x')).toContain('\nQuery: x')
    expect(formatEmbeddingInput(harrier, 'passage', 'x')).toBe('x')
  })
})

describe('Matryoshka truncation and normalisation', () => {
  it('truncates a unit 768d vector to 512d and re-normalises it', () => {
    const native = l2Normalize(Array.from({ length: 768 }, (_, i) => Math.sin(i + 1) + 0.3))
    const naive = native.slice(0, 512)
    expect(norm(naive)).toBeLessThan(0.999) // truncating alone breaks the unit norm
    const out = truncateAndNormalize(native, 512)
    expect(out).toHaveLength(512)
    expect(norm(out)).toBeCloseTo(1, 12)
    // same direction as the leading components
    const ratio = out[0]! / native[0]!
    for (let i = 0; i < 512; i++) expect(out[i]! / native[i]!).toBeCloseTo(ratio, 9)
  })
  it('does not truncate when the stored width is the native width', () => {
    expect(truncateAndNormalize([3, 4], 2)).toEqual([0.6, 0.8])
  })
  it('rejects zero and non-finite vectors', () => {
    expect(() => l2Normalize([0, 0])).toThrow('Invalid embedding')
    expect(() => l2Normalize([1, Number.NaN])).toThrow('Invalid embedding')
  })
  it('merges two halves of an over-long text into one unit vector', () => {
    const merged = mergeHalves([1, 0], [0, 1])
    expect(norm(merged)).toBeCloseTo(1, 12)
    expect(merged[0]).toBeCloseTo(merged[1]!, 12)
  })
})

describe('pooling', () => {
  const profile = (over: Partial<EmbeddingProfile>): EmbeddingProfile => ({ ...EMBEDDING_PROFILES.base, ...over })

  it('mean pools only the attended tokens (Bekko)', () => {
    const base = profile({ pooling: 'mean', dimensions: 2, nativeDimensions: 2 })
    // 3 tokens, the last one is padding and must be ignored
    const hidden = { data: [1, 0, 0, 1, 100, 100], tokens: 3, width: 2 }
    const out = poolOutput(base, { hidden, attentionMask: [1, 1, 0] })
    expect(out[0]).toBeCloseTo(Math.SQRT1_2, 12)
    expect(out[1]).toBeCloseTo(Math.SQRT1_2, 12)
  })
  it('mean pooling truncates the pooled vector, then re-normalises', () => {
    const p = profile({ pooling: 'mean', dimensions: 2, nativeDimensions: 4 })
    const out = poolOutput(p, { hidden: { data: [3, 4, 100, 100], tokens: 1, width: 4 }, attentionMask: [1] })
    expect(out).toHaveLength(2)
    expect(out[0]).toBeCloseTo(0.6, 12)
    expect(out[1]).toBeCloseTo(0.8, 12)
  })
  it('takes the graph sentence embedding as is for EmbeddingGemma-2, truncated to 512', () => {
    const sentence = l2Normalize(Array.from({ length: 768 }, (_, i) => Math.cos(i) + 0.1))
    const out = poolOutput(EMBEDDING_PROFILES.mid, { sentenceEmbedding: sentence, attentionMask: [1] })
    expect(out).toHaveLength(512)
    expect(norm(out)).toBeCloseTo(1, 12)
    expect(() => poolOutput(EMBEDDING_PROFILES.mid, { attentionMask: [1] })).toThrow('sentence_embedding')
  })
  it('takes the last attended token for the legacy last-token profiles', () => {
    const p = profile({ pooling: 'last-token', dimensions: 2, nativeDimensions: 2 })
    const out = poolOutput(p, { hidden: { data: [1, 0, 0, 2, 9, 9], tokens: 3, width: 2 }, attentionMask: [1, 1, 0] })
    expect(out).toEqual([0, 1])
  })
  it('fails loudly when the stored width does not match', () => {
    const p = profile({ pooling: 'mean', dimensions: 3, nativeDimensions: 2 })
    expect(() => poolOutput(p, { hidden: { data: [1, 2], tokens: 1, width: 2 }, attentionMask: [1] })).toThrow('dimension mismatch')
  })
})

describe('stored form of a vector', () => {
  const unit = l2Normalize(Array.from({ length: 384 }, (_, i) => Math.sin(i * 1.7) + 0.05))
  it('rounds passages of an int8 profile through the int8 grid, queries stay float', () => {
    expect(finishVector(EMBEDDING_PROFILES.base, 'passage', unit)).toEqual(roundTripInt8(unit))
    expect(finishVector(EMBEDDING_PROFILES.base, 'query', unit)).toEqual(unit)
  })
  it('leaves fp32 profiles untouched', () => {
    const v = l2Normalize(Array.from({ length: 320 }, (_, i) => Math.sin(i)))
    expect(finishVector(EMBEDDING_PROFILES.standard, 'passage', v)).toEqual(v)
  })
  it('rejects a vector of the wrong width', () => {
    expect(() => finishVector(EMBEDDING_PROFILES.base, 'passage', [1, 0])).toThrow('dimension mismatch')
  })
})

describe('model inputs', () => {
  it('adds the empty multimodal inputs only for models that declare them', () => {
    const withExtras = buildFeeds(EMBEDDING_PROFILES.mid, ['input_ids', 'attention_mask', 'image_features', 'video_features', 'audio_features'], [2, 5, 1], [1, 1, 1])
    expect(Object.keys(withExtras)).toEqual(['input_ids', 'attention_mask', 'image_features', 'video_features', 'audio_features'])
    expect(withExtras.image_features!.dims).toEqual([0, 512])
    expect(withExtras.input_ids!.dims).toEqual([1, 3])
    const bekko = buildFeeds(EMBEDDING_PROFILES.base, ['input_ids', 'attention_mask'], [2, 5, 1], [1, 1, 1])
    expect(Object.keys(bekko)).toEqual(['input_ids', 'attention_mask'])
    const bert = buildFeeds(EMBEDDING_PROFILES.base, ['input_ids', 'attention_mask', 'token_type_ids'], [2], [1])
    expect(bert.token_type_ids!.dims).toEqual([1, 1])
  })
})
