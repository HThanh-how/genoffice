/**
 * Grayscale helpers for the Tesseract path: a small baseline-JPEG / PNG decoder (luma only), a
 * cheap illumination flattening ("background normalisation") and a PNG encoder. Pure TypeScript,
 * no native module: the page images arrive as JPEG (from the PDF renderer or the user's file) and
 * Tesseract on tinted, stamped invoices needs the paper background removed first (benchmark:
 * invoice-number recovery 51-76% raw -> 80-90% normalised).
 *
 * Anything unusual (progressive JPEG, palette PNG, CMYK ...) returns null and the caller passes
 * the original bytes to the engine unprocessed: worse accuracy, never a failure.
 */
import { deflateSync, inflateSync } from 'node:zlib'
import { downscaleGray } from '../jpeg-gray'

export interface GrayImage {
  width: number
  height: number
  data: Uint8Array
}

/** Refuse to decode absurd images (a 12 MP phone photo is fine, a decompression bomb is not). */
const MAX_PIXELS = 40_000_000

// ---- JPEG (baseline / extended sequential Huffman, 8-bit) -------------------------------------

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]

/** COS[u*8+x] = c(u)/2 * cos((2x+1)u*pi/16): one 1-D IDCT output sample is a dot product. */
const COS = (() => {
  const t = new Float32Array(64)
  for (let u = 0; u < 8; u++)
    for (let x = 0; x < 8; x++)
      t[u * 8 + x] = ((u === 0 ? Math.SQRT1_2 : 1) / 2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16)
  return t
})()

interface HuffTable {
  maxCode: Int32Array // per length 1..16, -1 when no code of that length
  valPtr: Int32Array
  minCode: Int32Array
  values: Uint8Array
}

function buildHuffman(counts: Uint8Array, values: Uint8Array): HuffTable {
  const maxCode = new Int32Array(18).fill(-1)
  const valPtr = new Int32Array(18)
  const minCode = new Int32Array(18)
  let code = 0
  let k = 0
  for (let len = 1; len <= 16; len++) {
    valPtr[len] = k
    minCode[len] = code
    code += counts[len - 1]!
    k += counts[len - 1]!
    maxCode[len] = counts[len - 1]! ? code - 1 : -1
    code <<= 1
  }
  return { maxCode, valPtr, minCode, values }
}

interface JpegComponent {
  id: number
  h: number
  v: number
  tq: number
  dcTable: number
  acTable: number
  pred: number
}

export function decodeJpegGray(bytes: Uint8Array): GrayImage | null {
  try {
    return decodeJpegGrayUnsafe(bytes)
  } catch {
    return null
  }
}

function decodeJpegGrayUnsafe(bytes: Uint8Array): GrayImage | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  const quant: Array<Int32Array | undefined> = []
  const dc: Array<HuffTable | undefined> = []
  const ac: Array<HuffTable | undefined> = []
  let width = 0
  let height = 0
  let comps: JpegComponent[] = []
  let restart = 0
  let adobeTransform = -1
  let pos = 2
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) {
      pos++
      continue
    }
    const marker = bytes[pos + 1]!
    if (marker === 0xff) {
      pos++
      continue
    }
    pos += 2
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (marker === 0xd9) return null
    const length = (bytes[pos]! << 8) | bytes[pos + 1]!
    const end = pos + length
    if (length < 2 || end > bytes.length) return null
    let p = pos + 2
    if (marker === 0xdb) {
      while (p < end) {
        const pq = bytes[p]! >> 4
        const tq = bytes[p]! & 15
        p++
        const table = new Int32Array(64)
        for (let i = 0; i < 64; i++) {
          table[ZIGZAG[i]!] = pq ? (bytes[p]! << 8) | bytes[p + 1]! : bytes[p]!
          p += pq ? 2 : 1
        }
        quant[tq] = table
      }
    } else if (marker === 0xc0 || marker === 0xc1) {
      if (bytes[p] !== 8) return null
      height = (bytes[p + 1]! << 8) | bytes[p + 2]!
      width = (bytes[p + 3]! << 8) | bytes[p + 4]!
      const n = bytes[p + 5]!
      if (!width || !height || width * height > MAX_PIXELS || (n !== 1 && n !== 3)) return null
      comps = []
      for (let i = 0; i < n; i++) {
        const o = p + 6 + i * 3
        comps.push({
          id: bytes[o]!,
          h: bytes[o + 1]! >> 4,
          v: bytes[o + 1]! & 15,
          tq: bytes[o + 2]!,
          dcTable: 0,
          acTable: 0,
          pred: 0,
        })
      }
    } else if (marker === 0xc2 || (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)) {
      return null // progressive, lossless, arithmetic: not supported
    } else if (marker === 0xc4) {
      while (p < end) {
        const tc = bytes[p]! >> 4
        const th = bytes[p]! & 15
        p++
        const counts = bytes.subarray(p, p + 16)
        p += 16
        let total = 0
        for (const c of counts) total += c
        const table = buildHuffman(counts, bytes.subarray(p, p + total))
        p += total
        if (tc === 0) dc[th] = table
        else ac[th] = table
      }
    } else if (marker === 0xdd) {
      restart = (bytes[p]! << 8) | bytes[p + 1]!
    } else if (marker === 0xee && length >= 14 && bytes[p] === 0x41 && bytes[p + 1] === 0x64) {
      adobeTransform = bytes[p + 11]!
    } else if (marker === 0xda) {
      if (!comps.length) return null
      const ns = bytes[p]!
      if (ns !== comps.length) return null // interleaved single scan only
      for (let i = 0; i < ns; i++) {
        const cs = bytes[p + 1 + i * 2]!
        const tables = bytes[p + 2 + i * 2]!
        const comp = comps.find((c) => c.id === cs)
        if (!comp) return null
        comp.dcTable = tables >> 4
        comp.acTable = tables & 15
      }
      // 3 components without the YCbCr transform are RGB: luma would need a colour conversion
      if (comps.length === 3 && adobeTransform === 0) return null
      return decodeScan(bytes, end, width, height, comps, quant, dc, ac, restart)
    }
    pos = end
  }
  return null
}

