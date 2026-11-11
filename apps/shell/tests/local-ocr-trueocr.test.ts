import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { PNG } from 'pngjs'
import { decodeGray, decodePngGray } from '../src/main/document-memory/local-ocr/gray-image'
import { encodeGrayJpeg } from '../src/main/document-memory/jpeg-gray'
import { describe, expect, it, vi } from 'vitest'
import {
  decodeBlocksOrder,
  decodeCtc,
  decodeLines,
  decodeOrder,
  lineFeatures,
  widthBatches,
  type LineBox,
} from '../src/main/document-memory/local-ocr/trueocr-decode'
import {
  decodeTrueOcrImage,
  estimateSkew,
  quarterTurn,
  roundEven,
} from '../src/main/document-memory/local-ocr/trueocr-image'
import {
  TrueOcrEngine,
  TRUEOCR_DESCRIPTOR,
} from '../src/main/document-memory/local-ocr/trueocr-engine'
import {
  needsTesseract,
  recognizeWithLocalFallback,
  TRUEOCR_TESSERACT_MIN_CONFIDENCE,
} from '../src/main/document-memory/local-ocr/trueocr-fallback'
import { LocalOcrEngineRegistry, engineChain } from '../src/main/document-memory/local-ocr/registry'
import { findTrueOcrDir } from '../src/main/document-memory/local-ocr/resources'
import {
  shouldEscalate,
  TRUEOCR_ESCALATION_THRESHOLD,
} from '../src/main/document-memory/local-ocr/escalation'
import { agyOcrSettingsFrom, mergeLocalOcrSettings } from '../src/shared/fork/agy-ocr'
import { localOcrCopy } from '../src/renderer/src/i18n/strings-local-ocr'
import type {
  LocalOcrEngine,
  LocalOcrRecognition,
} from '../src/main/document-memory/runtime/local-ocr-engine'
import { realIndexWorkerFactory } from './helpers/index-worker-process'

const input = { bytes: new Uint8Array([1]), dpi: 150, lang: 'vie' }
const good: LocalOcrRecognition = {
  text: 'Cộng hòa xã hội chủ nghĩa Việt Nam',
  meanConfidence: 0.99,
  ms: 1,
}
function fake(id: string, result: LocalOcrRecognition = good): LocalOcrEngine {
  return {
    id,
    descriptor: { ...TRUEOCR_DESCRIPTOR, id },
    isAvailable: () => true,
    recognizePage: vi.fn(async () => result),
    dispose: vi.fn(async () => {}),
  }
}

