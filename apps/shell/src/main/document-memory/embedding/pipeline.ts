import { Tensor, type InferenceSession } from 'onnxruntime-node'
import type { EmbeddingProfile } from '../embedding-profiles'
import { roundTripInt8 } from './vector-codec'

/**
 * The text -> vector recipe for one profile, free of file and process concerns so it can be
 * tested against reference vectors:
 *
 *   input   = query ? instruction wrapper / queryPrefix : passagePrefix, then the text
 *   tokens  = the model's own tokenizer.json (special tokens come from its post-processor)
 *   pooling = mean over the attention mask | the graph's `sentence_embedding` | last token
 *   output  = L2-normalise (native) -> keep the first `dimensions` (Matryoshka) -> L2-normalise
 *             -> passages only: round through the int8 grid when the space is int8
 */

export type EmbeddingKind = 'query' | 'passage'

export function formatEmbeddingInput(
  profile: EmbeddingProfile,
  kind: EmbeddingKind,
  text: string,
): string {
  if (kind === 'query') {
    const instruction = profile.queryInstruction?.trim()
    if (instruction) return `Instruct: ${instruction}\nQuery: ${text}`
    return `${profile.queryPrefix}${text}`
  }
  return `${profile.passagePrefix}${text}`
}

export function l2Normalize(vector: ArrayLike<number>): number[] {
  let sum = 0
  for (let i = 0; i < vector.length; i++) {
    const n = vector[i]!
    if (!Number.isFinite(n)) throw new Error('Invalid embedding')
    sum += n * n
  }
  const norm = Math.sqrt(sum)
  if (!norm) throw new Error('Invalid embedding')
  const out = new Array<number>(vector.length)
  for (let i = 0; i < vector.length; i++) out[i] = vector[i]! / norm
  return out
}

/**
 * Matryoshka truncation: the leading `dimensions` of an already normalised native vector,
 * normalised again. Models trained with MRL (EmbeddingGemma-2, Qwen3) are valid at the
 * truncated width only after this re-normalisation.
 */
export function truncateAndNormalize(vector: ArrayLike<number>, dimensions: number): number[] {
  const native = l2Normalize(vector)
  return dimensions < native.length ? l2Normalize(native.slice(0, dimensions)) : native
}

export function validateDimensions(vector: number[], profile: EmbeddingProfile): number[] {
  if (vector.length !== profile.dimensions) {
    throw new Error(
      `Embedding dimension mismatch: expected ${profile.dimensions}, got ${vector.length}`,
    )
  }
  return vector
}

/** The vector as the profile's space stores it (passages go through the int8 grid, queries stay float). */
export function finishVector(
  profile: EmbeddingProfile,
  kind: EmbeddingKind,
  vector: number[],
): number[] {
  validateDimensions(vector, profile)
  return kind === 'passage' && profile.vectorQuantisation === 'int8' ? roundTripInt8(vector) : vector
}

/** Combines the two halves of a text that was too long for one pass. */
export function mergeHalves(a: number[], b: number[]): number[] {
  return l2Normalize(a.map((value, i) => value + b[i]!))
}

export interface PoolInput {
  sentenceEmbedding?: ArrayLike<number>
  hidden?: { data: ArrayLike<number>; tokens: number; width: number }
  attentionMask: ArrayLike<number>
}

/** Pooling + normalisation + Matryoshka truncation of one model output; returns the stored-width vector. */
export function poolOutput(profile: EmbeddingProfile, input: PoolInput): number[] {
  if (profile.pooling === 'sentence') {
    if (!input.sentenceEmbedding) throw new Error('Model output has no sentence_embedding')
    return validateDimensions(truncateAndNormalize(input.sentenceEmbedding, profile.dimensions), profile)
  }
  const hidden = input.hidden
  if (!hidden) throw new Error('Model output has no hidden states')
  const { data, width } = hidden
  const mask = input.attentionMask

  if (profile.pooling === 'last-token') {
    let last = mask.length - 1
    while (last > 0 && !mask[last]) last--
    const vector = new Array<number>(width)
    for (let j = 0; j < width; j++) vector[j] = Number(data[last * width + j])
    return validateDimensions(truncateAndNormalize(vector, profile.dimensions), profile)
  }

  // mean over the attention mask
  const vector = new Array<number>(width).fill(0)
  let count = 0
  for (let token = 0; token < hidden.tokens; token++) {
    if (!mask[token]) continue
    count++
    const base = token * width
    for (let j = 0; j < width; j++) vector[j]! += Number(data[base + j])
  }
  if (!count) throw new Error('Invalid embedding')
  return validateDimensions(truncateAndNormalize(vector, profile.dimensions), profile)
}

export function buildFeeds(
  profile: EmbeddingProfile,
  inputNames: readonly string[],
  ids: ArrayLike<number>,
  attentionMask: ArrayLike<number>,
): Record<string, Tensor> {
  const length = ids.length
  const feeds: Record<string, Tensor> = {
    input_ids: new Tensor('int64', BigInt64Array.from(Array.from(ids), BigInt), [1, length]),
    attention_mask: new Tensor('int64', BigInt64Array.from(Array.from(attentionMask), BigInt), [
      1,
      length,
    ]),
  }
  if (inputNames.includes('token_type_ids'))
    feeds.token_type_ids = new Tensor('int64', new BigInt64Array(length), [1, length])
  for (const input of profile.emptyInputs ?? [])
    if (inputNames.includes(input.name))
      feeds[input.name] = new Tensor('float32', new Float32Array(0), input.dims)
  return feeds
}

/** Reads the pooled inputs out of an ORT result. */
export function poolInputFromOutputs(
  session: Pick<InferenceSession, 'outputNames'>,
  output: InferenceSession.OnnxValueMapType,
  attentionMask: ArrayLike<number>,
): PoolInput {
  const sentence = output.sentence_embedding
  const hidden = output.last_hidden_state ?? output.token_embeddings ?? output[session.outputNames[0]!]
  return {
    attentionMask,
    ...(sentence ? { sentenceEmbedding: sentence.data as Float32Array } : {}),
    ...(hidden && hidden.dims.length === 3
      ? { hidden: { data: hidden.data as Float32Array, tokens: hidden.dims[1]!, width: hidden.dims[2]! } }
      : {}),
  }
}
