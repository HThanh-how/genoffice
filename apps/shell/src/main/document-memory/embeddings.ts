import { indexingWorkerData, postIndexMessage } from './runtime'
import { withBackgroundBudget } from './cpu-budget'
import { createEmbeddingSessionKeeper } from '../fork/embedding-ort'
import type { SessionKeeper } from '../fork/embedding-session'
import { workerPolicy } from '../fork/indexing-worker-policy'
import { createReadStream } from 'node:fs'
import { freemem } from 'node:os'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { Tokenizer } from '@huggingface/tokenizers'
import { InferenceSession, Tensor } from 'onnxruntime-node'
import {
  EMBEDDING_PROFILES,
  embeddingProfile,
  type EmbeddingProfile,
  type EmbeddingProfileFile,
  type EmbeddingProfileId,
} from './embedding-profiles'

// The standard profile, under the names this module always exported.
export const EMBEDDING_MODEL = EMBEDDING_PROFILES.standard.repo
export const EMBEDDING_REVISION = EMBEDDING_PROFILES.standard.revision
export const EMBEDDING_ID = EMBEDDING_PROFILES.standard.embeddingId

type Loaded = {
  tokenizer: Tokenizer
  session: InferenceSession
  keeper: SessionKeeper<InferenceSession>
}

let loaded:
  | {
      profileId: EmbeddingProfileId
      value: Promise<Loaded>
    }
  | undefined

function filePath(cache: string, profile: EmbeddingProfile, file: EmbeddingProfileFile): string {
  return join(cache, profile.repo, profile.revision, file.path)
}

function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * A cached file counts as verified once its SHA-256 matched; the result is remembered next to it
 * (with the size) so a 2 GB model is hashed once, not on every start.
 */
async function verified(path: string, file: EmbeddingProfileFile): Promise<boolean> {
  let fileStat: Awaited<ReturnType<typeof stat>>
  try {
    fileStat = await stat(path)
  } catch {
    return false
  }

  if (!file.sha256) return true
  const marker = `${path}.verified`
  try {
    const recorded = await readFile(marker, 'utf8')
    if (recorded === `${file.sha256}:${fileStat.size}`) return true
  } catch {
    /* not verified yet */
  }

  try {
    const calculated = await sha256OfFile(path)
    if (calculated !== file.sha256) return false
    await writeFile(marker, `${file.sha256}:${fileStat.size}`)
    return true
  } catch {
    return false
  }
}

async function downloadFile(url: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  const response = await fetch(url)
  if (!response.ok || !response.body)
    throw new Error(`Download of ${url} failed with HTTP ${response.status}`)
  const reader = response.body.getReader()
  const part = `${destination}.part-${Date.now()}`
  const file = await open(part, 'w')
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      await file.write(value)
    }
    await file.sync()
    await file.close()
    await rename(part, destination)
  } catch (error) {
    await file.close().catch(() => {})
    await rm(part, { force: true }).catch(() => {})
    throw error
  }
}

async function cachedFile(
  cache: string,
  profile: EmbeddingProfile,
  file: EmbeddingProfileFile,
): Promise<string> {
  const path = filePath(cache, profile, file)
  if (!(await verified(path, file))) {
    const url = `https://huggingface.co/${profile.repo}/resolve/${profile.revision}/${file.path}`
    await downloadFile(url, path)
    if (!(await verified(path, file))) {
      await rm(path, { force: true }).catch(() => {})
      throw new Error(`Downloaded file ${file.path} failed SHA-256 checksum`)
    }
  }
  return path
}

async function loadEmbeddingModel(cacheDir: string, profile: EmbeddingProfile): Promise<Loaded> {
  const paths = new Map<string, string>()
  for (const file of profile.files) paths.set(file.path, await cachedFile(cacheDir, profile, file))
  const tokenizer = new Tokenizer(
    JSON.parse(await readFile(paths.get(profile.tokenizerFile)!, 'utf8')),
    JSON.parse(await readFile(paths.get(profile.tokenizerConfigFile)!, 'utf8')),
  )
  // Sized to the indexing policy; the keeper re-creates it between batches when that changes.
  const keeper = await createEmbeddingSessionKeeper(
    paths.get(profile.modelFile)!,
    profile.id !== 'high',
  )
  return { tokenizer, session: keeper.current(), keeper }
}

function validateDimensions(vector: number[], profile: EmbeddingProfile): number[] {
  if (vector.length !== profile.dimensions) {
    throw new Error(
      `Embedding dimension mismatch: expected ${profile.dimensions}, got ${vector.length}`,
    )
  }
  return vector
}

