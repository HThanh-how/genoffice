/**
 * Persisted state of the scanned-PDF reader (`agy-ocr-state.json` in userData): today's page and
 * token counters (keyed by the LOCAL calendar day), the day-halt after a quota/auth error, the
 * global backoff and per-file attempt/non-retryable records. The OCR text itself lives in the
 * index database (see ocr-sidecar.ts); this file only carries bookkeeping, so losing it can at
 * worst re-spend a day's budget, never lose or duplicate text.
 */
import { randomUUID } from 'node:crypto'
import type { OcrAutoBudgetAccount } from './ocr-auto-budget'
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import {
  emptyDayCounters,
  localDateKey,
  type OcrDayCounters,
  type OcrErrorKind,
  type QuotaArmed,
  type QuotaDecision,
  type TimezoneOffset,
} from '@genoffice/ai-provider/agy-ocr'

export interface OcrFileState {
  /** failed attempts since the last success */
  attempts: number
  /** never tried again by the scheduler (a manual read may still try) */
  nonRetryable?: boolean
  /** plain-language reason, shown to the user */
  reason?: string
  totalPages?: number
  updatedAt: number
}

export interface OcrStateData {
  version: 1
  day: OcrDayCounters
  /** the whole day's run was stopped (quota / rate limit / sign-in / missing CLI) */
  halted?: { day: string; kind: OcrErrorKind; message: string; at: number }
  /** consecutive failed calls, and when the next call may start */
  backoff: { failures: number; until: number }
  /** per-bucket quota hysteresis: true = that bucket currently allows work */
  armed: QuotaArmed
  /** last /usage reading's verdict (what the UI shows while paused) */
  quota?: { at: number; decision: QuotaDecision }
  lastResult?: { at: number; pages: number; file: string }
  lastError?: { at: number; message: string; path?: string }
  lastRunAt?: number
  files: Record<string, OcrFileState>
  autoBudgets?: Record<string, OcrAutoBudgetAccount>
  manualQueue?: Array<{ id: number; path: string }>
  pendingReindexPaths?: string[]
}

export interface OcrStateFs {
  read(path: string): string | undefined
  write(path: string, text: string): void
}

const realFs: OcrStateFs = {
  read(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  },
  write(path, text) {
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx', flush: true })
      renameSync(temp, path)
    } catch (error) {
      try {
        unlinkSync(temp)
      } catch {
        // the temporary file may never have been created
      }
      throw error
    }
  },
}

const MAX_FILE_RECORDS = 4000

