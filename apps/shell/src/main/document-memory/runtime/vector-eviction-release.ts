import type { DatabaseSync } from 'node:sqlite'
import { CACHE_RETENTION_LOW_WATERMARK } from '../storage-budget'
import { releaseVectorEvictions, type VectorEvictionReleaseResult } from '../storage/vector-eviction-marker'

/**
 * Evicted vectors are only re-embedded (the marker released) when usage is comfortably below the retention
 * band: strictly below RELEASE_USAGE_RATIO now AND at most RELEASE_PROJECTED_RATIO after re-embedding the
 * released chunks. Retention evicts at 90% down to 80%, so re-embedding can never push usage back over the
 * trigger: no evict -> re-embed oscillation, by construction.
 */
export const VECTOR_RELEASE_USAGE_RATIO = 0.6
export const VECTOR_RELEASE_PROJECTED_RATIO = Math.min(0.75, CACHE_RETENTION_LOW_WATERMARK - 0.05)
/** Conservative bytes per re-embedded chunk (covers 1024-dim float32 + row/index overhead). */
export const VECTOR_RELEASE_BYTES_PER_CHUNK = 4608
export const VECTOR_RELEASE_MAX_DOCUMENTS = 25

export interface VectorReleaseUsage {
  limitState: string
  /** Total managed bytes (db + wal + shm + ...). */
  usedBytes: number
  budgetBytes: number
  isDegraded?: boolean
  measurementStatus?: string
}

export function releaseEvictedVectorsIfRoom(
  db: DatabaseSync,
  usage: VectorReleaseUsage,
): VectorEvictionReleaseResult {
  const none = { documents: 0, chunks: 0 }
  if (usage.isDegraded || (usage.measurementStatus && usage.measurementStatus !== 'fresh')) return none
  if (usage.limitState !== 'ok') return none
  if (!(usage.budgetBytes > 0) || !Number.isFinite(usage.usedBytes) || usage.usedBytes < 0) return none
  if (usage.usedBytes / usage.budgetBytes >= VECTOR_RELEASE_USAGE_RATIO) return none
  const roomBytes = usage.budgetBytes * VECTOR_RELEASE_PROJECTED_RATIO - usage.usedBytes
  const maxChunks = Math.floor(roomBytes / VECTOR_RELEASE_BYTES_PER_CHUNK)
  return releaseVectorEvictions(db, { maxDocuments: VECTOR_RELEASE_MAX_DOCUMENTS, maxChunks })
}
