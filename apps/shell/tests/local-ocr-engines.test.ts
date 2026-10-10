import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { encodeGrayJpeg } from '../src/main/document-memory/jpeg-gray'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'
import { LocalOcrJob } from '../src/main/document-memory/local-ocr/local-ocr-job'
import { IMAGE_OCR_STATE } from '../src/main/document-memory/media/media-ocr-gate'
import {
  decodeGray,
  decodeJpegGray,
  decodePngGray,
  encodeGrayPng,
  flattenIllumination,
  limitLongEdge,
  type GrayImage,
} from '../src/main/document-memory/local-ocr/gray-image'
import {
  RAPIDOCR_DESCRIPTOR,
  RAPIDOCR_MEASUREMENTS,
} from '../src/main/document-memory/local-ocr/rapidocr-descriptor'
import {
  LocalOcrEngineRegistry,
  engineChain,
  listEngineDescriptors,
} from '../src/main/document-memory/local-ocr/registry'
import { findTessdataDir, findVisionHelper } from '../src/main/document-memory/local-ocr/resources'
import {
  TesseractEngine,
  parseTsvWords,
} from '../src/main/document-memory/local-ocr/tesseract-engine'
import {
  AppleVisionEngine,
  parseHelperOutput,
} from '../src/main/document-memory/local-ocr/vision-engine'
import { shouldEscalate } from '../src/main/document-memory/local-ocr/escalation'
import type { LocalOcrEngine } from '../src/main/document-memory/runtime/local-ocr-engine'

const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'ocr', 'invoice-synth.png'))

function fakeEngine(
  id: string,
  minFreeRamMB: number,
  platforms: NodeJS.Platform[] | 'all',
): LocalOcrEngine {
  return {
    id,
    descriptor: {
      id,
      name: id,
      platforms,
      minFreeRamMB,
      dpi: 100,
      escalationThreshold: 0.5,
      license: 'test',
      available: true,
      notes: '',
    },
    isAvailable: (platform, ram) =>
      (platforms === 'all' || platforms.includes(platform)) && ram >= minFreeRamMB,
    recognizePage: async () => ({ text: '', meanConfidence: 0, ms: 0 }),
    dispose: async () => undefined,
  }
}

