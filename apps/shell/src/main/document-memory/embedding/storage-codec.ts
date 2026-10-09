import { embeddingProfile } from '../embedding-profiles'
import {
  decodeFloat32Blob,
  decodeInt8Blob,
  encodeVectorBlob,
  INT8_SCALE_BYTES,
  type VectorQuantisation,
} from './vector-codec'

/**
 * Glue for the repositories that read and write `chunk_embeddings.vector`.
 *
 * Writes follow the space's profile (`vectorQuantisation`: fp32 for the legacy spaces, int8 for
 * the tiers). Reads do not need to know it: the two encodings never have the same length for a
 * given dimension (dim * 4 versus dim + 4, equal only at dim = 4/3), so the row's byte length
 * says which one it is. That also means a space can hold both during a rollout, and nothing in
 * the schema has to change.
 */

/** Quantisation a vector written to this space should use (unknown spaces stay fp32). */
export function quantisationForSpace(spaceId: string): VectorQuantisation {
  const profile = embeddingProfile(spaceId)
  return profile.embeddingId === spaceId ? profile.vectorQuantisation : 'fp32'
}

export function encodeVectorForSpace(spaceId: string, vector: ArrayLike<number>): Uint8Array {
  return encodeVectorBlob(vector, quantisationForSpace(spaceId))
}

/** Which encoding a stored blob has for `dimensions`, or null when its length fits neither. */
export function detectBlobQuantisation(byteLength: number, dimensions: number): VectorQuantisation | null {
  if (byteLength === dimensions * Float32Array.BYTES_PER_ELEMENT) return 'fp32'
  if (byteLength === dimensions + INT8_SCALE_BYTES) return 'int8'
  return null
}

/** Decodes either encoding; a malformed blob yields an empty vector (callers already treat that as invalid). */
export function decodeStoredVector(blob: Uint8Array, dimensions: number): Float32Array {
  switch (detectBlobQuantisation(blob.byteLength, dimensions)) {
    case 'fp32':
      return decodeFloat32Blob(blob, dimensions)
    case 'int8':
      return decodeInt8Blob(blob, dimensions)
    default:
      return new Float32Array(0)
  }
}

/** True when `byteLength` is a well-formed stored vector of `dimensions` in either encoding. */
export function isStoredVectorLength(byteLength: number, dimensions: number): boolean {
  return detectBlobQuantisation(byteLength, dimensions) !== null
}
