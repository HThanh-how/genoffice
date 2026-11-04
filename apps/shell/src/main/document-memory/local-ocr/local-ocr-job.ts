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
import { folderPauses } from '../folder-pause'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { totalmem } from 'node:os'
import type { DatabaseSync } from 'node:sqlite'
import type { LocalOcrSettings } from '../../../shared/fork/agy-ocr'
import { clampPdfPages, DEFAULT_PDF_PAGES } from '../chunks'
import { DEFAULT_STORAGE_BUDGET } from '../storage-budget'
import { backgroundCoolDown } from '../cpu-budget'
import type { OcrRenderRequest, OcrRenderResult } from '../agy-ocr-render'
import {
  IMAGE_OCR_STATE,
  markImageOcr,
  selectImageOcrCandidates,
  type ImageOcrCandidate,
} from '../media/media-ocr-gate'
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
import { classifyOcrSourceError } from '../ocr-source-errors'

/** PDFs larger than this are not read locally (the renderer loads the whole file). */
export const LOCAL_OCR_MAX_PDF_BYTES = 64 * 1024 * 1024
export const LOCAL_OCR_MAX_IMAGE_BYTES = MAX_OCR_IMAGE_BYTES
/** Images with both sides under this are icons / thumbnails, not documents. */
export const LOCAL_OCR_MIN_IMAGE_EDGE_PX = 120
/** Machines with this much RAM or less read one page per file. */
export const LOW_RAM_TOTAL_MB = 4096
/** The slow pass over the pages after the first ones: at most this many are read per file on such machines. */
export const LOW_RAM_REST_PAGES = 10
/** Pages of one file read per visit of the slow pass, so that the quick pass gets its turn between visits. */
export const REST_PAGES_PER_VISIT = 5
/** The slow pass pauses this many times (each one as long as the quick pass's) after each page. */
export const REST_COOL_FACTOR = 2
/** Files visited by the slow pass in one `runOnce`: the runner calls again, and the quick queue is looked at first. */
export const REST_VISITS_PER_RUN = 2
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
  | {
      kind: 'page'
      engine: string
      ms: number
      S: number
      escalate: boolean
      reason: EscalationReason
      chars: number
    }
  | { kind: 'file-failed'; code: string }
  | { kind: 'file-skipped'; code: string }
  | { kind: 'stopped'; reason: string }

export interface LocalOcrJobDeps {
  db: DatabaseSync
  settings(): LocalOcrSettings
  registry: { select(preference?: LocalOcrEnginePreference): EngineSelection | null }
  /** render PDF pages (the index worker's `ocr-render`); null = no answer in time */
  render(path: string, request: OcrRenderRequest): Promise<OcrRenderResult | null>
  /** the indexer's PDF page limit: pages after it are never indexed, so the slow pass never reads them */
  pdfPageLimit?(): number
  /** on battery the slow pass waits for the charger (the quick pass follows `gate`) */
  onBattery?(): boolean
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
  sourceAvailable?(path: string): Promise<boolean>
  sourceOffline?(path: string): void
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

const PERMANENT_RENDER_CODES = new Set(['password', 'corrupt', 'unsupported', 'too-large'])

function cleanText(text: string): string {
  return text
    .split('\n')
    .map((line) => postProcessVietnameseOcrText(line))
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_TEXT_CHARS)
}

/**
 * Per database: the files whose pages from the slow pass are in `ocr_pages` and not yet in the index.
 * (A `LocalOcrJob` lives for one run, and the pages of one visit are indexed only when something ends the
 * visits of the file: the file is finished, a page failed, the run was stopped.)
 */
const unindexed = new WeakMap<DatabaseSync, Set<string>>()

export class LocalOcrJob {
  private readonly ocr: OcrSidecar
  /** characters stored by the last recognizeAndSave (0 = blank page) */
  private lastChars = 0

  constructor(private readonly deps: LocalOcrJobDeps) {
    this.ocr = new OcrSidecar(deps.db)
  }

  private pending(): Set<string> {
    let paths = unindexed.get(this.deps.db)
    if (!paths) unindexed.set(this.deps.db, (paths = new Set()))
    return paths
  }

  /** Puts every file with pages that were read and not yet indexed back in the index. */
  private flushUnindexed(): void {
    const paths = this.pending()
    for (const path of [...paths]) {
      paths.delete(path)
      this.deps.reindex(path)
    }
  }

  /** Leading pages read per file on this machine. */
  lightPages(): number {
    const wanted = Math.max(1, Math.min(5, Math.round(this.deps.settings().lightPages)))
    const total = this.deps.totalRamMB ? this.deps.totalRamMB() : totalmem() / (1024 * 1024)
    return total <= LOW_RAM_TOTAL_MB ? 1 : wanted
  }

