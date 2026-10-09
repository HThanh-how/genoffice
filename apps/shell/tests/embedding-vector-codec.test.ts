import { describe, expect, it } from 'vitest'
import {
  INT8_SCALE_BYTES,
  cosineWithInt8Blob,
  decodeInt8Blob,
  decodeVectorBlob,
  dequantiseInt8,
  encodeInt8Blob,
  encodeVectorBlob,
  isValidVectorBlobLength,
  quantiseInt8,
  roundTripInt8,
  vectorBlobBytes,
} from '../src/main/document-memory/embedding/vector-codec'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'
import {
  decodeStoredVector,
  detectBlobQuantisation,
  encodeVectorForSpace,
  isStoredVectorLength,
  quantisationForSpace,
} from '../src/main/document-memory/embedding/storage-codec'

/** Deterministic pseudo-random unit vectors (no Math.random so failures reproduce). */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}
function gaussian(next: () => number): number {
  return Math.sqrt(-2 * Math.log(next() || 1e-12)) * Math.cos(2 * Math.PI * next())
}
function unitVector(next: () => number, dimensions: number): number[] {
  const raw = Array.from({ length: dimensions }, () => gaussian(next))
  const norm = Math.sqrt(raw.reduce((sum, n) => sum + n * n, 0))
  return raw.map((n) => n / norm)
}
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!
  return sum
}
const cosine = (a: ArrayLike<number>, b: ArrayLike<number>) => dot(a, b) / Math.sqrt(dot(a, a) * dot(b, b))

describe('int8 vector codec', () => {
  it.each([384, 512])('round-trips a %i-d unit vector with cosine error below 1e-4', (dimensions) => {
    const next = rng(dimensions)
    for (let i = 0; i < 50; i++) {
      const vector = unitVector(next, dimensions)
      const { scale, values } = quantiseInt8(vector)
      const back = dequantiseInt8(values, scale)
      expect(1 - cosine(vector, back)).toBeLessThan(1e-4)
      // symmetric grid: no component is off by more than half a quantisation step
      for (let j = 0; j < dimensions; j++) expect(Math.abs(vector[j]! - back[j]!)).toBeLessThanOrEqual(scale / 2 + 1e-12)
      // the largest component is exactly representable
      expect(Math.max(...Array.from(values, Math.abs))).toBe(127)
    }
  })

  it('is idempotent, so a rounded vector stores losslessly', () => {
    const next = rng(7)
    for (let i = 0; i < 25; i++) {
      const once = roundTripInt8(unitVector(next, 512))
      expect(roundTripInt8(once)).toEqual(once)
      const blob = encodeInt8Blob(once)
      expect(Array.from(decodeInt8Blob(blob, 512))).toEqual(once.map(Math.fround))
      expect(Array.from(encodeInt8Blob(Array.from(decodeInt8Blob(blob, 512))))).toEqual(Array.from(blob))
    }
  })

  it('stores dim + 4 bytes instead of dim * 4', () => {
    const vector = unitVector(rng(3), 384)
    expect(encodeInt8Blob(vector).byteLength).toBe(384 + INT8_SCALE_BYTES)
    expect(encodeVectorBlob(vector, 'fp32').byteLength).toBe(384 * 4)
    expect(vectorBlobBytes(384, 'int8')).toBe(388)
    expect(vectorBlobBytes(512, 'int8')).toBe(516)
    expect(vectorBlobBytes(320, 'fp32')).toBe(1280)
    expect(isValidVectorBlobLength(388, 384, 'int8')).toBe(true)
    expect(isValidVectorBlobLength(388, 384, 'fp32')).toBe(false)
    // the benchmark report's numbers
    for (const id of ['base', 'balanced', 'mid', 'plus'] as const) {
      const profile = EMBEDDING_PROFILES[id]
      expect(vectorBlobBytes(profile.dimensions, profile.vectorQuantisation)).toBe(profile.dimensions + 4)
    }
  })

  it('decodes fp32 and int8 through one entry point, and rejects malformed blobs', () => {
    const vector = unitVector(rng(11), 128)
    expect(Array.from(decodeVectorBlob(encodeVectorBlob(vector, 'fp32'), 128, 'fp32'))).toEqual(vector.map(Math.fround))
    expect(decodeVectorBlob(encodeVectorBlob(vector, 'int8'), 128, 'int8')).toHaveLength(128)
    expect(decodeVectorBlob(encodeVectorBlob(vector, 'int8'), 127, 'int8')).toHaveLength(0)
    expect(decodeVectorBlob(encodeVectorBlob(vector, 'fp32'), 128, 'int8')).toHaveLength(0)
    expect(decodeVectorBlob(new Uint8Array(10), 128, 'fp32')).toHaveLength(0)
    // an unaligned fp32 view still decodes
    const padded = new Uint8Array(1 + 128 * 4)
    padded.set(encodeVectorBlob(vector, 'fp32'), 1)
    expect(Array.from(decodeVectorBlob(padded.subarray(1), 128, 'fp32'))).toEqual(vector.map(Math.fround))
    // corrupt scale
    const bad = encodeInt8Blob(vector)
    new DataView(bad.buffer).setFloat32(0, Number.NaN, true)
    expect(decodeInt8Blob(bad, 128)).toHaveLength(0)
  })

  it('refuses to quantise non-finite values and handles the zero vector', () => {
    expect(() => quantiseInt8([0.1, Number.NaN])).toThrow()
    expect(() => quantiseInt8([Number.POSITIVE_INFINITY])).toThrow()
    expect(roundTripInt8([0, 0, 0])).toEqual([0, 0, 0])
  })

  it('scores a float query against an int8 blob like the dequantised vector, without allocating it', () => {
    const next = rng(21)
    for (let i = 0; i < 25; i++) {
      const query = unitVector(next, 512)
      const doc = unitVector(next, 512)
      const blob = encodeInt8Blob(doc)
      const expected = cosine(query, decodeInt8Blob(blob, 512))
      expect(cosineWithInt8Blob(query, dot(query, query), blob)).toBeCloseTo(expected, 6)
      expect(Math.abs(cosineWithInt8Blob(query, dot(query, query), blob) - cosine(query, doc))).toBeLessThan(2e-3)
    }
    expect(cosineWithInt8Blob([1, 0], 1, encodeInt8Blob([1, 0, 0]))).toBeNaN()
  })

  it('keeps retrieval intact: the int8 index finds the same nearest neighbour as fp32', () => {
    const next = rng(99)
    const docs = Array.from({ length: 300 }, () => unitVector(next, 384))
    const blobs = docs.map((d) => encodeInt8Blob(d))
    let agree = 0
    const queries = 60
    for (let q = 0; q < queries; q++) {
      const target = docs[(q * 5) % docs.length]!
      const noise = unitVector(next, 384)
      const query = target.map((v, i) => v + 0.25 * noise[i]!)
      const queryNorm = dot(query, query)
      let bestFloat = -1, bestInt8 = -1, scoreFloat = -2, scoreInt8 = -2
      docs.forEach((d, i) => {
        const a = cosine(query, d)
        if (a > scoreFloat) { scoreFloat = a; bestFloat = i }
        const b = cosineWithInt8Blob(query, queryNorm, blobs[i]!)
        if (b > scoreInt8) { scoreInt8 = b; bestInt8 = i }
      })
      if (bestFloat === bestInt8) agree++
    }
    expect(agree).toBe(queries)
  })
})


