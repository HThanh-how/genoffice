import type {
  LocalOcrEngine,
  LocalOcrRecognition,
  LocalOcrRecognizeInput,
} from '../runtime/local-ocr-engine'
import { TRUEOCR_ENGINE_ID } from './trueocr-engine'
import { TESSERACT_ENGINE_ID } from './tesseract-engine'
import type { EngineSelection, LocalOcrEnginePreference } from './registry'

/** Sample-derived confidence floor; see docs/local-ocr-trueocr.md for calibration. */
export const TRUEOCR_TESSERACT_MIN_CONFIDENCE = 0.8

export function needsTesseract(page: LocalOcrRecognition): boolean {
  return (
    !page.text.trim() ||
    !Number.isFinite(page.meanConfidence) ||
    page.meanConfidence < TRUEOCR_TESSERACT_MIN_CONFIDENCE
  )
}

/** A local retry only. Cloud admission, sensitivity and scoring remain the caller's responsibility. */
export async function recognizeWithLocalFallback(
  primary: LocalOcrEngine,
  input: LocalOcrRecognizeInput,
  registry: { select(preference?: LocalOcrEnginePreference): EngineSelection | null },
  canContinue: () => Promise<boolean> = async () => true,
): Promise<{ engine: LocalOcrEngine; recognition: LocalOcrRecognition; sensitiveText: string }> {
  let recognition: LocalOcrRecognition | undefined, failure: unknown
  try {
    recognition = await primary.recognizePage(input)
  } catch (error) {
    failure = error
  }
  if (primary.id !== TRUEOCR_ENGINE_ID || (recognition && !needsTesseract(recognition))) {
    if (!recognition) throw failure
    return { engine: primary, recognition, sensitiveText: recognition.text }
  }
  if (await canContinue()) {
    const fallback = registry.select(TESSERACT_ENGINE_ID)?.engine
    if (fallback && fallback.id === TESSERACT_ENGINE_ID) {
      try {
        const retry = await fallback.recognizePage(input)
        return {
          engine: fallback,
          recognition: retry,
          sensitiveText: `${recognition?.text ?? ''}\n${retry.text}`,
        }
      } catch (error) {
        if (!recognition) throw error
      } finally {
        await fallback.dispose().catch(() => undefined)
      }
    }
  }
  if (!recognition) throw failure
  return { engine: primary, recognition, sensitiveText: recognition.text }
}
