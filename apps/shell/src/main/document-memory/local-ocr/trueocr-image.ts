/** TrueOCR 0.1.1 geometry/preprocessing, ported from preprocess.py/page.py (Apache-2.0). */
import { decodeGray, decodePngGray, type GrayImage } from './gray-image'

/** PNG alpha is composited on white; JPEG EXIF is applied before page geometry, like the reference. */
export function decodeTrueOcrImage(bytes: Uint8Array): GrayImage | null {
  const image = bytes[0] === 0x89 ? decodePngGray(bytes, true) : decodeGray(bytes)
  if (!image || bytes[0] !== 0xff || bytes[1] !== 0xd8) return image
  let orientation = 1
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let p = 2; p + 4 < bytes.length;) {
      if (bytes[p] !== 0xff) break
      const marker = bytes[p + 1]!,
        length = view.getUint16(p + 2)
      if (marker === 0xda || length < 2 || p + 2 + length > bytes.length) break
      if (marker === 0xe1 && String.fromCharCode(...bytes.subarray(p + 4, p + 10)) === 'Exif\0\0') {
        const base = p + 10,
          little = view.getUint16(base) === 0x4949
        const ifd = base + view.getUint32(base + 4, little),
          count = view.getUint16(ifd, little)
        for (let i = 0; i < count; i++) {
          const entry = ifd + 2 + i * 12
          if (
            view.getUint16(entry, little) === 0x112 &&
            view.getUint16(entry + 2, little) === 3 &&
            view.getUint32(entry + 4, little) === 1
          )
            orientation = view.getUint16(entry + 8, little)
        }
        break
      }
      p += length + 2
    }
  } catch {
    return null
  }
  let normalized = image
  if ([2, 4, 5, 7].includes(orientation)) {
    const data = new Uint8Array(image.data.length)
    for (let y = 0; y < image.height; y++)
      for (let x = 0; x < image.width; x++)
        data[y * image.width + x] = image.data[y * image.width + image.width - 1 - x]!
    normalized = { ...image, data }
  }
  const turns: Record<number, number> = { 3: 2, 4: 2, 5: -1, 6: 1, 7: 1, 8: -1 }
  return quarterTurn(normalized, turns[orientation] ?? 0)
}

/** Python/NumPy round-to-even, including negative halves. */
export function roundEven(n: number): number {
  const lo = Math.floor(n)
  return n - lo === 0.5 ? lo + (lo % 2 === 0 ? 0 : 1) : Math.round(n)
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const m = sorted.length >> 1
  return sorted.length % 2 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2
}

/** OpenCV-style area resampling (including enlargement), or bilinear interpolation. */
export function resizeGray(
  image: GrayImage,
  width: number,
  height: number,
  area: boolean,
): GrayImage {
  if (width === image.width && height === image.height) return image
  const data = new Uint8Array(width * height)
  const sx = image.width / width,
    sy = image.height / height
  if (area) {
    const temp = new Float32Array(width * image.height)
    for (let x = 0; x < width; x++) {
      const start = x * sx,
        end = (x + 1) * sx
      for (let ix = Math.floor(start); ix < Math.ceil(end); ix++) {
        const weight = (Math.min(end, ix + 1) - Math.max(start, ix)) / sx
        for (let y = 0; y < image.height; y++)
          temp[y * width + x]! +=
            image.data[y * image.width + Math.min(ix, image.width - 1)]! * weight
      }
    }
    for (let y = 0; y < height; y++) {
      const start = y * sy,
        end = (y + 1) * sy
      for (let x = 0; x < width; x++) {
        let sum = 0
        for (let iy = Math.floor(start); iy < Math.ceil(end); iy++)
          sum +=
            (temp[Math.min(iy, image.height - 1) * width + x]! *
              (Math.min(end, iy + 1) - Math.max(start, iy))) /
            sy
        data[y * width + x] = roundEven(sum)
      }
    }
  } else {
    for (let y = 0; y < height; y++) {
      const fy = Math.max(0, (y + 0.5) * sy - 0.5),
        y0 = Math.floor(fy),
        y1 = Math.min(image.height - 1, y0 + 1),
        wy = fy - y0
      for (let x = 0; x < width; x++) {
        const fx = Math.max(0, (x + 0.5) * sx - 0.5),
          x0 = Math.floor(fx),
          x1 = Math.min(image.width - 1, x0 + 1),
          wx = fx - x0
        data[y * width + x] = Math.round(
          (image.data[y0 * image.width + x0]! * (1 - wx) +
            image.data[y0 * image.width + x1]! * wx) *
            (1 - wy) +
            (image.data[y1 * image.width + x0]! * (1 - wx) +
              image.data[y1 * image.width + x1]! * wx) *
              wy,
        )
      }
    }
  }
  return { width, height, data }
}

