/// Electron's decoder for image-cutout.ts: PNG / JPEG / whatever Chromium reads, into RGBA.
/// Separate file because it imports electron: only Electron main processes may import it.

import { nativeImage } from 'electron'
import type { PixelImage } from './image-cutout-core'

export async function decodeWithElectron(bytes: Uint8Array): Promise<PixelImage | null> {
  const image = nativeImage.createFromBuffer(Buffer.from(bytes))
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  const bgra = image.toBitmap()
  if (width <= 0 || height <= 0 || bgra.length < width * height * 4) return null
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height * 4; i += 4) {
    data[i] = bgra[i + 2]!
    data[i + 1] = bgra[i + 1]!
    data[i + 2] = bgra[i]!
    data[i + 3] = bgra[i + 3]!
  }
  return { data, width, height }
}
