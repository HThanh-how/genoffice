/**
 * The scanned-PDF reader: while the user's Antigravity quota is plentiful it sends page images of
 * not-yet-readable PDFs to Antigravity, stores the transcription and lets the normal indexing
 * pipeline chunk and embed it (see ocr-sidecar.ts for how text re-enters the index). Everything
 * that touches the outside world is injected, so the whole policy (quota hysteresis, gating,
 * ordering, batching, failure and backoff rules) is tested without agy, PDFium, Electron or a
 * real clock.
 *
 * Rules that keep it safe to leave on:
 *  - quota-paced: `/usage` (free) is read before every call. The weekly bucket keeps a reserve
 *    that shrinks day by day (90% on day 1, 80% on day 2 ... never below 20%) and the 5-hour
 *    bucket one that glides from 85% to 70% over its window; each can be ignored. A batch starts
 *    only while every checked bucket is above its floor (plus a small margin). It never runs
 *    when the usage cannot be read;
 *  - nothing runs on battery / while the user is active / while indexing is paused (settings);
 *  - quota, rate-limit, sign-in and missing-CLI errors end the day's run (no retries today);
 *  - any other failure backs off exponentially (10 min, 20 min, 40 min ...) and stops the run;
 *  - a file that fails 3 times, or cannot be read at all (password, damaged), is marked
 *    non-retryable with a plain reason and is never tried again by the scheduler;
 *  - optional safety caps: PDFs per day (0 = unlimited), pages per file, pages per call.
 */
import { basename } from 'node:path'
import { clampPdfPages, DEFAULT_PDF_PAGES } from './chunks'
import {
  OCR_MAX_CALLS_PER_RUN,
  ocrPageLimit,
  OCR_MAX_FILE_ATTEMPTS,
  OCR_TICK_MS,
  classifyAgyOcrError,
  decideQuota,
  haltsTheDay,
  localDateKey,
  ocrBackoffMs,
  orderOcrCandidates,
  parseAgyOcrOutput,
  pdfCapReached,
  planOcrBatch,
  type AgyUsageReading,
  type OcrCandidate,
  type OcrErrorKind,
  type QuotaBucketView,
  type QuotaRules,
  type TimezoneOffset,
} from '@genoffice/ai-provider/agy-ocr'
import type {
  AgyOcrActivity,
  AgyOcrBucketLive,
  AgyOcrReadNowResult,
  AgyOcrSettings,
  AgyOcrStatus,
} from '../../shared/fork/agy-ocr'
import type { OcrRenderRequest, OcrRenderResult } from './agy-ocr-render'
import type { OcrStateStore } from './agy-ocr-state'
import type { OcrDocRow, OcrFileMeta, OcrPageText } from './ocr-sidecar'

/** user idle time (seconds) that counts as "idle"; the indexing policy uses the same figure */
export const OCR_IDLE_SECONDS = 120

// ---- gating -------------------------------------------------------------------------------

export interface OcrPolicyView {
  paused: boolean
  onBattery: boolean
}

export type OcrGateReason = 'indexing-paused' | 'on-battery' | 'not-idle' | 'no-power-info'

/** May the reader start (or continue) a call right now? */
export function evaluateOcrGate(input: {
  settings: Pick<AgyOcrSettings, 'onlyOnAC' | 'onlyWhenIdle'>
  /** latest indexing policy (battery / low memory / lock / thermal); null before the first reading */
  policy: OcrPolicyView | null
  /** seconds since the last keyboard or mouse input; null when unknown */
  idleSeconds: number | null
}): { ok: true } | { ok: false; reason: OcrGateReason } {
  const { settings, policy, idleSeconds } = input
  if (!policy) return { ok: false, reason: 'no-power-info' }
  if (policy.paused) return { ok: false, reason: 'indexing-paused' }
  if (settings.onlyOnAC && policy.onBattery) return { ok: false, reason: 'on-battery' }
  if (settings.onlyWhenIdle && !(idleSeconds !== null && idleSeconds >= OCR_IDLE_SECONDS))
    return { ok: false, reason: 'not-idle' }
  return { ok: true }
}

