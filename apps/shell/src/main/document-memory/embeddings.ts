import { indexingWorkerData, postIndexMessage } from './runtime'
import { withBackgroundBudget } from './cpu-budget'
import { createEmbeddingSessionKeeper } from '../fork/embedding-ort'
import type { SessionKeeper } from '../fork/embedding-session'
import { createReadStream } from 'node:fs'
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
const loading = new Map<string, Promise<Loaded>>()

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
  if (!file.sha256) return true
  const marker = `${path}.verified`
  try {
    const [recorded, size] = await Promise.all([readFile(marker, 'utf8'), stat(path)])
    if (recorded === `${file.sha256}:${size.size}`) return true
  } catch {
    /* not verified yet */
  }
  if ((await sha256OfFile(path)) !== file.sha256) return false
  await writeFile(marker, `${file.sha256}:${(await stat(path)).size}`)
  return true
}

async function cachedFile(
  cache: string,
  profile: EmbeddingProfile,
  file: EmbeddingProfileFile,
): Promise<string> {
  const path = filePath(cache, profile, file)
  try {
    await stat(path)
    if (await verified(path, file)) return path
    await rm(path, { force: true })
    throw new Error('Model checksum mismatch; retry download')
  } catch (error) {
    if (error instanceof Error && error.message.includes('checksum')) throw error
    /* download the missing file */
  }
  const response = await fetch(
    `https://huggingface.co/${profile.repo}/resolve/${profile.revision}/${file.path}`,
    // a 2 GB file on a slow line needs far longer than the small model did
    { signal: AbortSignal.timeout(file.bytes ? 3 * 3600_000 : 180_000) },
  )
  if (!response.ok || !response.body) throw new Error('Model download failed')
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.partial`
  const handle = await open(temporary, 'w', 0o600)
  try {
    let received = 0
    const total = Number(response.headers.get('content-length')) || file.bytes || 0
    const reader = response.body.getReader()
    while (true) {
      const { done, value: chunk } = await reader.read()
      if (done) break
      await handle.write(chunk)
      received += chunk.length
      postIndexMessage({
        type: 'model',
        state: 'downloading',
        progress: total > 0 ? (received / total) * 100 : undefined,
      })
    }
    await handle.close()
    await rename(temporary, path)
  } catch (error) {
    await handle.close().catch(() => {})
    await rm(temporary, { force: true })
    throw error
  }
  if (!(await verified(path, file))) {
    await rm(path, { force: true })
    throw new Error('Model checksum mismatch; retry download')
  }
  return path
}

export async function loadEmbeddingModel(
  cacheDir: string,
  profile: EmbeddingProfile = embeddingProfile(indexingWorkerData.embeddingProfile),
): Promise<Loaded> {
  const paths = new Map<string, string>()
  for (const file of profile.files) paths.set(file.path, await cachedFile(cacheDir, profile, file))
  const tokenizer = new Tokenizer(
    JSON.parse(await readFile(paths.get(profile.tokenizerFile)!, 'utf8')),
    JSON.parse(await readFile(paths.get(profile.tokenizerConfigFile)!, 'utf8')),
  )
  // Sized to the indexing policy; the keeper re-creates it between batches when that changes.
  const keeper = await createEmbeddingSessionKeeper(paths.get(profile.modelFile)!)
  return { tokenizer, session: keeper.current(), keeper }
}

export async function embedTexts(
  texts: string[],
  kind: 'query' | 'passage',
  cacheDir = indexingWorkerData.cacheDir,
  profile: EmbeddingProfile = embeddingProfile(indexingWorkerData.embeddingProfile),
): Promise<number[][]> {
  if (!cacheDir) throw new Error('Embedding cache unavailable')
  let pending = loading.get(profile.id)
  if (!pending) {
    postIndexMessage({ type: 'model', state: 'downloading' })
    pending = loadEmbeddingModel(cacheDir, profile)
      .then((model) => {
        postIndexMessage({ type: 'model', state: 'ready' })
        return model
      })
      .catch(() => {
        loading.delete(profile.id)
        postIndexMessage({
          type: 'model',
          state: 'error',
          error: 'Local embedding model unavailable; text search remains available',
        })
        throw new Error('Local embedding model unavailable')
      })
    loading.set(profile.id, pending)
  }
  const { tokenizer, keeper } = await pending
  if (kind === 'passage') await keeper.align()
  const session = keeper.current()
  const prefix = kind === 'query' ? profile.queryPrefix : profile.passagePrefix
  async function encode(text: string): Promise<number[]> {
    const { ids, attention_mask } = tokenizer.encode(`${prefix}${text}`)
    // Never silently truncate a chunk: split unusually token-dense text and pool both vectors.
    if (ids.length > 512) {
      const middle = Math.floor(text.length / 2)
      const a = await encode(text.slice(0, middle)),
        b = await encode(text.slice(middle))
      return normalize(a.map((value, i) => value + b[i]!))
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
    if (profile.pooling === 'sentence' && output.sentence_embedding)
      return normalize(Array.from(output.sentence_embedding.data as Float32Array, Number))
    const hidden =
      output.last_hidden_state ?? output.token_embeddings ?? output[session.outputNames[0]!]!
    const dimensions = hidden.dims[2]!
    const vector = Array<number>(dimensions).fill(0)
    for (let token = 0; token < ids.length; token++) {
      if (!attention_mask[token]) continue
      for (let j = 0; j < dimensions; j++) vector[j]! += Number(hidden.data[token * dimensions + j])
    }
    return normalize(vector)
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
