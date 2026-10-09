import {
  BEKKO_A8M,
  BEKKO_A25M,
  EMBEDDING_GEMMA_2,
  buildEmbeddingId,
  type ModelArtifactSpec,
} from './embedding/model-specs'
import { ORT_WITH_GATHER_BLOCK_QUANTIZED_BITS, ortSupports } from './embedding/ort-support'
import type { VectorQuantisation } from './embedding/vector-codec'

/**
 * Legacy profiles (existing installs keep working, nothing is re-embedded):
 *   standard = F2LLM-v2-80M, 320d, fp32 vectors
 *   high     = Qwen3-Embedding-0.6B, 512d, fp32 vectors
 *
 * Tiered profiles (fresh installs get the one recommendEmbeddingProfile() picks):
 *   base     = Bekko-v1 a8m,  384d int8   (<= 6 GB RAM or <= 2 cores)
 *   balanced = Bekko-v1 a25m, 384d int8   (8 GB; the benchmark's "DEFAULT" tier)
 *   mid      = EmbeddingGemma-2 270M, 512d (MRL) int8   (16 GB)
 *   plus     = same model and the SAME 512d space as mid (32 GB / 8 cores): upgrading RAM never
 *              forces a re-embed; it only gets more threads, parallel runs and a longer input.
 *
 * The id 'balanced' (not 'default') avoids a profile literally named 'default' next to the
 * DEFAULT_EMBEDDING_PROFILE constant, which for installs without a saved choice is still 'standard'.
 */

export type EmbeddingProfileId = 'standard' | 'high' | 'base' | 'balanced' | 'mid' | 'plus'

export type EmbeddingTier = 'legacy' | 'base' | 'default' | 'mid' | 'high'

export interface EmbeddingProfileFile {
  /** path inside the model repository */
  path: string
  /** SHA-256 verified once, right after the download */
  sha256?: string
  bytes?: number
}

export type EmbeddingPooling = 'mean' | 'sentence' | 'last-token'

export interface EmbeddingProfile {
  id: EmbeddingProfileId

  repo: string
  revision: string

  files: EmbeddingProfileFile[]

  /** hardware tier this profile is meant for ('legacy' for the two original profiles) */
  tier: EmbeddingTier

  modelFile: string
  tokenizerFile: string
  tokenizerConfigFile: string

  /**
   * Stable vector-space ID.
   * Must change whenever model revision, pooling,
   * dimensions or passage preprocessing changes.
   */
  embeddingId: string

  /** Native model hidden dimension. */
  nativeDimensions: number

  /** Dimension persisted in the vector index. */
  dimensions: number

  pooling: EmbeddingPooling

  /**
   * Instruction used for queries only.
   * Do not put this into passage embeddings.
   */
  queryInstruction: string

  queryPrefix: string
  passagePrefix: string

  /**
   * How vectors of this space are stored. 'int8' = per-vector symmetric scale (see
   * embedding/vector-codec.ts); 'fp32' = Float32 as before. Part of the embeddingId.
   */
  vectorQuantisation: VectorQuantisation

  /** Extra empty float inputs a multimodal ONNX export needs for text-only use. */
  emptyInputs?: Array<{ name: string; dims: number[] }>

  /** Maximum tokens GenOffice itself permits. */
  maxInputTokens: number

  /** Upper bound of ONNX intra-op threads (the indexing policy may use fewer). */
  maxThreads: number
  /** Embeddings computed in parallel on one session while indexing. */
  concurrency: number
  /** Subject to the "allowHeavyEmbedding" (low RAM / battery) gate. */
  heavy: boolean
  /** The session may be re-created with another thread count between batches. */
  resizableSession: boolean

  /** Licence label for docs and the NOTICE file. */
  license: string

  /** Oldest onnxruntime-node that can load this model's ONNX files (absent = any). */
  minOrtVersion?: string

  downloadMB: number

  /** Estimated peak resident memory. */
  memoryMB: number

  /**
   * Minimum free system RAM before the model may be loaded.
   */
  minFreeMemoryMB: number
}

export const LEGACY_E5_EMBEDDING_ID =
  'Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78:q8'
export const LEGACY_VIETNAMESE_EMBEDDING_ID =
  'AITeamVN/Vietnamese_Embedding@dea33aa1ab339f38d66ae0a40e6c40e0a9249568:fp32'

