/**
 * Baseline grayscale JPEG encoder (ITU-T T.81, standard Annex K tables). Pure TypeScript with no
 * native or Electron dependency, because page images for OCR are produced inside the index
 * child process (plain Node, no `nativeImage`, and no native canvas that every platform build
 * is guaranteed to ship). Grayscale is enough for transcription and keeps a 1600 px page well
 * under 400 KB.
 */

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]

const LUMA_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113,
  92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
]

const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
const AC_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d]
const AC_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
]

interface HuffmanCode {
  code: number
  size: number
}

/** Canonical Huffman codes from a (bits, values) table (T.81 Annex C). */
function buildCodes(bits: number[], values: number[]): Map<number, HuffmanCode> {
  const codes = new Map<number, HuffmanCode>()
  let code = 0
  let k = 0
  for (let size = 1; size <= 16; size++) {
    for (let i = 0; i < bits[size - 1]!; i++) codes.set(values[k++]!, { code: code++, size })
    code <<= 1
  }
  return codes
}

const DC_CODES = buildCodes(DC_BITS, DC_VALUES)
const AC_CODES = buildCodes(AC_BITS, AC_VALUES)

// cos((2x + 1) * u * pi / 16) * c(u) / 2, so a 1-D transform is one dot product per output
const DCT = (() => {
  const table = new Float64Array(64)
  for (let u = 0; u < 8; u++)
    for (let x = 0; x < 8; x++)
      table[u * 8 + x] =
        (Math.cos(((2 * x + 1) * u * Math.PI) / 16) * (u === 0 ? Math.SQRT1_2 : 1)) / 2
  return table
})()

function scaledQuantTable(quality: number): number[] {
  const q = Math.min(100, Math.max(1, Math.round(quality)))
  const scale = q < 50 ? 5000 / q : 200 - q * 2
  return LUMA_QUANT.map((v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))))
}

class BitWriter {
  private readonly bytes: number[] = []
  private bitBuffer = 0
  private bitCount = 0

  write(code: number, size: number): void {
    for (let i = size - 1; i >= 0; i--) {
      this.bitBuffer = (this.bitBuffer << 1) | ((code >> i) & 1)
      if (++this.bitCount === 8) {
        this.bytes.push(this.bitBuffer)
        if (this.bitBuffer === 0xff) this.bytes.push(0) // byte stuffing
        this.bitBuffer = 0
        this.bitCount = 0
      }
    }
  }

  /** pad the last byte with 1 bits */
  finish(): number[] {
    if (this.bitCount > 0) this.write(0x7f, 8 - this.bitCount)
    return this.bytes
  }
}

function category(value: number): number {
  let magnitude = Math.abs(value)
  let size = 0
  while (magnitude) {
    size++
    magnitude >>= 1
  }
  return size
}

function writeValue(writer: BitWriter, value: number, size: number): void {
  if (size === 0) return
  writer.write(value < 0 ? value + (1 << size) - 1 : value, size)
}

function segment(marker: number, payload: number[]): number[] {
  const length = payload.length + 2
  return [0xff, marker, length >> 8, length & 0xff, ...payload]
}

/**
 * Encode 8-bit grayscale pixels (row-major, `width * height` bytes) as a baseline JPEG.
 * `quality` is 1..100 (default 82).
 */
export function encodeGrayJpeg(
  pixels: Uint8Array,
  width: number,
  height: number,
  quality = 82,
): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new Error('Invalid image size')
  if (width > 0xffff || height > 0xffff) throw new Error('Image too large for JPEG')
  if (pixels.length < width * height) throw new Error('Pixel buffer is too small')
  const quant = scaledQuantTable(quality)
  const writer = new BitWriter()
  const block = new Float64Array(64)
  const temp = new Float64Array(64)
  let previousDc = 0

  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      // level-shifted block, edge pixels replicated beyond the image
      for (let y = 0; y < 8; y++) {
        const sy = Math.min(by + y, height - 1) * width
        for (let x = 0; x < 8; x++)
          block[y * 8 + x] = pixels[sy + Math.min(bx + x, width - 1)]! - 128
      }
      // separable DCT: rows, then columns
      for (let y = 0; y < 8; y++)
        for (let u = 0; u < 8; u++) {
          let sum = 0
          for (let x = 0; x < 8; x++) sum += block[y * 8 + x]! * DCT[u * 8 + x]!
          temp[y * 8 + u] = sum
        }
      for (let u = 0; u < 8; u++)
        for (let v = 0; v < 8; v++) {
          let sum = 0
          for (let y = 0; y < 8; y++) sum += temp[y * 8 + u]! * DCT[v * 8 + y]!
          block[v * 8 + u] = sum
        }
      const quantised = new Int32Array(64)
      for (let i = 0; i < 64; i++) {
        const natural = ZIGZAG[i]!
        quantised[i] = Math.round(block[natural]! / quant[natural]!)
      }
      // DC: difference from the previous block
      const diff = quantised[0]! - previousDc
      previousDc = quantised[0]!
      const dcSize = category(diff)
      const dcCode = DC_CODES.get(dcSize)!
      writer.write(dcCode.code, dcCode.size)
      writeValue(writer, diff, dcSize)
      // AC: run-length of zeros + size category
      let zeros = 0
      for (let i = 1; i < 64; i++) {
        const value = quantised[i]!
        if (value === 0) {
          zeros++
          continue
        }
        while (zeros > 15) {
          const zrl = AC_CODES.get(0xf0)!
          writer.write(zrl.code, zrl.size)
          zeros -= 16
        }
        const size = category(value)
        const code = AC_CODES.get((zeros << 4) | size)!
        writer.write(code.code, code.size)
        writeValue(writer, value, size)
        zeros = 0
      }
      if (zeros > 0) {
        const eob = AC_CODES.get(0x00)!
        writer.write(eob.code, eob.size)
      }
    }
  }

  const header = [
    0xff,
    0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xdb, [0, ...ZIGZAG.map((natural) => quant[natural]!)]),
    ...segment(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]),
    ...segment(0xc4, [0x00, ...DC_BITS, ...DC_VALUES]),
    ...segment(0xc4, [0x10, ...AC_BITS, ...AC_VALUES]),
    ...segment(0xda, [1, 1, 0x00, 0, 63, 0]),
  ]
  const scan = writer.finish()
  const out = new Uint8Array(header.length + scan.length + 2)
  out.set(header, 0)
  out.set(scan, header.length)
  out[out.length - 2] = 0xff
  out[out.length - 1] = 0xd9
  return out
}

/** Box-filter downscale of an 8-bit grayscale image (used when a page is larger than the target). */
export function downscaleGray(
  pixels: Uint8Array,
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number,
): Uint8Array {
  const out = new Uint8Array(targetWidth * targetHeight)
  for (let y = 0; y < targetHeight; y++) {
    const y0 = Math.floor((y * height) / targetHeight)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / targetHeight))
    for (let x = 0; x < targetWidth; x++) {
      const x0 = Math.floor((x * width) / targetWidth)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / targetWidth))
      let sum = 0
      let count = 0
      for (let sy = y0; sy < y1; sy++)
        for (let sx = x0; sx < x1; sx++) {
          sum += pixels[sy * width + sx]!
          count++
        }
      out[y * targetWidth + x] = Math.round(sum / count)
    }
  }
  return out
}
