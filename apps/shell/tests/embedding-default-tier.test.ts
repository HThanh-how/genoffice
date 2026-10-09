import { describe, expect, it } from 'vitest'
import {
  recommendEmbeddingProfile,
  suggestBiggestProfile,
} from '../src/main/document-memory/embedding-profiles'

describe('default embedding tier', () => {
  const machine = (totalMemGiB: number, logicalCores: number, ortVersion = '1.23.2') => ({
    arch: 'x64',
    platform: 'win32',
    totalMemGiB,
    logicalCores,
    ortVersion,
  })

  it('is the fastest tier (base, Bekko a8m) on every machine, from 4 GB to 64 GB', () => {
    for (const [ram, cores] of [
      [4, 1],
      [4, 2],
      [8, 4],
      [16, 8],
      [27.8, 16],
      [32, 8],
      [64, 32],
    ] as const) {
      expect(recommendEmbeddingProfile(machine(ram, cores))).toEqual({ profile: 'base' })
    }
  })

  it('does not depend on the bundled onnxruntime version', () => {
    expect(recommendEmbeddingProfile(machine(32, 8, '1.21.0')).profile).toBe('base')
  })

  it('still reports the biggest tier a machine could run, for the upgrade hint', () => {
    expect(suggestBiggestProfile(machine(8, 4)).profile).toBe('balanced')
    expect(suggestBiggestProfile(machine(16, 8)).profile).toBe('mid')
    expect(suggestBiggestProfile(machine(32, 8)).profile).toBe('plus')
  })
})
