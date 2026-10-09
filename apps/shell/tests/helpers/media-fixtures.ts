import { closeSync, openSync, truncateSync, writeSync } from 'node:fs'

/** Tiny but structurally valid file headers for the media parsers. Nothing here is a decodable picture. */

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  return b
}
const u16le = (n: number): Buffer => {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}
const u32le = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0)
  return b
}

export function png(width: number, height: number): Buffer {
  const ihdr = Buffer.concat([u32(width), u32(height), Buffer.from([8, 2, 0, 0, 0])])
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    u32(13),
    Buffer.from('IHDR'),
    ihdr,
    u32(0),
  ])
}

/** TIFF block (little endian) with ExifIFD -> DateTimeOriginal; optional width/height in IFD0 (for .tif files). */
export function tiff(options: { exifDate?: string; width?: number; height?: number } = {}): Buffer {
  const entries: Array<{ tag: number; type: number; count: number; value: Buffer }> = []
  const date = options.exifDate ? Buffer.from(`${options.exifDate}\0`, 'latin1') : null
  if (options.width !== undefined) entries.push({ tag: 256, type: 4, count: 1, value: u32le(options.width) })
  if (options.height !== undefined) entries.push({ tag: 257, type: 4, count: 1, value: u32le(options.height) })
  const ifd0Count = entries.length + (date ? 1 : 0)
  const ifd0Size = 2 + ifd0Count * 12 + 4
  const exifIfdOffset = 8 + ifd0Size
  const exifIfdSize = 2 + 12 + 4
  const dateOffset = exifIfdOffset + exifIfdSize
  const header = Buffer.concat([Buffer.from('II'), u16le(42), u32le(8)])
  const ifd0: Buffer[] = [u16le(ifd0Count)]
  for (const e of entries) ifd0.push(u16le(e.tag), u16le(e.type), u32le(e.count), e.value)
  if (date) ifd0.push(u16le(0x8769), u16le(4), u32le(1), u32le(exifIfdOffset))
  ifd0.push(u32le(0))
  const parts = [header, ...ifd0]
  if (date) {
    parts.push(u16le(1), u16le(0x9003), u16le(2), u32le(date.length), u32le(dateOffset), u32le(0), date)
  }
  return Buffer.concat(parts)
}

export function jpeg(width: number, height: number, options: { exifDate?: string; bigApp?: number } = {}): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])]
  if (options.exifDate) {
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff({ exifDate: options.exifDate })])
    parts.push(Buffer.from([0xff, 0xe1]), Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload)
  }
  if (options.bigApp) {
    // e.g. a 100 KB ICC profile before the frame header: the parser must hop over it, not read it.
    const n = Math.min(options.bigApp, 65_000)
    for (let i = 0; i < Math.ceil(options.bigApp / n); i++) {
      parts.push(Buffer.from([0xff, 0xe2]), Buffer.from([(n + 2) >> 8, (n + 2) & 0xff]), Buffer.alloc(n, 0x11))
    }
  }
  const sof = Buffer.concat([Buffer.from([8]), Buffer.from([height >> 8, height & 0xff, width >> 8, width & 0xff]), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])])
  parts.push(Buffer.from([0xff, 0xc0]), Buffer.from([(sof.length + 2) >> 8, (sof.length + 2) & 0xff]), sof)
  parts.push(Buffer.from([0xff, 0xda, 0, 2]))
  return Buffer.concat(parts)
}

export function gif(width: number, height: number): Buffer {
  return Buffer.concat([Buffer.from('GIF89a'), u16le(width), u16le(height), Buffer.from([0, 0, 0])])
}

export function bmp(width: number, height: number): Buffer {
  const header = Buffer.alloc(54)
  header.write('BM', 0, 'latin1')
  header.writeUInt32LE(54, 10)
  header.writeUInt32LE(40, 14)
  header.writeInt32LE(width, 18)
  header.writeInt32LE(-height, 22) // top-down bitmaps store a negative height
  header.writeUInt16LE(1, 26)
  header.writeUInt16LE(24, 28)
  return header
}

export function webp(width: number, height: number, flavor: 'VP8X' | 'VP8L' | 'VP8 ' = 'VP8X'): Buffer {
  const head = Buffer.alloc(30)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(22, 4)
  head.write('WEBP', 8, 'latin1')
  head.write(flavor, 12, 'latin1')
  if (flavor === 'VP8X') {
    head.writeUIntLE(width - 1, 24, 3)
    head.writeUIntLE(height - 1, 27, 3)
  } else if (flavor === 'VP8L') {
    head[20] = 0x2f
    head.writeUInt32LE(((height - 1) << 14) | (width - 1), 21)
  } else {
    head.set([0x9d, 0x01, 0x2a], 23)
    head.writeUInt16LE(width, 26)
    head.writeUInt16LE(height, 28)
  }
  return head
}

const box = (type: string, ...body: Buffer[]): Buffer => {
  const payload = Buffer.concat(body)
  return Buffer.concat([u32(payload.length + 8), Buffer.from(type, 'latin1'), payload])
}