function sample(image: GrayImage, x: number, y: number, replicate: boolean): number {
  if (replicate) {
    x = Math.max(0, Math.min(image.width - 1, x))
    y = Math.max(0, Math.min(image.height - 1, y))
  } else if (x < 0 || y < 0 || x >= image.width || y >= image.height) return 0
  return image.data[y * image.width + x]!
}

/** Same-size counter-clockwise rotation, OpenCV's 1/32-pixel interpolation table. */
export function rotatePage(image: GrayImage, degrees: number, replicate = true): GrayImage {
  const { width, height } = image
  const data = new Uint8Array(width * height)
  const a = (degrees * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a)
  const tx = ((1 - c) * width) / 2 + (s * height) / 2
  const ty = (-s * width) / 2 + ((1 - c) * height) / 2
  const ax = new Int32Array(width),
    ay = new Int32Array(width)
  for (let x = 0; x < width; x++) {
    ax[x] = roundEven(c * x * 1024)
    ay[x] = roundEven(s * x * 1024)
  }
  for (let y = 0; y < height; y++) {
    // warpAffine rounds row and column contributions separately at 1/1024 precision.
    const bx = roundEven((-s * y + tx) * 1024) + 16
    const by = roundEven((c * y + ty) * 1024) + 16
    for (let x = 0; x < width; x++) {
      const xx = (bx + ax[x]!) >> 5
      const yy = (by + ay[x]!) >> 5
      const ix = xx >> 5,
        iy = yy >> 5,
        fx = xx & 31,
        fy = yy & 31
      const sum =
        sample(image, ix, iy, replicate) * (32 - fx) * (32 - fy) +
        sample(image, ix + 1, iy, replicate) * fx * (32 - fy) +
        sample(image, ix, iy + 1, replicate) * (32 - fx) * fy +
        sample(image, ix + 1, iy + 1, replicate) * fx * fy
      data[y * width + x] = (sum + 512) >> 10
    }
  }
  return { width, height, data }
}

export function quarterTurn(image: GrayImage, clockwise: number): GrayImage {
  const k = ((clockwise % 4) + 4) % 4
  if (!k) return image
  const width = k % 2 ? image.height : image.width
  const height = k % 2 ? image.width : image.height
  const data = new Uint8Array(width * height)
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const dx = k === 1 ? image.height - 1 - y : k === 2 ? image.width - 1 - x : y
      const dy = k === 1 ? x : k === 2 ? image.height - 1 - y : image.width - 1 - x
      data[dy * width + dx] = image.data[y * image.width + x]!
    }
  return { width, height, data }
}

function inkThumb(image: GrayImage, side: number): GrayImage {
  const s = side / Math.max(image.width, image.height)
  const thumb = resizeGray(
    image,
    Math.max(1, roundEven(image.width * s)),
    Math.max(1, roundEven(image.height * s)),
    true,
  )
  return { ...thumb, data: Uint8Array.from(thumb.data, (n) => 255 - n) }
}

function sharpness(image: GrayImage, degrees: number): number {
  const rotated = rotatePage(image, degrees, false)
  let previous = 0,
    score = 0
  for (let y = 0; y < rotated.height; y++) {
    let sum = 0
    for (let x = 0; x < rotated.width; x++) sum += rotated.data[y * rotated.width + x]!
    if (y) score += (sum - previous) ** 2
    previous = sum
  }
  return score
}