/** The quota floors the settings describe; an ignored bucket never blocks. */
export function quotaRulesOf(settings: AgyOcrSettings): QuotaRules {
  return {
    weekly: {
      firstDayFloor: settings.weeklyFirstDayFloor,
      dropPerDay: settings.weeklyDropPerDay,
      minFloor: settings.weeklyMinFloor,
      ignore: settings.ignoreWeekly,
    },
    fiveHour: {
      floorStart: settings.fiveHourFloorStart,
      floorEnd: settings.fiveHourFloorEnd,
      ignore: settings.ignoreFiveHour,
    },
  }
}

// ---- dependencies ---------------------------------------------------------------------------

export interface OcrJobHost {
  /** document memory is switched on (nothing is read while it is off) */
  isEnabled(): boolean
  candidates(maxPagesPerFile: number): OcrDocRow[]
  documentById(id: number): { id: number; path: string } | null
  pagesDone(path: string, mtimeMs: number, sizeBytes: number): number[]
  /** null = the index process did not answer in time */
  render(path: string, request: OcrRenderRequest): Promise<OcrRenderResult | null>
  savePages(path: string, meta: OcrFileMeta, pages: readonly OcrPageText[]): void
  /** queue the document for re-extraction so the new OCR text becomes chunks and vectors */
  reindex(path: string): void
  /**
   * Put the new OCR text into the index right now and resolve once the file is searchable: for a
   * read the person asked for, which must not wait in the line behind every other file.
   */
  reindexNow?(path: string): Promise<void>
}

export interface OcrRecognizeInput {
  model: string
  /** 1-based PDF page numbers, in image order */
  pages: number[]
  images: Uint8Array[]
  signal: AbortSignal
}

export interface OcrJobDeps {
  settings(): AgyOcrSettings
  /** how many pages of a PDF the indexer reads: nothing past it is worth a transcription */
  pdfPageLimit?(): number
  host: OcrJobHost
  state: OcrStateStore
  /** one agy call for several page images; throws agy's own error message on failure */
  recognize(input: OcrRecognizeInput): Promise<{
    text: string
    usage?: { inputTokens?: number; outputTokens?: number; thinkingTokens?: number }
  }>
  /** `agy /usage` (free); null when it cannot be read. Must not throw. */
  readUsage(): Promise<AgyUsageReading | null>
  policy(): OcrPolicyView | null
  idleSeconds(): number | null
  now(): number
  timezoneOffset: TimezoneOffset
  /** repeating timer; returns the cancel function */
  every(callback: () => void, ms: number): () => void
}

/** What a call to processFile tells the loop that runs it. */
interface FileOutcome {
  pages: number
  /** end the whole run (halt, backoff, quota, gate closed, aborted) */
  stop: boolean
}

const WAITING_CACHE_MS = 60_000
const NO_WORK_RECHECK_MS = 60 * 60_000
/** a blocked quota is not asked again before its window refreshes (capped), see nextCheckAt */
const MAX_QUOTA_WAIT_MS = 6 * 60 * 60_000

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const RENDER_REASONS: Record<string, string> = {
  password: 'The PDF is password-protected',
  corrupt: 'The PDF is damaged',
  unsupported: 'The PDF cannot be opened',
  'too-large': 'The PDF is too large to read with OCR',
  missing: 'The file is no longer there',
}

export class AgyOcrJob {
  private cancelTick: (() => void) | null = null
  private running = false
  private abort: AbortController | null = null
  private stopped = false
  /** do not look for work before this time (nothing to do, or the quota is blocked until a reset) */
  private nextCheckAt = 0
  private waiting: { at: number; count: number } | null = null
  private callsThisRun = 0

  constructor(private readonly deps: OcrJobDeps) {}

  // ---- lifecycle ----

  start(): void {
    if (this.cancelTick || this.stopped) return
    this.cancelTick = this.deps.every(() => void this.tick(), OCR_TICK_MS)
  }

  stop(): void {
    this.stopped = true
    this.cancelTick?.()
    this.cancelTick = null
    this.abort?.abort()
  }