export async function embedTexts(
  texts: string[],
  kind: 'query' | 'passage',
  cacheDir = indexingWorkerData.cacheDir,
  profile: EmbeddingProfile = embeddingProfile(indexingWorkerData.embeddingProfile),
): Promise<number[][]> {
  if (!cacheDir) throw new Error('Embedding cache unavailable')

  if (loaded && loaded.profileId !== profile.id) {
    const old = await loaded.value.catch(() => null)
    if (old) {
      await old.keeper.dispose?.()
    }
    loaded = undefined
  }

  let pending = loaded?.value
  if (!pending) {
    if (profile.id === 'high' && workerPolicy.allowHeavyEmbedding === false) {
      postIndexMessage({
        type: 'model',
        state: 'blocked',
        error:
          'High-accuracy embedding model disabled by indexing policy (low RAM or battery). Semantic search temporarily paused; text search remains available.',
      })
      throw new Error('High-accuracy embedding model disabled by indexing policy')
    }

    const freeMB = freemem() / (1024 * 1024)
    if (profile.minFreeMemoryMB && freeMB < profile.minFreeMemoryMB) {
      postIndexMessage({
        type: 'model',
        state: 'error',
        error: `Insufficient free memory (${Math.round(freeMB)} MB free, ${profile.minFreeMemoryMB} MB required). Semantic search temporarily paused; text search remains available.`,
      })
      throw new Error(`Insufficient free memory: ${Math.round(freeMB)} MB free, ${profile.minFreeMemoryMB} MB required`)
    }

    postIndexMessage({ type: 'model', state: 'downloading' })
    pending = loadEmbeddingModel(cacheDir, profile)
      .then((model) => {
        postIndexMessage({ type: 'model', state: 'ready' })
        return model
      })
      .catch((err) => {
        if (loaded?.profileId === profile.id) {
          loaded = undefined
        }
        const errorMsg =
          err instanceof Error && err.message.startsWith('Insufficient free memory')
            ? err.message
            : 'Local embedding model unavailable; text search remains available'
        postIndexMessage({
          type: 'model',
          state: 'error',
          error: errorMsg,
        })
        throw err
      })
    loaded = { profileId: profile.id, value: pending }
  }

  const { tokenizer, keeper } = await pending
  if (kind === 'passage') await keeper.align()
  const session = keeper.current()

  const formatted = (text: string): string => {
    if (kind === 'query') {
      const instruction = profile.queryInstruction?.trim()
      if (instruction) {
        return `Instruct: ${instruction}\nQuery: ${text}`
      }
      return `${profile.queryPrefix}${text}`
    }
    return `${profile.passagePrefix}${text}`
  }

  async function encode(text: string): Promise<number[]> {
    const { ids, attention_mask } = tokenizer.encode(formatted(text))
    // Never silently truncate a chunk: split unusually token-dense text and pool both vectors.
    if (ids.length > profile.maxInputTokens) {
      const middle = Math.floor(text.length / 2)
      const a = await encode(text.slice(0, middle)),
        b = await encode(text.slice(middle))
      return validateDimensions(
        normalize(a.map((value, i) => value + b[i]!)),
        profile,
      )
    }
    const feeds: Record<string, Tensor> = {
      input_ids: new Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
      attention_mask: new Tensor('int64', BigInt64Array.from(attention_mask, BigInt), [
        1,
        ids.length,
      ]),
    }
    if (session.inputNames.includes('token_type_ids'))
      feeds.token_type_ids = new Tensor('int64', new BigInt64Array(ids.length), [1, ids.length])
    const output = await session.run(feeds)

    if (profile.pooling === 'sentence' && output.sentence_embedding) {
      const vec = Array.from(output.sentence_embedding.data as Float32Array, Number)
      const truncated = profile.dimensions < vec.length ? vec.slice(0, profile.dimensions) : vec
      return validateDimensions(normalize(truncated), profile)
    }

    const hidden =
      output.last_hidden_state ?? output.token_embeddings ?? output[session.outputNames[0]!]!
    const nativeDimensions = hidden.dims[2]!

    if (profile.pooling === 'last-token') {
      let lastToken = attention_mask.length - 1
      while (lastToken > 0 && !attention_mask[lastToken]) {
        lastToken--
      }
      const vector = Array.from({ length: nativeDimensions }, (_, j) =>
        Number(hidden.data[lastToken * nativeDimensions + j]),
      )
      const truncated =
        profile.dimensions < vector.length ? vector.slice(0, profile.dimensions) : vector
      return validateDimensions(normalize(truncated), profile)
    }

    // Default: mean pooling
    const vector = Array<number>(nativeDimensions).fill(0)
    for (let token = 0; token < ids.length; token++) {
      if (!attention_mask[token]) continue
      for (let j = 0; j < nativeDimensions; j++)
        vector[j]! += Number(hidden.data[token * nativeDimensions + j])
    }
    const truncated =
      profile.dimensions < vector.length ? vector.slice(0, profile.dimensions) : vector
    return validateDimensions(normalize(truncated), profile)
  }

  const vectors: number[][] = []
  for (const text of texts)
    vectors.push(
      await (kind === 'passage' ? withBackgroundBudget(() => encode(text)) : encode(text)),
    )
  return vectors
}

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0))
  if (!norm || vector.some((n) => !Number.isFinite(n))) throw new Error('Invalid embedding')
  return vector.map((n) => n / norm)
}
