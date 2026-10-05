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

export const EMBEDDING_PROFILES: Record<EmbeddingProfileId, EmbeddingProfile> = {
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

    maxInputTokens: 512,

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

    maxInputTokens: 1024,

    downloadMB: 600,
    memoryMB: 900,
    minFreeMemoryMB: 900,
  },
}

export function assertEmbeddingManifest(profile: EmbeddingProfile): void {
  for (const file of profile.files) {
    if (file.sha256 && !/^[a-f0-9]{64}$/i.test(file.sha256)) {
      throw new Error(`Invalid SHA-256 for ${profile.id}:${file.path}`)
    }
  }
}

assertEmbeddingManifest(EMBEDDING_PROFILES.standard)
assertEmbeddingManifest(EMBEDDING_PROFILES.high)

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