  /** Settings changed: re-evaluate soon; a re-enabled reader gets a fresh chance (clears a halt). */
  settingsChanged(previous: AgyOcrSettings | null): void {
    const now = this.deps.settings()
    this.waiting = null
    this.nextCheckAt = 0
    const reenabled = !previous?.enabled && now.enabled
    if (reenabled || previous?.model !== now.model)
      this.deps.state.update((data) => {
        data.armed = { fiveHour: false, weekly: false }
        if (reenabled) {
          delete data.halted
          data.backoff = { failures: 0, until: 0 }
        }
      })
    if (previous?.enabled && !now.enabled) this.abort?.abort()
  }

  // ---- scheduler ----

  /** One cheap check; does real work only when a run is due. Never throws. */
  async tick(): Promise<void> {
    try {
      const settings = this.workingSettings()
      if (this.stopped || !settings.enabled || this.running) return
      if (!this.deps.host.isEnabled()) return
      const now = this.deps.now()
      if (now < this.nextCheckAt) return
      const state = this.deps.state.get()
      const today = this.deps.state.today()
      const day = localDateKey(now, this.deps.timezoneOffset)
      if (state.halted && state.halted.day === day) return
      if (state.backoff.until > now) return
      if (pdfCapReached(settings.maxPdfsPerDay, today)) return
      if (!this.gateOpen(settings)) return
      await this.runScheduled(settings)
    } catch (error) {
      this.recordError(errorText(error))
    }
  }

  private gateOpen(settings: AgyOcrSettings): boolean {
    return evaluateOcrGate({
      settings,
      policy: this.deps.policy(),
      idleSeconds: this.deps.idleSeconds(),
    }).ok
  }

  /**
   * Read `/usage` (free) and apply the quota floors. True only when a call may start now; an
   * unreadable usage never runs.
   */
  private async quotaAllows(settings: AgyOcrSettings): Promise<boolean> {
    const rules = quotaRulesOf(settings)
    // both limits switched off: the quota is not consulted at all (the usage is not even read)
    if (rules.fiveHour.ignore && rules.weekly.ignore) return true
    const reading = await this.deps.readUsage()
    const now = this.deps.now()
    const decision = decideQuota({
      reading,
      model: settings.model,
      armed: this.deps.state.get().armed,
      rules,
      now,
    })
    this.deps.state.update((data) => {
      data.armed = decision.armed
      data.quota = { at: now, decision }
    })
    if (decision.kind === 'blocked' && decision.blocking) {
      // the floor only drops on a schedule and quota only grows at a refill: do not ask before then
      const wake = decision.blocking.clearsAt ?? decision.blocking.resetAt
      if (wake !== undefined) this.nextCheckAt = Math.min(wake + 30_000, now + MAX_QUOTA_WAIT_MS)
    }
    return decision.run
  }

  private async runScheduled(settings: AgyOcrSettings): Promise<void> {
    this.running = true
    this.abort = new AbortController()
    this.callsThisRun = 0
    const touched = new Set<string>()
    let quotaBlocked = false
    try {
      const now = this.deps.now()
      const queue = this.eligible(settings.maxPagesPerFile)
      if (queue.length === 0) {
        this.nextCheckAt = now + NO_WORK_RECHECK_MS
        return
      }
      const ordered = orderOcrCandidates(queue, now, settings.maxPagesPerFile)
      for (const candidate of ordered) {
        if (this.abort.signal.aborted || this.callsThisRun >= OCR_MAX_CALLS_PER_RUN) break
        if (pdfCapReached(settings.maxPdfsPerDay, this.deps.state.today())) break
        const outcome = await this.processFile(candidate, settings, { manual: false, touched })
        if (outcome.stop) {
          quotaBlocked = this.deps.state.get().quota?.decision.run === false
          break
        }
      }
      // record where the quota stands after the work (free): the next decision starts from it
      if (this.callsThisRun > 0 && !quotaBlocked && !this.abort.signal.aborted)
        await this.quotaAllows(settings)
      this.deps.state.update((data) => void (data.lastRunAt = this.deps.now()))
    } finally {
      this.flushReindex(touched)
      this.running = false
      this.abort = null
      this.waiting = null
    }
  }

