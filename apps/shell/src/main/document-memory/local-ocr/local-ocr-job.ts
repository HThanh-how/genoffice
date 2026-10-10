/**
 * The local "light index" OCR pass. It runs BEFORE the cloud reader (agy-ocr-job.ts) and does the
 * cheap part on this machine: the first `lightPages` pages of every scanned PDF and every OCR-worthy
 * image are recognised, scored, and written through the same path the cloud reader uses
 * (`ocr_pages` -> re-extract -> chunks -> FTS / embeddings). Pages the local engine is unsure about
 * are flagged `escalate`; only those become cloud work (see `OcrSidecar.candidates`).
 *
 * Privacy: this is the only reader that sees `sensitive` files (identity papers, passports ...) and
 * images; everything stays on the device. A page whose recognised TEXT looks like such a paper is
 * never flagged for the cloud, even when its file name gave nothing away.
 *
 * Everything with side effects is injected (engine registry, renderer, persistence, gates), so the
 * policy is tested against a real SQLite database with only the engine call replaced.
 *
 * Wiring (not done here, see the report): run `runOnce()` from the OCR scheduler tick of the
 * document-memory runtime with `render` = the index worker's `ocr-render`, `savePages` =
 * `persistOcrPagesGated` (storage admission + budget) and `gate` = `evaluateOcrGate`.
 */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { totalmem } from 'node:os'
import type { DatabaseSync } from 'node:sqlite'
import type { LocalOcrSettings } from '../../../shared/fork/agy-ocr'
import { backgroundCoolDown } from '../cpu-budget'
import type { OcrRenderRequest, OcrRenderResult } from '../agy-ocr-render'
import { IMAGE_OCR_STATE, markImageOcr, selectImageOcrCandidates, type ImageOcrCandidate } from '../media/media-ocr-gate'
import { MAX_OCR_IMAGE_BYTES } from '../media/media-kinds'
import { isSensitiveName } from '../media/sensitive-names'
import { OcrSidecar, type OcrDocRow, type OcrFileMeta, type OcrPageText } from '../ocr-sidecar'
import {
  LocalOcrUnavailableError,
  postProcessVietnameseOcrText,
  type LocalOcrEngine,
} from '../runtime/local-ocr-engine'
import { shouldEscalate, type EscalationReason } from './escalation'
import type { EngineSelection, LocalOcrEnginePreference } from './registry'
import { detectImageFormat } from './tesseract-prepare'

/** PDFs larger than this are not read locally (the renderer loads the whole file). */
export const LOCAL_OCR_MAX_PDF_BYTES = 64 * 1024 * 1024
export const LOCAL_OCR_MAX_IMAGE_BYTES = MAX_OCR_IMAGE_BYTES
/** Images with both sides under this are icons / thumbnails, not documents. */
export const LOCAL_OCR_MIN_IMAGE_EDGE_PX = 120
/** Machines with this much RAM or less read one page per file. */
export const LOW_RAM_TOTAL_MB = 4096
/** What the PDF renderer's 1600 px long edge is worth on A4, for the Tesseract flattening radius. */
export const RENDERED_PAGE_DPI = 137
const MAX_TEXT_CHARS = 30_000
const DEFAULT_MAX_FILES = 25

export interface LocalOcrSavePagesResult {
  ok: boolean
  code?: string
  error?: string
}

export type LocalOcrGate = { ok: true } | { ok: false; reason: string }

/** Events carry counts and scores only: never file names or recognised text. */
export type LocalOcrEvent =
  | { kind: 'page'; engine: string; ms: number; S: number; escalate: boolean; reason: EscalationReason; chars: number }
  | { kind: 'file-failed'; code: string }
  | { kind: 'file-skipped'; code: string }
  | { kind: 'stopped'; reason: string }

export interface LocalOcrJobDeps {
  db: DatabaseSync
  settings(): LocalOcrSettings
  registry: { select(preference?: LocalOcrEnginePreference): EngineSelection | null }
  /** render PDF pages (the index worker's `ocr-render`); null = no answer in time */
  render(path: string, request: OcrRenderRequest): Promise<OcrRenderResult | null>
  /** persistence through the storage admission / budget gate */
  savePages(
    path: string,
    meta: OcrFileMeta,
    pages: readonly OcrPageText[],
  ): Promise<LocalOcrSavePagesResult | void> | LocalOcrSavePagesResult | void
  /** queue the document so the new OCR text becomes chunks, FTS rows and vectors */
  reindex(path: string): void
  /** idle / AC / paused policy; checked before every page */
  gate(): LocalOcrGate
  /** duty cycle: waits after `activeMs` of work (default: the indexing policy's cool-down) */
  coolDown?(activeMs: number): Promise<void>
  isStopped?(): boolean
  readImage?(path: string): Promise<{ bytes: Uint8Array; mtimeMs: number; sizeBytes: number }>
  totalRamMB?(): number
  log?(event: LocalOcrEvent): void
  maxPdfBytes?: number
  maxImageBytes?: number
}

