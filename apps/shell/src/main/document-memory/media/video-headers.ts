import { HEAD_BYTES } from './byte-source'
import type { ByteSource, MediaMetadata } from './media-types'

const MAX_DIMENSION = 100_000
/** Seconds between the QuickTime epoch (1904-01-01) and the Unix epoch. */
const QT_EPOCH_OFFSET_S = 2_082_844_800
/** Plausible container creation dates only (a zeroed field or garbage must not become a "date"). */
const MIN_TAKEN_MS = Date.UTC(1990, 0, 1)
const MAX_TAKEN_MS = Date.UTC(2100, 0, 1)

function plausible(ms: number): number | undefined {
  return Number.isFinite(ms) && ms >= MIN_TAKEN_MS && ms <= MAX_TAKEN_MS ? ms : undefined
}

// ---------------------------------------------------------------- ISO BMFF (mp4, m4v, mov, 3gp)

interface BoxHeader {
  type: string
  start: number
  body: number
  end: number
}

async function boxAt(src: ByteSource, offset: number, limit: number): Promise<BoxHeader | null> {
  if (offset + 8 > limit) return null
  const h = await src.read(offset, 16)
  if (h.length < 8) return null
  let size = h.readUInt32BE(0)
  let header = 8
  if (size === 1) {
    if (h.length < 16) return null
    size = Number(h.readBigUInt64BE(8))
    header = 16
  } else if (size === 0) size = limit - offset
  if (!Number.isSafeInteger(size) || size < header) return null
  return { type: h.toString('latin1', 4, 8), start: offset, body: offset + header, end: Math.min(limit, offset + size) }
}

function brandContainer(brand: string, ext: string): string {
  if (brand === 'qt  ') return 'mov'
  if (brand.startsWith('3g')) return '3gp'
  if (brand === 'M4V ' || brand === 'M4VH' || brand === 'M4VP') return 'm4v'
  return ext === 'mov' ? 'mov' : ext === 'm4v' ? 'm4v' : ext === '3gp' ? '3gp' : 'mp4'
}

async function readMoov(src: ByteSource, moov: BoxHeader, out: MediaMetadata): Promise<void> {
  let offset = moov.body
  let bestArea = 0
  for (let child = 0; child < 48 && offset < moov.end; child++) {
    const box = await boxAt(src, offset, moov.end)
    if (!box) break
    if (box.type === 'mvhd') {
      const b = await src.read(box.body, 36)
      if (b.length >= 20) {
        const v1 = b[0] === 1
        const created = v1 ? Number(b.readBigUInt64BE(4)) : b.readUInt32BE(4)
        const timescale = v1 ? b.readUInt32BE(20) : b.readUInt32BE(12)
        const duration = v1 && b.length >= 32 ? Number(b.readBigUInt64BE(24)) : b.readUInt32BE(16)
        if (timescale > 0 && duration > 0 && duration < 0xffffffffffff) out.durationMs = Math.round((duration / timescale) * 1000)
        if (created > QT_EPOCH_OFFSET_S) {
          const taken = plausible((created - QT_EPOCH_OFFSET_S) * 1000)
          if (taken !== undefined) out.takenMs = taken
        }
      }
    } else if (box.type === 'trak') {
      // tkhd is the first child of trak; audio/text tracks have 0x0 or tiny dimensions.
      const tkhd = await boxAt(src, box.body, box.end)
      if (tkhd?.type === 'tkhd') {
        const b = await src.read(tkhd.body, 96)
        const v1 = b[0] === 1
        const matrix = v1 ? 52 : 40
        const sizeAt = v1 ? 88 : 76
        if (b.length >= sizeAt + 8) {
          let w = b.readUInt32BE(sizeAt) / 65536
          let h = b.readUInt32BE(sizeAt + 4) / 65536
          // A 90/270 degree rotation matrix (phone portrait video) swaps the displayed axes.
          if (b.readInt32BE(matrix) === 0 && b.readInt32BE(matrix + 4) !== 0) [w, h] = [h, w]
          w = Math.round(w)
          h = Math.round(h)
          if (w > 0 && h > 0 && w <= MAX_DIMENSION && h <= MAX_DIMENSION && w * h > bestArea) {
            bestArea = w * h
            out.width = w
            out.height = h
          }
        }
      }
    }
    offset = box.end
  }
}

async function readIsoVideo(src: ByteSource, head: Buffer, ext: string): Promise<MediaMetadata> {
  const out: MediaMetadata = { container: brandContainer(head.toString('latin1', 8, 12), ext) }
  let offset = 0
  for (let top = 0; top < 64 && offset < src.size; top++) {
    const box = await boxAt(src, offset, src.size)
    if (!box) break
    if (box.type === 'moov') {
      await readMoov(src, box, out)
      break
    }
    offset = box.end // ftyp, free, wide, mdat (the media bytes are skipped, never read)
  }
  return out
}

// ---------------------------------------------------------------- Matroska / WebM

interface Vint {
  value: number
  length: number
  unknown: boolean
}

