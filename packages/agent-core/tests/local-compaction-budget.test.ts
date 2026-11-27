import { describe, expect, it } from 'vitest'
import { createIpcTransport, localCompactionBudget } from '../src/electron-transport'

describe('local model compaction budget', () => {
  it('compacts well before the model window is full, far under the 256 KB default', () => {
    for (const size of [8192, 16384, 32768]) {
      const { maxBytes, keepRecentBytes } = localCompactionBudget(size)
      expect(maxBytes).toBeLessThan(80 * 1024)
      expect(keepRecentBytes).toBeLessThan(maxBytes)
    }
  })
  it('grows with the window and never collapses to nothing', () => {
    expect(localCompactionBudget(32768).maxBytes).toBeGreaterThan(
      localCompactionBudget(16384).maxBytes,
    )
    expect(localCompactionBudget(16384).maxBytes).toBeGreaterThan(
      localCompactionBudget(8192).maxBytes,
    )
    expect(localCompactionBudget(2048).maxBytes).toBeGreaterThanOrEqual(6 * 1024)
    expect(localCompactionBudget(undefined).maxBytes).toBe(localCompactionBudget(32768).maxBytes)
  })
  it('is what the transport reports for the local provider only', () => {
    const make = (settings: unknown) =>
      createIpcTransport({ getSettings: () => settings } as never).compactionBudget?.()
    expect(
      make({ provider: 'local', providers: { local: { local: { contextSize: 16384 } } } }),
    ).toEqual(localCompactionBudget(16384))
    expect(make({ provider: 'openai' })).toBeUndefined()
  })
})
