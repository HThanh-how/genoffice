/**
 * Local OCR contract and candidate metadata for GenOffice.
 *
 * Implemented engines (see ../local-ocr/): Apple Vision `accurate` on macOS (bundled Swift helper)
 * and Tesseract `vie` (tessdata_fast, tesseract.js WASM) everywhere else. The candidates below are
 * the OTHER models that were looked at; they stay `candidate_only` until an engine for them exists
 * (RapidOCR PP-OCRv6-tiny is phase 2: see ../local-ocr/rapidocr-descriptor.ts for its measured numbers).
 * Candidate `metrics` stay unknown here on purpose: measured figures live in the engine descriptors.
 */

export type MetricStatus = 'documented' | 'measured' | 'unknown'

export interface OcrCandidateWeightInfo {
  /**
   * Documented file size of weights on disk from official upstream release, or null if unverified.
   */
  readonly weightSizeBytes: number | null
  readonly dtype?: string
  readonly artifactVersion?: string
  readonly source?: string
  /**
   * Weights disk footprint is NOT runtime RAM or bundle size.
   * Peak RAM must never be derived from weights size.
   */
  readonly weightsDisclaimer: string
}

export interface OcrCandidateBenchmarkMetrics {
  readonly status: 'unknown'
  readonly dataset: null
  readonly hardware: null
  readonly vietnameseAccuracy: null
  readonly avgCpuLatencyMs: null
  readonly typicalRamBytes: null
  readonly peakRamBytes: null
}

export interface OcrCandidateMetadata {
  readonly id: string
  readonly name: string
  readonly modelFamily: string
  readonly modelType: 'cnn-rnn' | 'vlm'
  readonly weights: OcrCandidateWeightInfo
  readonly metrics: OcrCandidateBenchmarkMetrics
  // Flat properties for compatibility with callers expecting legacy OcrEngineBenchmark
  readonly weightSizeBytes: number | null
  readonly typicalRamBytes: null
  readonly avgCpuLatencyMs: null
  readonly vietnameseAccuracy: null
  readonly license: string
  readonly licenseVerified: boolean
  readonly licenseCompliant: boolean | null
  readonly recommendedForLocal: false
  readonly status: 'candidate_only'
  readonly feasibilityReason: string
}

export type OcrEngineBenchmark = OcrCandidateMetadata