function selectModelArtifact(profile: 'standard' | 'high'): {
  modelFile: string
  sha256: string
} {
  const isArm = process.arch === 'arm64'
  if (profile === 'high') {
    return isArm
      ? {
          modelFile: 'onnx/model_qint8_arm64.onnx',
          sha256: '85689f02c507b4f72eb473f33ceed491f0172d09463e83d5f9ed1a551e68c5ec',
        }
      : {
          modelFile: 'onnx/model_quint8_avx2.onnx',
          sha256: 'a7eda29cc374b01ae75eb1af1ab65c3c61a64c43f39f16e08c6e37c075dcbf4d',
        }
  }

  return isArm
    ? {
        modelFile: 'onnx/model_qint8_arm64.onnx',
        sha256: '2177fbd79bd6259904a54514e0e313efd28704acd98bfe276a06b2c638f2e4c1',
      }
    : {
        modelFile: 'onnx/model_quint8_avx2.onnx',
        sha256: '5776b04dd1fe5ba5589965cb540e3f31fd33bcbf68e2177fbd79bd6259904a54',
      }
}

const standardArtifact = selectModelArtifact('standard')
const highArtifact = selectModelArtifact('high')

const LEGACY_PROFILES: Record<'standard' | 'high', EmbeddingProfile> = {
  standard: {
    id: 'standard',

    repo: 'genoffice/F2LLM-v2-80M-ONNX',

    // Full commit SHA pinned to upstream weights baseline
    revision: 'ad88d7a126711f1490cd4bad645dc9d3acc2af6a',

    files: [
      { path: 'tokenizer.json', sha256: '7e295e5bb91a3d35335f92fa4294a6e4e0ab4aa586db853e14312a62135bfddc' },
      { path: 'tokenizer_config.json', sha256: '3c0884a30471f4f542dc89630f62a380bb70a341fafda826136a7be921fec7ea' },
      { path: standardArtifact.modelFile, sha256: standardArtifact.sha256 },
    ],

    tier: 'legacy',

    modelFile: standardArtifact.modelFile,
    tokenizerFile: 'tokenizer.json',
    tokenizerConfigFile: 'tokenizer_config.json',

    embeddingId: 'f2llm-v2-80m:ad88d7a126:q8:last-token:320:v1',

    nativeDimensions: 320,
    dimensions: 320,

    pooling: 'last-token',

    queryInstruction:
      'Given a user query, retrieve the most relevant local document passages. Documents may be in Vietnamese or English.',

    queryPrefix: '',
    passagePrefix: '',

    vectorQuantisation: 'fp32',
    maxInputTokens: 512,
    maxThreads: 16,
    concurrency: 1,
    heavy: false,
    resizableSession: true,
    license: 'Apache-2.0',

    downloadMB: 95,
    memoryMB: 180,
    minFreeMemoryMB: 384,
  },
  high: {
    id: 'high',

    repo: 'Qwen/Qwen3-Embedding-0.6B',

    // Full commit SHA pinned to official Hugging Face ONNX release
    revision: 'bd58e9fd4b0467770da53678d8da25481c0f959b',

    files: [
      { path: 'tokenizer.json', sha256: 'def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a' },
      { path: 'tokenizer_config.json' },
      { path: highArtifact.modelFile, sha256: highArtifact.sha256 },
    ],

    tier: 'legacy',

    modelFile: highArtifact.modelFile,
    tokenizerFile: 'tokenizer.json',
    tokenizerConfigFile: 'tokenizer_config.json',

    embeddingId: 'qwen3-embedding-0.6b:bd58e9fd4b:q8:last-token:512:v1',

    nativeDimensions: 1024,

    // Do not store 1024D by default.
    dimensions: 512,

    pooling: 'last-token',

    queryInstruction:
      'Given a user query, retrieve the most relevant local document passages. Documents may be in Vietnamese or English.',

    queryPrefix: '',
    passagePrefix: '',

    vectorQuantisation: 'fp32',
    maxInputTokens: 1024,
    maxThreads: 16,
    concurrency: 1,
    heavy: true,
    resizableSession: false,
    license: 'Apache-2.0',

    downloadMB: 600,
    memoryMB: 900,
    minFreeMemoryMB: 900,
  },
}

/**
 * The model behind MID and PLUS. One line swaps in the MIT-licensed fallback (HARRIER_270M, 640d)
 * if the Gemma terms are ever a problem; the swap changes the embeddingId, i.e. a new vector space.
 */
const MID_MODEL: ModelArtifactSpec = EMBEDDING_GEMMA_2

function totalDownloadMB(spec: ModelArtifactSpec): number {
  return Math.ceil(spec.files.reduce((sum, file) => sum + (file.bytes ?? 0), 0) / 1e6)
}

