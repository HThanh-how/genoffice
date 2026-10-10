/**
 * Tesseract 5 + `vie` tessdata_fast (0.53 MB, Apache-2.0) through tesseract.js (Apache-2.0, WASM).
 *
 * Why tesseract.js and not a native binary: a native Tesseract needs per-OS builds of
 * libtesseract + leptonica + codecs (~6 MB each) that nobody ships for Windows, and Linux has no
 * system OCR at all. tesseract.js is the same C++ compiled to WebAssembly: ONE npm package that runs
 * on macOS, Windows and Linux (x64 and arm64) inside the app's own Node, with the language model
 * read from a bundled file (no download: `langPath` is local, `cacheMethod: 'none'`). It runs in a
 * worker thread, so the calling thread never blocks. The price is speed (WASM is slower than the
 * native binary the benchmark used) and ~150-250 MB RSS; the job's duty cycle absorbs the former.
 *
 * Calibrated configuration (benchmark): ~150 dpi grey, background-normalised, page segmentation
 * mode 6, one worker. Normalisation lifts invoice-number recovery from 51-76% to 80-90% on tinted,
 * stamped invoices and costs a few passes over the pixel buffer (see gray-image.ts).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  LocalOcrUnavailableError,
  type LocalOcrEngine,
  type LocalOcrEngineDescriptor,
  type LocalOcrRecognition,
  type LocalOcrRecognizeInput,
  type LocalOcrToken,
} from '../runtime/local-ocr-engine'
import { TESSERACT_ESCALATION_THRESHOLD } from './escalation'
import { prepareForTesseract, TESSERACT_MAX_EDGE_PX } from './tesseract-prepare'
import { findTessdataDir, findTesseractWorkerScript, tesseractCoresPresent } from './resources'

export const TESSERACT_ENGINE_ID = 'tesseract-vie'

export const TESSERACT_DESCRIPTOR: LocalOcrEngineDescriptor = {
  id: TESSERACT_ENGINE_ID,
  name: 'Tesseract 5 vie (tessdata_fast, WASM)',
  platforms: 'all',
  // native Tesseract measured 47-200 MB; the WASM build plus its worker thread sits near 150-250 MB
  minFreeRamMB: 300,
  dpi: 150,
  escalationThreshold: TESSERACT_ESCALATION_THRESHOLD,
  license: 'Apache-2.0 (tesseract.js, tesseract.js-core, tessdata_fast)',
  available: true,
  notes:
    'psm 6, background-normalised, one worker. Blind to wrong digits on stamped invoices: see lowConfidenceInvoiceNumber.',
}

export { TESSERACT_MAX_EDGE_PX }
const DEFAULT_TIMEOUT_MS = 90_000
const DEFAULT_INIT_TIMEOUT_MS = 30_000

/** The slice of tesseract.js this file uses. */
interface TesseractWorker {
  setParameters(params: Record<string, string>): Promise<unknown>
  recognize(
    image: Uint8Array,
    options: object,
    output: Record<string, boolean>,
  ): Promise<{ data: { text: string; tsv?: string } }>
  terminate(): Promise<unknown>
}
interface TesseractModule {
  createWorker(
    langs: string,
    oem: number,
    options: Record<string, unknown>,
  ): Promise<TesseractWorker>
}

export interface TesseractEngineOptions {
  /** directory holding vie.traineddata; undefined = look it up, null = none */
  langPath?: string | null
  /** worker thread script; undefined = the unpacked one in a packaged app, else tesseract.js's own */
  workerPath?: string | null
  /** replaces the dynamic `import('tesseract.js')` (tests) */
  loadModule?: () => Promise<TesseractModule>
  /**
   * decode / shrink / flatten off the calling thread (the app asks the index worker); a rejected or
   * missing answer sends the original image to Tesseract unprocessed. Default: in this thread.
   */
  prepare?: (bytes: Uint8Array, dpi: number) => Promise<Uint8Array | null>
  /** worker initialization timeout in milliseconds (default: 30_000) */
  initTimeoutMs?: number
}

async function loadTesseract(): Promise<TesseractModule> {
  const mod = (await import('tesseract.js')) as unknown as TesseractModule & {
    default?: TesseractModule
  }
  return typeof mod.createWorker === 'function' ? mod : (mod.default as TesseractModule)
}

export class TesseractEngine implements LocalOcrEngine {
  readonly id = TESSERACT_ENGINE_ID
  readonly descriptor = TESSERACT_DESCRIPTOR
  private readonly langPath: string | null
  private readonly workerPath: string | null
  private readonly loadModule: () => Promise<TesseractModule>
  private readonly prepare: (bytes: Uint8Array, dpi: number) => Promise<Uint8Array | null>
  private readonly initTimeoutMs: number
  private worker: Promise<TesseractWorker> | null = null
  private chain: Promise<unknown> = Promise.resolve()

  constructor(options: TesseractEngineOptions = {}) {
    this.langPath = options.langPath === undefined ? findTessdataDir() : options.langPath
    this.workerPath =
      options.workerPath === undefined ? findTesseractWorkerScript() : options.workerPath
    this.loadModule = options.loadModule ?? loadTesseract
    this.prepare = options.prepare ?? (async (bytes, dpi) => prepareForTesseract(bytes, dpi))
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS
  }

