/**
 * Vector storage codec for `chunk_embeddings.vector` (BLOB) and the quantised vector space.
 *
 * Two on-disk encodings exist:
 *
 *  - `fp32`: little-endian Float32 * dim (dim * 4 bytes). This is what every legacy space
 *    ('standard', 'high') has always used and it is what `floatBlob` / `blobVector` in
 *    storage/repositories/embedding-repository.ts read and write today.
 *  - `int8`: one Float32 scale followed by `dim` signed bytes (dim + 4 bytes). The scale is
 *    per vector and symmetric: scale = max(|v|) / 127, q = round(v / scale), v' = q * scale.
 *
 * Why per-vector symmetric scale (not one global scale): embeddings are unit-normalised
 * after Matryoshka truncation, but the magnitude of the largest component differs a lot
 * between texts, so a global scale either clips or wastes range. A per-vector scale costs
 * four bytes, keeps the largest component exactly representable and is what the embedding
 * benchmark measured (macro nDCG@10 change within +-0.001 of fp32 at native dimension, see
 * the benchmark report section 4). Cosine similarity needs no dequantisation pass:
 * dot(query, q) * scale gives the dot product with the stored vector, and the stored vector
 * norm is available from one more pass over the bytes (or ~1 for unit vectors).
 *
 * The quantiser is idempotent: encode(decode(blob)) reproduces the same bytes, so a space
 * whose passage vectors were already rounded through `roundTripInt8` (embeddings.ts does
 * this for int8 profiles) stores losslessly in either encoding.
 */

export type VectorQuantisation = 'fp32' | 'int8'

/** Bytes used by the per-vector scale in the int8 encoding. */
export const INT8_SCALE_BYTES = 4

/** Size in bytes of one stored vector. */
export function vectorBlobBytes(dimensions: number, quantisation: VectorQuantisation): number {
  return quantisation === 'int8' ? dimensions + INT8_SCALE_BYTES : dimensions * 4
}

/** Per-vector symmetric int8 quantisation: the scale (float32-exact) and the signed bytes. */
export function quantiseInt8(vector: ArrayLike<number>): { scale: number; values: Int8Array } {
  let max = 0
  for (let i = 0; i < vector.length; i++) {
    const value = vector[i]!
    if (!Number.isFinite(value)) throw new Error('Cannot quantise a non-finite vector')
    const abs = Math.abs(value)
    if (abs > max) max = abs
  }
  const scale = Math.fround(max / 127)
  const values = new Int8Array(vector.length)
  if (scale > 0) {
    for (let i = 0; i < vector.length; i++) {
      const q = Math.round(vector[i]! / scale)
      values[i] = q > 127 ? 127 : q < -127 ? -127 : q
    }
  }
  return { scale, values }
}

export function dequantiseInt8(values: Int8Array, scale: number): number[] {
  const out = new Array<number>(values.length)
  for (let i = 0; i < values.length; i++) out[i] = values[i]! * scale
  return out
}

/** The vector exactly as it would come back from an int8 store. */
export function roundTripInt8(vector: ArrayLike<number>): number[] {
  const { scale, values } = quantiseInt8(vector)
  return dequantiseInt8(values, scale)
}

export function encodeInt8Blob(vector: ArrayLike<number>): Uint8Array {
  const { scale, values } = quantiseInt8(vector)
  const blob = new Uint8Array(INT8_SCALE_BYTES + values.length)
  new DataView(blob.buffer).setFloat32(0, scale, true)
  blob.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), INT8_SCALE_BYTES)
  return blob
}

/** Decodes an int8 blob; an invalid length (wrong dimension, truncated row) yields an empty vector. */
export function decodeInt8Blob(blob: Uint8Array, dimensions: number): Float32Array {
  if (blob.byteLength !== dimensions + INT8_SCALE_BYTES) return new Float32Array(0)
  const scale = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getFloat32(0, true)
  if (!Number.isFinite(scale)) return new Float32Array(0)
  const out = new Float32Array(dimensions)
  const bytes = new Int8Array(blob.buffer, blob.byteOffset + INT8_SCALE_BYTES, dimensions)
  for (let i = 0; i < dimensions; i++) out[i] = bytes[i]! * scale
  return out
}

export function encodeFloat32Blob(vector: ArrayLike<number>): Uint8Array {
  return new Uint8Array(new Float32Array(Array.from(vector)).buffer)
}

export function decodeFloat32Blob(blob: Uint8Array, dimensions: number): Float32Array {
  if (blob.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) return new Float32Array(0)
  if (blob.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0)
    return new Float32Array(blob.buffer, blob.byteOffset, dimensions)
  const copy = blob.slice()
  return new Float32Array(copy.buffer, copy.byteOffset, dimensions)
}

export function encodeVectorBlob(
  vector: ArrayLike<number>,
  quantisation: VectorQuantisation,
): Uint8Array {
  return quantisation === 'int8' ? encodeInt8Blob(vector) : encodeFloat32Blob(vector)
}

export function decodeVectorBlob(
  blob: Uint8Array,
  dimensions: number,
  quantisation: VectorQuantisation,
): Float32Array {
  return quantisation === 'int8'
    ? decodeInt8Blob(blob, dimensions)
    : decodeFloat32Blob(blob, dimensions)
}

/** True when `byteLength` is the stored size of one `dimensions`-wide vector in this encoding. */
export function isValidVectorBlobLength(
  byteLength: number,
  dimensions: number,
  quantisation: VectorQuantisation,
): boolean {
  return byteLength === vectorBlobBytes(dimensions, quantisation)
}

/**
 * Cosine similarity between a float query and a stored int8 blob without materialising the
 * dequantised vector. `queryNormSquared` is sum(query^2); returns NaN for a malformed blob
 * (the same contract as `cosine` in embedding-repository.ts).
 */
export function cosineWithInt8Blob(
  query: ArrayLike<number>,
  queryNormSquared: number,
  blob: Uint8Array,
): number {
  const dimensions = blob.byteLength - INT8_SCALE_BYTES
  if (dimensions <= 0 || query.length !== dimensions) return Number.NaN
  const scale = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getFloat32(0, true)
  if (!Number.isFinite(scale)) return Number.NaN
  const bytes = new Int8Array(blob.buffer, blob.byteOffset + INT8_SCALE_BYTES, dimensions)
  let dot = 0
  let norm = 0
  for (let i = 0; i < dimensions; i++) {
    const q = bytes[i]!
    dot += query[i]! * q
    norm += q * q
  }
  // dot and norm are in quantised units; the scale cancels in the cosine.
  return queryNormSquared && norm ? dot / Math.sqrt(queryNormSquared * norm) : 0
}