export function estimateSkew(image: GrayImage, side = 800): number {
  const fine = inkThumb(image, side)
  if (fine.data.reduce((sum, n) => sum + n, 0) / fine.data.length < 0.003 * 255) return 0
  const coarse = inkThumb(image, side / 2)
  const grid = Array.from({ length: 46 }, (_, i) => -45 + 2 * i)
  const scores = grid.map((a) => sharpness(coarse, a))
  const best = grid
    .map((a, i) => ({ a, score: scores[i]! }))
    .sort((a, b) => a.score - b.score)
    .slice(-2)
  const near = new Set<number>()
  for (const start of [0, ...best.map((v) => v.a)])
    for (let j = -4; j <= 4; j++) near.add(start + j * 0.5)
  let angle = 0,
    value = -Infinity
  for (const a of near) {
    const score = sharpness(fine, a)
    if (score > value) {
      value = score
      angle = a
    }
  }
  let final = angle
  value = -Infinity
  for (let j = -5; j <= 5; j++) {
    const a = angle + j * 0.1,
      score = sharpness(fine, a)
    if (score > value) {
      value = score
      final = a
    }
  }
  return final
}

export function inkInput(
  image: GrayImage,
  longSide: number,
  multiple: number,
): { data: Float32Array; width: number; height: number; scale: number } {
  const scale = longSide / Math.max(image.width, image.height)
  const resized = resizeGray(
    image,
    Math.max(1, roundEven(image.width * scale)),
    Math.max(1, roundEven(image.height * scale)),
    scale < 1 || multiple === longSide,
  )
  const width = Math.ceil(resized.width / multiple) * multiple,
    height = Math.ceil(resized.height / multiple) * multiple
  const data = new Float32Array(width * height)
  for (let y = 0; y < resized.height; y++)
    for (let x = 0; x < resized.width; x++)
      data[y * width + x] = 1 - Math.fround(resized.data[y * resized.width + x]! / 255)
  return { data, width, height, scale }
}

export function cropBox(image: GrayImage, box: readonly number[]): GrayImage {
  const x0 = Math.max(0, Math.floor(box[0]!)),
    y0 = Math.max(0, Math.floor(box[1]!))
  const x1 = Math.min(image.width, Math.ceil(box[2]!)),
    y1 = Math.min(image.height, Math.ceil(box[3]!))
  const width = x1 - x0,
    height = y1 - y0
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++)
    data.set(
      image.data.subarray((y + y0) * image.width + x0, (y + y0) * image.width + x1),
      y * width,
    )
  return { width, height, data }
}

export function prepareLine(
  image: GrayImage,
  maxWidth: number,
  padY: number,
  padX: number,
): { data: Float32Array; width: number } {
  // The reference removes a trailing black pad, when present.
  let used = -1
  for (let x = image.width - 1; x >= 0 && used < 0; x--)
    for (let y = 0; y < image.height; y++)
      if (image.data[y * image.width + x]) {
        used = x
        break
      }
  if (used >= 0 && image.width - used - 1 >= 8)
    image = cropBox(image, [0, 0, used + 1, image.height])
  const hist = new Uint32Array(256)
  for (const value of image.data) hist[value]!++
  const percentile = (q: number): number => {
    const p = q * (image.data.length - 1),
      lo = Math.floor(p),
      g = p - lo
    let count = 0,
      low = 0,
      high = 255
    for (let v = 0; v < 256; v++) {
      count += hist[v]!
      if (count > lo) {
        low = v
        break
      }
    }
    count = 0
    for (let v = 0; v < 256; v++) {
      count += hist[v]!
      if (count > Math.min(lo + 1, image.data.length - 1)) {
        high = v
        break
      }
    }
    return low + (high - low) * g
  }
  const lo = percentile(0.02),
    med = percentile(0.5),
    hi = percentile(0.98)
  const dark = hi - med > 2 * (med - lo) + 8
  const x0 = Math.floor(-padX * image.height),
    x1 = Math.ceil(image.width + padX * image.height)
  const py = (3 * (1 + 2 * padY) - 1) / 2
  const y0 = Math.floor(-py * image.height),
    y1 = Math.ceil(image.height + py * image.height)
  const width = x1 - x0,
    height = y1 - y0
  const data = new Uint8Array(width * height).fill(dark ? 0 : 255)
  for (let y = 0; y < image.height; y++)
    data.set(image.data.subarray(y * image.width, (y + 1) * image.width), (y - y0) * width - x0)
  const outWidth = Math.max(8, Math.min(maxWidth, roundEven((width * 96) / height)))
  const resized = resizeGray({ width, height, data }, outWidth, 96, height > 96)
  return {
    width: outWidth,
    data: Float32Array.from(resized.data, (n) => (dark ? n / 255 : 1 - Math.fround(n / 255))),
  }
}
