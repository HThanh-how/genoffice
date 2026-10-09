/**
 * RapidOCR + PP-OCRv6-tiny (ONNX): PHASE 2, descriptor only. Nothing runs and `available` is
 * false, so the registry can never select it. The numbers are the offline benchmark's.
 *
 * Why it is not wired yet: it needs a TypeScript port of DB text detection post-processing and
 * CTC decoding on top of onnxruntime-node, and its recogniser charset lacks ~92 of the 134
 * precomposed Vietnamese letters (it reads "Đơn vị" as "Đon vi"), so its text is only suitable
 * for the diacritic-folded lexical index, not for display or embeddings.
 */
import type { LocalOcrEngineDescriptor } from '../runtime/local-ocr-engine'
import { RAPIDOCR_ESCALATION_THRESHOLD } from './escalation'

export interface RapidOcrMeasurements {
  readonly weightBytes: number
  readonly onnxRuntimeDylibBytesMacArm64: number
  /** peak RSS by detector side cap (MB), 24 pages, one thread, 100 dpi */
  readonly peakRssMB: { readonly limit640: number; readonly limit960: number; readonly uncapped: number }
  readonly cpuSecondsPerPage100dpi: { readonly limit640: number; readonly limit960: number; readonly uncapped: number }
  readonly invoiceNumberRecovery100dpi: number
  readonly consensusTokenRecall100dpi: number
}

export const RAPIDOCR_MEASUREMENTS: RapidOcrMeasurements = {
  weightBytes: 6_319_431, // det 1,829,618 + rec 4,489,813
  onnxRuntimeDylibBytesMacArm64: 32 * 1024 * 1024,
  peakRssMB: { limit640: 483, limit960: 708, uncapped: 1004 },
  cpuSecondsPerPage100dpi: { limit640: 0.76, limit960: 0.91, uncapped: 1.03 },
  invoiceNumberRecovery100dpi: 1.0,
  consensusTokenRecall100dpi: 0.91,
}

export const RAPIDOCR_DESCRIPTOR: LocalOcrEngineDescriptor = {
  id: 'rapidocr-ppocrv6-tiny',
  name: 'RapidOCR PP-OCRv6-tiny (phase 2)',
  platforms: 'all',
  minFreeRamMB: 1536, // the benchmark's own advice: only when >= 1.5 GB is free
  dpi: 100,
  escalationThreshold: RAPIDOCR_ESCALATION_THRESHOLD,
  license: 'Apache-2.0 (RapidOCR, PP-OCR weights); onnxruntime MIT',
  available: false,
  notes:
    'Descriptor only. Needs detector/CTC post-processing in TS; recogniser drops Vietnamese diacritics (folded index only).',
}
