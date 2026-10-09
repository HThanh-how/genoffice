/**
 * Apple Vision `accurate` through the small signed Swift helper that already ships for the PDF
 * app (packages/pdf2docx/ocr-helper/vision-ocr.swift: PNG/JPEG on stdin, JSON lines on stdout,
 * `VNRecognizeTextRequest` at `.accurate`). The `fast` level cannot read Vietnamese diacritics
 * (word recall 3-16%) and is deliberately not reachable from here.
 *
 * Measured (Apple silicon, 16 GB): 0.5 s/page wall, 0.2-0.55 GB RSS, invoice number 100%, 99-100%
 * agreement with the other engines, at 100 dpi already (the 1600 px render is fine too).
 * One helper process at a time; the process exits after every page, so no RAM stays resident.
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import {
  LocalOcrUnavailableError,
  type LocalOcrEngine,
  type LocalOcrEngineDescriptor,
  type LocalOcrRecognition,
  type LocalOcrRecognizeInput,
  type LocalOcrToken,
} from '../runtime/local-ocr-engine'
import { VISION_ESCALATION_THRESHOLD } from './escalation'
import { findVisionHelper } from './resources'

export const VISION_ENGINE_ID = 'apple-vision'

export const VISION_DESCRIPTOR: LocalOcrEngineDescriptor = {
  id: VISION_ENGINE_ID,
  name: 'Apple Vision (accurate)',
  platforms: ['darwin'],
  minFreeRamMB: 550, // measured peak RSS 0.2-0.55 GB
  dpi: 100,
  escalationThreshold: VISION_ESCALATION_THRESHOLD,
  license: 'OS API (nothing redistributed); helper is this repo (Apache-2.0)',
  available: true,
  notes: 'macOS only. Recognition level accurate; language hints vi-VT,en-US.',
}

const DEFAULT_TIMEOUT_MS = 45_000
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

interface HelperLine {
  t?: unknown
  c?: unknown
}

export interface VisionEngineOptions {
  /** absolute path of the helper binary; undefined = look it up, null = none */
  helperPath?: string | null
  /** recognition language hints; an empty list lets Vision auto-detect */
  languages?: readonly string[]
}

export class AppleVisionEngine implements LocalOcrEngine {
  readonly id = VISION_ENGINE_ID
  readonly descriptor = VISION_DESCRIPTOR
  private readonly helperPath: string | null
  private readonly languages: readonly string[]
  private useLanguages = true
  private chain: Promise<unknown> = Promise.resolve()

  constructor(options: VisionEngineOptions = {}) {
    this.helperPath = options.helperPath === undefined ? findVisionHelper() : options.helperPath
    this.languages = options.languages ?? ['vi-VT', 'en-US']
  }

  isAvailable(platform: NodeJS.Platform, freeRamMB: number): boolean {
    return platform === 'darwin' && this.helperPath !== null && freeRamMB >= this.descriptor.minFreeRamMB
  }

  recognizePage(input: LocalOcrRecognizeInput): Promise<LocalOcrRecognition> {
    // one page at a time: a second caller waits for the first helper process to exit
    const run = this.chain.then(() => this.recognizeNow(input))
    this.chain = run.catch(() => undefined)
    return run
  }

  private async recognizeNow(input: LocalOcrRecognizeInput): Promise<LocalOcrRecognition> {
    if (!this.helperPath) throw new LocalOcrUnavailableError(this.id, 'the Vision helper is not bundled')
    const bytes = input.bytes ?? (input.imagePath ? await readFile(input.imagePath) : null)
    if (!bytes) throw new Error('recognizePage needs bytes or imagePath')
    const started = performance.now()
    let output: string
    try {
      output = await this.runHelper(bytes, this.useLanguages ? this.languages : [], input.timeoutMs)
    } catch (error) {
      // an older macOS may not know vi-VT: retry once with automatic language detection
      if (this.useLanguages && this.languages.length && error instanceof HelperExit) {
        this.useLanguages = false
        output = await this.runHelper(bytes, [], input.timeoutMs)
      } else throw error
    }
    return { ...parseHelperOutput(output), ms: Math.round(performance.now() - started) }
  }

  private runHelper(bytes: Uint8Array, languages: readonly string[], timeoutMs?: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.helperPath!, languages.length ? [languages.join(',')] : [], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      })
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      const finish = (action: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        action()
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(() => reject(new Error('the Vision helper timed out')))
      }, timeoutMs ?? DEFAULT_TIMEOUT_MS)
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_OUTPUT_BYTES) {
          child.kill('SIGKILL')
          finish(() => reject(new Error('the Vision helper produced too much output')))
          return
        }
        chunks.push(chunk)
      })
      child.on('error', (error) => finish(() => reject(error)))
      child.on('close', (code) =>
        finish(() =>
          code === 0
            ? resolve(Buffer.concat(chunks).toString('utf8'))
            : reject(new HelperExit(code)),
        ),
      )
      child.stdin.on('error', () => undefined) // helper may exit before reading everything
      child.stdin.end(bytes)
    })
  }

  async dispose(): Promise<void> {
    await this.chain
  }
}

class HelperExit extends Error {
  constructor(code: number | null) {
    super(`the Vision helper exited with code ${code}`)
  }
}

/** JSON from the helper -> text + line tokens (reading order as Vision returns it). */
export function parseHelperOutput(output: string): Omit<LocalOcrRecognition, 'ms'> {
  let parsed: { lines?: HelperLine[] }
  try {
    parsed = JSON.parse(output.replace(/^\uFEFF/, '')) as { lines?: HelperLine[] }
  } catch {
    throw new Error('the Vision helper returned unreadable output')
  }
  const tokens: LocalOcrToken[] = []
  for (const line of parsed.lines ?? []) {
    if (typeof line.t !== 'string' || !line.t.trim()) continue
    const confidence = typeof line.c === 'number' && Number.isFinite(line.c) ? line.c : 0
    tokens.push({ text: line.t, confidence })
  }
  let weight = 0
  let sum = 0
  for (const token of tokens) {
    weight += token.text.length
    sum += token.text.length * token.confidence
  }
  return {
    text: tokens.map((token) => token.text).join('\n'),
    meanConfidence: weight ? sum / weight : 0,
    tokens,
  }
}
