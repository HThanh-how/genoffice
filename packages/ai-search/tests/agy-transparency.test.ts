import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const generate = vi.hoisted(() => vi.fn())
vi.mock('@genoffice/ai-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@genoffice/ai-provider')>()),
  generateImageWithProvider: generate,
}))
vi.mock('../src/gsk', () => ({
  gskGenerateImage: vi.fn(),
  gskAnalyzeMedia: vi.fn(),
  hasGskAuth: vi.fn(() => true),
}))

import { PNG } from 'pngjs'
import { readGeneratedImage } from '@genoffice/electron-utils/generated-images'
import { AGY_NO_ALPHA_NOTICE, makeAgyImageTransparent } from '../src/agy-transparency'
import { generateImageTool } from '../src/media-tools'
import { gskGenerateImage } from '../src/gsk'

const PIXELS = {
  width: 30,
  height: 30,
  data: (() => {
    const data = new Uint8ClampedArray(30 * 30 * 4).fill(255)
    for (let y = 10; y < 20; y++)
      for (let x = 10; x < 20; x++) {
        const i = (y * 30 + x) * 4
        data[i] = 200
        data[i + 1] = 20
        data[i + 2] = 30
      }
    return data
  })(),
}
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const decode = async () => PIXELS

function settings(imageProvider: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'genoffice-agy-transparency-'))
  const path = join(dir, 'ai-settings.json')
  writeFileSync(
    path,
    JSON.stringify({
      provider: 'agy',
      providers: { agy: { model: 'gemini-3.8-flash-low' } },
      media: {
        provider: imageProvider,
        imageProvider,
        providers: { [imageProvider]: { apiKey: 'k', imageModel: 'm' } },
      },
    }),
  )
  return path
}

function storedPng(url: string): PNG {
  const stored = readGeneratedImage(url)
  if (!stored) throw new Error('not in the generated image store')
  expect(stored.mime).toBe('image/png')
  return PNG.sync.read(stored.bytes)
}

beforeEach(() => {
  generate.mockReset()
  generate.mockResolvedValue({ bytes: JPEG_BYTES, mime: 'image/jpeg', name: 'a.jpg' })
  vi.mocked(gskGenerateImage).mockReset()
})

describe('makeAgyImageTransparent', () => {
  it('returns a PNG with real alpha when the backdrop can be cut', async () => {
    const out = await makeAgyImageTransparent({ bytes: JPEG_BYTES, mime: 'image/jpeg' }, { decode })
    expect(out.transparent).toBe(true)
    expect(out.mime).toBe('image/png')
    expect(out.notice).toBeUndefined()
    const png = PNG.sync.read(Buffer.from(out.bytes))
    expect(png.data[3]).toBe(0)
    expect(png.data[(15 * 30 + 15) * 4 + 3]).toBe(255)
  })

  it('hands the opaque picture back with an honest notice when it cannot decode it', async () => {
    const out = await makeAgyImageTransparent({ bytes: JPEG_BYTES, mime: 'image/jpeg' })
    expect(out.transparent).toBe(false)
    expect(out.bytes).toBe(JPEG_BYTES)
    expect(out.mime).toBe('image/jpeg')
    expect(out.notice).toContain(AGY_NO_ALPHA_NOTICE)
    expect(out.notice).toContain('cannot decode')
  })
})

describe('generateImageTool with the agy image provider', () => {
  it('chains the local cutout for transparentBackground and stores a PNG', async () => {
    const r = await generateImageTool(
      settings('agy'),
      { prompt: 'a red icon', transparentBackground: true },
      { cutout: { decode } },
    )
    expect(r.error).toBeUndefined()
    expect(r.transparent).toBe(true)
    expect(r.notice).toBeUndefined()
    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate.mock.calls[0]![0]).toBe('agy')
    // the provider is asked for the plain backdrop the cutout relies on
    expect(generate.mock.calls[0]![2]).toMatchObject({ transparent: true })
    expect(storedPng(r.url!).data[3]).toBe(0)
    expect(gskGenerateImage).not.toHaveBeenCalled()
  })

  it('keeps the opaque picture and says so when no decoder is available', async () => {
    const r = await generateImageTool(settings('agy'), {
      prompt: 'a red icon',
      transparentBackground: true,
    })
    expect(r.transparent).toBe(false)
    expect(r.notice).toContain(AGY_NO_ALPHA_NOTICE)
    const stored = readGeneratedImage(r.url!)
    expect(stored?.mime).toBe('image/jpeg')
    expect(Array.from(stored!.bytes)).toEqual(Array.from(JPEG_BYTES))
  })

  it('leaves ordinary requests untouched: no cutout, no transparency claim', async () => {
    const decodeSpy = vi.fn(decode)
    const r = await generateImageTool(
      settings('agy'),
      { prompt: 'a landscape' },
      { cutout: { decode: decodeSpy } },
    )
    expect(decodeSpy).not.toHaveBeenCalled()
    expect(r.transparent).toBeUndefined()
    expect(readGeneratedImage(r.url!)?.mime).toBe('image/jpeg')
  })

  it('does not run the agy cutout for other providers', async () => {
    const decodeSpy = vi.fn(decode)
    const r = await generateImageTool(
      settings('gemini'),
      { prompt: 'an icon', transparentBackground: true },
      { cutout: { decode: decodeSpy } },
    )
    expect(decodeSpy).not.toHaveBeenCalled()
    expect(r.transparent).toBeUndefined()
  })
})
