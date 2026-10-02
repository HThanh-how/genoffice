import { describe, expect, it } from 'vitest'
import {
  EMBEDDING_PROFILES,
  embeddingProfile,
  recommendEmbeddingProfile,
} from '../src/main/document-memory/embedding-profiles'

describe('embedding profiles', () => {
  it('keeps the standard model id exactly as stored vectors know it', () => {
    expect(EMBEDDING_PROFILES.standard.embeddingId).toBe(
      'Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78:q8',
    )
    expect(EMBEDDING_PROFILES.standard.dimensions).toBe(384)
    expect(EMBEDDING_PROFILES.high.dimensions).toBe(1024)
    expect(embeddingProfile('nonsense').id).toBe('standard')
    expect(embeddingProfile(undefined).id).toBe('standard')
  })

  it('gives every downloaded file of the high profile a checksum', () => {
    for (const file of EMBEDDING_PROFILES.high.files) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('recommendEmbeddingProfile', () => {
  const pc = { arch: 'x64', platform: 'win32' }
  it('advises standard for an old i3 (16 GB but only 4 threads)', () => {
    expect(recommendEmbeddingProfile({ ...pc, totalMemGiB: 15.9, logicalCores: 4 })).toEqual({
      profile: 'standard',
      limit: 'cpu',
    })
  })
  it('advises standard for a Ryzen 7 laptop with 8 GB (enough threads, too little memory)', () => {
    expect(recommendEmbeddingProfile({ ...pc, totalMemGiB: 7.4, logicalCores: 8 })).toEqual({
      profile: 'standard',
      limit: 'memory',
    })
  })
  it('allows high on a 16 GB machine with 8+ threads and on Apple Silicon', () => {
    expect(recommendEmbeddingProfile({ ...pc, totalMemGiB: 15.9, logicalCores: 12 }).profile).toBe(
      'high',
    )
    expect(
      recommendEmbeddingProfile({
        arch: 'arm64',
        platform: 'darwin',
        totalMemGiB: 16,
        logicalCores: 10,
      }).profile,
    ).toBe('high')
  })
})
