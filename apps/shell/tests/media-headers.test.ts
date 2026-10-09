import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bufferSource } from '../src/main/document-memory/media/byte-source'
import { readImageMetadata, parseExifDate } from '../src/main/document-memory/media/image-headers'
import { readVideoMetadata } from '../src/main/document-memory/media/video-headers'
import { readMediaMetadata } from '../src/main/document-memory/media/media-reader'
import { avi, bmp, gif, heic, jpeg, mkv, mp4, png, tiff, webp, writeSparse } from './helpers/media-fixtures'

const image = (buffer: Buffer) => readImageMetadata(bufferSource(buffer))
const video = (buffer: Buffer, ext = 'mp4') => readVideoMetadata(bufferSource(buffer), ext)

describe('image header parsing (first 64 KB only, never pixels)', () => {
  it('reads width/height/container of every supported format', async () => {
    expect(await image(png(1920, 1080))).toMatchObject({ container: 'png', width: 1920, height: 1080 })
    expect(await image(jpeg(4032, 3024))).toMatchObject({ container: 'jpeg', width: 4032, height: 3024 })
    expect(await image(gif(320, 200))).toMatchObject({ container: 'gif', width: 320, height: 200 })
    expect(await image(bmp(640, 480))).toMatchObject({ container: 'bmp', width: 640, height: 480 })
    expect(await image(webp(800, 600, 'VP8X'))).toMatchObject({ container: 'webp', width: 800, height: 600 })
    expect(await image(webp(801, 601, 'VP8L'))).toMatchObject({ container: 'webp', width: 801, height: 601 })
    expect(await image(webp(802, 602, 'VP8 '))).toMatchObject({ container: 'webp', width: 802, height: 602 })
    expect(await image(tiff({ width: 2480, height: 3508 }))).toMatchObject({ container: 'tiff', width: 2480, height: 3508 })
    expect(await image(heic(4000, 3000))).toMatchObject({ container: 'heic', width: 4000, height: 3000 })
  })

  it('reads the EXIF capture date of a JPEG as local wall-clock time, hopping over big APP segments', async () => {
    const found = await image(jpeg(100, 50, { exifDate: '2017:03:16 10:20:30', bigApp: 150_000 }))
    expect(found).toMatchObject({ container: 'jpeg', width: 100, height: 50 })
    expect(found.takenMs).toBe(new Date(2017, 2, 16, 10, 20, 30).getTime())
    expect((await image(tiff({ exifDate: '2020:12:31 23:59:59' }))).takenMs).toBe(new Date(2020, 11, 31, 23, 59, 59).getTime())
  })

  it('rejects impossible dates and absurd dimensions instead of storing garbage', async () => {
    expect(parseExifDate('0000:00:00 00:00:00')).toBeUndefined()
    expect(parseExifDate('2017:13:40 10:00:00')).toBeUndefined()
    expect(parseExifDate('not a date')).toBeUndefined()
    expect((await image(png(0, 10))).width).toBeUndefined()
    expect((await image(png(4_000_000_000, 4_000_000_000))).width).toBeUndefined()
  })

  it('never throws or hangs on truncated, corrupt or hostile headers', async () => {
    const samples = [
      png(10, 10), jpeg(10, 10, { exifDate: '2017:03:16 10:20:30' }), gif(10, 10), bmp(10, 10), webp(10, 10),
      tiff({ width: 10, height: 10, exifDate: '2017:03:16 10:20:30' }), heic(10, 10),
    ]
    for (const sample of samples) {
      for (let length = 0; length <= sample.length; length++) {
        await expect(image(sample.subarray(0, length))).resolves.toBeTypeOf('object')
      }
      for (let at = 0; at < sample.length; at += 3) {
        const mangled = Buffer.from(sample)
        mangled[at] = 0xff
        await expect(image(mangled)).resolves.toBeTypeOf('object')
      }
    }
    // A TIFF whose IFD offset points far outside the file, a JPEG with a zero-length segment loop.
    const wild = Buffer.from(tiff({ width: 5, height: 5 }))
    wild.writeUInt32LE(0xfffffff0, 4)
    await expect(image(wild)).resolves.toEqual({ container: 'tiff' })
    const loop = Buffer.concat([Buffer.from([0xff, 0xd8]), ...Array.from({ length: 500 }, () => Buffer.from([0xff, 0xe0, 0x00, 0x02]))])
    await expect(image(loop)).resolves.toMatchObject({ container: 'jpeg' })
    for (let i = 0; i < 50; i++) {
      const noise = Buffer.alloc(300)
      for (let j = 0; j < noise.length; j++) noise[j] = (i * 31 + j * 17) & 0xff
      await expect(image(noise)).resolves.toBeTypeOf('object')
    }
  })
})