function decodeScan(
  bytes: Uint8Array,
  start: number,
  width: number,
  height: number,
  comps: JpegComponent[],
  quant: Array<Int32Array | undefined>,
  dc: Array<HuffTable | undefined>,
  ac: Array<HuffTable | undefined>,
  restart: number,
): GrayImage | null {
  const hMax = Math.max(...comps.map((c) => c.h))
  const vMax = Math.max(...comps.map((c) => c.v))
  if (comps.some((c) => !c.h || !c.v || hMax % c.h || vMax % c.v)) return null
  const single = comps.length === 1
  // a one-component scan is not interleaved: its MCU is one block regardless of the sampling factors
  const mcuW = single ? 8 : 8 * hMax
  const mcuH = single ? 8 : 8 * vMax
  const mcusX = Math.ceil(width / mcuW)
  const mcusY = Math.ceil(height / mcuH)
  const luma = comps[0]!
  const lumaH = single ? 1 : luma.h
  const lumaV = single ? 1 : luma.v
  const planeW = mcusX * lumaH * 8
  const planeH = mcusY * lumaV * 8
  const plane = new Uint8Array(planeW * planeH)
  const lumaQuant = quant[luma.tq]
  if (!lumaQuant) return null

  let pos = start
  let bitBuf = 0
  let bitCnt = 0
  const readBit = (): number => {
    if (bitCnt === 0) {
      if (pos >= bytes.length) throw new Error('eof')
      let byte = bytes[pos++]!
      if (byte === 0xff) {
        const next = bytes[pos]!
        if (next === 0) pos++
        else throw new Error('marker') // RST/EOI inside a block: damaged
        byte = 0xff
      }
      bitBuf = byte
      bitCnt = 8
    }
    bitCnt--
    return (bitBuf >> bitCnt) & 1
  }
  const receive = (n: number): number => {
    let v = 0
    for (let i = 0; i < n; i++) v = (v << 1) | readBit()
    return v
  }
  const extend = (v: number, n: number): number => (n && v < 1 << (n - 1) ? v - (1 << n) + 1 : v)
  const decodeHuff = (table: HuffTable): number => {
    let code = 0
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | readBit()
      const max = table.maxCode[len]!
      if (max >= 0 && code <= max && code >= table.minCode[len]!)
        return table.values[table.valPtr[len]! + code - table.minCode[len]!]!
    }
    throw new Error('bad huffman code')
  }

  const block = new Int32Array(64)
  const tmp = new Float32Array(64)
  const decodeBlock = (comp: JpegComponent, wantPixels: boolean, bx: number, by: number): void => {
    const dcTable = dc[comp.dcTable]
    const acTable = ac[comp.acTable]
    if (!dcTable || !acTable) throw new Error('missing table')
    block.fill(0)
    const t = decodeHuff(dcTable)
    comp.pred += extend(receive(t), t)
    block[0] = comp.pred
    let k = 1
    while (k < 64) {
      const rs = decodeHuff(acTable)
      const s = rs & 15
      const r = rs >> 4
      if (s === 0) {
        if (r < 15) break
        k += 16
        continue
      }
      k += r
      if (k > 63) break
      block[ZIGZAG[k]!] = extend(receive(s), s)
      k++
    }
    if (!wantPixels) return
    for (let i = 0; i < 64; i++) block[i] = block[i]! * lumaQuant[i]!
    // rows: tmp[v][x] = sum_u COS[u][x] * block[v][u]
    for (let v = 0; v < 8; v++)
      for (let x = 0; x < 8; x++) {
        let sum = 0
        for (let u = 0; u < 8; u++) sum += COS[u * 8 + x]! * block[v * 8 + u]!
        tmp[v * 8 + x] = sum
      }
    for (let x = 0; x < 8; x++)
      for (let y = 0; y < 8; y++) {
        let sum = 0
        for (let v = 0; v < 8; v++) sum += COS[v * 8 + y]! * tmp[v * 8 + x]!
        const value = Math.round(sum + 128)
        plane[(by * 8 + y) * planeW + bx * 8 + x] = value < 0 ? 0 : value > 255 ? 255 : value
      }
  }

  let mcuCount = 0
  for (let my = 0; my < mcusY; my++)
    for (let mx = 0; mx < mcusX; mx++) {
      if (restart && mcuCount > 0 && mcuCount % restart === 0) {
        // byte-align, skip the RSTn marker, reset predictors
        bitCnt = 0
        while (pos + 1 < bytes.length && !(bytes[pos] === 0xff && bytes[pos + 1]! >= 0xd0 && bytes[pos + 1]! <= 0xd7)) pos++
        pos += 2
        for (const c of comps) c.pred = 0
      }
      if (single) {
        decodeBlock(luma, true, mx, my)
      } else {
        for (let ci = 0; ci < comps.length; ci++) {
          const comp = comps[ci]!
          for (let v = 0; v < comp.v; v++)
            for (let h = 0; h < comp.h; h++)
              decodeBlock(comp, ci === 0, mx * comp.h + h, my * comp.v + v)
        }
      }
      mcuCount++
    }

  if (planeW === width && planeH === height) return { width, height, data: plane }
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) data.set(plane.subarray(y * planeW, y * planeW + width), y * width)
  return { width, height, data }
}