export const OCR_MODEL_CANDIDATES: Readonly<Record<string, OcrCandidateMetadata>> = Object.freeze({
  'pp-ocrv6-tiny': {
    id: 'pp-ocrv6-tiny',
    name: 'PaddleOCR PP-OCRv6 Tiny (Candidate)',
    modelFamily: 'PaddleOCR',
    modelType: 'cnn-rnn',
    weights: {
      weightSizeBytes: 6_319_431, // measured: det 1,829,618 + rec 4,489,813 bytes (ONNX)
      dtype: 'FP32 / INT8',
      artifactVersion: 'PP-OCRv6-preview',
      source: 'PaddlePaddle/PaddleOCR GitHub repository',
      weightsDisclaimer:
        'Weights size on disk != runtime RAM or bundle size. Peak RAM cannot be derived from weight size.',
    },
    metrics: {
      status: 'unknown',
      dataset: null,
      hardware: null,
      vietnameseAccuracy: null,
      avgCpuLatencyMs: null,
      typicalRamBytes: null,
      peakRamBytes: null,
    },
    weightSizeBytes: 6_319_431,
    typicalRamBytes: null,
    avgCpuLatencyMs: null,
    vietnameseAccuracy: null,
    license: 'Apache-2.0',
    licenseVerified: true,
    licenseCompliant: null,
    recommendedForLocal: false,
    status: 'candidate_only',
    feasibilityReason:
      'Best cross-platform candidate in the offline benchmark (invoice number 100% at 100 dpi) but its recogniser lacks ~92 Vietnamese letters, so it is a phase-2 folded-index engine; no runtime is wired yet.',
  },
  'pp-ocrv6-small': {
    id: 'pp-ocrv6-small',
    name: 'PaddleOCR PP-OCRv6 Small (Candidate)',
    modelFamily: 'PaddleOCR',
    modelType: 'cnn-rnn',
    weights: {
      weightSizeBytes: null,
      dtype: 'FP32 / INT8',
      artifactVersion: 'PP-OCRv6-preview',
      source: 'PaddlePaddle/PaddleOCR GitHub repository',
      weightsDisclaimer:
        'Weights size on disk != runtime RAM or bundle size. Peak RAM cannot be derived from weight size.',
    },
    metrics: {
      status: 'unknown',
      dataset: null,
      hardware: null,
      vietnameseAccuracy: null,
      avgCpuLatencyMs: null,
      typicalRamBytes: null,
      peakRamBytes: null,
    },
    weightSizeBytes: null,
    typicalRamBytes: null,
    avgCpuLatencyMs: null,
    vietnameseAccuracy: null,
    license: 'Apache-2.0',
    licenseVerified: true,
    licenseCompliant: null,
    recommendedForLocal: false,
    status: 'candidate_only',
    feasibilityReason:
      'Candidate pipeline model. Local inference runtime is not yet implemented in GenOffice; accuracy and latency unmeasured.',
  },
  'pp-ocrv5-mobile': {
    id: 'pp-ocrv5-mobile',
    name: 'PaddleOCR PP-OCRv5 Mobile (Candidate)',
    modelFamily: 'PaddleOCR',
    modelType: 'cnn-rnn',
    weights: {
      weightSizeBytes: 16 * 1024 * 1024,
      dtype: 'FP32 / INT8',
      artifactVersion: 'PP-OCRv5_mobile',
      source: 'PaddlePaddle/PaddleOCR official repository (det+rec models ~16 MB total)',
      weightsDisclaimer:
        'Weights disk size (~16 MB) != runtime memory or bundle size. Never derive RAM from weights.',
    },
    metrics: {
      status: 'unknown',
      dataset: null,
      hardware: null,
      vietnameseAccuracy: null,
      avgCpuLatencyMs: null,
      typicalRamBytes: null,
      peakRamBytes: null,
    },
    weightSizeBytes: 16 * 1024 * 1024,
    typicalRamBytes: null,
    avgCpuLatencyMs: null,
    vietnameseAccuracy: null,
    license: 'Apache-2.0',
    licenseVerified: true,
    licenseCompliant: null,
    recommendedForLocal: false,
    status: 'candidate_only',
    feasibilityReason:
      'Lightweight mobile pipeline candidate. Local inference runtime is not implemented; performance unmeasured in GenOffice.',
  },
  'vintern-1b-v3.5': {
    id: 'vintern-1b-v3.5',
    name: 'Vintern-1B-v3.5 (Candidate)',
    modelFamily: 'Vintern / Qwen2-VL',
    modelType: 'vlm',
    weights: {
      weightSizeBytes: 1_200 * 1024 * 1024,
      dtype: 'INT4 (AWQ/GGUF) / FP16',
      artifactVersion: 'v3.5',
      source: 'Hugging Face (5CD-AI/Vintern-1B-v3.5, INT4 quantized weights ~1.2 GB)',
      weightsDisclaimer:
        'Quantized weights size (~1.2 GB) != runtime context RAM or engine bundle. Runtime memory depends on context length and VLM engine overhead; never derive RAM directly from weights.',
    },
    metrics: {
      status: 'unknown',
      dataset: null,
      hardware: null,
      vietnameseAccuracy: null,
      avgCpuLatencyMs: null,
      typicalRamBytes: null,
      peakRamBytes: null,
    },
    weightSizeBytes: 1_200 * 1024 * 1024,
    typicalRamBytes: null,
    avgCpuLatencyMs: null,
    vietnameseAccuracy: null,
    license: 'Apache-2.0',
    licenseVerified: true,
    licenseCompliant: null,
    recommendedForLocal: false,
    status: 'candidate_only',
    feasibilityReason:
      'Multimodal vision-language model candidate. Requires dedicated local VLM runtime; resource consumption and latency unmeasured on desktop.',
  },
  'erax-vl-2b-v1.5': {
    id: 'erax-vl-2b-v1.5',
    name: 'EraX-VL-2B-V1.5 (Candidate)',
    modelFamily: 'EraX-VL',
    modelType: 'vlm',
    weights: {
      weightSizeBytes: 2_200 * 1024 * 1024,
      dtype: 'INT4 (GGUF/AWQ) / FP16',
      artifactVersion: 'v1.5',
      source: 'Hugging Face (EraX-VL-2B-V1.5, INT4 quantized weights ~2.2 GB)',
      weightsDisclaimer:
        'Weights file size (~2.2 GB) != runtime process RAM or memory working set. VLM KV cache and image embeddings require substantial additional memory. Never derive RAM from weights.',
    },
    metrics: {
      status: 'unknown',
      dataset: null,
      hardware: null,
      vietnameseAccuracy: null,
      avgCpuLatencyMs: null,
      typicalRamBytes: null,
      peakRamBytes: null,
    },
    weightSizeBytes: 2_200 * 1024 * 1024,
    typicalRamBytes: null,
    avgCpuLatencyMs: null,
    vietnameseAccuracy: null,
    license: 'Apache-2.0',
    licenseVerified: true,
    licenseCompliant: null,
    recommendedForLocal: false,
    status: 'candidate_only',
    feasibilityReason:
      '2B parameter vision-language model candidate. Local runtime not integrated in GenOffice; RAM and CPU latency unmeasured.',
  },
  'glm-ocr': {
    id: 'glm-ocr',
    name: 'GLM-OCR (Candidate)',
    modelFamily: 'GLM',
    modelType: 'vlm',
    weights: {
      weightSizeBytes: null,
      dtype: 'unspecified',
      artifactVersion: 'GLM-OCR',
      source: 'THUDM / Zhipu AI GLM-OCR repository (distinct model from GLM-4V)',
      weightsDisclaimer:
        'Distinct from general GLM-4V models. Weights size on disk != runtime RAM or engine bundle.',
    },
    metrics: {
      status: 'unknown',
      dataset: null,
      hardware: null,
      vietnameseAccuracy: null,
      avgCpuLatencyMs: null,
      typicalRamBytes: null,
      peakRamBytes: null,
    },
    weightSizeBytes: null,
    typicalRamBytes: null,
    avgCpuLatencyMs: null,
    vietnameseAccuracy: null,
    license: 'Unknown (requires verification of specific artifact license)',
    licenseVerified: false,
    licenseCompliant: null,
    recommendedForLocal: false,
    status: 'candidate_only',
    feasibilityReason:
      'Specialized document parsing candidate, distinct from GLM-4V. License and runtime resource requirements have not been independently verified; unmeasured in GenOffice.',
  },
})

