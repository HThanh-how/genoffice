import { HEAD_BYTES } from './byte-source'
import type { ByteSource, MediaMetadata } from './media-types'

/** Dimensions above this are corrupt headers, not pictures. */
const MAX_DIMENSION = 1_000_000

function dims(width: number, height: number): Pick<MediaMetadata, 'width' | 'height'> {
  return width > 0 && height > 0 && width <= MAX_DIMENSION && height <= MAX_DIMENSION ? { width, height } : {}
}

/** EXIF `YYYY:MM:DD HH:MM:SS` (local wall clock, no zone) to epoch ms. */
export function parseExifDate(text: string): number | undefined {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text)
  if (!m) return undefined
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number]
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return undefined
  const ms = new Date(y, mo - 1, d, h, mi, s).getTime()
  return Number.isFinite(ms) ? ms : undefined
}

interface TiffFacts {
  width?: number
  height?: number
  takenMs?: number
}

/** TIFF structure at `base` (a TIFF file, or the payload of a JPEG APP1 "Exif" segment). Bounded and defensive. */
async function readTiff(src: ByteSource, base: number, wantDims: boolean): Promise<TiffFacts> {
  const out: TiffFacts = {}
  const header = await src.read(base, 8)
  if (header.length < 8) return out
  const little = header[0] === 0x49 && header[1] === 0x49
  if (!little && !(header[0] === 0x4d && header[1] === 0x4d)) return out
  const u16 = (b: Buffer, o: number) => (little ? b.readUInt16LE(o) : b.readUInt16BE(o))
  const u32 = (b: Buffer, o: number) => (little ? b.readUInt32LE(o) : b.readUInt32BE(o))
  if (u16(header, 2) !== 42) return out

  const readIfd = async (offset: number) => {
    const entries = new Map<number, { type: number; count: number; at: number; field: Buffer }>()
    if (offset < 8 || offset > src.size) return entries
    const countBuf = await src.read(base + offset, 2)
    if (countBuf.length < 2) return entries
    const count = Math.min(u16(countBuf, 0), 128)
    const body = await src.read(base + offset + 2, count * 12)
    for (let i = 0; i + 12 <= body.length; i += 12) {
      entries.set(u16(body, i), {
        type: u16(body, i + 2),
        count: u32(body, i + 4),
        at: i + 8,
        field: body.subarray(i + 8, i + 12),
      })
    }
    return entries
  }
  const number = (e: { type: number; field: Buffer }) =>
    e.type === 3 ? u16(e.field, 0) : e.type === 4 ? u32(e.field, 0) : 0
  const ascii = async (e: { count: number; field: Buffer }) => {
    if (e.count < 19 || e.count > 64) return undefined
    const raw = await src.read(base + u32(e.field, 0), e.count)
    return raw.toString('latin1').replace(/\0.*$/, '')
  }

  const ifd0 = await readIfd(u32(header, 4))
  if (wantDims) {
    const w = ifd0.get(256)
    const h = ifd0.get(257)
    if (w && h) Object.assign(out, dims(number(w), number(h)))
  }
  const exifPointer = ifd0.get(0x8769)
  if (exifPointer) {
    const exif = await readIfd(u32(exifPointer.field, 0))
    const original = exif.get(0x9003) ?? exif.get(0x9004)
    const text = original ? await ascii(original) : undefined
    if (text) out.takenMs = parseExifDate(text)
  }
  if (out.takenMs === undefined) {
    const modified = ifd0.get(306)
    const text = modified ? await ascii(modified) : undefined
    if (text) out.takenMs = parseExifDate(text)
  }
  return out
}

async function readJpeg(src: ByteSource): Promise<MediaMetadata> {
  const out: MediaMetadata = { container: 'jpeg' }
  let offset = 2
  let sawExif = false
  for (let segment = 0; segment < 64 && offset < src.size; segment++) {
    const head = await src.read(offset, 9)
    if (head.length < 4 || head[0] !== 0xff) break
    const marker = head[1]!
    if (marker === 0xff) {
      offset += 1 // fill byte
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) break
    const length = head.readUInt16BE(2)
    if (length < 2) break
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrame) {
      if (head.length >= 9) Object.assign(out, dims(head.readUInt16BE(7), head.readUInt16BE(5)))
      break
    }
    if (marker === 0xe1 && !sawExif) {
      const payload = await src.read(offset + 4, Math.min(length - 2, HEAD_BYTES))
      if (payload.length > 14 && payload.toString('latin1', 0, 6) === 'Exif\0\0') {
        sawExif = true
        const facts = await readTiff(src, offset + 4 + 6, false)
        if (facts.takenMs !== undefined) out.takenMs = facts.takenMs
      }
    }
    offset += 2 + length
  }
  return out
}

