import { describe, expect, it } from 'vitest'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'

describe('Index Diagnostics Metadata & Architecture Suite (IT-4)', () => {
  it('derives vector dimensions directly from profile metadata (not hardcoded 768/1024)', () => {
    // Spec 35: Standard is F2LLM-v2-80M persisted at 320D, High is Qwen3-Embedding-0.6B persisted at 512D
    const standardProfile = EMBEDDING_PROFILES.standard
    expect(standardProfile.dimensions).toBe(320)
    expect(standardProfile.nativeDimensions).toBe(320)

    const highProfile = EMBEDDING_PROFILES.high
    expect(highProfile.dimensions).toBe(512)
    expect(highProfile.nativeDimensions).toBe(1024)

    // Ensure model repo points to official baselines
    expect(standardProfile.repo).toContain('F2LLM-v2-80M')
    expect(highProfile.repo).toContain('Qwen3-Embedding-0.6B')
  })
})