describe('gray image helpers', () => {
  const pattern = (w: number, h: number): GrayImage => {
    const data = new Uint8Array(w * h)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        data[y * w + x] = (x * 3 + y * 2 + ((x >> 3) ^ (y >> 3)) * 9) & 255
    return { width: w, height: h, data }
  }

  it('PNG round trip is exact', () => {
    const image = pattern(61, 47) // not a multiple of 8
    const back = decodePngGray(encodeGrayPng(image))!
    expect(back.width).toBe(61)
    expect(Array.from(back.data)).toEqual(Array.from(image.data))
  })

  it("decodes the app's own baseline gray JPEGs (odd sizes included) close to the source", () => {
    for (const [w, h] of [
      [64, 64],
      [75, 51],
      [640, 480],
    ] as const) {
      const smooth = new Uint8Array(w * h)
      for (let i = 0; i < smooth.length; i++) smooth[i] = 40 + ((i % w) * 170) / w // gradient survives JPEG
      const decoded = decodeJpegGray(encodeGrayJpeg(smooth, w, h, 90))!
      expect([decoded.width, decoded.height]).toEqual([w, h])
      let diff = 0
      for (let i = 0; i < smooth.length; i++) diff += Math.abs(decoded.data[i]! - smooth[i]!)
      expect(diff / smooth.length).toBeLessThan(3)
    }
  })

  it('returns null (caller passes the bytes through) for anything it cannot handle', () => {
    expect(decodeGray(new Uint8Array([1, 2, 3, 4]))).toBeNull()
    expect(
      decodeJpegGray(new Uint8Array([0xff, 0xd8, 0xff, 0xc2, 0, 8, 8, 0, 8, 0, 8, 1])),
    ).toBeNull() // progressive
    expect(decodeJpegGray(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull()
    expect(decodePngGray(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull()
    const jpeg = encodeGrayJpeg(new Uint8Array(64 * 64).fill(128), 64, 64, 80)
    expect(decodeJpegGray(jpeg.subarray(0, jpeg.length >> 1))).toBeNull() // truncated scan
  })

  it('limitLongEdge only shrinks', () => {
    const image = pattern(300, 200)
    expect(limitLongEdge(image, 400)).toBe(image)
    const small = limitLongEdge(image, 150)
    expect([small.width, small.height]).toEqual([150, 100])
  })

  it('flattenIllumination removes a tinted, shaded background and keeps the ink dark', () => {
    const w = 400
    const h = 300
    const data = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = 150 + (x * 90) / w // shaded paper 150..240
    for (let y = 100; y < 104; y++) for (let x = 40; x < 360; x++) data[y * w + x] = 40 // a text-like stroke
    const flat = flattenIllumination({ width: w, height: h, data }, 150)
    const paper = [flat.data[20 * w + 10]!, flat.data[20 * w + 390]!, flat.data[250 * w + 200]!]
    for (const value of paper) expect(value).toBeGreaterThan(215)
    expect(Math.abs(paper[0]! - paper[1]!)).toBeLessThan(25) // the gradient is gone
    expect(flat.data[102 * w + 200]!).toBeLessThan(110) // ink survives
  })
})

describe('Tesseract engine (real tesseract.js WASM + the bundled vie model)', () => {
  it('has its model bundled and is refused when free RAM is below the measured need', () => {
    expect(findTessdataDir()).not.toBeNull()
    const engine = new TesseractEngine()
    expect(engine.isAvailable('win32', 4096)).toBe(true)
    expect(engine.isAvailable('linux', engine.descriptor.minFreeRamMB - 1)).toBe(false)
    expect(new TesseractEngine({ langPath: null }).isAvailable('linux', 99999)).toBe(false)
  })

  it('reads the synthetic Vietnamese invoice (PNG and a baseline-JPEG copy)', async () => {
    const engine = new TesseractEngine()
    try {
      const png = await engine.recognizePage({ bytes: FIXTURE, dpi: 150, lang: 'vie' })
      expect(png.text).toMatch(/HÓA ĐƠN GIÁ TRỊ GIA TĂNG/)
      expect(png.text).toMatch(/0433/)
      expect(png.text).toMatch(/Viettel/)
      expect(png.meanConfidence).toBeGreaterThan(0.8)
      expect(png.tokens!.length).toBeGreaterThan(30)
      expect(png.ms).toBeGreaterThan(0)

      const gray = decodePngGray(FIXTURE)!
      const jpeg = encodeGrayJpeg(gray.data, gray.width, gray.height, 82)
      const fromJpeg = await engine.recognizePage({ bytes: jpeg, dpi: 137, lang: 'vie' })
      expect(fromJpeg.text).toMatch(/Công ty TNHH Viettel/)
      expect(fromJpeg.text).toMatch(/0433/)
      // good pages stay local (the number's word confidence decides, so only check the score path)
      expect(shouldEscalate(fromJpeg, engine.id).score.S).toBeGreaterThan(0.5)
    } finally {
      await engine.dispose()
    }
  }, 60_000)

  it('serialises concurrent calls and starts a fresh worker after dispose', async () => {
    const engine = new TesseractEngine()
    try {
      const [a, b] = await Promise.all([
        engine.recognizePage({ bytes: FIXTURE, dpi: 150, lang: 'vie' }),
        engine.recognizePage({ bytes: FIXTURE, dpi: 150, lang: 'vie' }),
      ])
      expect(a.text).toBe(b.text)
      await engine.dispose()
      expect((await engine.recognizePage({ bytes: FIXTURE, dpi: 150, lang: 'vie' })).text).toBe(
        a.text,
      )
    } finally {
      await engine.dispose()
    }
  }, 60_000)

  it('parses word rows of the TSV output only', () => {
    const tsv = [
      'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
      '4\t1\t1\t1\t1\t0\t0\t0\t10\t10\t-1\t',
      '5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t93.5\tHÓA',
      '5\t1\t1\t1\t1\t2\t0\t0\t10\t10\t-1\t',
      '5\t1\t1\t1\t1\t3\t0\t0\t10\t10\t40\t0433',
    ].join('\n')
    expect(parseTsvWords(tsv)).toEqual([
      { text: 'HÓA', confidence: 0.935 },
      { text: '0433', confidence: 0.4 },
    ])
  })
})

describe.runIf(process.platform === 'darwin' && findVisionHelper() !== null)(
  'Apple Vision engine (real helper)',
  () => {
    it('reads diacritics at the accurate level and is refused below its RAM figure', async () => {
      const engine = new AppleVisionEngine()
      expect(engine.isAvailable('darwin', 4096)).toBe(true)
      expect(engine.isAvailable('darwin', engine.descriptor.minFreeRamMB - 1)).toBe(false)
      expect(engine.isAvailable('win32', 99999)).toBe(false)
      const result = await engine.recognizePage({ bytes: FIXTURE, dpi: 100, lang: 'vie' })
      expect(result.text).toMatch(/HÓA ĐƠN GIÁ TRỊ GIA TĂNG/)
      expect(result.text).toMatch(/Số: 0433/)
      expect(result.text).toMatch(/Tiền Giang/)
      expect(shouldEscalate(result, engine.id)).toMatchObject({ escalate: false })
      await engine.dispose()
    }, 30_000)

    it('fails cleanly on bytes that are not an image', async () => {
      const engine = new AppleVisionEngine()
      await expect(
        engine.recognizePage({ bytes: new Uint8Array([1, 2, 3]), dpi: 100, lang: 'vie' }),
      ).rejects.toThrow()
    }, 30_000)
  },
)

describe('Vision helper output parsing', () => {
  it('builds text, tokens and a character-weighted confidence', () => {
    const out = parseHelperOutput(
      JSON.stringify({
        lines: [{ t: 'Hóa đơn', c: 1, b: [0, 0, 1, 1] }, { t: 'xx', c: 0 }, { t: '  ' }, { c: 1 }],
        paper: 0.9,
      }),
    )
    expect(out.text).toBe('Hóa đơn\nxx')
    expect(out.meanConfidence).toBeCloseTo(7 / 9, 5)
    expect(out.tokens).toHaveLength(2)
    expect(() => parseHelperOutput('not json')).toThrow()
  })
})

describe('engine selection: tier-aware, RAM-guarded', () => {
  const factories = () => ({
    'apple-vision': () => fakeEngine('apple-vision', 550, ['darwin']),
    'tesseract-vie': () => fakeEngine('tesseract-vie', 300, 'all'),
  })

  it('macOS tries Vision then Tesseract; everything else gets Tesseract only', () => {
    expect(engineChain('darwin')).toEqual(['apple-vision', 'tesseract-vie'])
    expect(engineChain('win32')).toEqual(['tesseract-vie'])
    expect(engineChain('linux')).toEqual(['tesseract-vie'])
    // an explicit choice goes first, but Vision cannot be forced onto a machine without it
    expect(engineChain('darwin', 'tesseract-vie')).toEqual(['tesseract-vie', 'apple-vision'])
    expect(engineChain('win32', 'apple-vision')).toEqual(['tesseract-vie'])
  })

  it('picks by platform', () => {
    const mac = new LocalOcrEngineRegistry({
      platform: 'darwin',
      freeRamMB: () => 8000,
      factories: factories(),
    })
    expect(mac.select()!.engine.id).toBe('apple-vision')
    const win = new LocalOcrEngineRegistry({
      platform: 'win32',
      freeRamMB: () => 8000,
      factories: factories(),
    })
    expect(win.select()!.engine.id).toBe('tesseract-vie')
    expect(win.select()!.skipped).toEqual([]) // Vision is not even in the chain there
  })

  it('never starts an engine when free RAM is below its measured need; falls back, then refuses', () => {
    let free = 8000
    const registry = new LocalOcrEngineRegistry({
      platform: 'darwin',
      freeRamMB: () => free,
      factories: factories(),
    })
    expect(registry.select()!.engine.id).toBe('apple-vision')
    free = 400 // Vision needs ~550 MB, Tesseract ~300
    const fallback = registry.select()!
    expect(fallback.engine.id).toBe('tesseract-vie')
    expect(fallback.skipped).toEqual([{ id: 'apple-vision', reason: 'low-ram' }])
    free = 250
    expect(registry.select()).toBeNull()
  })

  it('the real registry refuses everything at 100 MB and RapidOCR is never selectable', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(new LocalOcrEngineRegistry({ platform, freeRamMB: () => 100 }).select()).toBeNull()
      expect(engineChain(platform)).not.toContain(RAPIDOCR_DESCRIPTOR.id)
    }
    expect(RAPIDOCR_DESCRIPTOR.available).toBe(false)
    expect(RAPIDOCR_MEASUREMENTS.weightBytes).toBe(1_829_618 + 4_489_813)
    expect(listEngineDescriptors().map((d) => [d.id, d.available])).toEqual([
      ['apple-vision', true],
      ['tesseract-vie', true],
      ['rapidocr-ppocrv6-tiny', false],
    ])
  })

  it('disposeAll disposes every engine that was created', async () => {
    let disposed = 0
    const registry = new LocalOcrEngineRegistry({
      platform: 'linux',
      freeRamMB: () => 8000,
      factories: {
        'tesseract-vie': () => ({
          ...fakeEngine('tesseract-vie', 300, 'all'),
          dispose: async () => void disposed++,
        }),
      },
    })
    registry.select()
    await registry.disposeAll()
    expect(disposed).toBe(1)
  })
})

describe('OCR crash prevention and error handling (JOB OCR-WIN-01)', () => {
  it('OCR-CRASH-01: A genuinely invalid image triggers a rejected OCR operation but does not terminate the host process', () => {
    const tsxCli = join(__dirname, '../../../node_modules/tsx/dist/cli.mjs')
    const enginePath = join(
      __dirname,
      '../src/main/document-memory/local-ocr/tesseract-engine',
    ).replace(/\\/g, '/')
    const childCode = `
      import { TesseractEngine } from '${enginePath}';
      async function run() {
        const engine = new TesseractEngine();
        try {
          await engine.recognizePage({ bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), dpi: 150, lang: 'vie' });
          process.exit(2);
        } catch (err) {
          await engine.dispose();
          process.stdout.write('REJECTION_CAUGHT:' + (err?.message || err));
          process.exit(0);
        }
      }
      run();
    `
    const res = spawnSync(process.execPath, [tsxCli, '-e', childCode], {
      encoding: 'utf-8',
      timeout: 30_000,
    })
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('REJECTION_CAUGHT:')
    expect(res.stderr).not.toContain('Uncaught Exception')
    expect(res.stderr).not.toContain('throw err')
  }, 35_000)

  it('OCR-CRASH-02: The injected Tesseract module receives an errorHandler function', async () => {
    let capturedOptions: Record<string, unknown> | null = null
    const fakeWorker = {
      setParameters: async () => {},
      recognize: async () => ({ data: { text: 'ok', tsv: '' } }),
      terminate: async () => {},
    }
    const engine = new TesseractEngine({
      langPath: '/mock/lang',
      loadModule: async () => ({
        createWorker: async (_langs, _oem, options) => {
          capturedOptions = options
          return fakeWorker
        },
      }),
    })
    await engine.recognizePage({ bytes: new Uint8Array([1, 2, 3]), dpi: 150, lang: 'vie' })
    expect(capturedOptions).not.toBeNull()
    expect(typeof capturedOptions!.errorHandler).toBe('function')
    await engine.dispose()
  })

  it('OCR-CRASH-03: Invoking errorHandler does not synchronously throw', async () => {
    let capturedHandler: ((err: unknown) => void) | null = null
    const fakeWorker = {
      setParameters: async () => {},
      recognize: async () => ({ data: { text: 'ok', tsv: '' } }),
      terminate: async () => {},
    }
    const engine = new TesseractEngine({
      langPath: '/mock/lang',
      loadModule: async () => ({
        createWorker: async (_langs, _oem, options) => {
          capturedHandler = options.errorHandler as (err: unknown) => void
          return fakeWorker
        },
      }),
    })
    await engine.recognizePage({ bytes: new Uint8Array([1, 2, 3]), dpi: 150, lang: 'vie' })
    expect(capturedHandler).not.toBeNull()
    expect(() => capturedHandler!(new Error('Error attempting to read image.'))).not.toThrow()
    expect(() => capturedHandler!('Error attempting to read image.')).not.toThrow()
    expect(() => capturedHandler!(null)).not.toThrow()
    expect(() => capturedHandler!(undefined)).not.toThrow()
    expect(() => capturedHandler!({ custom: 'error' })).not.toThrow()
    await engine.dispose()
  })

  it('OCR-CRASH-04: An OCR worker rejection is propagated as a failed operation and not changed to success', async () => {
    const fakeWorker = {
      setParameters: async () => {},
      recognize: async () => {
        throw new Error('Error attempting to read image.')
      },
      terminate: async () => {},
    }
    const engine = new TesseractEngine({
      langPath: '/mock/lang',
      loadModule: async () => ({
        createWorker: async () => fakeWorker,
      }),
    })
    await expect(
      engine.recognizePage({ bytes: new Uint8Array([1, 2, 3]), dpi: 150, lang: 'vie' }),
    ).rejects.toThrow('Error attempting to read image.')
    await engine.dispose()
  })

  it('OCR-CRASH-05: A valid Vietnamese PNG is recognized after a previous invalid image', async () => {
    const engine = new TesseractEngine()
    try {
      await expect(
        engine.recognizePage({
          bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
          dpi: 150,
          lang: 'vie',
        }),
      ).rejects.toThrow()

      const res = await engine.recognizePage({ bytes: FIXTURE, dpi: 150, lang: 'vie' })
      expect(res.text).toMatch(/HÓA ĐƠN GIÁ TRỊ GIA TĂNG/)
      expect(res.text).toMatch(/0433/)
      expect(res.meanConfidence).toBeGreaterThan(0.8)
    } finally {
      await engine.dispose()
    }
  }, 60_000)

  it('OCR-CRASH-06: A valid JPEG continues to work', async () => {
    const engine = new TesseractEngine()
    try {
      const gray = decodePngGray(FIXTURE)!
      const jpeg = encodeGrayJpeg(gray.data, gray.width, gray.height, 82)
      const res = await engine.recognizePage({ bytes: jpeg, dpi: 150, lang: 'vie' })
      expect(res.text).toMatch(/Công ty TNHH Viettel/)
      expect(res.text).toMatch(/0433/)
      expect(res.meanConfidence).toBeGreaterThan(0.7)
    } finally {
      await engine.dispose()
    }
  }, 60_000)

  it('OCR-CRASH-07: Multiple sequential OCR failures do not leak workers or leave the engine unusable', async () => {
    const engine = new TesseractEngine()
    try {
      const invalidInputs = [
        new Uint8Array([]),
        new Uint8Array([1, 2, 3]),
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00]),
        new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
      ]
      for (const input of invalidInputs) {
        await expect(
          engine.recognizePage({ bytes: input, dpi: 150, lang: 'vie' }),
        ).rejects.toThrow()
      }

      const res = await engine.recognizePage({ bytes: FIXTURE, dpi: 150, lang: 'vie' })
      expect(res.text).toMatch(/HÓA ĐƠN GIÁ TRỊ GIA TĂNG/)
      expect(res.text).toMatch(/0433/)
    } finally {
      await engine.dispose()
    }
  }, 60_000)

  it('OCR-CRASH-08: A worker initialization failure is bounded and does not leave createWorker() pending forever', async () => {
    // 1. errorHandler during init rejects immediately without hanging
    const failEngine = new TesseractEngine({
      langPath: '/mock/lang',
      initTimeoutMs: 1000,
      loadModule: async () => ({
        createWorker: async (_langs, _oem, options) => {
          setTimeout(() => {
            const handler = options.errorHandler as ((e: unknown) => void) | undefined
            handler?.(new Error('Init error: corrupted traineddata'))
          }, 10)
          return new Promise(() => {}) // never resolves
        },
      }),
    })
    await expect(
      failEngine.recognizePage({ bytes: FIXTURE, dpi: 150, lang: 'vie' }),
    ).rejects.toThrow(/Init error: corrupted traineddata/)
    await failEngine.dispose()

    // 2. Unresponsive createWorker is bounded by initTimeoutMs
    const hangingEngine = new TesseractEngine({
      langPath: '/mock/lang',
      initTimeoutMs: 150,
      loadModule: async () => ({
        createWorker: async () => new Promise(() => {}), // hangs forever
      }),
    })
    await expect(
      hangingEngine.recognizePage({ bytes: FIXTURE, dpi: 150, lang: 'vie' }),
    ).rejects.toThrow(/Tesseract worker initialization timed out/)
    await hangingEngine.dispose()
  })

  it('OCR-CRASH-09: Existing cancellation, shutdown and disposal behavior remains correct', async () => {
    let terminateCalls = 0
    const fakeWorker = {
      setParameters: async () => {},
      recognize: async () =>
        new Promise((resolve) => setTimeout(() => resolve({ data: { text: 'ok', tsv: '' } }), 200)),
      terminate: async () => {
        terminateCalls++
      },
    }
    const engine = new TesseractEngine({
      langPath: '/mock/lang',
      loadModule: async () => ({
        createWorker: async () => fakeWorker,
      }),
    })

    // Timeout triggers disposal of worker
    await expect(
      engine.recognizePage({
        bytes: new Uint8Array([1, 2, 3]),
        dpi: 150,
        lang: 'vie',
        timeoutMs: 50,
      }),
    ).rejects.toThrow('Tesseract timed out')
    expect(terminateCalls).toBe(1)

    // Dispose is idempotent and safe
    await engine.dispose()
    await engine.dispose()
    expect(terminateCalls).toBe(1)
  })

  it('OCR-CRASH-10: Per-file OCR errors are recorded without crashing the full Local OCR run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocr-crash10-'))
    const store = new DocumentMemoryStore(join(dir, 'test.sqlite'))
    store.ensureEmbeddingSpace(EMBEDDING_PROFILES.standard)

    try {
      const img1 = join(dir, 'receipt1.png')
      const img2 = join(dir, 'receipt2.png')
      writeFileSync(img1, FIXTURE)
      writeFileSync(img2, FIXTURE)

      const st1 = statSync(img1)
      const st2 = statSync(img2)
      store.enrollMedia(img1, st1.mtimeMs, st1.size)
      store.enrollMedia(img2, st2.mtimeMs, st2.size)

      let engineCalls = 0
      const engine: LocalOcrEngine = {
        id: 'tesseract-vie',
        descriptor: {
          id: 'tesseract-vie',
          name: 'test',
          platforms: 'all',
          minFreeRamMB: 1,
          dpi: 150,
          escalationThreshold: 0.5,
          license: 'test',
          available: true,
          notes: '',
        },
        isAvailable: () => true,
        recognizePage: async () => {
          engineCalls++
          if (engineCalls === 1) throw new Error('Error attempting to read image.')
          return { text: 'Recognized OK', meanConfidence: 0.9, ms: 5 }
        },
        dispose: async () => {},
      }

      const registry = new LocalOcrEngineRegistry({
        platform: 'darwin',
        freeRamMB: () => 8000,
        factories: { 'tesseract-vie': () => engine },
      })

      const job = new LocalOcrJob({
        db: store.rawDb,
        settings: () => ({ enabled: true, lightPages: 2, engine: 'tesseract-vie' }),
        registry,
        gate: () => ({ ok: true }),
        render: async () => null,
        savePages: async (_p, _m, _pg) => ({ ok: true }),
        reindex: () => {},
        coolDown: async () => {},
      })

      const summary = await job.runOnce()
      expect(summary.files).toBe(2)
      expect(summary.failed).toBe(1)
      expect(summary.pages).toBe(1)

      const states = Object.fromEntries(
        (
          store.rawDb
            .prepare(
              'SELECT d.path AS path, m.ocr_state AS state FROM document_media m JOIN documents d ON d.id = m.document_id',
            )
            .all() as unknown as Array<{ path: string; state: number }>
        ).map((r) => [r.path, r.state]),
      )

      expect(states[img1]).toBe(IMAGE_OCR_STATE.failed)
      expect(states[img2]).toBe(IMAGE_OCR_STATE.done)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Tesseract worker lifecycle and bounded initialization (JOB OCR2-04)', () => {
  it('Condition 2: createWorker() resolving after initialization timeout is terminated immediately', async () => {
    let terminateCalls = 0
    let resolveWorker: (w: any) => void
    const workerPromise = new Promise((resolve) => {
      resolveWorker = resolve
    })
    const fakeWorker = {
      setParameters: async () => {},
      recognize: async () => ({ data: { text: 'ok', tsv: '' } }),
      terminate: async () => {
        terminateCalls++
      },
    }

    const engine = new TesseractEngine({
      langPath: '/mock/lang',
      initTimeoutMs: 40,
      loadModule: async () => ({
        createWorker: async () => workerPromise as any,
      }),
    })

    await expect(
      engine.recognizePage({ bytes: new Uint8Array([1, 2, 3]), dpi: 150, lang: 'vie' }),
    ).rejects.toThrow('Tesseract worker initialization timed out')

    expect(terminateCalls).toBe(0)
    // Worker resolves late after timeout has already rejected
    resolveWorker!(fakeWorker)
    // Allow microtasks to run
    await new Promise((r) => setTimeout(r, 20))
    expect(terminateCalls).toBe(1)
    await engine.dispose()
  })

  it('Condition 4 & 5: setParameters() rejection or hang is bounded and terminates worker', async () => {
    let terminateCalls = 0
    const hangingWorker = {
      setParameters: () => new Promise(() => {}), // never resolves
      recognize: async () => ({ data: { text: 'ok', tsv: '' } }),
      terminate: async () => {
        terminateCalls++
      },
    }

    const engine = new TesseractEngine({
      langPath: '/mock/lang',
      initTimeoutMs: 50,
      loadModule: async () => ({
        createWorker: async () => hangingWorker as any,
      }),
    })

    await expect(
      engine.recognizePage({ bytes: new Uint8Array([1, 2, 3]), dpi: 150, lang: 'vie' }),
    ).rejects.toThrow('Tesseract worker initialization timed out')

    expect(terminateCalls).toBe(1)
    await engine.dispose()
  })

  it('Condition 6: dispose() during in-flight initialization terminates worker when created', async () => {
    let terminateCalls = 0
    let resolveWorker: (w: any) => void
    const workerPromise = new Promise((resolve) => {
      resolveWorker = resolve
    })
    const fakeWorker = {
      setParameters: async () => {},
      recognize: async () => ({ data: { text: 'ok', tsv: '' } }),
      terminate: async () => {
        terminateCalls++
      },
    }

    let createWorkerCalled = false
    const engine = new TesseractEngine({
      langPath: '/mock/lang',
      initTimeoutMs: 5000,
      loadModule: async () => ({
        createWorker: async () => {
          createWorkerCalled = true
          return workerPromise as any
        },
      }),
    })

    const runPromise = engine.recognizePage({ bytes: new Uint8Array([1, 2, 3]), dpi: 150, lang: 'vie' })
    while (!createWorkerCalled) await new Promise((r) => setTimeout(r, 5))
    // dispose while initialization is still pending
    await engine.dispose()
    // Worker resolves after dispose
    resolveWorker!(fakeWorker)
    await expect(runPromise).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 20))
    expect(terminateCalls).toBeGreaterThanOrEqual(1)
  })

  it('Condition 10: multiple rapid initialization failures reset state cleanly without leaked workers', async () => {
    let attempts = 0
    let terminateCalls = 0
    const workingWorker = {
      setParameters: async () => {},
      recognize: async () => ({ data: { text: 'success', tsv: '' } }),
      terminate: async () => {
        terminateCalls++
      },
    }

    const engine = new TesseractEngine({
      langPath: '/mock/lang',
      initTimeoutMs: 100,
      loadModule: async () => ({
        createWorker: async () => {
          attempts++
          if (attempts <= 2) {
            throw new Error(`Init failed attempt ${attempts}`)
          }
          return workingWorker as any
        },
      }),
    })

    await expect(
      engine.recognizePage({ bytes: new Uint8Array([1, 2, 3]), dpi: 150, lang: 'vie' }),
    ).rejects.toThrow('Init failed attempt 1')

    await expect(
      engine.recognizePage({ bytes: new Uint8Array([1, 2, 3]), dpi: 150, lang: 'vie' }),
    ).rejects.toThrow('Init failed attempt 2')

    // 3rd attempt succeeds cleanly
    const result = await engine.recognizePage({ bytes: new Uint8Array([1, 2, 3]), dpi: 150, lang: 'vie' })
    expect(result.text).toBe('success')

    await engine.dispose()
    expect(terminateCalls).toBe(1)
  })
})
