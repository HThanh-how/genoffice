/**
 * The CPU-heavy part of the Tesseract path: decode (baseline JPEG / PNG, luma only), shrink, flatten
 * the paper background, re-encode as PNG. Measured on Apple silicon: ~30 ms for a rendered PDF page
 * but ~260 ms for a 12 MP photo, all synchronous. In the app it therefore runs in the index worker
 * (`ocr-prepare` request, see worker.ts), never on the main thread; the engine only falls back to
 * calling it in-process when no worker is wired (tests, CLI).
 *
 * Supported formats not decoded by the local grayscale decoder (progressive JPEG, etc.) are validated
 * and passed through unprocessed to Tesseract.
 * Corrupt data, unknown formats, and unsupported image formats (such as HEIC) return null and are never
 * labeled as successfully prepared image data.
 */
import { decodeGray, encodeGrayPng, flattenIllumination, limitLongEdge } from './gray-image'

/** Longest edge fed to Tesseract: 2000 px is ~170 dpi on A4; bigger photos are shrunk (speed, RAM). */
export const TESSERACT_MAX_EDGE_PX = 2000

export type DetectedImageFormat =
  | 'png'
  | 'jpeg'
  | 'bmp'
  | 'gif'
  | 'webp'
  | 'tiff'
  | 'heic'
  | 'unknown'

export function isCompleteJpeg(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return false
  }

  let end = bytes.length - 1
  while (
    end > 1 &&
    (bytes[end] === 0x00 || bytes[end] === 0x0a || bytes[end] === 0x0d || bytes[end] === 0x20)
  ) {
    end--
  }
  if (end < 3 || bytes[end - 1] !== 0xff || bytes[end] !== 0xd9) {
    return false
  }

  let hasSos = false
  let pos = 2
  while (pos + 1 < bytes.length) {
    if (bytes[pos] !== 0xff) {
      pos++
      continue
    }
    const marker = bytes[pos + 1]!
    if (marker === 0xff || marker === 0x00) {
      pos++
      continue
    }
    pos += 2
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue
    }
    if (marker === 0xda) {
      hasSos = true
      break
    }
    if (marker === 0xd9) {
      break
    }
    if (pos + 2 > bytes.length) return false
    const len = (bytes[pos]! << 8) | bytes[pos + 1]!
    if (len < 2) return false
    pos += len
  }

  return hasSos
}

export function isCompletePng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== sig[i]) return false
  }
  let pos = 8
  while (pos + 8 <= bytes.length) {
    const len =
      ((bytes[pos]! << 24) >>> 0) +
      (bytes[pos + 1]! << 16) +
      (bytes[pos + 2]! << 8) +
      bytes[pos + 3]!
    const type = String.fromCharCode(
      bytes[pos + 4]!,
      bytes[pos + 5]!,
      bytes[pos + 6]!,
      bytes[pos + 7]!,
    )
    if (type === 'IEND') {
      return pos + 12 <= bytes.length
    }
    pos += 12 + len
    if (len < 0 || pos > bytes.length) {
      return false
    }
  }
  return false
}

export function detectImageFormat(bytes: Uint8Array): DetectedImageFormat {
  if (!bytes || bytes.length < 8) return 'unknown'

  // PNG
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png'
  }

  // JPEG / JFIF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg'
  }

  // BMP
  if (bytes[0] === 0x42 && bytes[1] === 0x4d && bytes.length >= 14) {
    return 'bmp'
  }

  // GIF
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'gif'
  }

  // WebP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp'
  }

  // TIFF
  if (
    bytes.length >= 8 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))
  ) {
    return 'tiff'
  }

  // HEIC / HEIF / AVIF
  if (
    bytes.length >= 16 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    let brandHeader = ''
    for (let i = 8; i < Math.min(bytes.length, 64); i++) {
      brandHeader += String.fromCharCode(bytes[i]!)
    }
    if (/heic|heix|heim|heis|hevc|hevx|mif1|msf1|avif|avis/i.test(brandHeader)) {
      return 'heic'
    }
  }

  return 'unknown'
}

export function prepareForTesseract(bytes: Uint8Array, dpi: number): Uint8Array | null {
  if (!bytes || bytes.length < 8) {
    return null
  }

  const format = detectImageFormat(bytes)

  if (format === 'heic') {
    return null
  }

  if (format === 'png') {
    const gray = decodeGray(bytes)
    if (gray) {
      return encodeGrayPng(
        flattenIllumination(limitLongEdge(gray, TESSERACT_MAX_EDGE_PX), dpi || 150),
      )
    }
    if (isCompletePng(bytes)) {
      return bytes
    }
    return null
  }

  if (format === 'jpeg') {
    const gray = decodeGray(bytes)
    if (gray) {
      return encodeGrayPng(
        flattenIllumination(limitLongEdge(gray, TESSERACT_MAX_EDGE_PX), dpi || 150),
      )
    }
    if (isCompleteJpeg(bytes)) {
      return bytes
    }
    return null
  }

  if (format === 'bmp' || format === 'gif' || format === 'webp' || format === 'tiff') {
    return bytes
  }

  return null
}
