import type { ModelArtifactManifest } from '../document-memory/embedding/model-files'

/**
 * The one local chat model GenOffice supports: LFM3-VL-2B at Q4_K_M, run text-only by the
 * managed llama-server (packages/ai-provider/src/local-llm).
 *
 * Pinned from the Hugging Face API (GET /api/models/LiquidAI/LFM3-VL-2B-GGUF?blobs=true):
 * the commit SHA of `main` and the LFS sha256 / size of the GGUF at that commit. Bump `revision`
 * and the file entry together; a different revision is a different model as far as the cache is
 * concerned (the cache path contains the revision).
 *
 * Not mirrorable: the LFM Open License v1.0 allows redistribution, but whether GenOffice mirrors
 * the weights itself is a legal decision still open, so the only source is Hugging Face.
 */
export const LFM3_VL_2B_Q4_K_M: ModelArtifactManifest = {
  id: 'lfm3-vl-2b-q4_k_m',
  repo: 'LiquidAI/LFM3-VL-2B-GGUF',
  revision: '1add221a5ea6c047fcf1eaaf2d247939d7cf8849',
  files: [
    {
      path: 'LFM3-VL-2B-Q4_K_M.gguf',
      sha256: '56dac2e192ff0d9ab8507f4f1aeb4aed0463449bbbefaac79497f041c95f21eb',
      bytes: 1_099_627_808,
    },
  ],
  mirrorable: false,
}

/** Folder under userData that holds local chat models (one subfolder per repo and revision). */
export const LOCAL_MODELS_DIR_NAME = 'local-models'

/** Shown in download failure messages instead of the embedding downloader's "search model". */
export const LOCAL_MODEL_LABEL = 'local AI model'