  /** Settings with the "unlimited pages" marker resolved; `status()` keeps the raw value for the UI. */
  private workingSettings(): AgyOcrSettings {
    const settings = this.deps.settings()
    // text read from pages beyond the indexer's page limit is never indexed, so it is never paid
    // for: the reader stops at that page ("unlimited" included, "read now" included)
    const indexed = clampPdfPages(this.deps.pdfPageLimit?.() ?? DEFAULT_PDF_PAGES)
    return {
      ...settings,
      maxPagesPerFile: Math.min(ocrPageLimit(settings.maxPagesPerFile), indexed),
    }
  }

  /** Candidates the scheduler may still try (non-retryable files are out). */
  private eligible(maxPagesPerFile: number): OcrCandidate[] {
    const files = this.deps.state.get().files
    const out: OcrCandidate[] = []
    for (const row of this.deps.host.candidates(maxPagesPerFile)) {
      if (files[row.path]?.nonRetryable) continue
      out.push({
        path: row.path,
        sizeBytes: row.sizeBytes,
        lastOpenedAt: row.lastOpenedAt,
        mtimeMs: row.mtimeMs,
        pagesDone: row.pagesDone,
        ...(row.totalPages !== undefined ? { totalPages: row.totalPages } : {}),
        ...(row.skipPages ? { skipPages: row.skipPages } : {}),
      })
    }
    return out
  }

  // ---- one file ----

