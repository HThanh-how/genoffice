import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'
import {
  CUTOUT_MAX_REMOVED,
  CUTOUT_MIN_REMOVED,
  cutoutGeneratedBackground,
  encodePng,
} from '../src/image-cutout'
import type { PixelImage } from '../src/image-cutout-core'

function solid(width: number, height: number, rgb: [number, number, number]): PixelImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0]
    data[i * 4 + 1] = rgb[1]
    data[i * 4 + 2] = rgb[2]
    data[i * 4 + 3] = 255
  }
  return { data, width, height }
}

function paint(
  img: PixelImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgb: [number, number, number],
): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4
      img.data[i] = rgb[0]
      img.data[i + 1] = rgb[1]
      img.data[i + 2] = rgb[2]
    }
  }
}

const decodeFixture = (image: PixelImage | null) => async () => image
const alphaAt = (png: PNG, x: number, y: number) => png.data[(y * png.width + x) * 4 + 3]!

describe('encodePng', () => {
  it('writes a PNG that a reference decoder reads back pixel for pixel', () => {
    const img = solid(3, 2, [10, 20, 30])
    img.data[3] = 0
    img.data[4 * 5 + 3] = 128
    const png = PNG.sync.read(Buffer.from(encodePng(img)))
    expect([png.width, png.height]).toEqual([3, 2])
    expect(Array.from(png.data)).toEqual(Array.from(img.data))
  })

  it('refuses an empty or truncated pixel buffer', () => {
    expect(() => encodePng({ data: new Uint8ClampedArray(0), width: 0, height: 0 })).toThrow()
    expect(() => encodePng({ data: new Uint8ClampedArray(8), width: 4, height: 4 })).toThrow()
  })
})

describe('cutoutGeneratedBackground', () => {
  it('turns a flat white backdrop into real alpha and keeps the subject opaque', async () => {
    const img = solid(40, 40, [255, 255, 255])
    paint(img, 12, 12, 28, 28, [220, 30, 40])
    const out = await cutoutGeneratedBackground(new Uint8Array([1]), {
      decode: decodeFixture(img),
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.removedFraction).toBeCloseTo(1 - 256 / 1600, 2)
    const png = PNG.sync.read(Buffer.from(out.png))
    expect(alphaAt(png, 0, 0)).toBe(0)
    expect(alphaAt(png, 39, 39)).toBe(0)
    expect(alphaAt(png, 20, 20)).toBe(255)
    // the subject colour survives untouched
    expect(Array.from(png.data.subarray((20 * 40 + 20) * 4, (20 * 40 + 20) * 4 + 3))).toEqual([
      220, 30, 40,
    ])
  })

  it('absorbs JPEG-like noise around the backdrop but keeps an enclosed white region', async () => {
    const img = solid(60, 60, [255, 255, 255])
    paint(img, 10, 10, 50, 50, [30, 60, 200])
    paint(img, 25, 25, 35, 35, [255, 255, 255]) // a white highlight inside the subject
    for (let i = 0; i < 60 * 60; i++) {
      const p = i * 4
      if (img.data[p] === 255) {
        const n = (i * 7) % 9
        img.data[p] = 255 - n
        img.data[p + 1] = 255 - n
        img.data[p + 2] = 255 - ((i * 3) % 7)
      }
    }
    const out = await cutoutGeneratedBackground(new Uint8Array([1]), {
      decode: decodeFixture(img),
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const png = PNG.sync.read(Buffer.from(out.png))
    expect(alphaAt(png, 2, 2)).toBe(0)
    expect(alphaAt(png, 30, 30)).toBe(255)
  })

  it('zeroes the colour of removed pixels so nothing bleeds in when a viewer premultiplies', async () => {
    const img = solid(30, 30, [250, 250, 250])
    paint(img, 10, 10, 20, 20, [0, 0, 0])
    const out = await cutoutGeneratedBackground(new Uint8Array([1]), {
      decode: decodeFixture(img),
    })
    if (!out.ok) throw new Error('expected a cutout')
    const png = PNG.sync.read(Buffer.from(out.png))
    expect(Array.from(png.data.subarray(0, 4))).toEqual([0, 0, 0, 0])
  })

  it('reports why it did not cut, never a picture that only looks transparent', async () => {
    const bytes = new Uint8Array([1])
    expect(await cutoutGeneratedBackground(bytes)).toEqual({ ok: false, reason: 'no-decoder' })
    expect(await cutoutGeneratedBackground(bytes, { decode: decodeFixture(null) })).toEqual({
      ok: false,
      reason: 'decode-failed',
    })
    expect(
      await cutoutGeneratedBackground(bytes, {
        decode: async () => {
          throw new Error('corrupt')
        },
      }),
    ).toEqual({ ok: false, reason: 'decode-failed' })
    expect(
      await cutoutGeneratedBackground(bytes, {
        decode: decodeFixture(solid(20, 20, [255, 255, 255])),
        maxPixels: 100,
      }),
    ).toEqual({ ok: false, reason: 'too-large' })
    // a uniform picture: the "backdrop" is the whole picture, so the subject would be lost
    expect(
      await cutoutGeneratedBackground(bytes, { decode: decodeFixture(solid(20, 20, [9, 9, 9])) }),
    ).toEqual({ ok: false, reason: 'subject-lost' })
    // a 1 px white frame around a busy picture is not a backdrop worth cutting
    const framed = solid(400, 400, [255, 255, 255])
    for (let y = 1; y < 399; y++)
      for (let x = 1; x < 399; x++) paint(framed, x, y, x + 1, y + 1, [x % 200, y % 200, 90])
    expect(await cutoutGeneratedBackground(bytes, { decode: decodeFixture(framed) })).toEqual({
      ok: false,
      reason: 'no-background',
    })
  })

  it('keeps its removal window inside sane bounds', () => {
    expect(CUTOUT_MIN_REMOVED).toBeGreaterThan(0)
    expect(CUTOUT_MAX_REMOVED).toBeLessThan(1)
  })
})
