import type { EmbeddingPooling, EmbeddingProfileFile } from '../embedding-profiles'

/**
 * Pinned model artifacts for the tiered embedding profiles (benchmark decision, 2026-10).
 *
 * Every revision is a full commit SHA read from the Hugging Face model API; every LFS file
 * carries the sha256 and size the API reports for that revision (and was re-hashed after a
 * real download when the parity harness was run). Small non-LFS files (tokenizer_config.json)
 * were hashed from the pinned revision. Bump `revision` AND the file table together; the
 * embeddingId changes with the revision, which creates a new vector space by design.
 */

/** Bump when any query/passage template below changes: it is part of every new embeddingId. */
export const PREFIX_VERSION = 'p1'

export interface ModelArtifactSpec {
  /** short, stable name used inside the embeddingId */
  slug: string
  repo: string
  revision: string
  files: EmbeddingProfileFile[]
  modelFile: string
  tokenizerFile: string
  tokenizerConfigFile: string
  /** weight precision of the ONNX file, part of the embeddingId */
  modelPrecision: 'q8' | 'qe8'
  pooling: EmbeddingPooling
  nativeDimensions: number
  /** Dimension the tiered profiles store (Matryoshka-truncated and re-normalised when smaller). */
  storedDimensions: number
  queryInstruction: string
  queryPrefix: string
  passagePrefix: string
  /** Extra empty float inputs a multimodal export demands even for text-only use. */
  emptyInputs?: Array<{ name: string; dims: number[] }>
  /** SPDX-ish licence label shown in docs/NOTICE. */
  license: string
  /** Largest input the model itself accepts. */
  modelMaxTokens: number
}

const RETRIEVAL_TASK =
  'Given a user query, retrieve the most relevant local document passages. Documents may be in Vietnamese or English.'

/** hotchpotch/bekko-embedding-v1-a8m, MIT. ModernBERT, 384d, mean pooling, no prefixes. */
export const BEKKO_A8M: ModelArtifactSpec = {
  slug: 'bekko-a8m',
  repo: 'hotchpotch/bekko-embedding-v1-a8m',
  revision: 'c721113d59a1d91b447450324f51c4b3332c924a',
  files: [
    {
      path: 'tokenizer.json',
      sha256: '8bd47075711f75a143d1b78e01a41cc65c1c591b00d3cfeffc23db07adce1392',
      bytes: 34363442,
    },
    {
      path: 'tokenizer_config.json',
      sha256: '2ee40d1066ac855e1ea38ac422dbe1f3ddf84c9d415e79272adce569668f3de4',
      bytes: 46634,
    },
    {
      path: 'onnx/model.onnx',
      sha256: '96d8cc6199e96357b21b2fb12f6d7ffd2d4abc7b182fe94b5468fbd6dc819af7',
      bytes: 130099079,
    },
  ],
  modelFile: 'onnx/model.onnx',
  tokenizerFile: 'tokenizer.json',
  tokenizerConfigFile: 'tokenizer_config.json',
  modelPrecision: 'qe8',
  pooling: 'mean',
  nativeDimensions: 384,
  storedDimensions: 384,
  queryInstruction: '',
  queryPrefix: '',
  passagePrefix: '',
  license: 'MIT',
  modelMaxTokens: 8192,
}

/** hotchpotch/bekko-embedding-v1-a25m, MIT. Same tokenizer and recipe as a8m, wider network. */
export const BEKKO_A25M: ModelArtifactSpec = {
  ...BEKKO_A8M,
  slug: 'bekko-a25m',
  repo: 'hotchpotch/bekko-embedding-v1-a25m',
  revision: '44f0b8af0f487acd0ccf1a7cb7ae7a29a6dfc09c',
  files: [
    BEKKO_A8M.files[0]!,
    BEKKO_A8M.files[1]!,
    {
      path: 'onnx/model.onnx',
      sha256: 'd676a3d4f769e63de4bf6778068761eced1721f29b1b6909e94b3f9544e2edd3',
      bytes: 199300251,
    },
  ],
}

/**
 * EmbeddingGemma-2 270M text tower, community ONNX int8 export (onnx-community, Apache-2.0
 * metadata; the Gemma Prohibited-Use Policy still applies to the weights, see LICENSES/NOTICE).
 * The graph pools internally: its `sentence_embedding` output is mean pooled, projected
 * 512 -> 768 and L2-normalised; we truncate to 512 (Matryoshka) and re-normalise.
 */