// ---- PNG (8-bit gray / gray+alpha / RGB / RGBA, non-interlaced) -------------------------------

export function decodePngGray(bytes: Uint8Array): GrayImage | null {
  try {
    return decodePngGrayUnsafe(bytes)
  } catch {
    return null
  }
}

function decodePngGrayUnsafe(bytes: Uint8Array): GrayImage | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 33 || sig.some((b, i) => bytes[i] !== b)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = 8
  let width = 0
  let height = 0
  let channels = 0
  const idat: Uint8Array[] = []
  while (pos + 8 <= bytes.length) {
    const length = view.getUint32(pos)
    const type = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!, bytes[pos + 6]!, bytes[pos + 7]!)
    const body = bytes.subarray(pos + 8, pos + 8 + length)
    if (type === 'IHDR') {
      width = view.getUint32(pos + 8)
      height = view.getUint32(pos + 12)
      const depth = bytes[pos + 16]
      const colorType = bytes[pos + 17]
      const interlace = bytes[pos + 20]
      if (depth !== 8 || interlace !== 0) return null
      channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0
      if (!channels || !width || !height || width * height > MAX_PIXELS) return null
    } else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    pos += 12 + length
  }
  if (!channels || !idat.length) return null
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  if (raw.length < (stride + 1) * height) return null
  const prev = new Uint8Array(stride)
  const cur = new Uint8Array(stride)
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels]! : 0
      const b = prev[i]!
      const c = i >= channels ? prev[i - channels]! : 0
      let predictor = 0
      if (filter === 1) predictor = a
      else if (filter === 2) predictor = b
      else if (filter === 3) predictor = (a + b) >> 1
      else if (filter === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (filter !== 0) return null
      cur[i] = (line[i]! + predictor) & 255
    }
    for (let x = 0; x < width; x++) {
      const o = x * channels
      out[y * width + x] =
        channels < 3 ? cur[o]! : (cur[o]! * 299 + cur[o + 1]! * 587 + cur[o + 2]! * 114) / 1000
    }
    prev.set(cur)
  }
  return { width, height, data: out }
}