  /**
   * Read pages of one file, call after call, until its page limit, a failure, a closed gate or
   * quota, or an abort. Pages are charged to today's counters BEFORE the call (a crash mid-call
   * cannot lead to a free retry) and refunded only when the failure proves nothing was consumed.
   */
  private async processFile(
    candidate: OcrCandidate,
    settings: AgyOcrSettings,
    options: { manual: boolean; touched: Set<string> },
  ): Promise<FileOutcome> {
    const { host, state } = this.deps
    const path = candidate.path
    let charged = 0
    let counted = false
    const signal = this.abort?.signal
    while (!signal?.aborted) {
      if (this.callsThisRun >= OCR_MAX_CALLS_PER_RUN) return { pages: charged, stop: true }
      if (!options.manual) {
        if (!this.gateOpen(settings)) return { pages: charged, stop: true }
        if (!(await this.quotaAllows(settings))) return { pages: charged, stop: true }
        if (signal?.aborted) break
      }
      const done = host.pagesDone(path, candidate.mtimeMs, candidate.sizeBytes)
      // pages that have their own text layer count as read: they are never rendered or sent
      const skip = candidate.skipPages ?? []
      const rendered = await host.render(path, {
        done: [...done, ...skip],
        maxPages: settings.maxPagesPerFile,
        count: settings.pagesPerCall,
      })
      if (!rendered) {
        this.failFile(path, 'The index process did not answer in time')
        return { pages: charged, stop: true }
      }
      if (!rendered.ok) {
        if (rendered.code === 'render') {
          this.failFile(path, rendered.message)
          return { pages: charged, stop: false }
        }
        this.markNonRetryable(path, RENDER_REASONS[rendered.code] ?? rendered.message)
        return { pages: charged, stop: false }
      }
      state.update((data) => {
        const file = (data.files[path] ??= { attempts: 0, updatedAt: 0 })
        file.totalPages = rendered.totalPages
        file.updatedAt = this.deps.now()
      })
      const doneNow = new Set(
        host.pagesDone(path, rendered.mtimeMs, rendered.sizeBytes).concat(done, skip),
      )
      const wanted = planOcrBatch({
        totalPages: rendered.totalPages,
        done: doneNow,
        maxPagesPerFile: settings.maxPagesPerFile,
        pagesPerCall: settings.pagesPerCall,
        budget: settings.pagesPerCall,
      })
      const pages = rendered.pages.filter((p) => wanted.includes(p.page))
      if (pages.length === 0) break // nothing left to read in this file
      const numbers = pages.map((p) => p.page)

      if (!counted) {
        counted = true
        state.update((data) => void (data.day.pdfs += 1))
      }
      this.callsThisRun++
      this.charge(pages.length, 1)
      charged += pages.length
      let response: Awaited<ReturnType<OcrJobDeps['recognize']>>
      try {
        response = await this.deps.recognize({
          model: settings.model,
          pages: numbers,
          images: pages.map((p) => p.jpeg),
          signal: signal ?? new AbortController().signal,
        })
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          this.refund(pages.length, 1)
          return { pages: charged - pages.length, stop: true }
        }
        const message = errorText(error)
        const kind = classifyAgyOcrError(message)
        if (haltsTheDay(kind)) {
          this.refund(pages.length, 1) // the service refused: nothing was read or billed
          this.haltDay(kind, message)
          return { pages: charged - pages.length, stop: true }
        }
        this.failFile(path, message)
        return { pages: charged, stop: true }
      }

      if (response.usage)
        state.update((data) => {
          data.day.inputTokens += response.usage?.inputTokens ?? 0
          data.day.outputTokens += response.usage?.outputTokens ?? 0
          data.day.thinkingTokens += response.usage?.thinkingTokens ?? 0
        })
      const parsed = parseAgyOcrOutput(response.text, numbers)
      const got: OcrPageText[] = numbers
        .filter((n) => parsed.pages.has(n))
        .map((n) => ({ page: n, text: parsed.pages.get(n) ?? '' }))
      if (got.length > 0) {
        try {
          host.savePages(
            path,
            {
              hash: rendered.hash,
              mtimeMs: rendered.mtimeMs,
              sizeBytes: rendered.sizeBytes,
              totalPages: rendered.totalPages,
              model: settings.model,
            },
            got,
          )
          options.touched.add(path)
        } catch (error) {
          this.failFile(path, errorText(error))
          return { pages: charged, stop: true }
        }
      }
      if (parsed.missing.length > 0) {
        // the answer did not cover every page: keep what we got, count an attempt, stop here
        this.failFile(
          path,
          `The answer was missing page ${parsed.missing.join(', ')}`,
          got.length > 0,
        )
        return { pages: charged, stop: true }
      }
      this.succeed(path, got.length)
      candidate = { ...candidate, pagesDone: candidate.pagesDone + got.length }
      // every page up to the file's limit is read: no further call (or usage read) for this file
      if (doneNow.size + got.length >= Math.min(rendered.totalPages, settings.maxPagesPerFile))
        break
    }
    return { pages: charged, stop: false }
  }

  // ---- state transitions ----

  private charge(pages: number, calls: number): void {
    this.deps.state.update((data) => {
      data.day.pages += pages
      data.day.calls += calls
    })
  }

  private refund(pages: number, calls: number): void {
    this.deps.state.update((data) => {
      data.day.pages = Math.max(0, data.day.pages - pages)
      data.day.calls = Math.max(0, data.day.calls - calls)
    })
  }

  private succeed(path: string, pages: number): void {
    this.deps.state.update((data) => {
      const file = (data.files[path] ??= { attempts: 0, updatedAt: 0 })
      file.attempts = 0
      delete file.reason
      file.updatedAt = this.deps.now()
      data.backoff = { failures: 0, until: 0 }
      data.lastResult = { at: this.deps.now(), pages, file: basename(path) }
      delete data.lastError
    })
  }

  /** A failed call: count it against the file and back off globally. Never retried in a loop. */
  private failFile(path: string, message: string, madeProgress = false): void {
    this.deps.state.update((data) => {
      const file = (data.files[path] ??= { attempts: 0, updatedAt: 0 })
      file.attempts += madeProgress ? 0 : 1
      file.updatedAt = this.deps.now()
      if (file.attempts >= OCR_MAX_FILE_ATTEMPTS) {
        file.nonRetryable = true
        file.reason = `Failed ${OCR_MAX_FILE_ATTEMPTS} times: ${message}`.slice(0, 300)
      }
      data.backoff.failures += 1
      data.backoff.until = this.deps.now() + ocrBackoffMs(data.backoff.failures)
      data.lastError = { at: this.deps.now(), message: message.slice(0, 300) }
    })
  }

  private markNonRetryable(path: string, reason: string): void {
    this.deps.state.update((data) => {
      const total = data.files[path]?.totalPages
      data.files[path] = {
        attempts: data.files[path]?.attempts ?? 0,
        ...(total !== undefined ? { totalPages: total } : {}),
        nonRetryable: true,
        reason,
        updatedAt: this.deps.now(),
      }
    })
  }

  private haltDay(kind: OcrErrorKind, message: string): void {
    const now = this.deps.now()
    this.deps.state.update((data) => {
      data.halted = {
        day: localDateKey(now, this.deps.timezoneOffset),
        kind,
        message: message.slice(0, 300),
        at: now,
      }
      data.lastError = { at: now, message: message.slice(0, 300) }
    })
  }

  private recordError(message: string): void {
    this.deps.state.update(
      (data) => void (data.lastError = { at: this.deps.now(), message: message.slice(0, 300) }),
    )
  }

  /** Queue re-extraction of every file that gained pages (once per file per run). */
  private flushReindex(touched: Set<string>): void {
    for (const path of touched) {
      try {
        this.deps.host.reindex(path)
      } catch (error) {
        this.recordError(errorText(error))
      }
    }
    touched.clear()
    this.waiting = null
  }

  /** A manual read: the pages just read become searchable text now, not when the line gets to it. */
  private async indexNow(touched: Set<string>): Promise<void> {
    const reindexNow = this.deps.host.reindexNow
    if (!reindexNow) return
    for (const path of [...touched]) {
      try {
        await reindexNow.call(this.deps.host, path)
        touched.delete(path)
      } catch (error) {
        // left in `touched`: it is queued the ordinary way when this read ends
        this.recordError(errorText(error))
      }
    }
  }

  // ---- manual read of one file ----

  /**
   * "Read with Antigravity now": one file, up to maxPagesPerFile, ignoring the quota thresholds,
   * the halt, the backoff and the gate. The caller has already asked the user to confirm. Pages
   * are still counted in today's totals.
   */
  async readNow(documentId: number): Promise<AgyOcrReadNowResult> {
    if (this.stopped) return { ok: false, error: 'unavailable' }
    if (this.running) return { ok: false, error: 'busy' }
    const document = this.deps.host.documentById(documentId)
    if (!document || !/\.pdf$/i.test(document.path)) return { ok: false, error: 'not-pdf' }
    const settings = this.workingSettings()
    const row = this.deps.host
      .candidates(settings.maxPagesPerFile)
      .find((candidate) => candidate.path === document.path)
    if (!row) {
      // Every page has been read already, but the file may never have taken the text in (the
      // earlier request to index it was queued and lost): read it into the index now.
      const reindexNow = this.deps.host.reindexNow
      if (!reindexNow) return { ok: false, error: 'nothing-to-read' }
      try {
        await reindexNow.call(this.deps.host, document.path)
        return { ok: true, pages: 0 }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    }
    this.running = true
    this.abort = new AbortController()
    this.callsThisRun = 0
    const touched = new Set<string>()
    const before = this.deps.state.today().pages
    const startedAt = this.deps.now()
    try {
      // a deliberate request outranks the earlier verdicts about this file
      this.deps.state.update((data) => {
        const file = data.files[document.path]
        if (file) {
          file.attempts = 0
          delete file.nonRetryable
          delete file.reason
        }
      })
      const outcome = await this.processFile(
        {
          path: row.path,
          sizeBytes: row.sizeBytes,
          lastOpenedAt: row.lastOpenedAt,
          mtimeMs: row.mtimeMs,
          pagesDone: row.pagesDone,
          ...(row.totalPages !== undefined ? { totalPages: row.totalPages } : {}),
        },
        settings,
        { manual: true, touched },
      )
      const state = this.deps.state.get()
      const file = state.files[document.path]
      const failure = file?.nonRetryable
        ? file.reason
        : state.lastError && state.lastError.at >= startedAt
          ? state.lastError.message
          : undefined
      const pages = this.deps.state.today().pages - before
      await this.indexNow(touched)
      if (touched.size === 0 && failure && (outcome.stop || file?.nonRetryable))
        return { ok: false, error: failure }
      return { ok: true, pages: Math.max(pages, outcome.pages) }
    } catch (error) {
      return { ok: false, error: errorText(error) }
    } finally {
      this.flushReindex(touched)
      this.running = false
      this.abort = null
    }
  }

  // ---- status for the UI ----

  status(): AgyOcrStatus {
    const settings = this.deps.settings()
    const state = this.deps.state.get()
    const today = this.deps.state.today()
    const now = this.deps.now()
    const decision = state.quota?.decision
    const live = (view: QuotaBucketView | undefined): AgyOcrBucketLive | undefined =>
      view
        ? {
            percent: Math.round(view.remaining * 1000) / 10,
            floor: Math.round(view.floor * 10) / 10,
            startAt: Math.round(view.startAt * 10) / 10,
            ignored: view.ignored,
            ...(view.nextFloor !== undefined ? { nextFloor: view.nextFloor } : {}),
            ...(view.nextFloorAt !== undefined ? { nextFloorAt: view.nextFloorAt } : {}),
          }
        : undefined
    const weekly = live(decision?.weekly)
    const fiveHour = live(decision?.fiveHour)
    return {
      settings,
      day: today.day,
      pdfsToday: today.pdfs,
      pagesToday: today.pages,
      tokensToday: {
        input: today.inputTokens,
        output: today.outputTokens,
        thinking: today.thinkingTokens,
      },
      callsToday: today.calls,
      filesWaiting: this.filesWaiting(settings, now),
      running: this.running,
      ...(state.quota && decision && (fiveHour || weekly)
        ? {
            quota: {
              ...(decision.group ? { group: decision.group } : {}),
              ...(fiveHour ? { fiveHour } : {}),
              ...(weekly ? { weekly } : {}),
              readAt: state.quota.at,
            },
          }
        : {}),
      ...(state.lastResult ? { lastResult: state.lastResult } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
      activity: this.activity(settings, now),
    }
  }

  private filesWaiting(settings: AgyOcrSettings, now: number): number {
    if (this.waiting && now - this.waiting.at < WAITING_CACHE_MS) return this.waiting.count
    let count: number
    try {
      count = this.eligible(settings.maxPagesPerFile).length
    } catch {
      count = this.waiting?.count ?? 0
    }
    this.waiting = { at: now, count }
    return count
  }

  private activity(settings: AgyOcrSettings, now: number): AgyOcrActivity {
    if (!settings.enabled) return { kind: 'off' }
    if (this.running) return { kind: 'working' }
    const state = this.deps.state.get()
    const day = localDateKey(now, this.deps.timezoneOffset)
    if (state.halted?.day === day) return { kind: 'halted', message: state.halted.message }
    if (state.backoff.until > now) return { kind: 'backoff', until: state.backoff.until }
    if (this.filesWaiting(settings, now) === 0) return { kind: 'nothing' }
    if (pdfCapReached(settings.maxPdfsPerDay, this.deps.state.today())) return { kind: 'cap' }
    const gate = evaluateOcrGate({
      settings,
      policy: this.deps.policy(),
      idleSeconds: this.deps.idleSeconds(),
    })
    if (!gate.ok) return { kind: 'gate', why: gate.reason }
    const decision = state.quota?.decision
    if (!decision) return { kind: 'checking' }
    switch (decision.kind) {
      case 'run':
        return { kind: 'working' }
      case 'unreadable':
        return { kind: 'quota-unreadable' }
      case 'unknown-group':
        return { kind: 'quota-unknown-group', ...(decision.group ? { group: decision.group } : {}) }
      case 'blocked': {
        const block = decision.blocking
        // the schedule or the refill has passed since the verdict: it is stale, the next check decides
        const due = block?.clearsAt ?? block?.resetAt
        if (!block || (due !== undefined && due <= now)) return { kind: 'checking' }
        return {
          kind: 'quota-blocked',
          window: block.window,
          percent: Math.round(block.remaining * 1000) / 10,
          floor: Math.round(block.floor * 10) / 10,
          startAt: Math.round(block.startAt * 10) / 10,
          belowFloor: block.belowFloor,
          ...(block.clearsAt !== undefined ? { clearsAt: block.clearsAt } : {}),
          ...(block.resetAt !== undefined ? { resetAt: block.resetAt } : {}),
        }
      }
    }
  }
}
