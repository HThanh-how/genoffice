import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  decodeGray,
  encodeGrayPng,
  type GrayImage,
} from '../src/main/document-memory/local-ocr/gray-image'
import {
  chooseOrientation,
  probeOrientation,
} from '../src/main/document-memory/local-ocr/orientation'
import { findTessdataDir } from '../src/main/document-memory/local-ocr/resources'
import { TesseractEngine } from '../src/main/document-memory/local-ocr/tesseract-engine'
import { prepareForTesseract } from '../src/main/document-memory/local-ocr/tesseract-prepare'
import { orientTesseractImage } from '../src/main/document-memory/local-ocr/orientation-image'

describe('orientation confidence policy', () => {
  it.each([
    [[90, 20, 30, 25], 0],
    [[28, 86, 31, 24], 90],
    [[32, 21, 81, 25], 180],
    [[28, 25, 31, 86], 270],
    [[44, 59, 20, 30], 0], // below minimum, even with enough gain
    [[60, 74, 20, 30], 0], // insufficient gain
    [[45, 60, 20, 30], 90], // both boundaries inclusive
    [[70, 70, 70, 70], 0],
    [[0, NaN, Infinity, 20], 0],
    [[NaN, 90, 30, 20], 0],
  ])('scores %j select %i degrees', (scores, expected) => {
    expect(chooseOrientation(scores)).toBe(expected)
  })

  it('stops probing a confidently upright page after one recognition', async () => {
    const recognize = vi.fn(async () => 90)
    expect(await probeOrientation(recognize)).toBe(0)
    expect(recognize).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('probes sequentially and applies the selected angle to the full image', async () => {
    const bytes = encodeGrayPng({ width: 10, height: 10, data: new Uint8Array(100).fill(255) })
    const calls: number[] = []
    const orient = vi.fn(async (image, degrees, edge) => {
      calls.push(degrees)
      return orientTesseractImage(image, degrees, edge)
    })
    const prepare = vi.fn(async (image: Uint8Array) => image)
    const worker = {
      setParameters: async () => {},
      recognize: async () => {
        return {
          data: {
            text: 'synthetic text',
            confidence: [28, 25, 31, 86, 90][calls.length - 1],
            tsv: '',
          },
        }
      },
      terminate: async () => {},
    }
    const engine = new TesseractEngine({
      langPath: '/synthetic',
      prepare,
      orient,
      loadModule: async () => ({ createWorker: async () => worker }),
    })
    try {
      await engine.recognizePage({ bytes, dpi: 150, lang: 'vie' })
      expect(orient.mock.calls[0]).toEqual([bytes, 0, 800])
      expect(calls).toEqual([0, 90, 180, 270, 270])
    } finally {
      await engine.dispose()
    }
  })

  it('bounds probes and final recognition by one page timeout and never continues a timed-out probe', async () => {
    let resolveProbe!: (result: { data: { text: string; confidence: number } }) => void
    const recognize = vi.fn(
      () =>
        new Promise<{ data: { text: string; confidence: number } }>((r) => {
          resolveProbe = r
        }),
    )
    const terminate = vi.fn(async () => {})
    const engine = new TesseractEngine({
      langPath: '/synthetic',
      prepare: async (bytes) => bytes,
      orient: async (bytes) => bytes,
      loadModule: async () => ({
        createWorker: async () => ({ setParameters: async () => {}, recognize, terminate }),
      }),
    })
    await expect(
      engine.recognizePage({ bytes: new Uint8Array(10), dpi: 150, lang: 'vie', timeoutMs: 20 }),
    ).rejects.toThrow('Tesseract timed out')
    resolveProbe({ data: { text: '', confidence: 0 } })
    await new Promise((r) => setImmediate(r))
    expect(recognize).toHaveBeenCalledTimes(1)
    expect(terminate).toHaveBeenCalledTimes(1)
  })
})

function clockwise(image: GrayImage): GrayImage {
  const { width, height, data } = image
  const rotated = new Uint8Array(data.length)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) rotated[x * height + height - 1 - y] = data[y * width + x]
  return { width: height, height: width, data: rotated }
}

// No canvas text renderer is installed. Use the repository's explicitly synthetic invoice,
// generating all four rotated PNG variants in this test; never read external documents.
it.skipIf(!findTessdataDir())(
  'bundled engine finds all four orientations of synthetic Vietnamese text',
  async () => {
    const angles: number[] = []
    const engine = new TesseractEngine({
      orient: async (bytes, degrees, edge) => {
        if (!edge && Math.max(decodeGray(bytes)!.width, decodeGray(bytes)!.height) > 800)
          angles.push(degrees)
        return orientTesseractImage(bytes, degrees, edge)
      },
    })
    let image = decodeGray(readFileSync(join(__dirname, 'fixtures/ocr/invoice-synth.png')))!
    try {
      for (const rotation of [0, 90, 180, 270]) {
        const bytes = encodeGrayPng(image)
        const small = decodeGray(orientTesseractImage(prepareForTesseract(bytes, 150)!, 0, 800)!)!
        expect(Math.max(small.width, small.height)).toBeLessThanOrEqual(800)
        const result = await engine.recognizePage({ bytes, dpi: 150, lang: 'vie' })
        expect(result.text).toMatch(/HÓA ĐƠN GIÁ TRỊ GIA TĂNG/)
        expect(result.meanConfidence).toBeGreaterThan(0.8)
        if (rotation === 0) expect(angles).toEqual([])
        else expect(angles.at(-1)).toBe((360 - rotation) % 360)
        image = clockwise(image)
      }
    } finally {
      await engine.dispose()
    }
  },
  120_000,
)
