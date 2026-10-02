/**
 * The embedding models Document memory can use. "standard" is the small multilingual E5 the app
 * always shipped with; "high" is a Vietnamese retrieval model (a bge-m3 fine-tune) that finds
 * the right passage much more often but is about six times slower and needs ~2.3 GB of memory.
 *
 * Measured on Vietnamese legal retrieval (400 questions over 5,266 articles, nDCG@10): e5-small
 * 83.5, Vietnamese_Embedding 93.6. On the real ONNX files with 4 CPU threads (M4): e5-small int8
 * 109 passages/s, Vietnamese_Embedding fp32 14 passages/s.
 *
 * Vectors of different models are never mixed: every document records the embedding id of the
 * model that produced its vectors, and a search only compares vectors of the current model.
 */

export type EmbeddingProfileId = 'standard' | 'high'

export interface EmbeddingProfileFile {
  /** path inside the model repository */
  path: string
  /** SHA-256 verified once, right after the download */
  sha256?: string
  bytes?: number
}

export interface EmbeddingProfile {
  id: EmbeddingProfileId
  repo: string
  revision: string
  /** every file to download (the model's external weight file included) */
  files: EmbeddingProfileFile[]
  modelFile: string
  tokenizerFile: string
  tokenizerConfigFile: string
  /** stored with each document so vectors of another model are never compared */
  embeddingId: string
  dimensions: number
  /** `mean` pools the token vectors; `sentence` uses the model's own pooled output */
  pooling: 'mean' | 'sentence'
  queryPrefix: string
  passagePrefix: string
  downloadMB: number
  /** rough resident memory while embedding */
  memoryMB: number
}

export const EMBEDDING_PROFILES: Record<EmbeddingProfileId, EmbeddingProfile> = {
  standard: {
    id: 'standard',
    repo: 'Xenova/multilingual-e5-small',
    revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    files: [
      { path: 'tokenizer_config.json' },
      { path: 'tokenizer.json' },
      {
        path: 'onnx/model_quantized.onnx',
        sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
      },
    ],
    modelFile: 'onnx/model_quantized.onnx',
    tokenizerFile: 'tokenizer.json',
    tokenizerConfigFile: 'tokenizer_config.json',
    embeddingId: 'Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78:q8',
    dimensions: 384,
    pooling: 'mean',
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
    downloadMB: 135,
    memoryMB: 300,
  },
  high: {
    id: 'high',
    repo: 'AITeamVN/Vietnamese_Embedding',
    revision: 'dea33aa1ab339f38d66ae0a40e6c40e0a9249568',
    files: [
      {
        path: 'onnx/tokenizer_config.json',
        sha256: 'b87c8703482b0300d3da30e201519aa641f6a450f5eb5bf1e624afbf70c74d80',
      },
      {
        path: 'onnx/tokenizer.json',
        sha256: '8bf8afbfd11306bd872018c53bfdf2e160a56f8edbcf49933324404791c148d3',
      },
      {
        path: 'onnx/model.onnx',
        sha256: '8abc48c79bda16d715a7ea838f91b21a97bf22c8f80ad1d11d7701f78ecbad1d',
      },
      {
        path: 'onnx/model.onnx_data',
        sha256: 'f4de2a8bc780de9b4f6dda97e2f403ea93a40b29db05ebee065a92ccf69884bf',
        bytes: 2_266_886_160,
      },
    ],
    modelFile: 'onnx/model.onnx',
    tokenizerFile: 'onnx/tokenizer.json',
    tokenizerConfigFile: 'onnx/tokenizer_config.json',
    embeddingId: 'AITeamVN/Vietnamese_Embedding@dea33aa1ab339f38d66ae0a40e6c40e0a9249568:fp32',
    dimensions: 1024,
    pooling: 'sentence',
    queryPrefix: '',
    passagePrefix: '',
    downloadMB: 2300,
    memoryMB: 2800,
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

/** "High" needs ~2.8 GB free and is ~6x slower: only machines with both RAM and cores get it. */
export const HIGH_PROFILE_MIN_MEM_GIB = 15
export const HIGH_PROFILE_MIN_CORES = 8

/**
 * Which model suits this computer. Apple Silicon counts as fast enough with any core count (its
 * performance cores outrun an 8-thread x86 laptop part); everything else needs 8 logical
 * processors. RAM below 15 GiB (a 16 GB machine reports ~15.9) is never enough.
 */
export function recommendEmbeddingProfile(spec: MachineSpec): EmbeddingRecommendation {
  if (spec.totalMemGiB < HIGH_PROFILE_MIN_MEM_GIB) return { profile: 'standard', limit: 'memory' }
  const appleSilicon = spec.platform === 'darwin' && spec.arch === 'arm64'
  if (!appleSilicon && spec.logicalCores < HIGH_PROFILE_MIN_CORES)
    return { profile: 'standard', limit: 'cpu' }
  return { profile: 'high' }
}