export function tieredProfile(
  id: 'base' | 'balanced' | 'mid' | 'plus',
  tier: EmbeddingTier,
  spec: ModelArtifactSpec,
  extra: Pick<
    EmbeddingProfile,
    | 'maxInputTokens'
    | 'maxThreads'
    | 'concurrency'
    | 'heavy'
    | 'resizableSession'
    | 'memoryMB'
    | 'minFreeMemoryMB'
  > & { minOrtVersion?: string },
): EmbeddingProfile {
  const vectorQuantisation = 'int8'
  return {
    id,
    repo: spec.repo,
    revision: spec.revision,
    files: spec.files.map((file) => ({ ...file })),
    tier,
    modelFile: spec.modelFile,
    tokenizerFile: spec.tokenizerFile,
    tokenizerConfigFile: spec.tokenizerConfigFile,
    embeddingId: buildEmbeddingId(spec, spec.storedDimensions, vectorQuantisation),
    nativeDimensions: spec.nativeDimensions,
    dimensions: spec.storedDimensions,
    pooling: spec.pooling,
    queryInstruction: spec.queryInstruction,
    queryPrefix: spec.queryPrefix,
    passagePrefix: spec.passagePrefix,
    vectorQuantisation,
    ...(spec.emptyInputs ? { emptyInputs: spec.emptyInputs.map((input) => ({ ...input })) } : {}),
    license: spec.license,
    downloadMB: totalDownloadMB(spec),
    ...extra,
  }
}

/**
 * Sizing. memoryMB is the whole indexing-process RSS measured in Node (macOS arm64, 1 intra-op
 * thread, batch 1, after short AND near-limit 450-token chunks; tests/embedding-parity.test.ts):
 * base 757, balanced 921 (+ the 34 MB, 262k-vocab JS tokenizer, which dominates), mid 564
 * (the Gemma weights are memory-mapped), rounded up. plus adds head-room for 8 threads, three
 * parallel runs and 1024-token inputs. Each stays within 15-20% of its tier's RAM floor
 * (4 / 8 / 16 / 32 GB). minFreeMemoryMB = memoryMB + 25%, what must be free before loading.
 */
export const EMBEDDING_PROFILES: Record<EmbeddingProfileId, EmbeddingProfile> = {
  ...LEGACY_PROFILES,
  base: tieredProfile('base', 'base', BEKKO_A8M, {
    maxInputTokens: 512,
    maxThreads: 1,
    concurrency: 1,
    heavy: false,
    resizableSession: true,
    memoryMB: 800,
    minFreeMemoryMB: 1000,
  }),
  balanced: tieredProfile('balanced', 'default', BEKKO_A25M, {
    maxInputTokens: 512,
    maxThreads: 2,
    concurrency: 1,
    heavy: false,
    resizableSession: true,
    memoryMB: 960,
    minFreeMemoryMB: 1200,
  }),
  mid: tieredProfile('mid', 'mid', MID_MODEL, {
    maxInputTokens: 512,
    maxThreads: 4,
    concurrency: 2,
    heavy: true,
    resizableSession: true,
    memoryMB: 700,
    minFreeMemoryMB: 896,
    minOrtVersion: ORT_WITH_GATHER_BLOCK_QUANTIZED_BITS,
  }),
  plus: tieredProfile('plus', 'high', MID_MODEL, {
    maxInputTokens: 1024,
    maxThreads: 8,
    concurrency: 3,
    heavy: true,
    resizableSession: true,
    memoryMB: 1000,
    minFreeMemoryMB: 1280,
    minOrtVersion: ORT_WITH_GATHER_BLOCK_QUANTIZED_BITS,
  }),
}

export const EMBEDDING_PROFILE_IDS = Object.keys(EMBEDDING_PROFILES) as EmbeddingProfileId[]

/** Profile ids a fresh install can be given, smallest first. */
export const TIERED_PROFILE_IDS = ['base', 'balanced', 'mid', 'plus'] as const

export function assertEmbeddingManifest(profile: EmbeddingProfile): void {
  for (const file of profile.files) {
    if (file.sha256 && !/^[a-f0-9]{64}$/i.test(file.sha256)) {
      throw new Error(`Invalid SHA-256 for ${profile.id}:${file.path}`)
    }
    if (file.bytes !== undefined && !(Number.isSafeInteger(file.bytes) && file.bytes > 0)) {
      throw new Error(`Invalid size for ${profile.id}:${file.path}`)
    }
  }
  if (!/^[a-f0-9]{40}$/.test(profile.revision)) {
    throw new Error(`Revision of ${profile.id} must be a full commit SHA`)
  }
  const paths = new Set(profile.files.map((file) => file.path))
  for (const required of [profile.modelFile, profile.tokenizerFile, profile.tokenizerConfigFile]) {
    if (!paths.has(required)) throw new Error(`Missing manifest entry for ${profile.id}:${required}`)
  }
  if (profile.tier !== 'legacy') {
    for (const file of profile.files) {
      if (!file.sha256 || !file.bytes) {
        throw new Error(`Tiered profile ${profile.id} must pin sha256 and size of ${file.path}`)
      }
    }
  }
  if (profile.dimensions > profile.nativeDimensions) {
    throw new Error(`Stored dimensions of ${profile.id} exceed the native dimensions`)
  }
}