  /**
   * Pages of one file read locally in all: the person's limit, never past the indexer's own page limit
   * (text beyond it is not indexed), and fewer on a small machine. Never below `lightPages()`, which
   * means "no slow pass".
   */
  restPages(): number {
    const asked = this.deps.settings().maxPages
    let wanted = Number.isFinite(asked) ? Math.round(asked) : 0
    wanted = Math.min(wanted, clampPdfPages(this.deps.pdfPageLimit?.() ?? DEFAULT_PDF_PAGES))
    // text of the pages after this many is never put in the index (worker.ts), so it is not read
    wanted = Math.min(wanted, DEFAULT_STORAGE_BUDGET.maxOcrPagesPerFile)
    const total = this.deps.totalRamMB ? this.deps.totalRamMB() : totalmem() / (1024 * 1024)
    if (total <= LOW_RAM_TOTAL_MB) wanted = Math.min(wanted, LOW_RAM_REST_PAGES)
    return Math.max(this.lightPages(), wanted)
  }

  /**
   * Read the next batch of files; safe to call repeatedly (done pages and images are never redone). */
  async runOnce(
    options: { maxFiles?: number; signal?: AbortSignal } = {},
  ): Promise<LocalOcrRunSummary> {
    const summary: LocalOcrRunSummary = { files: 0, pages: 0, escalated: 0, failed: 0, skipped: 0 }
    const settings = this.deps.settings()
    const stop = (reason: string): LocalOcrRunSummary => {
      summary.stoppedBecause = reason
      this.deps.log?.({ kind: 'stopped', reason })
      this.flushUnindexed() // the next run may be a long way off
      return summary
    }
    if (!settings.enabled) return stop('disabled')
    const light = this.lightPages()
    const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES)
    const pdfs = this.ocr.candidates(light, { mode: 'local', includeSensitive: true })
    const images = await this.imageCandidates(maxFiles)
    let engine: LocalOcrEngine | null = null
    try {
      let budget = maxFiles
      let visited = 0
      // a file that is not read now (its folder is paused, its drive is away) is not "waiting in the
      // quick queue": the slow pass below starts when no file of the quick queue could be visited
      const visitPdf = async (
        row: OcrDocRow,
        limit: number,
        slow: boolean,
      ): Promise<'skip' | 'done' | LocalOcrRunSummary> => {
        if (folderPauses.paused(row.path)) return 'skip'
        if (this.deps.sourceAvailable && !(await this.deps.sourceAvailable(row.path))) return 'skip'
        if (budget-- <= 0) return 'done'
        const outcome = await this.guarded(options.signal, slow)
        if (outcome) return stop(outcome)
        const picked = this.deps.registry.select(settings.engine)
        if (!picked) return stop('no-engine') // nothing fits the free RAM / no resources: try later
        engine = picked.engine
        const failedBefore = summary.failed
        const result = await this.readPdf(row, engine, limit, slow, options.signal, summary)
        summary.files++
        if (!slow) visited++
        // a visit that failed before it saved a page (the render, the first page) still ends the file's visits
        if (slow && summary.failed > failedBefore) this.flushUnindexed()
        return result ? stop(result) : 'skip'
      }
      for (const row of pdfs) {
        const outcome = await visitPdf(row, light, false)
        if (typeof outcome === 'object') return outcome
        if (outcome === 'done') break
      }
      for (const image of images) {
        if (folderPauses.paused(image.path)) continue
        if (this.deps.sourceAvailable && !(await this.deps.sourceAvailable(image.path))) continue
        if (!this.ocr.sourceRetryAllowed(image.path, image)) continue
        if (budget-- <= 0) break
        const outcome = await this.guarded(options.signal)
        if (outcome) return stop(outcome)
        const picked = this.deps.registry.select(settings.engine)
        if (!picked) return stop('no-engine')
        engine = picked.engine
        const result = await this.readImage(image, engine, options.signal, summary)
        summary.files++
        visited++
        if (result) return stop(result)
      }
      // The pages after the first ones come last: only when nothing of the quick queue was visited, a few
      // files at a time, so that a new file waits for at most REST_VISITS_PER_RUN visits.
      const rest = visited === 0 && !this.deps.onBattery?.() ? this.restPages() : 0
      // nothing more will be read now (on battery, or the limit was lowered): what was read is indexed
      if (visited === 0 && rest <= light) this.flushUnindexed()
      if (rest > light) {
        budget = Math.min(budget, REST_VISITS_PER_RUN)
        const candidates = this.ocr.candidates(rest, { mode: 'local', includeSensitive: true })
        for (const row of candidates) {
          const outcome = await visitPdf(row, rest, true)
          if (typeof outcome === 'object') return outcome
          if (outcome === 'done') break
        }
      }
      return summary
    } finally {
      // a Tesseract worker holds ~150 MB: do not keep it between runs
      await engine?.dispose().catch(() => undefined)
    }
  }

  /** Why work must not continue right now, or null. */
  private async guarded(signal?: AbortSignal, slow = false): Promise<string | null> {
    if (signal?.aborted) return 'aborted'
    if (this.deps.isStopped?.()) return 'stopped'
    const gate = this.deps.gate()
    if (!gate.ok) return `gate:${gate.reason}`
    if (slow && this.deps.onBattery?.()) return 'gate:on-battery'
    return null
  }

  /** Offline images must not fill the SQL limit and starve images on connected roots. */
  private async imageCandidates(limit: number): Promise<ImageOcrCandidate[]> {
    const images: ImageOcrCandidate[] = []
    let afterId = 0
    while (images.length < limit && !this.deps.isStopped?.()) {
      const page = selectImageOcrCandidates(this.deps.db, { engine: 'local', afterId, limit: 128 })
      for (const image of page) {
        afterId = image.documentId
        if (this.deps.sourceAvailable && !(await this.deps.sourceAvailable(image.path))) continue
        if (!this.ocr.sourceRetryAllowed(image.path, image)) continue
        images.push(image)
        if (images.length === limit) break
      }
      if (page.length < 128) break
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    return images
  }

  private async cool(activeMs: number): Promise<void> {
    await (this.deps.coolDown ?? backgroundCoolDown)(activeMs)
  }

  // ---- PDFs ----------------------------------------------------------------------------

  /** Returns a stop reason when the whole run must end, otherwise null. */
  private async readPdf(
    row: OcrDocRow,
    engine: LocalOcrEngine,
    /** pages of the file read in all by this pass (the quick pass: the first ones) */
    limit: number,
    /** the slow pass over the later pages: a few pages per visit, longer pauses */
    slow: boolean,
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
    const missing = Math.max(1, limit - row.pagesDone)
    const wantedCount = slow ? Math.min(REST_PAGES_PER_VISIT, missing) : missing
    const renderStarted = performance.now()
    const rendered = await this.deps.render(row.path, {
      done: [...present, ...skip],
      maxPages: skip.length ? Math.max(row.totalPages ?? 0, limit + skip.length) : limit,
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
      // Resource/worker gates stop this pass without consuming the file's three attempts.
      if (rendered.retryable) return 'render-deferred'
      if (rendered.code === 'offline') {
        this.deps.sourceOffline?.(row.path)
        return null
      }
      this.ocr.recordLocalFailure(
        row.path,
        file,
        rendered.code,
        PERMANENT_RENDER_CODES.has(rendered.code),
        rendered.detail ?? rendered.message,
      )
      summary.failed++
      this.deps.log?.({ kind: 'file-failed', code: rendered.code })
      return null
    }
    const meta = {
      hash: rendered.hash,
      mtimeMs: rendered.mtimeMs,
      sizeBytes: rendered.sizeBytes,
      totalPages: rendered.totalPages,
    }
    let touched = false
    let stopReason: string | null = null
    let first = true
    const failedBefore = summary.failed
    for (const page of rendered.pages) {
      if (present.includes(page.page) || skip.includes(page.page)) continue
      const why = await this.guarded(signal, slow)
      if (why) {
        stopReason = why
        break
      }
      const started = performance.now()
      let saved: 'saved' | 'denied' | undefined
      if (page.jpeg.byteLength === 0) {
        // a picture of a document that must not go to an engine (a thumbnail, too many pixels, a damaged
        // entry): a page without text, so that the file can be finished
        saved = await this.saveBlankPage(row.path, page.page, engine, meta, summary)
        if (saved === 'denied') {
          stopReason = 'storage-denied'
          break
        }
        touched = touched || saved === 'saved'
        continue
      }
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
            maxPages: limit,
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
      const activeMs = (first ? renderMs : 0) + (performance.now() - started)
      // (one pause is capped by the duty cycle, so the slow pass pauses again rather than for longer)
      for (let pause = 0; pause < (slow ? REST_COOL_FACTOR : 1); pause++) await this.cool(activeMs)
      first = false
    }
    if (touched) {
      // pages of this version were stored and none failed: an earlier failure row is stale
      if (summary.failed === failedBefore) this.ocr.clearLocalFailure(row.path, file)
      // The slow pass puts a file back in the index when its visits END (the file is finished, a page failed,
      // the run was stopped), not after every ordinary visit: each reindex makes a new version of the text, and
      // chunks and vectors would be made again and again. What was read stays in ocr_pages, the file stays a
      // candidate until it is finished, and `unindexed` remembers it for a run that stops before it saves a page.
      const ended =
        stopReason !== null ||
        summary.failed > failedBefore ||
        this.finished(row.path, file, meta.totalPages, limit, skip)
      if (!slow || ended) {
        this.pending().delete(row.path)
        this.deps.reindex(row.path)
      } else {
        this.pending().add(row.path)
      }
    }
    return stopReason
  }

  /** Every page up to `limit` is read, or has a text layer of its own. */
  private finished(
    path: string,
    file: { mtimeMs: number; sizeBytes: number },
    totalPages: number,
    limit: number,
    skip: readonly number[],
  ): boolean {
    const present = new Set(this.ocr.pagesPresent(path, file.mtimeMs, file.sizeBytes))
    for (let page = 1; page <= Math.min(totalPages, limit); page++)
      if (!present.has(page) && !skip.includes(page)) return false
    return true
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
      image.width !== null &&
      image.height !== null &&
      image.width < LOCAL_OCR_MIN_IMAGE_EDGE_PX &&
      image.height < LOCAL_OCR_MIN_IMAGE_EDGE_PX
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
      const failure = await classifyOcrSourceError(image.path, error)
      if (failure.code === 'offline') {
        this.deps.sourceOffline?.(image.path)
        return null
      }
      this.ocr.recordLocalFailure(image.path, image, failure.code, false, failure.detail)
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
      saved = await this.recognizeAndSave(
        image.path,
        1,
        loaded.bytes,
        engine.descriptor.dpi,
        engine,
        meta,
        summary,
      )
    } catch (error) {
      if (error instanceof LocalOcrUnavailableError) return 'no-engine'
      const isUnsupported =
        error instanceof Error && error.message.includes('unsupported-image-format')
      markImageOcr(
        db,
        image.documentId,
        isUnsupported ? IMAGE_OCR_STATE.skipped : IMAGE_OCR_STATE.failed,
      )
      summary.failed++
      this.deps.log?.({
        kind: 'file-failed',
        code: isUnsupported ? 'unsupported-image-format' : 'engine-error',
      })
      return null
    }
    if (saved === 'denied') return 'storage-denied'
    markImageOcr(db, image.documentId, IMAGE_OCR_STATE.done)
    this.ocr.clearLocalFailure(image.path, image)
    // a photo without text stays the lean media row it is, unless an older version of the file left chunks behind
    if (this.lastChars > 0 || this.hasChunks(image.documentId)) this.deps.reindex(image.path)
    await this.cool(performance.now() - started)
    return null
  }

  private hasChunks(documentId: number): boolean {
    return (
      this.deps.db.prepare('SELECT 1 FROM chunks WHERE document_id = ? LIMIT 1').get(documentId) !==
      undefined
    )
  }

  // ---- shared --------------------------------------------------------------------------

  /** Recognise one page, decide on escalation, store it. 'denied' = the storage gate said no. */
  private async saveBlankPage(
    path: string,
    page: number,
    engine: LocalOcrEngine,
    file: { hash: string; mtimeMs: number; sizeBytes: number; totalPages: number },
    summary: LocalOcrRunSummary,
  ): Promise<'saved' | 'denied'> {
    const saved = await this.deps.savePages(
      path,
      {
        ...file,
        model: `local:${engine.id}`,
        tier: 'local',
        engine: engine.id,
        quality: 0,
        escalate: false,
      },
      [{ page, text: '' }],
    )
    if (saved && typeof saved === 'object' && saved.ok === false) return 'denied'
    summary.pages++
    this.lastChars = 0
    return 'saved'
  }

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
  return /read image|cannot be read|unknown format|corrupt|truncated|decode|unsupported image/i.test(
    msg,
  )
}

export async function readImageFile(
  path: string,
): Promise<{ bytes: Uint8Array; mtimeMs: number; sizeBytes: number }> {
  const before = await stat(path)
  const bytes = await readFile(path)
  const after = await stat(path)
  if (
    before.mtimeMs !== after.mtimeMs ||
    before.size !== after.size ||
    bytes.byteLength !== after.size
  ) {
    throw new FileChangedDuringReadError(path)
  }
  return { bytes, mtimeMs: after.mtimeMs, sizeBytes: after.size }
}
