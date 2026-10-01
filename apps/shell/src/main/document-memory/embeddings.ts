import { indexingWorkerData, postIndexMessage } from './runtime'
import { withBackgroundBudget } from './cpu-budget'
import { createEmbeddingSessionKeeper } from '../fork/embedding-ort'
import type { SessionKeeper } from '../fork/embedding-session'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { Tokenizer } from '@huggingface/tokenizers'
import { InferenceSession, Tensor } from 'onnxruntime-node'

export const EMBEDDING_MODEL = 'Xenova/multilingual-e5-small'
export const EMBEDDING_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78'
export const EMBEDDING_ID = `${EMBEDDING_MODEL}@${EMBEDDING_REVISION}:q8`
const MODEL_SHA256 = 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193'
let loading:
  | Promise<{
      tokenizer: Tokenizer
      session: InferenceSession
      keeper: SessionKeeper<InferenceSession>
    }>
  | undefined

async function cachedFile(cache: string, file: string): Promise<string> {
  const path = join(cache, EMBEDDING_MODEL, EMBEDDING_REVISION, file)
  try {
    await readFile(path)
    return path
  } catch {
    /* download missing files */
  }
  const response = await fetch(
    `https://huggingface.co/${EMBEDDING_MODEL}/resolve/${EMBEDDING_REVISION}/${file}`,
    { signal: AbortSignal.timeout(180_000) },
  )
  if (!response.ok || !response.body) throw new Error('Model download failed')
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.partial`
  const handle = await import('node:fs/promises').then((fs) => fs.open(temporary, 'w', 0o600))
  try {
    let received = 0
    const total = Number(response.headers.get('content-length'))
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
  return path
}

export async function loadEmbeddingModel(cacheDir: string) {
  const configPath = await cachedFile(cacheDir, 'tokenizer_config.json')
  const tokenizerPath = await cachedFile(cacheDir, 'tokenizer.json')
  const modelPath = await cachedFile(cacheDir, 'onnx/model_quantized.onnx')
  const bytes = await readFile(modelPath)
  if (createHash('sha256').update(bytes).digest('hex') !== MODEL_SHA256) {
    await rm(modelPath, { force: true })
    throw new Error('Model checksum mismatch; retry download')
  }
  const tokenizer = new Tokenizer(
    JSON.parse(await readFile(tokenizerPath, 'utf8')),
    JSON.parse(await readFile(configPath, 'utf8')),
  )
  // Sized to the indexing policy; the keeper re-creates it between batches when that changes.
  const keeper = await createEmbeddingSessionKeeper(modelPath)
  return { tokenizer, session: keeper.current(), keeper }
}

export async function embedTexts(
  texts: string[],
  kind: 'query' | 'passage',
  cacheDir = indexingWorkerData.cacheDir,
): Promise<number[][]> {
  if (!cacheDir) throw new Error('Embedding cache unavailable')
  if (!loading) {
    postIndexMessage({ type: 'model', state: 'downloading' })
    loading = loadEmbeddingModel(cacheDir)
      .then((model) => {
        postIndexMessage({ type: 'model', state: 'ready' })
        return model
      })
      .catch(() => {
        loading = undefined
        postIndexMessage({
          type: 'model',
          state: 'error',
          error: 'Local embedding model unavailable; text search remains available',
        })
        throw new Error('Local embedding model unavailable')
      })
  }
  const { tokenizer, keeper } = await loading
  if (kind === 'passage') await keeper.align()
  const session = keeper.current()
  async function encode(text: string): Promise<number[]> {
    const { ids, attention_mask } = tokenizer.encode(`${kind}: ${text}`)
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
    const hidden = output.last_hidden_state ?? output[session.outputNames[0]!]!
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
