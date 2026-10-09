import type { StorageAdmissionController } from './storage-admission'

export const BASE_VECTOR_ROW_BYTES = 256
export const BASE_EMBEDDING_METADATA_BYTES = 1024
export const EMBEDDING_WAL_MULTIPLIER = 1.5
export const CONSERVATIVE_EMBEDDING_HEADROOM_BYTES = 10 * 1024 * 1024
export const DEFAULT_EMBED_RETRY_DELAY_MS = 15_000
export const MAX_EMBED_RETRY_DELAY_MS = 60_000

/**
 * Calculates conservative on-disk write byte footprint for a single passage vector.
 * Accounts for canonical Float32Array blob (dim * 4), legacy JSON / table row metadata,
 * SQLite B-tree index overhead, and SQLite WAL write amplification (1.5x).
 */
export function estimateSingleVectorBytes(dim: number): number {
  const safeDim = Number.isSafeInteger(dim) && dim > 0 ? dim : 384
  const canonicalBytes = safeDim * 4
  const legacyAndRowBytes = safeDim * 4 + BASE_VECTOR_ROW_BYTES
  const indexOverhead = safeDim * 2 + 128
  const rowBytes = canonicalBytes + legacyAndRowBytes + indexOverhead
  const est = Math.ceil(rowBytes * EMBEDDING_WAL_MULTIPLIER)
  return Number.isSafeInteger(est) && est > 512 ? est : 512
}

/**
 * Calculates conservative write reservation for a batch of chunk embeddings,
 * adding conservative metadata / WAL base floor.
 */
export function estimateEmbeddingBatchBytes(count: number, dim: number): number {
  const safeCount = Number.isSafeInteger(count) && count > 0 ? count : 0
  if (safeCount === 0) return BASE_EMBEDDING_METADATA_BYTES
  return safeCount * estimateSingleVectorBytes(dim) + BASE_EMBEDDING_METADATA_BYTES
}

/**
 * Validates that model worker embedding reply conforms strictly to:
 * - Top-level array of vectors
 * - Vector count strictly matches expected input chunk count
 * - Each vector is an array strictly matching model dimension
 * - All vector elements are strictly finite floating-point numbers (no NaN, Infinity, or non-numeric values).
 */
export function validateReturnedVectors(
  vectors: unknown,
  expectedCount: number,
  expectedDim: number,
): { valid: boolean; error?: string } {
  if (!Array.isArray(vectors)) {
    return { valid: false, error: 'Embedding worker result is not an array of vectors' }
  }
  if (vectors.length !== expectedCount) {
    return {
      valid: false,
      error: `Embedding vector count (${vectors.length}) does not match chunk count (${expectedCount})`,
    }
  }
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i]
    if (!Array.isArray(v)) {
      return { valid: false, error: `Embedding vector at index ${i} is not an array` }
    }
    if (v.length !== expectedDim) {
      return {
        valid: false,
        error: `Embedding vector at index ${i} dimension (${v.length}) does not match expected (${expectedDim})`,
      }
    }
    for (let j = 0; j < v.length; j++) {
      const val = v[j]
      if (typeof val !== 'number' || !Number.isFinite(val)) {
        return {
          valid: false,
          error: `Embedding vector at index ${i}[${j}] contains non-finite value (${String(val)})`,
        }
      }
    }
  }
  return { valid: true }
}

/**
 * Safely releases a reservation only if it matches the caller's unique owner token.
 * Prevents releasing somebody else's lease when tasks recycle or cancel concurrently.
 */
export function safeReleaseEmbeddingLease(
  admission: StorageAdmissionController,
  reservationId: string,
  ownerToken?: string,
): boolean {
  if (!ownerToken) {
    return admission.release(reservationId)
  }
  const existing = admission.listReservations().find((r) => r.id === reservationId)
  if (existing && (!existing.ownerId || existing.ownerId === ownerToken)) {
    return admission.release(reservationId)
  }
  return false
}