describe('video container parsing (moov/mvhd/tkhd, no audio/subtitles/frames)', () => {
  it('reads duration, dimensions and creation date of an mp4 whose moov is at the END of the file', async () => {
    const created = new Date(Date.UTC(2019, 6, 4, 12, 0, 0))
    const found = await video(mp4({ width: 1920, height: 1080, seconds: 125, created }))
    expect(found).toMatchObject({ container: 'mp4', width: 1920, height: 1080, durationMs: 125_000 })
    expect(found.takenMs).toBe(created.getTime())
  })

  it('maps brands to containers and swaps axes for rotated (portrait phone) video', async () => {
    expect((await video(mp4({ width: 640, height: 360, seconds: 3, brand: 'qt  ' }), 'mov')).container).toBe('mov')
    expect((await video(mp4({ width: 640, height: 360, seconds: 3, brand: '3gp4' }), '3gp')).container).toBe('3gp')
    expect(await video(mp4({ width: 1920, height: 1080, seconds: 3, rotated: true }))).toMatchObject({ width: 1080, height: 1920 })
  })

  it('reads mkv / webm (EBML) and avi (avih) headers', async () => {
    expect(await video(mkv({ width: 1280, height: 720, seconds: 61.5 }), 'mkv')).toMatchObject({ container: 'mkv', width: 1280, height: 720, durationMs: 61_500 })
    expect((await video(mkv({ width: 1280, height: 720, seconds: 10, doc: 'webm' }), 'webm')).container).toBe('webm')
    expect(await video(avi(704, 576, 750, 40_000), 'avi')).toMatchObject({ container: 'avi', width: 704, height: 576, durationMs: 30_000 })
  })

  it('never throws or hangs on truncated, corrupt or hostile containers', async () => {
    const samples = [mp4({ width: 100, height: 50, seconds: 2, mdatBytes: 10 }), mkv({ width: 10, height: 10, seconds: 1 }), avi(10, 10, 5, 1000)]
    for (const sample of samples) {
      for (let length = 0; length <= sample.length; length += 7) await expect(video(sample.subarray(0, length))).resolves.toBeTypeOf('object')
      for (let at = 0; at < Math.min(sample.length, 400); at += 5) {
        const mangled = Buffer.from(sample)
        mangled[at] = 0xff
        await expect(video(mangled)).resolves.toBeTypeOf('object')
      }
    }
    // A box that claims 4 GB, and a box chain that never advances.
    const huge = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12), Buffer.from([0xff, 0xff, 0xff, 0xf0]), Buffer.from('moov'), Buffer.alloc(64)])
    await expect(video(huge)).resolves.toMatchObject({ container: 'mp4' })
    const stuck = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.alloc(4), ...Array.from({ length: 300 }, () => Buffer.from([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65]))])
    await expect(video(stuck)).resolves.toMatchObject({ container: 'mp4' })
  })
})

describe('file reader', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-media-headers-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads a real file with bounded reads and falls back to the extension for the container', async () => {
    const big = join(dir, 'huge.png')
    writeSparse(big, png(7680, 4320), 900 * 1024 * 1024) // 900 MB sparse: reading it whole would be obvious
    const started = Date.now()
    expect(await readMediaMetadata(big, 'image')).toMatchObject({ container: 'png', width: 7680, height: 4320 })
    expect(Date.now() - started).toBeLessThan(1500)
    const odd = join(dir, 'weird.heic')
    writeFileSync(odd, Buffer.alloc(100, 7))
    expect(await readMediaMetadata(odd, 'image')).toEqual({ container: 'heic' })
  })

  it('returns null (never throws) for a missing or empty file', async () => {
    expect(await readMediaMetadata(join(dir, 'gone.jpg'), 'image')).toBeNull()
    const empty = join(dir, 'empty.mp4')
    writeFileSync(empty, '')
    expect(await readMediaMetadata(empty, 'video')).toEqual({ container: 'mp4' })
  })
})