/** Gray pixels from a JPEG or PNG; null when the format is not handled here. */
export function decodeGray(bytes: Uint8Array): GrayImage | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return decodeJpegGray(bytes)
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return decodePngGray(bytes)
  return null
}

// ---- scaling and illumination flattening ------------------------------------------------------

/** Shrink so the longest edge is at most `maxEdge` (never enlarge). */
export function limitLongEdge(image: GrayImage, maxEdge: number): GrayImage {
  const longest = Math.max(image.width, image.height)
  if (longest <= maxEdge) return image
  const scale = maxEdge / longest
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  return { width, height, data: downscaleGray(image.data, image.width, image.height, width, height) }
}

/** Running-sum box blur along one axis of a float plane, edges replicated. */
function boxBlurAxis(src: Float32Array, dst: Float32Array, w: number, h: number, radius: number, horizontal: boolean): void {
  const lines = horizontal ? h : w
  const len = horizontal ? w : h
  const step = horizontal ? 1 : w
  const lineStep = horizontal ? w : 1
  const size = 2 * radius + 1
  for (let l = 0; l < lines; l++) {
    const base = l * lineStep
    let sum = 0
    for (let i = -radius; i <= radius; i++) sum += src[base + Math.min(len - 1, Math.max(0, i)) * step]!
    for (let i = 0; i < len; i++) {
      dst[base + i * step] = sum / size
      sum += src[base + Math.min(len - 1, i + radius + 1) * step]! - src[base + Math.max(0, i - radius) * step]!
    }
  }
}

const FLATTEN_WHITE = 235
const FLATTEN_SHRINK = 4

/**
 * Divide the page by its own slowly varying background so tinted paper, shadows and stamp haze
 * become white while text stays dark. The background is a Gaussian-like blur (three box passes,
 * sigma ~ dpi/8 px, as in the benchmark) computed on a 4x shrunk copy and interpolated back, so
 * the cost is a few passes over the page, not a 17 px kernel per pixel.
 */
export function flattenIllumination(image: GrayImage, dpi: number): GrayImage {
  const { width, height, data } = image
  const sw = Math.max(1, Math.ceil(width / FLATTEN_SHRINK))
  const sh = Math.max(1, Math.ceil(height / FLATTEN_SHRINK))
  const small = new Float32Array(sw * sh)
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      let sum = 0
      let n = 0
      for (let yy = y * FLATTEN_SHRINK; yy < Math.min(height, (y + 1) * FLATTEN_SHRINK); yy++)
        for (let xx = x * FLATTEN_SHRINK; xx < Math.min(width, (x + 1) * FLATTEN_SHRINK); xx++) {
          sum += data[yy * width + xx]!
          n++
        }
      small[y * sw + x] = sum / n
    }
  const sigma = Math.max(8, dpi / 8) / FLATTEN_SHRINK
  const radius = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2))
  const scratch = new Float32Array(sw * sh)
  for (let pass = 0; pass < 3; pass++) {
    boxBlurAxis(small, scratch, sw, sh, radius, true)
    boxBlurAxis(scratch, small, sw, sh, radius, false)
  }
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / FLATTEN_SHRINK - 0.5))
    const y0 = Math.floor(fy)
    const y1 = Math.min(sh - 1, y0 + 1)
    const wy = fy - y0
    for (let x = 0; x < width; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / FLATTEN_SHRINK - 0.5))
      const x0 = Math.floor(fx)
      const x1 = Math.min(sw - 1, x0 + 1)
      const wx = fx - x0
      const bg =
        (small[y0 * sw + x0]! * (1 - wx) + small[y0 * sw + x1]! * wx) * (1 - wy) +
        (small[y1 * sw + x0]! * (1 - wx) + small[y1 * sw + x1]! * wx) * wy
      const value = (data[y * width + x]! / Math.max(1, bg)) * FLATTEN_WHITE
      out[y * width + x] = value > 255 ? 255 : value
    }
  }
  return { width, height, data: out }
}

// ---- PNG encoder ------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + body.length)
  out.writeUInt32BE(body.length, 0)
  out.write(type, 4, 'latin1')
  out.set(body, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length)
  return out
}

/** 8-bit grayscale PNG (fast deflate: the image goes straight to the OCR worker). */
export function encodeGrayPng(image: GrayImage): Buffer {
  const { width, height, data } = image
  const raw = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y++) raw.set(data.subarray(y * width, (y + 1) * width), y * (width + 1) + 1)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 1 })),
    chunk('IEND', new Uint8Array(0)),
  ])
}