describe('TrueOCR decoders and geometry', () => {
  it('composites PNG alpha on white without changing Tesseract decoding and applies JPEG EXIF', () => {
    const png = new PNG({ width: 1, height: 1 })
    png.data.fill(0)
    const bytes = PNG.sync.write(png)
    expect(decodePngGray(bytes)!.data[0]).toBe(0)
    expect(decodeTrueOcrImage(bytes)!.data[0]).toBe(255)
    const jpeg = encodeGrayJpeg(
      new Uint8Array(8 * 16).map((_, i) => i),
      8,
      16,
      90,
    )
    const tiff = Buffer.alloc(26)
    tiff.write('II')
    tiff.writeUInt16LE(42, 2)
    tiff.writeUInt32LE(8, 4)
    tiff.writeUInt16LE(1, 8)
    tiff.writeUInt16LE(0x112, 10)
    tiff.writeUInt16LE(3, 12)
    tiff.writeUInt32LE(1, 14)
    tiff.writeUInt16LE(6, 18)
    const exif = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 34]), Buffer.from('Exif\0\0'), tiff])
    const withExif = Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)])
    expect(decodeTrueOcrImage(withExif)).toEqual(quarterTurn(decodeGray(jpeg)!, 1))
  })

  it('uses the bundled charset, collapses CTC repeats across blanks and normalizes NFC', () => {
    const charset = ['a', 'á', ' ', 'b']
    expect(decodeCtc([1n, 1n, 0n, 1n, 3n, 2n], [0.8, 0.1, 1, 0.6, 0.9, 0.7], 6, charset)).toEqual({
      text: 'aa á',
      confidence: 0.75,
    })
    expect(decodeCtc([0, 0], [1, 1], 2, charset)).toEqual({ text: '', confidence: 0 })
    expect(() => decodeCtc([9], [1], 1, charset)).toThrow(/charset/)
    expect(decodeCtc([1, 2], [1, 1], 2, ['a', '\u0301']).text).toBe('á')
    const dir = findTrueOcrDir()
    if (dir) {
      const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
      expect(meta.charset).toContain('Đ')
      expect(meta.charset).toContain('ệ')
      for (const char of ['!', '?', '[', ']', '=', '"', '°', '₫', '–', '…'])
        expect(meta.charset).not.toContain(char)
    }
  })

  it('decodes four-connected core pixels, ignores singletons and expands by line height', () => {
    const tensor = new Float32Array(3 * 3 * 4)
    tensor.fill(-10, 0, 12)
    tensor[5] = 10
    tensor[6] = 10
    tensor[11] = 10
    tensor.fill(2, 12, 24)
    tensor.fill(4, 24)
    const boxes = decodeLines(tensor, 3, 4)
    expect(boxes).toHaveLength(1)
    expect(boxes[0]!.slice(0, 4)).toEqual([Math.fround(1.1), 1, Math.fround(6.9), 7])
    expect(boxes[0]![4]).toBeGreaterThan(0.99)
  })

  it('orders blocks with the model logits and table rows from left to right', () => {
    const boxes: LineBox[] = [
      [30, 10, 40, 20, 1],
      [0, 10, 10, 20, 1],
      [0, 40, 40, 50, 1],
    ]
    const same = [0, 8, -8, 8, 0, -8, -8, -8, 0]
    const a = [0, 0, 10, 0, 0, 10, -10, -10, 0]
    const cls = new Float32Array(30)
    cls[5] = 5
    cls[15] = 5
    expect(decodeBlocksOrder(a, same, boxes, cls)).toEqual([1, 0, 2])
    expect(decodeOrder([0, -9, 9, 0], 2)).toEqual([1, 0])
    const features = lineFeatures(boxes, ['- abc', 'Đơn vị.', 'Việt Nam'], 100, 100)
    expect(features).toHaveLength(48)
    expect(features[12]).toBe(1)
    expect(features[16 + 14]).toBe(1)
    expect(widthBatches([500, 65, 60, 700])).toEqual([[2, 1], [0], [3]])
  })

  it('rotates all quarter turns exactly and leaves blank pages unskewed', () => {
    const image = { width: 3, height: 2, data: new Uint8Array([1, 2, 3, 4, 5, 6]) }
    expect([...quarterTurn(image, 1).data]).toEqual([4, 1, 5, 2, 6, 3])
    expect(quarterTurn(quarterTurn(image, 1), -1)).toEqual(image)
    expect(estimateSkew({ width: 2, height: 2, data: new Uint8Array(4).fill(255) })).toBe(0)
    expect([roundEven(0.5), roundEven(1.5), roundEven(-1.5)]).toEqual([0, 2, -2])
  })
})