for (const profile of Object.values(EMBEDDING_PROFILES)) assertEmbeddingManifest(profile)

/**
 * What an install with no saved choice has always run, and therefore what an existing index
 * without a settings file keeps using. Fresh installs are advised by recommendEmbeddingProfile.
 */
export const DEFAULT_EMBEDDING_PROFILE: EmbeddingProfileId = 'standard'

export function isEmbeddingProfileId(value: unknown): value is EmbeddingProfileId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(EMBEDDING_PROFILES, value)
}

export function embeddingProfile(id: unknown): EmbeddingProfile {
  if (isEmbeddingProfileId(id)) return EMBEDDING_PROFILES[id]
  // mid and plus share one vector space; the smaller profile answers for the id.
  const bySpace = Object.values(EMBEDDING_PROFILES).find((profile) => profile.embeddingId === id)
  if (bySpace) return bySpace
  return EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE]
}

export interface MachineSpec {
  /** total RAM in GiB */
  totalMemGiB: number
  /** logical processors */
  logicalCores: number
  arch: string
  platform: string
  /** RAM that can be used right now, in MB; when absent the total is the upper bound */
  freeMemMB?: number
  /**
   * Version of the bundled onnxruntime-node; tiers whose models need a newer one are skipped.
   * Defaults to the installed version (see embedding/ort-support.ts), unknown = no restriction.
   */
  ortVersion?: string
}

export interface EmbeddingRecommendation {
  profile: EmbeddingProfileId
  /** why a bigger tier is not recommended (absent for the top tier) */
  limit?: 'memory' | 'cpu'
}

export const BASE_PROFILE_MAX_MEM_GIB = 6
export const BASE_PROFILE_MAX_CORES = 2
export const BALANCED_PROFILE_MAX_MEM_GIB = 12
export const MID_PROFILE_MAX_MEM_GIB = 24

/**
 * The largest tier this machine could comfortably run: <= 6 GB or <= 2 cores -> base,
 * <= 12 GB -> balanced, <= 24 GB -> mid, otherwise plus. This is only a hint for the settings
 * UI ("your machine can run a better model"); it is NOT the default, see recommendEmbeddingProfile. A tier whose minFreeMemoryMB does not fit in the memory
 * that is available is skipped (the next smaller one is used). Only fresh installs call this;
 * a saved choice is never replaced (see embedding/initial-profile.ts).
 */
export function suggestBiggestProfile(spec: MachineSpec): EmbeddingRecommendation {
  const cpuBound = spec.logicalCores <= BASE_PROFILE_MAX_CORES
  let index: number
  if (spec.totalMemGiB <= BASE_PROFILE_MAX_MEM_GIB || cpuBound) index = 0
  else if (spec.totalMemGiB <= BALANCED_PROFILE_MAX_MEM_GIB) index = 1
  else if (spec.totalMemGiB <= MID_PROFILE_MAX_MEM_GIB) index = 2
  else index = 3

  const availableMB = spec.freeMemMB ?? spec.totalMemGiB * 1024
  let memoryDowngrade = false
  const unusable = (id: EmbeddingProfileId): boolean => {
    const candidate = EMBEDDING_PROFILES[id]
    return (
      candidate.minFreeMemoryMB > availableMB ||
      !ortSupports(candidate.minOrtVersion, spec.ortVersion)
    )
  }
  while (index > 0 && unusable(TIERED_PROFILE_IDS[index]!)) {
    index--
    memoryDowngrade = true
  }

  const profile = TIERED_PROFILE_IDS[index]!
  if (index === TIERED_PROFILE_IDS.length - 1) return { profile }
  const memoryAllowsMore = spec.totalMemGiB > BASE_PROFILE_MAX_MEM_GIB
  return { profile, limit: memoryDowngrade || !(cpuBound && memoryAllowsMore) ? 'memory' : 'cpu' }
}

/**
 * Default tier for a fresh install: the fastest one (Bekko a8m) on every machine, so the first
 * index finishes quickly everywhere (it is ~3x faster than balanced and ~10x faster than mid for
 * ~0.01 nDCG less in the hybrid search, see the embedding benchmark). Bigger tiers are an explicit
 * user choice; suggestBiggestProfile tells the UI what the machine could run. Only fresh installs
 * call this; a saved choice is never replaced (see embedding/initial-profile.ts).
 */
export function recommendEmbeddingProfile(spec: MachineSpec): EmbeddingRecommendation {
  void spec // every machine gets the fastest tier; the spec only matters to suggestBiggestProfile
  return { profile: 'base' }
}