export interface LocalOcrRunSummary {
  files: number
  pages: number
  escalated: number
  failed: number
  skipped: number
  stoppedBecause?: string
}

const PERMANENT_RENDER_CODES = new Set(['password', 'corrupt', 'unsupported', 'too-large', 'missing'])

function cleanText(text: string): string {
  return text
    .split('\n')
    .map((line) => postProcessVietnameseOcrText(line))
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_TEXT_CHARS)
}

export class LocalOcrJob {
  private readonly ocr: OcrSidecar
  /** characters stored by the last recognizeAndSave (0 = blank page) */
  private lastChars = 0

  constructor(private readonly deps: LocalOcrJobDeps) {
    this.ocr = new OcrSidecar(deps.db)
  }

  /** Leading pages read per file on this machine. */
  lightPages(): number {
    const wanted = Math.max(1, Math.min(5, Math.round(this.deps.settings().lightPages)))
    const total = this.deps.totalRamMB ? this.deps.totalRamMB() : totalmem() / (1024 * 1024)
    return total <= LOW_RAM_TOTAL_MB ? 1 : wanted
  }

  /** Read the next batch of files; safe to call repeatedly (done pages and images are never redone). */
  async runOnce(options: { maxFiles?: number; signal?: AbortSignal } = {}): Promise<LocalOcrRunSummary> {
    const summary: LocalOcrRunSummary = { files: 0, pages: 0, escalated: 0, failed: 0, skipped: 0 }
    const settings = this.deps.settings()
    const stop = (reason: string): LocalOcrRunSummary => {
      summary.stoppedBecause = reason
      this.deps.log?.({ kind: 'stopped', reason })
      return summary
    }
    if (!settings.enabled) return stop('disabled')
    const light = this.lightPages()
    const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES)
    const pdfs = this.ocr.candidates(light, { mode: 'local', includeSensitive: true })
    const images = selectImageOcrCandidates(this.deps.db, { engine: 'local', limit: maxFiles })
    if (pdfs.length === 0 && images.length === 0) return summary
    let engine: LocalOcrEngine | null = null
    try {
      let budget = maxFiles
      for (const row of pdfs) {
        if (budget-- <= 0) break
        const outcome = await this.guarded(options.signal)
        if (outcome) return stop(outcome)
        const picked = this.deps.registry.select(settings.engine)
        if (!picked) return stop('no-engine') // nothing fits the free RAM / no resources: try later
        engine = picked.engine
        const result = await this.readPdf(row, engine, light, options.signal, summary)
        summary.files++
        if (result) return stop(result)
      }
      for (const image of images) {
        if (budget-- <= 0) break
        const outcome = await this.guarded(options.signal)
        if (outcome) return stop(outcome)
        const picked = this.deps.registry.select(settings.engine)
        if (!picked) return stop('no-engine')
        engine = picked.engine
        const result = await this.readImage(image, engine, options.signal, summary)
        summary.files++
        if (result) return stop(result)
      }
      return summary
    } finally {
      // a Tesseract worker holds ~150 MB: do not keep it between runs
      await engine?.dispose().catch(() => undefined)
    }
  }

  /** Why work must not continue right now, or null. */
  private async guarded(signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return 'aborted'
    if (this.deps.isStopped?.()) return 'stopped'
    const gate = this.deps.gate()
    if (!gate.ok) return `gate:${gate.reason}`
    return null
  }

  private async cool(activeMs: number): Promise<void> {
    await (this.deps.coolDown ?? backgroundCoolDown)(activeMs)
  }

  // ---- PDFs ----------------------------------------------------------------------------

  /** Returns a stop reason when the whole run must end, otherwise null. */
  private async readPdf(
    row: OcrDocRow,
    engine: LocalOcrEngine,
    light: number,
    signal: AbortSignal | undefined,
    summary: LocalOcrRunSummary,
  ): Promise<string | null> {
    const file = { mtimeMs: row.mtimeMs, sizeBytes: row.sizeBytes }
    if (row.sizeBytes > (this.deps.maxPdfBytes ?? LOCAL_OCR_MAX_PDF_BYTES)) {
      this.ocr.recordLocalFailure(row.path, file, 'too-large', true)
      summary.skipped++
      return null
    }
    const present = this.ocr.pagesPresent(row.path, row.mtimeMs, row.sizeBytes)
    const skip = row.skipPages ?? []
    const wantedCount = Math.max(1, light - row.pagesDone)
    const renderStarted = performance.now()
    const rendered = await this.deps.render(row.path, {
      done: [...present, ...skip],
      maxPages: skip.length ? Math.max(row.totalPages ?? 0, light + skip.length) : light,
      count: wantedCount,
    })
    const renderMs = performance.now() - renderStarted
    if (!rendered) {
      this.ocr.recordLocalFailure(row.path, file, 'render-timeout')
      summary.failed++
      this.deps.log?.({ kind: 'file-failed', code: 'render-timeout' })
      return null
    }
    if (!rendered.ok) {
      this.ocr.recordLocalFailure(row.path, file, rendered.code, PERMANENT_RENDER_CODES.has(rendered.code))
      summary.failed++
      this.deps.log?.({ kind: 'file-failed', code: rendered.code })
      return null
    }
    const meta = { hash: rendered.hash, mtimeMs: rendered.mtimeMs, sizeBytes: rendered.sizeBytes, totalPages: rendered.totalPages }
    let touched = false
    let stopReason: string | null = null
    let first = true
    for (const page of rendered.pages) {
      if (present.includes(page.page) || skip.includes(page.page)) continue
      const why = await this.guarded(signal)
      if (why) {
        stopReason = why
        break
      }
      const started = performance.now()
      let saved: 'saved' | 'denied' | undefined
      try {
        saved = await this.recognizeAndSave(
          row.path,
          page.page,
          page.jpeg,
          RENDERED_PAGE_DPI,
          engine,
          meta,
          summary,
        )
      } catch (error) {
        if (error instanceof LocalOcrUnavailableError) {
          stopReason = 'no-engine'
          break
        }
        // If an embedded JPEG failed due to genuine image-decoding error, attempt PDFium rasterization fallback once
        if (page.source === 'embedded' && isImageDecodeError(error)) {
          this.deps.log?.({ kind: 'file-failed', code: 'embedded-decode-error' })
          const fallback = await this.deps.render(row.path, {
            done: [...present, ...skip],
            maxPages: light,
            count: 1,
            retryRenderedPage: page.page,
          })
          if (fallback?.ok && fallback.pages.length === 1 && fallback.hash === meta.hash) {
            const fallbackPage = fallback.pages[0]!
            try {
              saved = await this.recognizeAndSave(
                row.path,
                page.page,
                fallbackPage.jpeg,
                RENDERED_PAGE_DPI,
                engine,
                meta,
                summary,
              )
            } catch (fallbackError) {
              if (fallbackError instanceof LocalOcrUnavailableError) {
                stopReason = 'no-engine'
                break
              }
              this.ocr.recordLocalFailure(row.path, file, 'engine-error')
              summary.failed++
              this.deps.log?.({ kind: 'file-failed', code: 'engine-error' })
              break
            }
          } else {
            this.ocr.recordLocalFailure(row.path, file, 'engine-error')
            summary.failed++
            this.deps.log?.({ kind: 'file-failed', code: 'engine-error' })
            break
          }
        } else {
          this.ocr.recordLocalFailure(row.path, file, 'engine-error')
          summary.failed++
          this.deps.log?.({ kind: 'file-failed', code: 'engine-error' })
          break
        }
      }
      if (saved === 'denied') {
        stopReason = 'storage-denied'
        break
      }
      touched = touched || saved === 'saved'
      await this.cool((first ? renderMs : 0) + (performance.now() - started))
      first = false
    }
    if (touched) this.deps.reindex(row.path)
    return stopReason
  }

  // ---- images --------------------------------------------------------------------------

  private async readImage(
    image: ImageOcrCandidate,
    engine: LocalOcrEngine,
    signal: AbortSignal | undefined,
    summary: LocalOcrRunSummary,
  ): Promise<string | null> {
    const { db } = this.deps
    const tooSmall =
      image.width !== null && image.height !== null &&
      image.width < LOCAL_OCR_MIN_IMAGE_EDGE_PX && image.height < LOCAL_OCR_MIN_IMAGE_EDGE_PX
    if (tooSmall || image.sizeBytes > (this.deps.maxImageBytes ?? LOCAL_OCR_MAX_IMAGE_BYTES)) {
      markImageOcr(db, image.documentId, IMAGE_OCR_STATE.skipped)
      summary.skipped++
      return null
    }
    let loaded: { bytes: Uint8Array; mtimeMs: number; sizeBytes: number }
    try {
      loaded = await (this.deps.readImage ?? readImageFile)(image.path)
    } catch (error) {
      if (error instanceof FileChangedDuringReadError) {
        summary.skipped++
        this.deps.log?.({ kind: 'file-skipped', code: 'file-modified' })
        return null
      }
      markImageOcr(db, image.documentId, IMAGE_OCR_STATE.failed)
      summary.failed++
      this.deps.log?.({ kind: 'file-failed', code: 'unreadable' })
      return null
    }
    // the file changed since it was enrolled: re-enrolment resets the state and it is picked up again
    if (loaded.mtimeMs !== image.mtimeMs || loaded.sizeBytes !== image.sizeBytes) {
      summary.skipped++
      return null
    }
    const why = await this.guarded(signal)
    if (why) return why
    if (detectImageFormat(loaded.bytes) === 'heic') {
      markImageOcr(db, image.documentId, IMAGE_OCR_STATE.skipped)
      summary.failed++
      this.deps.log?.({ kind: 'file-failed', code: 'unsupported-image-format' })
      return null
    }
    const started = performance.now()
    const meta = {
      hash: createHash('sha256').update(loaded.bytes).digest('hex'),
      mtimeMs: loaded.mtimeMs,
      sizeBytes: loaded.sizeBytes,
      totalPages: 1,
    }
    let saved: 'saved' | 'denied'
    try {
      saved = await this.recognizeAndSave(image.path, 1, loaded.bytes, engine.descriptor.dpi, engine, meta, summary)
    } catch (error) {
      if (error instanceof LocalOcrUnavailableError) return 'no-engine'
      const isUnsupported = error instanceof Error && error.message.includes('unsupported-image-format')
      markImageOcr(db, image.documentId, isUnsupported ? IMAGE_OCR_STATE.skipped : IMAGE_OCR_STATE.failed)
      summary.failed++
      this.deps.log?.({ kind: 'file-failed', code: isUnsupported ? 'unsupported-image-format' : 'engine-error' })
      return null
    }
    if (saved === 'denied') return 'storage-denied'
    markImageOcr(db, image.documentId, IMAGE_OCR_STATE.done)
    // a photo without text stays the lean media row it is, unless an older version of the file left chunks behind
    if (this.lastChars > 0 || this.hasChunks(image.documentId)) this.deps.reindex(image.path)
    await this.cool(performance.now() - started)
    return null
  }

  private hasChunks(documentId: number): boolean {
    return this.deps.db.prepare('SELECT 1 FROM chunks WHERE document_id = ? LIMIT 1').get(documentId) !== undefined
  }

  // ---- shared --------------------------------------------------------------------------

  /** Recognise one page, decide on escalation, store it. 'denied' = the storage gate said no. */
  private async recognizeAndSave(
    path: string,
    page: number,
    bytes: Uint8Array,
    dpi: number,
    engine: LocalOcrEngine,
    file: { hash: string; mtimeMs: number; sizeBytes: number; totalPages: number },
    summary: LocalOcrRunSummary,
  ): Promise<'saved' | 'denied'> {
    this.lastChars = 0
    const recognition = await engine.recognizePage({ bytes, dpi, lang: 'vie' })
    const verdict = shouldEscalate(recognition, engine.id)
    // Identity / legal papers are never cloud work, whatever their score: the cloud list drops them by
    // name, and this drops the ones whose name said nothing.
    const cloudAllowed = !isSensitiveName(basename(path), path)
    const escalate = verdict.escalate && cloudAllowed
    const text = cleanText(recognition.text)
    const saved = await this.deps.savePages(
      path,
      {
        ...file,
        model: `local:${engine.id}`,
        tier: 'local',
        engine: engine.id,
        quality: verdict.S,
        escalate,
      },
      [{ page, text }],
    )
    if (saved && typeof saved === 'object' && saved.ok === false) return 'denied'
    summary.pages++
    this.lastChars = text.length
    if (escalate) summary.escalated++
    this.deps.log?.({
      kind: 'page',
      engine: engine.id,
      ms: recognition.ms,
      S: Math.round(verdict.S * 1000) / 1000,
      escalate,
      reason: verdict.reason,
      chars: text.length,
    })
    return 'saved'
  }
}

export class FileChangedDuringReadError extends Error {
  constructor(path: string) {
    super(`File modified during read: ${path}`)
    this.name = 'FileChangedDuringReadError'
  }
}

export function isImageDecodeError(error: unknown): boolean {
  if (!error) return false
  const msg = error instanceof Error ? error.message : String(error)
  return /read image|cannot be read|unknown format|corrupt|truncated|decode|unsupported image/i.test(msg)
}

export async function readImageFile(path: string): Promise<{ bytes: Uint8Array; mtimeMs: number; sizeBytes: number }> {
  const before = await stat(path)
  const bytes = await readFile(path)
  const after = await stat(path)
  if (before.mtimeMs !== after.mtimeMs || before.size !== after.size || bytes.byteLength !== after.size) {
    throw new FileChangedDuringReadError(path)
  }
  return { bytes, mtimeMs: after.mtimeMs, sizeBytes: after.size }
}