function vint(buf: Buffer, pos: number, keepMarker: boolean): Vint | null {
  const first = buf[pos]
  if (first === undefined || first === 0) return null
  let length = 1
  while (!(first & (0x80 >> (length - 1)))) length++
  if (length > 8 || pos + length > buf.length) return null
  let value = keepMarker ? first : first & (0xff >> length)
  let allOnes = (first & (0xff >> length)) === 0xff >> length
  for (let i = 1; i < length; i++) {
    const byte = buf[pos + i]!
    value = value * 256 + byte
    if (byte !== 0xff) allOnes = false
  }
  return { value, length, unknown: !keepMarker && allOnes }
}

const EBML = { header: 0x1a45dfa3, segment: 0x18538067, info: 0x1549a966, tracks: 0x1654ae6b, entry: 0xae, video: 0xe0, cluster: 0x1f43b675 }

function readMatroska(buf: Buffer, ext: string): MediaMetadata {
  const out: MediaMetadata = { container: ext === 'webm' ? 'webm' : 'mkv' }
  let scaleNs = 1_000_000
  let rawDuration: number | undefined
  let stop = false
  const uint = (pos: number, size: number) => (size >= 1 && size <= 6 ? buf.readUIntBE(pos, size) : 0)
  const walk = (start: number, end: number, depth: number): void => {
    let pos = start
    for (let guard = 0; guard < 512 && pos < end && !stop; guard++) {
      const id = vint(buf, pos, true)
      if (!id) return
      const size = vint(buf, pos + id.length, false)
      if (!size) return
      const body = pos + id.length + size.length
      const bodyEnd = size.unknown ? end : Math.min(end, body + size.value)
      if (id.value === EBML.cluster) {
        stop = true
        return
      }
      if (id.value === EBML.header || id.value === EBML.segment || id.value === EBML.info || id.value === EBML.tracks || id.value === EBML.entry || id.value === EBML.video) {
        if (depth < 6) walk(body, bodyEnd, depth + 1)
      } else if (body + size.value <= buf.length) {
        if (id.value === 0x4282) {
          const doc = buf.toString('latin1', body, body + size.value)
          out.container = doc === 'webm' ? 'webm' : 'mkv'
        } else if (id.value === 0x2ad7b1) scaleNs = uint(body, size.value) || scaleNs
        else if (id.value === 0x4489 && (size.value === 4 || size.value === 8)) {
          rawDuration = size.value === 4 ? buf.readFloatBE(body) : buf.readDoubleBE(body)
        } else if (id.value === 0x4461 && size.value === 8) {
          // DateUTC: nanoseconds since 2001-01-01.
          const taken = plausible(Date.UTC(2001, 0, 1) + Number(buf.readBigInt64BE(body)) / 1e6)
          if (taken !== undefined) out.takenMs = taken
        } else if (id.value === 0xb0 && out.width === undefined) {
          const w = uint(body, size.value)
          if (w > 0 && w <= MAX_DIMENSION) out.width = w
        } else if (id.value === 0xba && out.height === undefined) {
          const h = uint(body, size.value)
          if (h > 0 && h <= MAX_DIMENSION) out.height = h
        }
      } else return
      if (size.unknown) return
      pos = body + size.value
    }
  }
  walk(0, buf.length, 0)
  if (rawDuration !== undefined && Number.isFinite(rawDuration) && rawDuration > 0) {
    out.durationMs = Math.round((rawDuration * scaleNs) / 1e6)
  }
  if (out.width === undefined || out.height === undefined) {
    delete out.width
    delete out.height
  }
  return out
}

// ---------------------------------------------------------------- the rest

function readAvi(head: Buffer): MediaMetadata {
  const out: MediaMetadata = { container: 'avi' }
  const at = head.subarray(0, 512).indexOf('avih', 12, 'latin1')
  if (at < 0 || at + 8 + 40 > head.length) return out
  const base = at + 8
  const microsPerFrame = head.readUInt32LE(base)
  const frames = head.readUInt32LE(base + 16)
  const width = head.readUInt32LE(base + 32)
  const height = head.readUInt32LE(base + 36)
  if (microsPerFrame > 0 && frames > 0) out.durationMs = Math.round((frames * microsPerFrame) / 1000)
  if (width > 0 && height > 0 && width <= MAX_DIMENSION && height <= MAX_DIMENSION) Object.assign(out, { width, height })
  return out
}

/** Container facts of a video, from the container header only (audio, subtitles and frames are never read). */
export async function readVideoMetadata(src: ByteSource, ext: string): Promise<MediaMetadata> {
  const extension = ext.replace(/^\./, '').toLowerCase()
  try {
    const head = await src.read(0, HEAD_BYTES)
    if (head.length < 12) return {}
    if (head.toString('latin1', 4, 8) === 'ftyp') return await readIsoVideo(src, head, extension)
    if (head.readUInt32BE(0) === EBML.header) return readMatroska(head, extension)
    if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 11) === 'AVI') return readAvi(head)
    if (head.toString('latin1', 0, 3) === 'FLV') return { container: 'flv' }
    if (head.readUInt32BE(0) === 0x3026b275) return { container: 'wmv' }
    if (head.readUInt32BE(0) === 0x000001ba || head.readUInt32BE(0) === 0x000001b3) return { container: 'mpg' }
  } catch {
    // A damaged header is "no facts", never an error.
  }
  return {}
}