describe('TrueOCR selection, fallback and settings', () => {
  it('orders platforms, respects an explicit Tesseract-only preference and RAM', () => {
    expect(engineChain('win32')).toEqual(['trueocr-vie', 'tesseract-vie'])
    expect(engineChain('linux')).toEqual(['trueocr-vie', 'tesseract-vie'])
    expect(engineChain('darwin')).toEqual(['apple-vision', 'trueocr-vie', 'tesseract-vie'])
    expect(engineChain('darwin', 'tesseract-vie')).toEqual(['tesseract-vie'])
    expect(engineChain('darwin', 'trueocr-vie')).toEqual([
      'trueocr-vie',
      'apple-vision',
      'tesseract-vie',
    ])
    const engine = new TrueOcrEngine()
    expect(engine.isAvailable('linux', 399)).toBe(false)
    expect(new TrueOcrEngine({ modelDir: null }).isAvailable('linux', Infinity)).toBe(false)
  })

  it('selects Tesseract when TrueOCR models are missing', async () => {
    const registry = new LocalOcrEngineRegistry({
      platform: 'linux',
      freeRamMB: () => 8000,
      factories: {
        'trueocr-vie': () => new TrueOcrEngine({ modelDir: null }),
        'tesseract-vie': () => fake('tesseract-vie'),
      },
    })
    expect(registry.select()).toMatchObject({
      engine: { id: 'tesseract-vie' },
      skipped: [{ id: 'trueocr-vie', reason: 'unavailable' }],
    })
    await registry.disposeAll()
  })

  it('tries Tesseract after an inference error, retaining the actual engine id', async () => {
    const primary = fake('trueocr-vie'),
      fallback = fake('tesseract-vie')
    primary.recognizePage = vi.fn(async () => {
      throw new Error('ORT failure')
    })
    const result = await recognizeWithLocalFallback(primary, input, {
      select: () => ({ engine: fallback, skipped: [] }),
    })
    expect(result.engine.id).toBe('tesseract-vie')
    expect(result.recognition).toEqual(good)
    expect(fallback.dispose).toHaveBeenCalledOnce()
  })

  it('retries low confidence and empty pages, preserves sensitivity, and keeps a primary result if the retry fails', async () => {
    const low = { ...good, text: 'Căn cước công dân', meanConfidence: 0.5 }
    const primary = fake('trueocr-vie', low),
      fallback = fake('tesseract-vie')
    const registry = { select: () => ({ engine: fallback, skipped: [] }) }
    const result = await recognizeWithLocalFallback(primary, input, registry)
    expect(result.sensitiveText).toContain('Căn cước công dân')
    expect(needsTesseract({ ...good, text: '' })).toBe(true)
    expect(needsTesseract({ ...good, meanConfidence: TRUEOCR_TESSERACT_MIN_CONFIDENCE })).toBe(
      false,
    )
    fallback.recognizePage = vi.fn(async () => {
      throw new Error('Tesseract unavailable')
    })
    expect((await recognizeWithLocalFallback(primary, input, registry)).recognition).toEqual(low)
    expect(
      (await recognizeWithLocalFallback(primary, input, registry, async () => false)).recognition,
    ).toEqual(low)
  })

  it('does not retry good TrueOCR or explicitly chosen Tesseract pages', async () => {
    const select = vi.fn(() => null)
    await recognizeWithLocalFallback(fake('trueocr-vie'), input, { select })
    await recognizeWithLocalFallback(
      fake('tesseract-vie', { ...good, meanConfidence: 0.1 }),
      input,
      { select },
    )
    expect(select).not.toHaveBeenCalled()
  })

  it('migrates missing settings to auto, accepts TrueOCR and retains explicit legacy choices', () => {
    expect(agyOcrSettingsFrom({}).localOcr?.engine).toBe('auto')
    expect(
      mergeLocalOcrSettings({ enabled: true, lightPages: 2, maxPages: 30 } as never, {}).engine,
    ).toBe('auto')
    for (const engine of ['trueocr-vie', 'tesseract-vie', 'apple-vision'] as const)
      expect(mergeLocalOcrSettings(undefined, { engine }).engine).toBe(engine)
    expect(localOcrCopy('vi').autoHint).toContain('TrueOCR')
    expect(localOcrCopy('zh').tesseract).toContain('Tesseract')
  })

  it('uses TrueOCR S threshold while preserving sensitivity and existing Tesseract scoring', () => {
    expect(TRUEOCR_ESCALATION_THRESHOLD).toBe(0.65)
    const page = { ...good, text: 'cộng hòa xã hội chủ nghĩa', meanConfidence: 0.6 }
    expect(shouldEscalate(page, 'trueocr-vie').escalate).toBe(true)
    expect(shouldEscalate(page, 'tesseract-vie').escalate).toBe(false)
    expect(shouldEscalate({ ...page, text: 'Căn cước công dân' }, 'trueocr-vie').escalate).toBe(
      false,
    )
  })
})

describe.runIf(findTrueOcrDir() !== null)('TrueOCR real models', () => {
  it('runs the full pipeline in the real index child process and answers disposal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trueocr-worker-'))
    const factory = await realIndexWorkerFactory()
    const worker = factory('unused', {
      cacheDir: join(dir, 'models'),
      dbPath: join(dir, 'worker.db'),
    } as never)
    const ask = (request: Record<string, unknown>, id: number) =>
      new Promise<{ result?: unknown; error?: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No TrueOCR worker reply')), 45_000)
        worker.on('message', (reply: { id?: number; result?: unknown; error?: string }) => {
          if (reply.id === id) {
            clearTimeout(timer)
            resolve(reply)
          }
        })
        worker.postMessage({ ...request, id })
      })
    try {
      const reply = await ask(
        {
          type: 'ocr-trueocr',
          input: {
            bytes: new Uint8Array(readFileSync(join(__dirname, 'fixtures/ocr/trueocr-synth.png'))),
            dpi: 150,
            lang: 'vie',
          },
        },
        91,
      )
      expect(reply.error).toBeUndefined()
      expect((reply.result as LocalOcrRecognition).text).toContain('Tiếng Việt có dấu')
      expect(await ask({ type: 'ocr-trueocr-dispose' }, 92)).toMatchObject({ result: true })
    } finally {
      await worker.terminate?.()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('matches the Python page-mode reference on a public synthetic Vietnamese image; releases and reloads sessions', async () => {
    const fixture = join(__dirname, 'fixtures/ocr/trueocr-synth.png')
    const expected = JSON.parse(readFileSync(fixture.replace('.png', '.json'), 'utf8'))
    const engine = new TrueOcrEngine()
    try {
      const result = await engine.recognizePage({ imagePath: fixture, dpi: 150, lang: 'vie' })
      expect(result.text.normalize('NFC')).toBe(expected.text.normalize('NFC'))
      expect(result.tokens).toHaveLength(expected.lines)
      expect(result.meanConfidence).toBeGreaterThan(0.95)
      await engine.dispose()
      expect((await engine.recognizePage({ imagePath: fixture, dpi: 150, lang: 'vie' })).text).toBe(
        result.text,
      )
    } finally {
      await engine.dispose()
    }
  }, 30_000)
})
