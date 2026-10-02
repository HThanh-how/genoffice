/**
 * Scanned-PDF reader (Antigravity) settings, status and IPC channels (fork-only).
 * Persisted in app-settings.json under `agyOcr`; ON by default (it only runs while the
 * Antigravity CLI is signed in, on AC power and when idle). It sends page images of the user's
 * scanned documents to Google through their Antigravity account.
 *
 * The reader is quota-paced instead of page-limited. Each Antigravity quota bucket keeps a
 * reserve that shrinks over its window (a "glide floor"): the weekly bucket day by day (90% on
 * day 1, 80% on day 2 ... never below 20%), the 5-hour bucket linearly (85% at the start of its
 * window down to 70% at the end). Both are on by default, editable, and each can be ignored. The
 * same settings apply to whichever quota group the chosen model belongs to (Gemini, or Claude
 * and GPT), because only that group's buckets are read.
 */
import {
  AGY_OCR_DEFAULT_MODEL,
  OCR_DEFAULT_FIVE_HOUR_FLOOR_END,
  OCR_DEFAULT_FIVE_HOUR_FLOOR_START,
  OCR_DEFAULT_MAX_PAGES_PER_FILE,
  OCR_DEFAULT_MAX_PDFS_PER_DAY,
  OCR_DEFAULT_PAGES_PER_CALL,
  OCR_DEFAULT_WEEKLY_DROP_PER_DAY,
  OCR_DEFAULT_WEEKLY_FIRST_DAY_FLOOR,
  OCR_DEFAULT_WEEKLY_MIN_FLOOR,
  OCR_MAX_PAGES_PER_CALL,
  OCR_MAX_PAGES_PER_FILE,
  OCR_MAX_PDFS_PER_DAY,
  validFiveHourFloors,
  validWeeklyFloors,
  type RankedOcrModel,
} from '@genoffice/ai-provider/agy-ocr'

export const AGY_OCR_SETTINGS_KEY = 'agyOcr'

export interface AgyOcrSettings {
  enabled: boolean
  model: string
  /** optional cap on distinct PDFs per local day; 0 = unlimited */
  maxPdfsPerDay: number
  maxPagesPerFile: number
  pagesPerCall: number
  /** weekly reserve (percent of the weekly quota left untouched): day 1 floor, drop per day, minimum */
  weeklyFirstDayFloor: number
  weeklyDropPerDay: number
  weeklyMinFloor: number
  ignoreWeekly: boolean
  /** 5-hour reserve: linear from the first value at the start of its window to the second at its end */
  fiveHourFloorStart: number
  fiveHourFloorEnd: number
  ignoreFiveHour: boolean
  onlyOnAC: boolean
  onlyWhenIdle: boolean
}

export const DEFAULT_AGY_OCR_SETTINGS: AgyOcrSettings = {
  enabled: true,
  model: AGY_OCR_DEFAULT_MODEL,
  maxPdfsPerDay: OCR_DEFAULT_MAX_PDFS_PER_DAY,
  maxPagesPerFile: OCR_DEFAULT_MAX_PAGES_PER_FILE,
  pagesPerCall: OCR_DEFAULT_PAGES_PER_CALL,
  weeklyFirstDayFloor: OCR_DEFAULT_WEEKLY_FIRST_DAY_FLOOR,
  weeklyDropPerDay: OCR_DEFAULT_WEEKLY_DROP_PER_DAY,
  weeklyMinFloor: OCR_DEFAULT_WEEKLY_MIN_FLOOR,
  ignoreWeekly: false,
  fiveHourFloorStart: OCR_DEFAULT_FIVE_HOUR_FLOOR_START,
  fiveHourFloorEnd: OCR_DEFAULT_FIVE_HOUR_FLOOR_END,
  ignoreFiveHour: false,
  onlyOnAC: true,
  onlyWhenIdle: true,
}

// same shape agy-cli accepts (isSafeAgyModelId); duplicated here because agy-cli is Node-only
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/