describe('storage codec glue', () => {
  it('writes int8 for the tiers and fp32 for the legacy and unknown spaces', () => {
    expect(quantisationForSpace(EMBEDDING_PROFILES.base.embeddingId)).toBe('int8')
    expect(quantisationForSpace(EMBEDDING_PROFILES.mid.embeddingId)).toBe('int8')
    expect(quantisationForSpace(EMBEDDING_PROFILES.standard.embeddingId)).toBe('fp32')
    expect(quantisationForSpace(EMBEDDING_PROFILES.high.embeddingId)).toBe('fp32')
    expect(quantisationForSpace('something-else')).toBe('fp32')
    expect(quantisationForSpace('standard')).toBe('fp32') // profile id, not a space id
  })

  it('reads either encoding by byte length alone', () => {
    const vector = unitVector(rng(5), 384)
    const space = EMBEDDING_PROFILES.base.embeddingId
    const int8 = encodeVectorForSpace(space, vector)
    const fp32 = encodeVectorForSpace(EMBEDDING_PROFILES.standard.embeddingId, vector)
    expect(int8.byteLength).toBe(388)
    expect(fp32.byteLength).toBe(1536)
    expect(detectBlobQuantisation(388, 384)).toBe('int8')
    expect(detectBlobQuantisation(1536, 384)).toBe('fp32')
    expect(detectBlobQuantisation(1000, 384)).toBeNull()
    expect(1 - cosine(decodeStoredVector(int8, 384), vector)).toBeLessThan(1e-4)
    expect(Array.from(decodeStoredVector(fp32, 384))).toEqual(vector.map(Math.fround))
    expect(decodeStoredVector(int8, 320)).toHaveLength(0)
    expect(isStoredVectorLength(388, 384)).toBe(true)
    expect(isStoredVectorLength(389, 384)).toBe(false)
  })

  it('has no dimension where the two encodings collide', () => {
    for (let dim = 1; dim <= 4096; dim++) expect(dim * 4 === dim + 4).toBe(false)
  })
})
