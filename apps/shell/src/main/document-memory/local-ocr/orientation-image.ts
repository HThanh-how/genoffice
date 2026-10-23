import { decodeGray, encodeGrayPng, limitLongEdge } from './gray-image'
import type { QuarterTurn } from './orientation'
import { TESSERACT_MAX_EDGE_PX } from './tesseract-prepare'

/** Lossless clockwise quarter turns with exchanged dimensions, so sideways pages are never clipped. */
export function orientTesseractImage(
  bytes: Uint8Array,
  degrees: QuarterTurn,
  maxEdge = TESSERACT_MAX_EDGE_PX,
): Uint8Array | null {
  const decoded = decodeGray(bytes)
  if (!decoded) return null // preserve the established passthrough path for uncommon encodings
  const { width, height, data } = limitLongEdge(decoded, maxEdge)
  const outWidth = degrees === 90 || degrees === 270 ? height : width
  const outHeight = degrees === 90 || degrees === 270 ? width : height
  const rotated = new Uint8Array(data.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx =
        degrees === 90 ? height - 1 - y : degrees === 180 ? width - 1 - x : degrees === 270 ? y : x
      const dy =
        degrees === 90 ? x : degrees === 180 ? height - 1 - y : degrees === 270 ? width - 1 - x : y
      rotated[dy * outWidth + dx] = data[y * width + x]
    }
  }
  return encodeGrayPng({ width: outWidth, height: outHeight, data: rotated })
}
