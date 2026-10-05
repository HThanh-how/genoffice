export type MemoryTier = 'low' | 'normal' | 'high'

export function memoryTierFromTotal(totalMemMB: number): MemoryTier {
  if (totalMemMB < 6 * 1024) return 'low'
  if (totalMemMB < 12 * 1024) return 'normal'
  return 'high'
}

export interface MemoryTierPolicy {
  allowQualityModel: boolean
  embeddingBatch: number
  maxBatchTokens: number
  unloadIdleMs: number
}

export const MEMORY_TIER_POLICIES: Record<MemoryTier, MemoryTierPolicy> = {
  low: {
    allowQualityModel: false,
    embeddingBatch: 4,
    maxBatchTokens: 1600,
    unloadIdleMs: 30_000,
  },
  normal: {
    allowQualityModel: true,
    embeddingBatch: 8,
    maxBatchTokens: 3000,
    unloadIdleMs: 120_000,
  },
  high: {
    allowQualityModel: true,
    embeddingBatch: 16,
    maxBatchTokens: 6000,
    unloadIdleMs: 300_000,
  },
}

export function detectMemoryTier(totalMemGiB: number): MemoryTier {
  return memoryTierFromTotal(totalMemGiB * 1024)
}

export function getMemoryLimits(tier: MemoryTier): {
  allowHeavyEmbedding: boolean
  maxBatchTokens: number
  unloadTimeoutMs: number
} {
  const policy = MEMORY_TIER_POLICIES[tier]
  return {
    allowHeavyEmbedding: policy.allowQualityModel,
    maxBatchTokens: policy.maxBatchTokens,
    unloadTimeoutMs: policy.unloadIdleMs,
  }
}
