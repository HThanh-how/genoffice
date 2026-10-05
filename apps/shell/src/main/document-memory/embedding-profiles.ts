/**
 * standard = F2LLM-v2-80M
 * high = Qwen3-Embedding-0.6B
 *
 * standard:
 * low-memory / default
 *
 * high:
 * quality mode
 */

export type EmbeddingProfileId = 'standard' | 'high'

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

  /** Maximum tokens GenOffice itself permits. */
  maxInputTokens: number

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

export const EMBEDDING_PROFILES: Record<EmbeddingProfileId, EmbeddingProfile> = {
  standard: {
    id: 'standard',

    repo: 'codefuse-ai/F2LLM-v2-80M',

    // Pinned branch/revision
    revision: 'main',

    files: [
      { path: 'tokenizer.json' },
      { path: 'tokenizer_config.json' },
      { path: 'onnx/model_q8.onnx' },
    ],

    modelFile: 'onnx/model_q8.onnx',
    tokenizerFile: 'tokenizer.json',
    tokenizerConfigFile: 'tokenizer_config.json',

    embeddingId: 'f2llm-v2-80m:main:q8:last-token:320:v1',

    nativeDimensions: 320,
    dimensions: 320,

    pooling: 'last-token',

    queryInstruction:
      'Given a user query, retrieve the most relevant local document passages. Documents may be in Vietnamese or English.',

    queryPrefix: '',
    passagePrefix: '',

    maxInputTokens: 512,

    downloadMB: 95,
    memoryMB: 180,
    minFreeMemoryMB: 384,
  },
  high: {
    id: 'high',

    repo: 'Qwen/Qwen3-Embedding-0.6B',

    // Pinned commit revision
    revision: 'b22da495047858cce924d27d76261e96be6febc0',

    files: [
      { path: 'tokenizer.json' },
      { path: 'tokenizer_config.json' },
      { path: 'onnx/model_q8.onnx' },
    ],

    modelFile: 'onnx/model_q8.onnx',
    tokenizerFile: 'tokenizer.json',
    tokenizerConfigFile: 'tokenizer_config.json',

    embeddingId: 'qwen3-embedding-0.6b:b22da49:q8:last-token:512:v1',

    nativeDimensions: 1024,

    // Do not store 1024D by default.
    dimensions: 512,

    pooling: 'last-token',

    queryInstruction:
      'Given a user query, retrieve the most relevant local document passages. Documents may be in Vietnamese or English.',

    queryPrefix: '',
    passagePrefix: '',

    maxInputTokens: 1024,

    downloadMB: 650,
    memoryMB: 900,
    minFreeMemoryMB: 900,
  },
}

export const DEFAULT_EMBEDDING_PROFILE: EmbeddingProfileId = 'standard'

export function isEmbeddingProfileId(value: unknown): value is EmbeddingProfileId {
  return value === 'standard' || value === 'high'
}

export function embeddingProfile(id: unknown): EmbeddingProfile {
  return EMBEDDING_PROFILES[isEmbeddingProfileId(id) ? id : DEFAULT_EMBEDDING_PROFILE]
}

export interface MachineSpec {
  /** total RAM in GiB */
  totalMemGiB: number
  /** logical processors */
  logicalCores: number
  arch: string
  platform: string
}

export interface EmbeddingRecommendation {
  profile: EmbeddingProfileId
  /** why "high" is not recommended (absent when it is) */
  limit?: 'memory' | 'cpu'
}

export const HIGH_PROFILE_MIN_MEM_GIB = 7
export const HIGH_PROFILE_MIN_CORES = 4

export function recommendEmbeddingProfile(spec: MachineSpec): EmbeddingRecommendation {
  if (spec.totalMemGiB < 6) {
    return {
      profile: 'standard',
      limit: 'memory',
    }
  }

  // F2 remains the safe default even on an 8 GB machine.
  if (spec.totalMemGiB < 12) {
    return {
      profile: 'standard',
      limit: 'memory',
    }
  }

  const appleSilicon = spec.platform === 'darwin' && spec.arch === 'arm64'

  if (!appleSilicon && spec.logicalCores < 6) {
    return {
      profile: 'standard',
      limit: 'cpu',
    }
  }

  return {
    profile: 'high',
  }
}