export function emptyOcrState(day: string): OcrStateData {
  return {
    version: 1,
    day: emptyDayCounters(day),
    backoff: { failures: 0, until: 0 },
    armed: { fiveHour: false, weekly: false },
    files: {},
  }
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** Tolerant parse: anything unreadable starts a fresh state instead of breaking the job. */
export function parseOcrState(text: string | undefined, fallbackDay: string): OcrStateData {
  const state = emptyOcrState(fallbackDay)
  if (!text) return state
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return state
  }
  if (!raw || typeof raw !== 'object') return state
  const r = raw as Record<string, unknown>
  const day = r.day as Record<string, unknown> | undefined
  if (day && typeof day.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day.day))
    state.day = {
      day: day.day,
      pdfs: num(day.pdfs),
      pages: num(day.pages),
      calls: num(day.calls),
      inputTokens: num(day.inputTokens),
      outputTokens: num(day.outputTokens),
      thinkingTokens: num(day.thinkingTokens),
    }
  const halted = r.halted as Record<string, unknown> | undefined
  if (halted && typeof halted.day === 'string' && typeof halted.message === 'string')
    state.halted = {
      day: halted.day,
      kind: (typeof halted.kind === 'string' ? halted.kind : 'other') as OcrErrorKind,
      message: halted.message,
      at: num(halted.at),
    }
  const backoff = r.backoff as Record<string, unknown> | undefined
  if (backoff) state.backoff = { failures: num(backoff.failures), until: num(backoff.until) }
  const armed = r.armed as Record<string, unknown> | undefined
  if (armed) state.armed = { fiveHour: armed.fiveHour === true, weekly: armed.weekly === true }
  const quota = r.quota as Record<string, unknown> | undefined
  if (
    quota &&
    typeof quota.at === 'number' &&
    quota.decision &&
    typeof quota.decision === 'object'
  ) {
    const kind = (quota.decision as { kind?: unknown }).kind
    if (['run', 'blocked', 'unreadable', 'unknown-group'].includes(String(kind)))
      state.quota = { at: quota.at, decision: quota.decision as QuotaDecision }
  }
  const last = r.lastResult as Record<string, unknown> | undefined
  if (last && typeof last.file === 'string')
    state.lastResult = { at: num(last.at), pages: num(last.pages), file: last.file }
  const error = r.lastError as Record<string, unknown> | undefined
  if (error && typeof error.message === 'string')
    state.lastError = {
      at: num(error.at),
      message: error.message,
      ...(typeof error.path === 'string' ? { path: error.path } : {}),
    }
  if (Array.isArray(r.manualQueue))
    state.manualQueue = r.manualQueue
      .filter((value): value is { id: number; path: string } => {
        if (!value || typeof value !== 'object') return false
        const item = value as Record<string, unknown>
        return (
          Number.isSafeInteger(item.id) &&
          Number(item.id) > 0 &&
          typeof item.path === 'string' &&
          item.path.length > 0 &&
          item.path.length <= 32_768
        )
      })
      .slice(0, 2000)
  if (Array.isArray(r.pendingReindexPaths))
    state.pendingReindexPaths = [
      ...new Set(
        r.pendingReindexPaths.filter(
          (path): path is string =>
            typeof path === 'string' && path.length > 0 && path.length <= 32_768,
        ),
      ),
    ].slice(0, 4000)
  if (typeof r.lastRunAt === 'number') state.lastRunAt = r.lastRunAt
  const files = r.files as Record<string, unknown> | undefined
  const budgets = r.autoBudgets as Record<string, unknown> | undefined
  if (budgets && typeof budgets === 'object') {
    state.autoBudgets = {}
    for (const [group, value] of Object.entries(budgets)) {
      if (!value || typeof value !== 'object') continue
      const b = value as Record<string, unknown>
      if (
        typeof b.day !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}\.\d{3}Z)?$/.test(b.day)
      )
        continue
      const account: OcrAutoBudgetAccount = {
        day: b.day,
        weeklySpent: num(b.weeklySpent),
        fiveHourSpent: num(b.fiveHourSpent),
        fiveHourResetAt: num(b.fiveHourResetAt),
        ...(num(b.weeklyResetAt) ? { weeklyResetAt: num(b.weeklyResetAt) } : {}),
      }
      const pending = b.pending as Record<string, unknown> | undefined
      if (pending && typeof pending.day === 'string')
        account.pending = {
          day: pending.day,
          fiveHourResetAt: num(pending.fiveHourResetAt),
          fiveHour: num(pending.fiveHour),
          weekly: num(pending.weekly),
          ...(pending.fiveHourObserved === true ? { fiveHourObserved: true } : {}),
          ...(pending.weeklyObserved === true ? { weeklyObserved: true } : {}),
        }
      state.autoBudgets[group] = account
    }
  }
  if (files && typeof files === 'object')
    for (const [path, value] of Object.entries(files)) {
      if (!value || typeof value !== 'object') continue
      const f = value as Record<string, unknown>
      state.files[path] = {
        attempts: num(f.attempts),
        ...(f.nonRetryable === true ? { nonRetryable: true } : {}),
        ...(typeof f.reason === 'string' ? { reason: f.reason } : {}),
        ...(typeof f.totalPages === 'number' ? { totalPages: f.totalPages } : {}),
        updatedAt: num(f.updatedAt),
      }
    }
  return state
}

/** Small write-through store around the JSON file. */
export class OcrStateStore {
  private data: OcrStateData
  private writeFailed = false

  hasPersistenceFailure(): boolean {
    return this.writeFailed
  }

  constructor(
    private readonly path: string,
    private readonly now: () => number,
    private readonly offset: TimezoneOffset,
    private readonly fs: OcrStateFs = realFs,
  ) {
    this.data = parseOcrState(fs.read(path), localDateKey(now(), offset))
  }

  get(): OcrStateData {
    return this.data
  }

  /** Mutate and persist. A failed write is swallowed: the in-memory state stays authoritative. */
  update(change: (data: OcrStateData) => void): OcrStateData {
    change(this.data)
    this.prune()
    try {
      this.fs.write(this.path, JSON.stringify(this.data))
      this.writeFailed = false
    } catch {
      this.writeFailed = true
      // an unwritable userData folder must not break the job; the next update retries
    }
    return this.data
  }

  /** Counters of the current local day (a new day starts again at zero). */
  today(): OcrDayCounters {
    const day = localDateKey(this.now(), this.offset)
    if (this.data.day.day !== day) this.update((data) => void (data.day = emptyDayCounters(day)))
    return this.data.day
  }

  private prune(): void {
    const entries = Object.entries(this.data.files)
    if (entries.length <= MAX_FILE_RECORDS) return
    // keep every non-retryable record (they stop wasted retries); drop the oldest others
    const keep = entries
      .filter(([, f]) => f.nonRetryable)
      .concat(
        entries.filter(([, f]) => !f.nonRetryable).sort((a, b) => b[1].updatedAt - a[1].updatedAt),
      )
      .slice(0, MAX_FILE_RECORDS)
    this.data.files = Object.fromEntries(keep)
  }
}
