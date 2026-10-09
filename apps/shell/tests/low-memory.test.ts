import { describe, expect, it } from 'vitest'
import {
  detectMemoryTier,
  getMemoryLimits,
} from '../src/main/document-memory/memory-tier'
import {
  suggestBiggestProfile,
  type MachineSpec,
} from '../src/main/document-memory/embedding-profiles'
import { canRunHeavyEmbedding } from '../src/main/document-memory/cpu-budget'

describe('Low Memory Tier & 4GB / 8GB Machine Profiles', () => {
  describe('Memory Tier Detection & Resource Limits', () => {
    it('detects low tier for machines with 4 GB RAM', () => {
      const tier = detectMemoryTier(4)
      expect(tier).toBe('low')

      const limits = getMemoryLimits(tier)
      expect(limits.allowHeavyEmbedding).toBe(false)
      expect(limits.maxBatchTokens).toBe(1600)
      expect(limits.unloadTimeoutMs).toBe(30_000)
    })

    it('detects normal tier for machines with 8 GB RAM', () => {
      const tier = detectMemoryTier(8)
      expect(tier).toBe('normal')

      const limits = getMemoryLimits(tier)
      expect(limits.allowHeavyEmbedding).toBe(true)
      expect(limits.maxBatchTokens).toBe(3000)
      expect(limits.unloadTimeoutMs).toBe(120_000)
    })

    it('detects high tier for machines with >= 16 GB RAM', () => {
      const tier = detectMemoryTier(16)
      expect(tier).toBe('high')

      const limits = getMemoryLimits(tier)
      expect(limits.allowHeavyEmbedding).toBe(true)
      expect(limits.maxBatchTokens).toBe(6000)
      expect(limits.unloadTimeoutMs).toBe(300_000)
    })
  })

  describe('Model Recommendations based on System Specs', () => {
    it('recommends the base tier (Bekko a8m) for 4 GB RAM machines with memory limit flag', () => {
      const spec4GB: MachineSpec = {
        totalMemGiB: 4,
        logicalCores: 4,
        platform: 'win32',
        arch: 'x64',
      }
      const rec = suggestBiggestProfile(spec4GB)
      expect(rec.profile).toBe('base')
      expect(rec.limit).toBe('memory')
    })

    it('recommends the balanced tier (Bekko a25m, ~1 GB resident) for 8 GB RAM machines', () => {
      const spec8GB: MachineSpec = {
        totalMemGiB: 8,
        logicalCores: 8,
        platform: 'win32',
        arch: 'x64',
      }
      const rec = suggestBiggestProfile(spec8GB)
      // Even with 8 cores, 8 GB machines stay on the 384d Bekko a25m: it fits well inside 20% of RAM
      expect(rec.profile).toBe('balanced')
    })

    it('recommends the mid tier (EmbeddingGemma-2) on 16 GB RAM once ONNX Runtime can load it', () => {
      const spec16GB: MachineSpec = {
        totalMemGiB: 16,
        logicalCores: 8,
        platform: 'win32',
        arch: 'x64',
        ortVersion: '1.23.2',
      }
      expect(suggestBiggestProfile(spec16GB).profile).toBe('mid')
      // an older bundled onnxruntime-node cannot load the Gemma export: stay on the Bekko tier
      expect(suggestBiggestProfile({ ...spec16GB, ortVersion: '1.21.0' }).profile).toBe('balanced')
    })
  })

  describe('Heavy Embedding Budgeting', () => {
    it('restricts heavy embedding on battery or low memory tier', () => {
      expect(canRunHeavyEmbedding('low', false)).toBe(false)
      expect(canRunHeavyEmbedding('normal', true)).toBe(false) // battery
      expect(canRunHeavyEmbedding('normal', false)).toBe(true) // plugged in normal tier
      expect(canRunHeavyEmbedding('high', false)).toBe(true)
    })
  })
})
