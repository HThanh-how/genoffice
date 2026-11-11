import {
  LocalOcrUnavailableError,
  type LocalOcrEngine,
  type LocalOcrEngineDescriptor,
  type LocalOcrRecognition,
  type LocalOcrRecognizeInput,
} from '../runtime/local-ocr-engine'
import { TRUEOCR_ESCALATION_THRESHOLD } from './escalation'
import { findTrueOcrDir, trueOcrModelsPresent } from './resources'
import type { TrueOcrPipeline } from './trueocr-pipeline'

export const TRUEOCR_ENGINE_ID = 'trueocr-vie'
export const TRUEOCR_DESCRIPTOR: LocalOcrEngineDescriptor = {
  id: TRUEOCR_ENGINE_ID,
  name: 'TrueOCR 0.1.1 Vietnamese (ONNX, CPU)',
  platforms: 'all',
  minFreeRamMB: 400,
  dpi: 150,
  escalationThreshold: TRUEOCR_ESCALATION_THRESHOLD,
  license: 'Apache-2.0 (TrueOCR/models); MIT (onnxruntime)',
  available: true,
  notes:
    'Ryzen 7 8845H/Windows, 31 original C pages, one thread: TS 766.4 ms/page, mean peak RSS 230.0 MiB; Python reference 286.3 ms/page, 151.8 MiB. Charset limits and methodology: docs/local-ocr-trueocr.md.',
}

export interface TrueOcrEngineOptions {
  modelDir?: string | null
  /** Production injects the index worker; default is in-process for CLI/tests. */
  recognize?: (input: LocalOcrRecognizeInput) => Promise<LocalOcrRecognition>
  release?: () => Promise<void>
}

export class TrueOcrEngine implements LocalOcrEngine {
  readonly id = TRUEOCR_ENGINE_ID
  readonly descriptor = TRUEOCR_DESCRIPTOR
  private readonly modelDir: string | null
  private pipeline: Promise<TrueOcrPipeline> | null = null
  private chain: Promise<unknown> = Promise.resolve()
  constructor(private readonly options: TrueOcrEngineOptions = {}) {
    this.modelDir = options.modelDir === undefined ? findTrueOcrDir() : options.modelDir
  }
  isAvailable(_platform: NodeJS.Platform, freeRamMB: number): boolean {
    return (
      this.modelDir !== null &&
      trueOcrModelsPresent(this.modelDir) &&
      freeRamMB >= this.descriptor.minFreeRamMB
    )
  }
  recognizePage(input: LocalOcrRecognizeInput): Promise<LocalOcrRecognition> {
    const run = this.chain.then(() => this.recognizeNow(input))
    this.chain = run.catch(() => undefined)
    return run
  }

  private async recognizeNow(input: LocalOcrRecognizeInput): Promise<LocalOcrRecognition> {
    if (!this.modelDir || !trueOcrModelsPresent(this.modelDir))
      throw new LocalOcrUnavailableError(this.id, 'TrueOCR models are not bundled')
    if (this.options.recognize) return this.options.recognize(input)
    const dir = this.modelDir
    this.pipeline ??= import('./trueocr-pipeline').then(
      ({ TrueOcrPipeline }) => new TrueOcrPipeline(dir),
    )
    return (await this.pipeline).recognizePage(input)
  }
  async dispose(): Promise<void> {
    const release = this.chain.then(async () => {
      const pending = this.pipeline
      this.pipeline = null
      if (pending) await (await pending).dispose()
      await this.options.release?.()
    })
    this.chain = release.catch(() => undefined)
    await release
  }
}