  isAvailable(_platform: NodeJS.Platform, freeRamMB: number): boolean {
    if (this.workerPath && !tesseractCoresPresent(this.workerPath)) return false
    return this.langPath !== null && freeRamMB >= this.descriptor.minFreeRamMB
  }

  recognizePage(input: LocalOcrRecognizeInput): Promise<LocalOcrRecognition> {
    // exactly one recognition at a time (a second WASM instance costs another ~150 MB)
    const run = this.chain.then(() => this.recognizeNow(input))
    this.chain = run.catch(() => undefined)
    return run
  }

  private async getWorker(): Promise<TesseractWorker> {
    if (!this.langPath)
      throw new LocalOcrUnavailableError(this.id, 'the vie language model is not bundled')
    const langPath = this.langPath
    this.worker ??= (async () => {
      const { createWorker } = await this.loadModule()

      let initReject: ((reason: unknown) => void) | null = null
      const initErrorPromise = new Promise<never>((_, reject) => {
        initReject = reject
      })

      let initTimer: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<never>((_, reject) => {
        initTimer = setTimeout(() => {
          reject(new Error('Tesseract worker initialization timed out'))
        }, this.initTimeoutMs)
      })

      let worker: TesseractWorker | null = null
      try {
        const createWorkerPromise = createWorker('vie', 1 /* LSTM only */, {
          langPath,
          ...(this.workerPath ? { workerPath: this.workerPath } : {}),
          gzip: false,
          cacheMethod: 'none', // never write a copy of the model anywhere
          logger: () => undefined,
          errorHandler: (error: unknown) => {
            // The OCR job Promise owns failure propagation.
            // Never throw from Tesseract's asynchronous message listener.
            // During initialization, Tesseract.js 7.0.0 may swallow errors and leave createWorker pending forever;
            // rejecting here ensures initialization fails promptly.
            if (initReject) {
              const rejectFn = initReject
              initReject = null
              rejectFn(error instanceof Error ? error : new Error(String(error)))
            }
          },
        })

        worker = await Promise.race([createWorkerPromise, initErrorPromise, timeoutPromise])
        initReject = null
        clearTimeout(initTimer)

        await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' })
        return worker
      } catch (error) {
        initReject = null
        clearTimeout(initTimer)
        if (worker) {
          await worker.terminate().catch(() => undefined)
        }
        throw error
      }
    })().catch((error: unknown) => {
      this.worker = null
      throw error
    })
    return this.worker
  }

  private async recognizeNow(input: LocalOcrRecognizeInput): Promise<LocalOcrRecognition> {
    const bytes = input.bytes ?? (input.imagePath ? await readFile(input.imagePath) : null)
    if (!bytes) throw new Error('recognizePage needs bytes or imagePath')
    const started = performance.now()
    // decode -> shrink -> flatten the background (off this thread in the app); undecodable formats go in unprocessed
    const image = (await this.prepare(bytes, input.dpi || 150).catch(() => null)) ?? bytes
    const worker = await this.getWorker()
    let timer: NodeJS.Timeout | undefined
    try {
      const result = await Promise.race([
        worker.recognize(image, {}, { text: true, tsv: true }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Tesseract timed out')),
            input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          )
        }),
      ])
      const tokens = parseTsvWords(result.data.tsv ?? '')
      let weight = 0
      let sum = 0
      for (const token of tokens) {
        weight += token.text.length
        sum += token.text.length * token.confidence
      }
      return {
        text: result.data.text.trim(),
        meanConfidence: weight ? sum / weight : 0,
        tokens,
        ms: Math.round(performance.now() - started),
      }
    } catch (error) {
      // a stuck or crashed WASM worker is thrown away; the next page starts a fresh one
      if (error instanceof Error && error.message === 'Tesseract timed out') await this.dispose()
      throw error instanceof Error ? error : new Error(String(error))
    } finally {
      clearTimeout(timer)
    }
  }

  async dispose(): Promise<void> {
    const pending = this.worker
    this.worker = null
    if (!pending) return
    try {
      await (await pending).terminate()
    } catch {
      // already gone
    }
  }
}

/** Word rows (level 5) of Tesseract's TSV output -> tokens with confidence 0..1. */
export function parseTsvWords(tsv: string): LocalOcrToken[] {
  const tokens: LocalOcrToken[] = []
  for (const row of tsv.split('\n')) {
    const cols = row.split('\t')
    if (cols.length < 12 || cols[0] !== '5') continue
    const text = cols.slice(11).join('\t').trim()
    const confidence = Number(cols[10])
    if (!text || !Number.isFinite(confidence) || confidence < 0) continue
    tokens.push({ text, confidence: Math.min(1, confidence / 100) })
  }
  return tokens
}

/** Where the model is expected (for packaging checks and messages). */
export function tesseractModelFile(dir: string): string {
  return join(dir, 'vie.traineddata')
}