export const OCR_MODEL_BENCHMARKS: Readonly<Record<string, OcrCandidateMetadata>> =
  OCR_MODEL_CANDIDATES

export interface OcrWordBox {
  text: string
  confidence: number
  box: [number, number, number, number] // [x1, y1, x2, y2]
}

export interface LocalOcrPageResult {
  text: string
  words: OcrWordBox[]
  engine: string
  durationMs: number
  confidence: number
}

/**
 * Typed error thrown when a local OCR operation is attempted without an available inference engine.
 */
export class LocalOcrUnavailableError extends Error {
  readonly code = 'LOCAL_OCR_UNAVAILABLE' as const
  readonly engineId: string
  readonly reason: string

  constructor(engineId: string, reason: string) {
    super(`Local OCR engine "${engineId}" is unavailable: ${reason}`)
    this.name = 'LocalOcrUnavailableError'
    this.engineId = engineId
    this.reason = reason
  }
}

/**
 * Normalizes Vietnamese OCR output by fixing common character splits and diacritic artifacts.
 * Performs standard NFC Unicode normalization and basic typography spacing.
 * Does NOT synthesize, hallucinate, or fabricate text content.
 */
export function postProcessVietnameseOcrText(text: string): string {
  if (!text) return ''
  return text
    .normalize('NFC')
    // Fix detached diacritics
    .replace(/([a-zA-Z])\s*([̣̀́̃̉])/g, '$1$2')
    // Normalize spaces around punctuation
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/([.,;:!?])(?=[a-zA-Z0-9])/g, '$1 ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

// ---- the engine abstraction ---------------------------------------------------------------------
// Implementations live in ./local-ocr/ (Apple Vision helper, Tesseract WASM); selection in
// ./local-ocr/registry.ts. This file only holds the contract so every module can depend on it.

/** One recognised word / line with the engine's own confidence (0..1). */
export interface LocalOcrToken {
  text: string
  confidence: number
}

export interface LocalOcrRecognizeInput {
  /** encoded image (JPEG / PNG); exactly one of bytes / imagePath */
  bytes?: Uint8Array
  imagePath?: string
  /** effective resolution of the image (used for background normalisation radius) */
  dpi: number
  /** recognition language, 'vie' in practice */
  lang: string
  timeoutMs?: number
}

export interface LocalOcrRecognition {
  text: string
  /** character-weighted mean of the engine's confidence, 0..1 */
  meanConfidence: number
  /** words (Tesseract) or lines (Vision) with their confidence; absent when the engine has none */
  tokens?: LocalOcrToken[]
  ms: number
}

/** Static facts about an engine: measured, not guessed (see the benchmark notes per entry). */
export interface LocalOcrEngineDescriptor {
  readonly id: string
  readonly name: string
  readonly platforms: readonly NodeJS.Platform[] | 'all'
  /** free RAM (MB) that must be available before the engine is started */
  readonly minFreeRamMB: number
  /** resolution the engine wants its input rendered at */
  readonly dpi: number
  /** escalation threshold on S = meanConfidence x syllable validity (below = ask the cloud reader) */
  readonly escalationThreshold: number
  readonly license: string
  /** false = descriptor only, nothing runs (RapidOCR, phase 2) */
  readonly available: boolean
  readonly notes: string
}

export interface LocalOcrEngine {
  readonly id: string
  readonly descriptor: LocalOcrEngineDescriptor
  /** can this engine run here now: platform supported, resources present, enough free RAM */
  isAvailable(platform: NodeJS.Platform, freeRamMB: number): boolean
  recognizePage(input: LocalOcrRecognizeInput): Promise<LocalOcrRecognition>
  dispose(): Promise<void>
}
