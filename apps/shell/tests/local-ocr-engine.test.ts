import { describe, it, expect } from 'vitest'
import {
  OCR_MODEL_BENCHMARKS,
  LocalOcrUnavailableError,
  postProcessVietnameseOcrText,
} from '../src/main/document-memory/runtime/local-ocr-engine'
import { RAPIDOCR_DESCRIPTOR } from '../src/main/document-memory/local-ocr/rapidocr-descriptor'
import { TesseractEngine } from '../src/main/document-memory/local-ocr/tesseract-engine'
import { AppleVisionEngine } from '../src/main/document-memory/local-ocr/vision-engine'

// History: this file used to assert that the whole local-OCR runtime was a stub (every engine
// candidate_only, `LocalOcrEngine` always unavailable). Real engines now exist (Apple Vision,
// Tesseract; see local-ocr-engines.test.ts), so the stub-only assertions were replaced by the
// honesty rules that still hold: candidates that have no runtime stay candidate_only with no invented
// metrics, an engine without its resources refuses with a typed error instead of fake output.
describe('Checkpoint 5: OCR Candidate Metadata & Local Engine Honesty', () => {
  it('OCR-01: PP-OCRv6 tiny & small are candidate-only with no fabricated benchmark metrics', () => {
    for (const id of ['pp-ocrv6-tiny', 'pp-ocrv6-small']) {
      const candidate = OCR_MODEL_BENCHMARKS[id]!
      expect(candidate.status).toBe('candidate_only')
      // No runtime for these candidates is wired (RapidOCR is phase 2), so nothing is recommended yet.
      expect(candidate.recommendedForLocal).toBe(false)
      expect(candidate.licenseVerified).toBe(true)
      // Unmeasured metrics must stay null; never derived from weight size.
      expect(candidate.metrics.status).toBe('unknown')
      expect(candidate.typicalRamBytes).toBeNull()
      expect(candidate.avgCpuLatencyMs).toBeNull()
      expect(candidate.vietnameseAccuracy).toBeNull()
      expect(candidate.metrics.peakRamBytes).toBeNull()
      expect(candidate.weights.weightsDisclaimer).toMatch(/RAM/)
    }
  })

  it('OCR-02: Heavy VLMs (Vintern, EraX) and GLM-OCR are candidate-only and never recommended for local scanning', () => {
    const vintern = OCR_MODEL_BENCHMARKS['vintern-1b-v3.5']!
    expect(vintern.modelType).toBe('vlm')
    expect(vintern.recommendedForLocal).toBe(false)
    expect(vintern.typicalRamBytes).toBeNull()
    expect(vintern.weightSizeBytes).toBeGreaterThan(1000 * 1024 * 1024) // documented ~1.2 GB weights

    const erax = OCR_MODEL_BENCHMARKS['erax-vl-2b-v1.5']!
    expect(erax.modelType).toBe('vlm')
    expect(erax.recommendedForLocal).toBe(false)
    expect(erax.avgCpuLatencyMs).toBeNull()

    const glm = OCR_MODEL_BENCHMARKS['glm-ocr']!
    expect(glm.licenseVerified).toBe(false)
    expect(glm.licenseCompliant).toBeNull()
    expect(glm.recommendedForLocal).toBe(false)
  })

  it('OCR-03: engines without their bundled resources refuse with a typed error and never fabricate text', async () => {
    const noModel = new TesseractEngine({ langPath: null })
    expect(noModel.isAvailable('linux', 64_000)).toBe(false)
    await expect(noModel.recognizePage({ bytes: new Uint8Array([1, 2, 3]), dpi: 150, lang: 'vie' })).rejects.toBeInstanceOf(
      LocalOcrUnavailableError,
    )
    const noHelper = new AppleVisionEngine({ helperPath: null })
    expect(noHelper.isAvailable('darwin', 64_000)).toBe(false)
    await expect(noHelper.recognizePage({ bytes: new Uint8Array([1, 2, 3]), dpi: 100, lang: 'vie' })).rejects.toBeInstanceOf(
      LocalOcrUnavailableError,
    )
    // RapidOCR is a descriptor with measured numbers but no runtime
    expect(RAPIDOCR_DESCRIPTOR.available).toBe(false)
    expect(OCR_MODEL_BENCHMARKS['pp-ocrv6-tiny']!.weightSizeBytes).toBe(1_829_618 + 4_489_813)
    await noModel.dispose()
  })

  it('OCR-04: postProcessVietnameseOcrText fixes detached diacritics and formatting', () => {
    const rawOcr = 'Bệnh  viện Đa khoa  , Thành phố  Hồ Chí Minh . '
    const cleaned = postProcessVietnameseOcrText(rawOcr)
    expect(cleaned).toBe('Bệnh viện Đa khoa, Thành phố Hồ Chí Minh.')
  })
})