export const EMBEDDING_GEMMA_2: ModelArtifactSpec = {
  slug: 'embeddinggemma-2',
  repo: 'onnx-community/embeddinggemma-2-ONNX',
  revision: 'daa72c51243991dfcaf9f9137d2c573d8f7790c0',
  files: [
    {
      path: 'tokenizer.json',
      sha256: '4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4',
      bytes: 32170510,
    },
    {
      path: 'tokenizer_config.json',
      sha256: '17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874',
      bytes: 1599,
    },
    {
      path: 'onnx/model_quantized.onnx',
      sha256: 'd06edd601f851c633a2519304cbeb8dc6170d7ceb61b436625c17fb9b6e74953',
      bytes: 495165,
    },
    {
      // external weights of model_quantized.onnx; must sit next to it
      path: 'onnx/model_quantized.onnx_data',
      sha256: '278a7ff1248c3618e4bd11a607fc54f7bdc7778854230f3956d3f86bd9db4f3b',
      bytes: 313724928,
    },
  ],
  modelFile: 'onnx/model_quantized.onnx',
  tokenizerFile: 'tokenizer.json',
  tokenizerConfigFile: 'tokenizer_config.json',
  modelPrecision: 'q8',
  pooling: 'sentence',
  nativeDimensions: 768,
  storedDimensions: 512,
  queryInstruction: '',
  queryPrefix: 'task: search result | query: ',
  passagePrefix: 'title: none | text: ',
  emptyInputs: [
    { name: 'image_features', dims: [0, 512] },
    { name: 'video_features', dims: [0, 512] },
    { name: 'audio_features', dims: [0, 512] },
  ],
  license: 'Apache-2.0 (Gemma Prohibited-Use Policy applies)',
  modelMaxTokens: 8192,
}

/**
 * microsoft/harrier-oss-v1-270m via onnx-community, MIT: the licence-clean substitute for
 * EmbeddingGemma-2. To swap MID/PLUS to it change `MID_MODEL` in embedding-profiles.ts to
 * HARRIER_270M and set the stored dimensions to 640 (the swap creates a new vector space).
 * Queries need the Instruct wrapper, passages none.
 */
export const HARRIER_270M: ModelArtifactSpec = {
  slug: 'harrier-oss-270m',
  repo: 'onnx-community/harrier-oss-v1-270m-ONNX',
  revision: 'd59c919d0159aea2c19ed7d04288fcdd048d0f9c',
  files: [
    {
      path: 'tokenizer.json',
      sha256: 'ec95be298bea26f90370854faa650744c9fb0a04ca5e5ff95dd3913393ac5e45',
      bytes: 20323311,
    },
    {
      path: 'tokenizer_config.json',
      sha256: '135405f3479eaebc473e2e78593f2195c7598948a215ee748758def426b30f59',
      bytes: 702,
    },
    {
      path: 'onnx/model_quantized.onnx',
      sha256: '44fe93efec64ac3446703403634fd8410c7dabf3814bf00dc0825f1e2dde75c0',
      bytes: 243493,
    },
    {
      path: 'onnx/model_quantized.onnx_data',
      sha256: 'a81e3db98eaedd77deafe07d7c3c03b254b7e012790a7a1774295aff03d4fbdf',
      bytes: 343702016,
    },
  ],
  modelFile: 'onnx/model_quantized.onnx',
  tokenizerFile: 'tokenizer.json',
  tokenizerConfigFile: 'tokenizer_config.json',
  modelPrecision: 'q8',
  pooling: 'sentence',
  nativeDimensions: 640,
  storedDimensions: 640,
  queryInstruction: RETRIEVAL_TASK,
  queryPrefix: '',
  passagePrefix: '',
  license: 'MIT',
  modelMaxTokens: 32768,
}

/**
 * Stable vector-space id: model + 10 hex of the revision + weight precision + pooling +
 * stored dimensions + vector quantisation + prefix-template version. Any of them changing
 * makes a different space, so stale vectors can never be searched with the wrong recipe.
 */
export function buildEmbeddingId(
  spec: Pick<ModelArtifactSpec, 'slug' | 'revision' | 'modelPrecision' | 'pooling'>,
  dimensions: number,
  vectorQuantisation: 'int8' | 'fp32',
): string {
  return [
    spec.slug,
    spec.revision.slice(0, 10),
    spec.modelPrecision,
    spec.pooling,
    String(dimensions),
    vectorQuantisation === 'int8' ? 'v8' : 'v32',
    PREFIX_VERSION,
  ].join(':')
}
