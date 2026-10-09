import { indexingWorkerData, postIndexMessage } from './runtime'
import { withBackgroundBudget } from './cpu-budget'
import type { SessionKeeper } from '../fork/embedding-session'
import { workerPolicy } from '../fork/indexing-worker-policy'
import { readFile } from 'node:fs/promises'
import { Tokenizer } from '@huggingface/tokenizers'
import type { InferenceSession } from 'onnxruntime-node'
import { EMBEDDING_PROFILES, embeddingProfile, type EmbeddingProfile, type EmbeddingProfileId } from './embedding-profiles'
import {
  EmbeddingModelDownloadError,
  ensureModelFiles,
  type ModelDownloadProgress,
} from './embedding/model-files'
import {
  buildFeeds,
  finishVector,
  formatEmbeddingInput,
  mergeHalves,
  poolInputFromOutputs,
  poolOutput,
  type EmbeddingKind,
} from './embedding/pipeline'
import { createProfileSessionKeeper } from './embedding/session'
import { installedOrtVersion, ortSupports, ortTooOldMessage } from './embedding/ort-support'
import { childFreeMemMB } from '../fork/embedding-ort'

// The standard profile, under the names this module always exported.
export const EMBEDDING_MODEL = EMBEDDING_PROFILES.standard.repo
export const EMBEDDING_REVISION = EMBEDDING_PROFILES.standard.revision
export const EMBEDDING_ID = EMBEDDING_PROFILES.standard.embeddingId

type Loaded = {
  tokenizer: Tokenizer
  keeper: SessionKeeper<InferenceSession>
}

// The worker runs embedding requests in one queue with a 150 s task timeout, and the host recycles
// the process when an extraction waits behind a long task. A multi-minute model download must
// therefore never hold a request: it continues in the background (resuming after any failure)
// and requests answer "still downloading" after this wait.
const MODEL_WAIT_MS = 20_000
let modelWaitMs = MODEL_WAIT_MS
export function overrideModelWaitMs(ms: number | undefined): void {
  modelWaitMs = ms ?? MODEL_WAIT_MS
}

async function loadedWithin(pending: Promise<Loaded>): Promise<Loaded> {
  let timer: NodeJS.Timeout | undefined
  const early = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('The search model is still being prepared; semantic indexing continues when it is ready.')),
      modelWaitMs,
    )
  })
  try {
    return await Promise.race([pending, early])
  } finally {
    clearTimeout(timer)
  }
}

let loaded:
  | {
      profileId: EmbeddingProfileId
      value: Promise<Loaded>
    }
  | undefined

/**
 * Reports download progress to the host as a whole percent (the status field the settings screen
 * already shows) when the integer changes or another source takes over. 1 is skipped: the
 * assistant reads values up to 1 as a fraction.
 */
function progressReporter(): (progress: ModelDownloadProgress) => void {
  let lastPercent = -1
  let lastHost = ''
  return ({ doneBytes, totalBytes, host }) => {
    if (totalBytes <= 0) return
    const percent = Math.min(99, Math.floor((doneBytes / totalBytes) * 100))
    if ((percent === lastPercent && host === lastHost) || percent === 1) return
    lastPercent = percent
    lastHost = host
    postIndexMessage({ type: 'model', state: 'downloading', progress: percent, source: host, doneBytes, totalBytes })
  }
}

async function loadEmbeddingModel(cacheDir: string, profile: EmbeddingProfile): Promise<Loaded> {
  const paths = await ensureModelFiles(cacheDir, profile, undefined, { onProgress: progressReporter() })
  const tokenizer = new Tokenizer(
    JSON.parse(await readFile(paths.get(profile.tokenizerFile)!, 'utf8')),
    JSON.parse(await readFile(paths.get(profile.tokenizerConfigFile)!, 'utf8')),
  )
  // Sized to the indexing policy and the tier's thread cap; the keeper re-creates it between batches.
  const keeper = await createProfileSessionKeeper(paths.get(profile.modelFile)!, profile)
  return { tokenizer, keeper }
}

/**
 * Runs `work` for every item with at most `limit` in flight; results keep the input order.
 * ONNX Runtime sessions accept concurrent run() calls, which hides tokenizer and JS pooling
 * time behind the next inference on the higher tiers.
 */
async function mapConcurrent<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await work(items[index]!)
    }
  })
  await Promise.all(lanes)
  return results
}

export async function embedTexts(
  texts: string[],
  kind: EmbeddingKind,
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
    if (profile.heavy && workerPolicy.allowHeavyEmbedding === false) {
      postIndexMessage({
        type: 'model',
        state: 'blocked',
        error:
          'High-accuracy embedding model disabled by indexing policy (low RAM or battery). Semantic search temporarily paused; text search remains available.',
      })
      throw new Error('High-accuracy embedding model disabled by indexing policy')
    }

    if (!ortSupports(profile.minOrtVersion)) {
      const message = ortTooOldMessage(profile.id, profile.minOrtVersion!, installedOrtVersion())
      postIndexMessage({ type: 'model', state: 'error', error: message })
      throw new Error(message)
    }

    const freeMB = childFreeMemMB()
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
        // Download problems carry an actionable message (private repo, bad checksum, offline).
        const errorMsg =
          err instanceof EmbeddingModelDownloadError ||
          (err instanceof Error && err.message.startsWith('Insufficient free memory'))
            ? err.message
            : 'Local embedding model unavailable; text search remains available'
        postIndexMessage({
          type: 'model',
          state: 'error',
          error: errorMsg,
        })
        throw err
      })
    // a failure while no request is waiting was already reported through the model message
    pending.catch(() => {})
    loaded = { profileId: profile.id, value: pending }
  }

  const { tokenizer, keeper } = await loadedWithin(pending)
  if (kind === 'passage') await keeper.align()
  const session = keeper.current()

  async function encodeRaw(text: string): Promise<number[]> {
    const { ids, attention_mask } = tokenizer.encode(formatEmbeddingInput(profile, kind, text))
    // Never silently truncate a chunk: split unusually token-dense text and pool both vectors.
    if (ids.length > profile.maxInputTokens && text.length > 1) {
      const middle = Math.floor(text.length / 2)
      return mergeHalves(await encodeRaw(text.slice(0, middle)), await encodeRaw(text.slice(middle)))
    }
    const output = await session.run(buildFeeds(profile, session.inputNames, ids, attention_mask))
    return poolOutput(profile, poolInputFromOutputs(session, output, attention_mask))
  }
  const encode = async (text: string): Promise<number[]> => finishVector(profile, kind, await encodeRaw(text))

  if (kind === 'query') return Promise.all(texts.map((text) => encode(text)))
  return mapConcurrent(texts, profile.concurrency, (text) => withBackgroundBudget(() => encode(text)))
}