function readIsoImageBoxes(buf: Buffer, start: number, end: number, depth: number, best: { area: number; w: number; h: number }): void {
  let pos = start
  for (let guard = 0; guard < 256 && pos + 8 <= end; guard++) {
    let size = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    let header = 8
    if (size === 1) {
      if (pos + 16 > end) return
      size = Number(buf.readBigUInt64BE(pos + 8))
      header = 16
    } else if (size === 0) size = end - pos
    if (size < header || pos + size > end) size = end - pos
    const body = pos + header
    if (type === 'ispe' && body + 12 <= end) {
      const w = buf.readUInt32BE(body + 4)
      const h = buf.readUInt32BE(body + 8)
      if (w > 0 && h > 0 && w * h > best.area) Object.assign(best, { area: w * h, w, h })
    } else if (depth < 4 && (type === 'meta' || type === 'iprp' || type === 'ipco')) {
      readIsoImageBoxes(buf, type === 'meta' ? body + 4 : body, pos + size, depth + 1, best)
    }
    pos += size
  }
}

async function readHeif(src: ByteSource, head: Buffer): Promise<MediaMetadata> {
  const out: MediaMetadata = { container: 'heic' }
  let offset = 0
  for (let box = 0; box < 32 && offset + 8 <= src.size; box++) {
    const header = box === 0 ? head.subarray(0, 16) : await src.read(offset, 16)
    if (header.length < 8) break
    let size = header.readUInt32BE(0)
    const type = header.toString('latin1', 4, 8)
    if (size === 1 && header.length >= 16) size = Number(header.readBigUInt64BE(8))
    else if (size === 0) size = src.size - offset
    if (size < 8) break
    if (type === 'meta') {
      const body = await src.read(offset + 8, Math.min(size - 8, HEAD_BYTES))
      const best = { area: 0, w: 0, h: 0 }
      readIsoImageBoxes(body, 4, body.length, 0, best)
      if (best.area > 0) Object.assign(out, dims(best.w, best.h))
      break
    }
    offset += size
  }
  return out
}

/** Header-only facts of an image (never decodes pixels). `{}` when the bytes are not a known image. */
export async function readImageMetadata(src: ByteSource): Promise<MediaMetadata> {
  try {
    const head = await src.read(0, HEAD_BYTES)
    if (head.length < 12) return {}
    if (head.readUInt32BE(0) === 0x89504e47 && head.readUInt32BE(4) === 0x0d0a1a0a) {
      return { container: 'png', ...(head.toString('latin1', 12, 16) === 'IHDR' ? dims(head.readUInt32BE(16), head.readUInt32BE(20)) : {}) }
    }
    if (head[0] === 0xff && head[1] === 0xd8) return await readJpeg(src)
    const tag = head.toString('latin1', 0, 6)
    if (tag === 'GIF87a' || tag === 'GIF89a') return { container: 'gif', ...dims(head.readUInt16LE(6), head.readUInt16LE(8)) }
    if (head[0] === 0x42 && head[1] === 0x4d && head.length >= 26) {
      const headerSize = head.readUInt32LE(14)
      return {
        container: 'bmp',
        ...(headerSize === 12
          ? dims(head.readUInt16LE(18), head.readUInt16LE(20))
          : dims(Math.abs(head.readInt32LE(18)), Math.abs(head.readInt32LE(22)))),
      }
    }
    if (tag.startsWith('RIFF') && head.toString('latin1', 8, 12) === 'WEBP' && head.length >= 30) {
      const kind = head.toString('latin1', 12, 16)
      if (kind === 'VP8X') return { container: 'webp', ...dims((head.readUIntLE(24, 3)) + 1, (head.readUIntLE(27, 3)) + 1) }
      if (kind === 'VP8L' && head[20] === 0x2f) {
        const bits = head.readUInt32LE(21)
        return { container: 'webp', ...dims((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1) }
      }
      if (kind === 'VP8 ' && head[23] === 0x9d && head[24] === 0x01 && head[25] === 0x2a) {
        return { container: 'webp', ...dims(head.readUInt16LE(26) & 0x3fff, head.readUInt16LE(28) & 0x3fff) }
      }
      return { container: 'webp' }
    }
    if ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0) ||
        (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0 && head[3] === 0x2a)) {
      return { container: 'tiff', ...(await readTiff(src, 0, true)) }
    }
    if (head.toString('latin1', 4, 8) === 'ftyp') {
      const brand = head.toString('latin1', 8, 12)
      if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return await readHeif(src, head)
    }
  } catch {
    // A damaged header is "no facts", never an error.
  }
  return {}
}