function int(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Apply a partial update (renderer input is untrusted) on top of `base`; every field is validated. */
export function mergeAgyOcrSettings(base: AgyOcrSettings, patch: unknown): AgyOcrSettings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>
  // the three weekly numbers are valid only together (0 <= min <= first <= 100); else the old ones stay
  const first = int(p.weeklyFirstDayFloor, 0, 100, base.weeklyFirstDayFloor)
  const drop = int(p.weeklyDropPerDay, 0, 100, base.weeklyDropPerDay)
  const min = int(p.weeklyMinFloor, 0, 100, base.weeklyMinFloor)
  const weeklyOk = validWeeklyFloors(first, drop, min)
  const start = int(p.fiveHourFloorStart, 0, 100, base.fiveHourFloorStart)
  const end = int(p.fiveHourFloorEnd, 0, 100, base.fiveHourFloorEnd)
  const fiveOk = validFiveHourFloors(start, end)
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : base.enabled,
    model:
      typeof p.model === 'string' && MODEL_ID.test(p.model.trim()) ? p.model.trim() : base.model,
    maxPdfsPerDay: int(p.maxPdfsPerDay, 0, OCR_MAX_PDFS_PER_DAY, base.maxPdfsPerDay),
    maxPagesPerFile: int(p.maxPagesPerFile, 0, OCR_MAX_PAGES_PER_FILE, base.maxPagesPerFile),
    pagesPerCall: int(p.pagesPerCall, 1, OCR_MAX_PAGES_PER_CALL, base.pagesPerCall),
    weeklyFirstDayFloor: weeklyOk ? first : base.weeklyFirstDayFloor,
    weeklyDropPerDay: weeklyOk ? drop : base.weeklyDropPerDay,
    weeklyMinFloor: weeklyOk ? min : base.weeklyMinFloor,
    ignoreWeekly: typeof p.ignoreWeekly === 'boolean' ? p.ignoreWeekly : base.ignoreWeekly,
    fiveHourFloorStart: fiveOk ? start : base.fiveHourFloorStart,
    fiveHourFloorEnd: fiveOk ? end : base.fiveHourFloorEnd,
    ignoreFiveHour: typeof p.ignoreFiveHour === 'boolean' ? p.ignoreFiveHour : base.ignoreFiveHour,
    onlyOnAC: typeof p.onlyOnAC === 'boolean' ? p.onlyOnAC : base.onlyOnAC,
    onlyWhenIdle: typeof p.onlyWhenIdle === 'boolean' ? p.onlyWhenIdle : base.onlyWhenIdle,
  }
}

/** Settings as stored in app-settings.json; anything missing or invalid falls back to the defaults (OFF). */
export function agyOcrSettingsFrom(stored: Record<string, unknown>): AgyOcrSettings {
  return mergeAgyOcrSettings(DEFAULT_AGY_OCR_SETTINGS, stored[AGY_OCR_SETTINGS_KEY])
}

/** One quota bucket as the UI shows it, in percent. */
export interface AgyOcrBucketLive {
  /** percent left, as last read */
  percent: number
  /** the reserve in force now */
  floor: number
  /** percent needed to start a batch (floor + margin) */
  startAt: number
  /** weekly: tomorrow's floor and when it takes effect (epoch ms) */
  nextFloor?: number
  nextFloorAt?: number
  /** the bucket is switched off by the user ("Ignore this limit") */
  ignored: boolean
}

/** What the reader is doing / waiting for, in terms the UI can phrase. */
export type AgyOcrActivity =
  | { kind: 'off' }
  /** reading now, or allowed and due at the next check */
  | { kind: 'working' }
  /** enabled; the quota has not been read yet */
  | { kind: 'checking' }
  | { kind: 'nothing' }
  | { kind: 'gate'; why: string }
  /** the optional PDFs-per-day cap is used up; resumes tomorrow */
  | { kind: 'cap' }
  /** quota / rate limit / sign-in error stopped today's run */
  | { kind: 'halted'; message: string }
  | { kind: 'backoff'; until: number }
  | {
      kind: 'quota-blocked'
      window: '5h' | 'weekly'
      /** percent left */
      percent: number
      floor: number
      startAt: number
      /** below the floor itself (false: just inside the margin above it) */
      belowFloor: boolean
      /** when the floor schedule lets work resume; absent = only when the quota refills */
      clearsAt?: number
      resetAt?: number
    }
  | { kind: 'quota-unreadable' }
  | { kind: 'quota-unknown-group'; group?: string }

export interface AgyOcrStatus {
  settings: AgyOcrSettings
  /** local calendar day the counters belong to */
  day: string
  pdfsToday: number
  pagesToday: number
  tokensToday: { input: number; output: number; thinking: number }
  callsToday: number
  /** scanned PDFs that still have pages to read */
  filesWaiting: number
  running: boolean
  /** latest quota reading for the model's group (undefined = never read) */
  quota?: {
    group?: string
    readAt: number
    weekly?: AgyOcrBucketLive
    fiveHour?: AgyOcrBucketLive
  }
  lastResult?: { at: number; pages: number; file: string }
  lastError?: { at: number; message: string }
  activity: AgyOcrActivity
}

export const AGY_OCR_CHANNELS = {
  getState: 'agy-ocr:get-state',
  setSettings: 'agy-ocr:set-settings',
  listModels: 'agy-ocr:list-models',
  readNow: 'agy-ocr:read-now',
} as const

export interface AgyOcrModelList {
  models: RankedOcrModel[]
  error?: string
}

export interface AgyOcrReadNowResult {
  ok: boolean
  pages?: number
  /** 'busy' | 'unavailable' | 'not-pdf' | 'nothing-to-read' | plain-language reason */
  error?: string
}

/** Renderer-facing methods, merged into HomeApi via ForkHomeApi. */
export interface AgyOcrApi {
  getAgyOcrStatus(): Promise<AgyOcrStatus | null>
  setAgyOcrSettings(patch: Partial<AgyOcrSettings>): Promise<AgyOcrSettings | null>
  listAgyOcrModels(): Promise<AgyOcrModelList>
  /** Read one scanned PDF now, ignoring the quota floors; `confirmed` must be true (explicit consent). */
  readScannedPdfWithAgy(documentId: number, confirmed: boolean): Promise<AgyOcrReadNowResult>
}