export function heic(width: number, height: number): Buffer {
  const ispe = box('ispe', Buffer.alloc(4), u32(width), u32(height))
  const thumb = box('ispe', Buffer.alloc(4), u32(Math.round(width / 8)), u32(Math.round(height / 8)))
  const meta = box('meta', Buffer.alloc(4), box('iprp', box('ipco', thumb, ispe)))
  return Buffer.concat([box('ftyp', Buffer.from('heic'), Buffer.alloc(4), Buffer.from('mif1')), meta])
}

const QT_EPOCH_OFFSET = 2_082_844_800

/** ftyp + (mdat big enough to push moov to the END, like a non-faststart camera file) + moov(mvhd, audio trak, video trak). */
export function mp4(options: { width: number; height: number; seconds: number; created?: Date; brand?: string; rotated?: boolean; mdatBytes?: number }): Buffer {
  const created = options.created ? Math.floor(options.created.getTime() / 1000) + QT_EPOCH_OFFSET : 0
  const mvhd = box('mvhd', Buffer.alloc(4), u32(created), u32(created), u32(1000), u32(options.seconds * 1000), Buffer.alloc(80))
  const tkhd = (w: number, h: number, rotated = false) => {
    const matrix = Buffer.alloc(36)
    if (rotated) {
      matrix.writeInt32BE(0, 0)
      matrix.writeInt32BE(0x10000, 4)
      matrix.writeInt32BE(-0x10000, 12)
      matrix.writeInt32BE(0, 16)
    } else {
      matrix.writeInt32BE(0x10000, 0)
      matrix.writeInt32BE(0x10000, 16)
    }
    return box('tkhd', Buffer.from([0, 0, 0, 3]), Buffer.alloc(20), Buffer.alloc(8), Buffer.alloc(8), matrix, u32(w * 65536), u32(h * 65536))
  }
  const audioTrak = box('trak', tkhd(0, 0), box('mdia', Buffer.alloc(64_000)))
  const videoTrak = box('trak', tkhd(options.width, options.height, options.rotated), box('mdia', Buffer.alloc(2000)))
  const moov = box('moov', mvhd, audioTrak, videoTrak)
  const ftyp = box('ftyp', Buffer.from(options.brand ?? 'isom'), Buffer.alloc(4), Buffer.from('isomiso2'))
  const payload = options.mdatBytes ?? 100_000
  return Buffer.concat([ftyp, u32(8 + payload), Buffer.from('mdat'), Buffer.alloc(payload), moov])
}

const vint = (n: number, length: number): Buffer => {
  const b = Buffer.alloc(length)
  let v = n
  for (let i = length - 1; i >= 0; i--) {
    b[i] = v & 0xff
    v = Math.floor(v / 256)
  }
  b[0] = (b[0] ?? 0) | (0x80 >> (length - 1))
  return b
}
const ebml = (id: number, ...body: Buffer[]): Buffer => {
  const payload = Buffer.concat(body)
  const idBytes: number[] = []
  for (let v = id; v > 0; v = Math.floor(v / 256)) idBytes.unshift(v & 0xff)
  return Buffer.concat([Buffer.from(idBytes), vint(payload.length, 2), payload])
}
const uintBytes = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}

export function mkv(options: { width: number; height: number; seconds: number; doc?: 'matroska' | 'webm' }): Buffer {
  const duration = Buffer.alloc(8)
  duration.writeDoubleBE(options.seconds * 1000)
  const header = ebml(0x1a45dfa3, ebml(0x4282, Buffer.from(options.doc ?? 'matroska')))
  const info = ebml(0x1549a966, ebml(0x2ad7b1, uintBytes(1_000_000)), ebml(0x4489, duration))
  const video = ebml(0xe0, ebml(0xb0, uintBytes(options.width)), ebml(0xba, uintBytes(options.height)))
  const tracks = ebml(0x1654ae6b, ebml(0xae, ebml(0x83, Buffer.from([1])), video))
  return Buffer.concat([header, ebml(0x18538067, info, tracks)])
}

export function avi(width: number, height: number, frames: number, microsPerFrame: number): Buffer {
  const avih = Buffer.alloc(56)
  avih.writeUInt32LE(microsPerFrame, 0)
  avih.writeUInt32LE(frames, 16)
  avih.writeUInt32LE(width, 32)
  avih.writeUInt32LE(height, 36)
  const head = Buffer.alloc(32)
  head.write('RIFF', 0, 'latin1')
  head.write('AVI ', 8, 'latin1')
  head.write('LIST', 12, 'latin1')
  head.write('hdrl', 20, 'latin1')
  head.write('avih', 24, 'latin1')
  head.writeUInt32LE(56, 28)
  return Buffer.concat([head, avih])
}

/** Write `header` then extend the file (sparse, no disk cost) to `totalBytes`. */
export function writeSparse(path: string, header: Buffer, totalBytes: number): void {
  const fd = openSync(path, 'w')
  try {
    writeSync(fd, header)
  } finally {
    closeSync(fd)
  }
  if (totalBytes > header.length) truncateSync(path, totalBytes)
}
