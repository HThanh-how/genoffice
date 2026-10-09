/**
 * The CPU-heavy part of the Tesseract path: decode (baseline JPEG / PNG, luma only), shrink, flatten
 * the paper background, re-encode as PNG. Measured on Apple silicon: ~30 ms for a rendered PDF page
 * but ~260 ms for a 12 MP photo, all synchronous. In the app it therefore runs in the index worker
 * (`ocr-prepare` request, see worker.ts), never on the main thread; the engine only falls back to
 * calling it in-process when no worker is wired (tests, CLI).
 *
 * Anything this cannot decode (progressive JPEG, palette PNG, CMYK ...) is returned unchanged: worse
 * accuracy, never a failure.
 */
import { decodeGray, encodeGrayPng, flattenIllumination, limitLongEdge } from './gray-image'

/** Longest edge fed to Tesseract: 2000 px is ~170 dpi on A4; bigger photos are shrunk (speed, RAM). */
export const TESSERACT_MAX_EDGE_PX = 2000

export function prepareForTesseract(bytes: Uint8Array, dpi: number): Uint8Array {
  const gray = decodeGray(bytes)
  if (!gray) return bytes
  return encodeGrayPng(flattenIllumination(limitLongEdge(gray, TESSERACT_MAX_EDGE_PX), dpi || 150))
}
