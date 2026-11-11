/** Page-mode port of TrueOCR 0.1.1 (https://github.com/pvd0anh/trueocr, Apache-2.0).
 * Owns all four lazy CPU sessions. In the app this module runs only in the index worker.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as Ort from 'onnxruntime-node'
import type { LocalOcrRecognition, LocalOcrRecognizeInput } from '../runtime/local-ocr-engine'
import {
  cropBox,
  decodeTrueOcrImage,
  estimateSkew,
  inkInput,
  median,
  prepareLine,
  quarterTurn,
  rotatePage,
} from './trueocr-image'
import {
  decodeBlocksOrder,
  decodeCtc,
  decodeLines,
  lineFeatures,
  widthBatches,
  type LineBox,
} from './trueocr-decode'

interface Meta {
  charset: string[]
  max_width: number
  pad_y: number
  pad_x: number
  det_long_side: number
}
interface Models {
  ort: typeof Ort
  meta: Meta
  det: Ort.InferenceSession
  rec: Ort.InferenceSession
  orient: Ort.InferenceSession
  order: Ort.InferenceSession
}

export class TrueOcrPipeline {
  private models: Promise<Models> | null = null
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly modelDir: string) {}

  private load(): Promise<Models> {
    if (!this.models) {
      const loading = (async () => {
        const ort = Ort
        const meta = JSON.parse(await readFile(join(this.modelDir, 'meta.json'), 'utf8')) as Meta
        if (
          !Array.isArray(meta.charset) ||
          !meta.charset.every((c) => typeof c === 'string') ||
          meta.max_width !== 768 ||
          meta.det_long_side !== 1024
        )
          throw new Error('Unsupported TrueOCR metadata')
        const sessions: Ort.InferenceSession[] = []
        try {
          for (const name of ['det', 'rec', 'orient', 'order'])
            sessions.push(
              await ort.InferenceSession.create(join(this.modelDir, `${name}.onnx`), {
                executionProviders: ['cpu'],
                intraOpNumThreads: 1,
                interOpNumThreads: 1,
                enableCpuMemArena: false,
                graphOptimizationLevel: 'all',
              }),
            )
          return {
            ort,
            meta,
            det: sessions[0]!,
            rec: sessions[1]!,
            orient: sessions[2]!,
            order: sessions[3]!,
          }
        } catch (error) {
          await Promise.all(sessions.map((s) => s.release()))
          throw error
        }
      })()
      this.models = loading
      void loading.catch(() => {
        if (this.models === loading) this.models = null
      })
    }
    return this.models
  }

  recognizePage(input: LocalOcrRecognizeInput): Promise<LocalOcrRecognition> {
    const run = this.chain.then(() => this.recognizeNow(input))
    this.chain = run.catch(() => undefined)
    return run
  }

  private async recognizeNow(input: LocalOcrRecognizeInput): Promise<LocalOcrRecognition> {
    const bytes = input.bytes ?? (input.imagePath ? await readFile(input.imagePath) : null)
    if (!bytes) throw new Error('recognizePage needs bytes or imagePath')
    const started = performance.now()
    const m = await this.load()
    let image = decodeTrueOcrImage(bytes)
    if (!image)
      throw new Error('TrueOCR unsupported image encoding (requires baseline JPEG or 8-bit PNG)')
    const deadline = started + (input.timeoutMs ?? 90_000)
    const check = () => {
      if (performance.now() > deadline) throw new Error('TrueOCR timed out')
    }
    let angle = estimateSkew(image)
    const orientationImage = Math.abs(angle) >= 0.3 ? rotatePage(image, angle) : image
    const oi = inkInput(orientationImage, 768, 768)
    const orientation = (
      await m.orient.run({ x: new m.ort.Tensor('float32', oi.data, [1, 1, 768, 768]) })
    ).p!
    let k = 0
    for (let i = 1; i < orientation.data.length; i++)
      if (Number(orientation.data[i]) > Number(orientation.data[k])) k = i
    if (Number(orientation.data[k]) <= 0.95) k = 0
    if (k) image = quarterTurn(image, k === 4 ? -1 : k)
    if (k === 1 || k === 3 || k === 4) angle = estimateSkew(image)
    if (Math.abs(angle) >= 0.3) image = rotatePage(image, angle)
    check()
    const detect = async (longSide: number) => {
      const x = inkInput(image!, longSide, 32)
      const out = (
        await m.det.run({ x: new m.ort.Tensor('float32', x.data, [1, 1, x.height, x.width]) })
      ).out!
      return {
        boxes: decodeLines(out.data as Float32Array, out.dims[2]!, out.dims[3]!),
        scale: x.scale,
      }
    }
    let detection = await detect(m.meta.det_long_side)
    if (detection.boxes.length >= 8) {
      const h = median(detection.boxes.map((b) => b[3] - b[1]))
      if (h < 9) {
        const side =
          Math.floor(Math.min(2048, (m.meta.det_long_side * 12) / Math.max(h, 1)) / 32) * 32
        if (side > m.meta.det_long_side) detection = await detect(side)
      }
    }
    const boxes: LineBox[] = []
    for (const box of detection.boxes) {
      const b: LineBox = [
        Math.max(0, Math.floor(Math.fround(box[0] / detection.scale))),
        Math.max(0, Math.floor(Math.fround(box[1] / detection.scale))),
        Math.min(image.width, Math.ceil(Math.fround(box[2] / detection.scale))),
        Math.min(image.height, Math.ceil(Math.fround(box[3] / detection.scale))),
        box[4],
      ]
      if (b[2] > b[0] && b[3] > b[1]) boxes.push(b)
    }
    // Bound pathological detector output before the quadratic order model allocates its tensors.
    if (boxes.length > 2048) throw new Error('TrueOCR detected too many lines')
    const lines = boxes.map((b) =>
      prepareLine(cropBox(image!, b), m.meta.max_width, m.meta.pad_y, m.meta.pad_x),
    )
    const predictions: Array<{ text: string; confidence: number }> = new Array(lines.length)
    for (const batch of widthBatches(lines.map((l) => l.width))) {
      check()
      const width = Math.ceil(Math.max(...batch.map((i) => lines[i]!.width)) / 8) * 8 + 8
      const data = new Float32Array(batch.length * 96 * width)
      const widths = new BigInt64Array(batch.length)
      batch.forEach((i, j) => {
        const line = lines[i]!
        widths[j] = BigInt(line.width)
        for (let y = 0; y < 96; y++)
          data.set(line.data.subarray(y * line.width, (y + 1) * line.width), (j * 96 + y) * width)
      })
      const out = await m.rec.run({
        x: new m.ort.Tensor('float32', data, [batch.length, 1, 96, width]),
        widths: new m.ort.Tensor('int64', widths, [batch.length]),
      })
      const ids = out.ids!.data as BigInt64Array,
        conf = out.conf!.data as Float32Array,
        lengths = out.lengths!.data as BigInt64Array
      const steps = out.ids!.dims[1]!
      batch.forEach((i, j) => {
        predictions[i] = decodeCtc(
          ids.subarray(j * steps, (j + 1) * steps),
          conf.subarray(j * steps, (j + 1) * steps),
          Number(lengths[j]),
          m.meta.charset,
        )
      })
    }
    let order = boxes.map((_, i) => i)
    if (boxes.length >= 2) {
      const feats = lineFeatures(
        boxes,
        predictions.map((p) => p.text),
        image.width,
        image.height,
      )
      const out = await m.order.run(
        {
          feats: new m.ort.Tensor('float32', feats, [1, boxes.length, 16]),
          mask: new m.ort.Tensor('bool', new Uint8Array(boxes.length).fill(1), [1, boxes.length]),
        },
        ['a', 'cls', 'same'],
      )
      order = decodeBlocksOrder(
        out.a!.data as Float32Array,
        out.same!.data as Float32Array,
        boxes,
        out.cls!.data as Float32Array,
        out.cls!.dims[2]!,
      )
    }
    check()
    const tokens = order.map((i) => predictions[i]!)
    let sum = 0,
      weight = 0
    for (const line of tokens) {
      sum += line.text.length * line.confidence
      weight += line.text.length
    }
    return {
      text: tokens.map((p) => p.text).join('\n'),
      tokens,
      meanConfidence: weight ? sum / weight : 0,
      ms: Math.round(performance.now() - started),
    }
  }

  async dispose(): Promise<void> {
    // Disposal queues behind outstanding inference; no session is released while ORT is using it.
    const release = this.chain.then(async () => {
      const pending = this.models
      this.models = null
      if (pending) {
        const m = await pending.catch(() => null)
        if (m) await Promise.all([m.det, m.rec, m.orient, m.order].map((s) => s.release()))
      }
    })
    this.chain = release.catch(() => undefined)
    await release
  }
}
