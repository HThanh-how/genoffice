import { executePostWriteAccounting } from './post-write-accounting'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { getValidatedFreeDiskBytes } from './content-write-budget'
import type { StorageAdmissionController } from './storage-admission'
import type { MaintenanceScheduler } from './maintenance-scheduler'
import type { StorageBudgetCoordinator } from './storage-budget-coordinator'
import { hardCapBytes, type StorageBudgetSnapshot } from '../storage-budget'
import type { DocumentMemoryStore } from '../store'
import type { OcrFileMeta, OcrPageText } from '../ocr-sidecar'
import type { OcrRenderRequest, OcrRenderResult } from '../agy-ocr-render'

export const BASE_OCR_ROW_BYTES = 256
export const BASE_OCR_METADATA_BYTES = 1024
export const OCR_WAL_MULTIPLIER = 1.5
export const CONSERVATIVE_OCR_HEADROOM_BYTES = 10 * 1024 * 1024 // 10 MB headroom
export const MAX_SINGLE_PAGE_TEXT_CHARS = 32_768
export const MAX_SINGLE_PAGE_TEXT_BYTES = 128 * 1024 // 128 KB
export const OCR_DEFAULT_TTL_MS = 60_000
export const MAX_BOUNDED_RENDER_PAGES = 50
export const ESTIMATED_RENDER_RAM_BYTES_PER_PAGE = 256 * 1024 // 256 KB RAM per rendered JPEG

export interface OcrSavePagesResult {
  ok: boolean
  savedCount?: number
  error?: string
  code?: 'quota-denied' | 'disk-space-insufficient' | 'accounting-degraded' | 'aborted' | 'invalid' | 'io-error'
}

/**
 * Validates and safely bounds OCR render request page count.
 * Uses real properties count, maxPages, done from OcrRenderRequest.
 */
export function validateBoundedRenderCount(request: unknown): number {
  if (!request || typeof request !== 'object') return 1
  const req = request as Partial<OcrRenderRequest>
  const count =
    typeof req.count === 'number' && Number.isSafeInteger(req.count) && req.count > 0 ? req.count : 1
  const maxPages =
    typeof req.maxPages === 'number' && Number.isSafeInteger(req.maxPages) && req.maxPages > 0
      ? req.maxPages
      : 1000
  const doneCount = Array.isArray(req.done) ? req.done.length : 0
  const remaining = Math.max(1, maxPages - doneCount)
  const bounded = Math.min(count, remaining)
  return Math.max(1, Math.min(bounded, MAX_BOUNDED_RENDER_PAGES))
}

/**
 * Calculates conservative on-disk write byte footprint for a single OCR page row.
 * Accounts for UTF-8 text, path, model, schema fields, B-tree record header,
 * and SQLite WAL write amplification (1.5x).
 */
export function estimateSingleOcrPageBytes(
  path: string,
  page: { page: number; text: string },
  model?: string,
): number {
  const textBytes = Buffer.byteLength(page.text || '', 'utf8')
  const pathBytes = Buffer.byteLength(path || '', 'utf8')
  const modelBytes = Buffer.byteLength(model || '', 'utf8')
  // Row payload: text, path, model, hash (64), mtime_ms (8), size_bytes (8), total_pages (8), page (8), created_at (8)
  const rowBytes = textBytes + pathBytes + modelBytes + BASE_OCR_ROW_BYTES + 104
  const est = Math.ceil(rowBytes * OCR_WAL_MULTIPLIER)
  return Number.isSafeInteger(est) && est > 512 ? est : 512
}

/**
 * Calculates total conservative on-disk write bytes for a batch of OCR pages,
 * adding base metadata / WAL overhead floor.
 */
export function estimateOcrBatchBytes(
  path: string,
  pages: readonly { page: number; text: string }[],
  model?: string,
): number {
  let total = BASE_OCR_METADATA_BYTES
  for (const page of pages) {
    total += estimateSingleOcrPageBytes(path, page, model)
  }
  return total
}

export interface SanitizeOcrPagesResult {
  pages: Array<{ page: number; text: string }>
  truncated: boolean
  truncatedPages: number[]
}

/**
 * Truthfully bounds oversized individual recognized page texts without corrupting raw files.
 * Enforces both character limit and byte limit per page.
 */
export function sanitizeOcrPages(
  pages: readonly { page: number; text: string }[],
  maxChars = MAX_SINGLE_PAGE_TEXT_CHARS,
  maxBytes = MAX_SINGLE_PAGE_TEXT_BYTES,
): SanitizeOcrPagesResult {
  let truncated = false
  const truncatedPages: number[] = []
  const safePages: Array<{ page: number; text: string }> = []

  for (const p of pages) {
    let text = typeof p.text === 'string' ? p.text : ''
    let pageTruncated = false
    if (text.length > maxChars) {
      text = text.slice(0, maxChars)
      pageTruncated = true
    }
    while (text.length > 0 && Buffer.byteLength(text, 'utf8') > maxBytes) {
      const excess = Buffer.byteLength(text, 'utf8') - maxBytes
      const charsToRemove = Math.max(1, Math.ceil(excess / 4))
      text = text.slice(0, Math.max(0, text.length - charsToRemove))
      pageTruncated = true
    }
    if (pageTruncated) {
      truncated = true
      truncatedPages.push(p.page)
    }
    safePages.push({ page: p.page, text })
  }
  return { pages: safePages, truncated, truncatedPages }
}

/**
 * Safely releases an OCR reservation only if it matches the caller's unique owner token.
 * Prevents releasing somebody else's lease when tasks recycle or cancel concurrently.
 */
export function safeReleaseOcrLease(
  admission: StorageAdmissionController,
  reservationId: string,
  ownerToken?: string,
): boolean {
  if (!ownerToken) return false
  const existing = admission.listReservations().find((r) => r.id === reservationId)
  if (existing && existing.ownerId === ownerToken) {
    return admission.release(reservationId)
  }
  return false
}

export interface PersistOcrPagesParams {
  store: Pick<DocumentMemoryStore, 'ocr'>
  admission: StorageAdmissionController
  maintScheduler: MaintenanceScheduler
  budgetCoord: StorageBudgetCoordinator
  dbDir: string
  path: string
  meta: OcrFileMeta
  pages: readonly OcrPageText[]
  isStopped?: () => boolean
  isEnabled?: () => boolean
  headroomBytes?: number
}

/**
 * Central admission gate and persistence executor for transcribed OCR pages.
 * Enforces:
 * - Pre-admission stopped/enabled and write-ready checks
 * - Page text byte/character sanitization
 * - Statfs physical disk space and headroom checks
 * - Fresh physical accounting measurement (fail-closed on unknown/degraded)
 * - Post-await source file mtime/size freshness guard
 * - Central admission reservation with unique owner token
 * - Synchronous SQLite persistence (no awaits in transaction)
 * - Post-commit physical refresh before lease release
 * - Exact-owner lease release
 */
export async function persistOcrPagesGated(
  params: PersistOcrPagesParams,
): Promise<OcrSavePagesResult> {
  const { store, admission, maintScheduler, budgetCoord, dbDir, path, meta, pages } = params

  if (params.isStopped?.() || (params.isEnabled && !params.isEnabled())) {
    return { ok: false, code: 'aborted', error: 'Document memory is stopped or disabled' }
  }

  if (!budgetCoord.isWriteReady()) {
    return {
      ok: false,
      code: 'quota-denied',
      error: 'Storage quota config pending worker confirmation',
    }
  }

  if (pages.length > MAX_BOUNDED_RENDER_PAGES) return { ok: false, code: 'invalid', error: 'OCR batch exceeds page limit' }
  const sanitized = sanitizeOcrPages(pages)
  if (sanitized.truncated) return { ok: false, code: 'invalid', error: 'OCR page text exceeds storage limits; no pages were saved' }
  if (sanitized.pages.length === 0) {
    return { ok: true, savedCount: 0 }
  }

  const estimatedBytes = estimateOcrBatchBytes(path, sanitized.pages, meta.model)
  const headroom = params.headroomBytes ?? CONSERVATIVE_OCR_HEADROOM_BYTES

  // 1. Physical disk headroom verification via statfs
  const freeDiskBytes = await getValidatedFreeDiskBytes(dbDir)
  if (freeDiskBytes === null || freeDiskBytes < estimatedBytes + headroom) {
    return {
      ok: false,
      code: 'disk-space-insufficient',
      error: `Insufficient disk space: required ${estimatedBytes + headroom} bytes, available ${freeDiskBytes} bytes`,
    }
  }

  // 2. Fresh physical measurement
  let snap: StorageBudgetSnapshot | null
  try {
    snap = await maintScheduler.refreshAccountingAsync()
  } catch (err) {
    return {
      ok: false,
      code: 'accounting-degraded',
      error: `Failed to refresh storage accounting: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (!snap || snap.isDegraded === true || snap.measurementStatus === 'unknown') {
    return {
      ok: false,
      code: 'accounting-degraded',
      error: 'Storage accounting is in an unknown or degraded state',
    }
  }

  // 3. Post-await guards: re-check stopped/enabled
  if (params.isStopped?.() || (params.isEnabled && !params.isEnabled())) {
    return { ok: false, code: 'aborted', error: 'Document memory stopped during accounting check' }
  }

  // 4. Source file freshness verification (source mtime/size guard)
  try {
    const currentStat = await stat(path)
    if (currentStat.mtimeMs !== meta.mtimeMs || currentStat.size !== meta.sizeBytes) {
      return {
        ok: false,
        code: 'invalid',
        error: 'Document changed on disk during OCR recognition; discarding stale transcription',
      }
    }
  } catch (err) {
    return {
      ok: false,
      code: 'invalid',
      error: `Source document inaccessible: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (params.isStopped?.() || (params.isEnabled && !params.isEnabled())) return { ok: false, code: 'aborted', error: 'OCR persistence cancelled' }
  if (!budgetCoord.isWriteReady()) return { ok: false, code: 'quota-denied', error: 'Storage budget is pending' }

  // 5. Central admission reserve with unique owner token
  const ownerToken = randomUUID()
  const reservationId = `ocr-save:${path}:${ownerToken}`
  const currentUsageBytes = snap.totalManagedBytes ?? snap.databaseBytes
  // Grace zone: OCR text is content; it is admitted up to the HARD cap, never beyond
  const budgetBytes = hardCapBytes(maintScheduler.budget)

  const decision = admission.reserve({
    reservationId,
    type: 'ocr',
    estimatedBytes,
    currentUsageBytes,
    budgetBytes,
    ttlMs: OCR_DEFAULT_TTL_MS,
    ownerId: ownerToken,
    holdUntilJobEnds: true,
    isAlive: () => !(params.isStopped?.() ?? false),
    options: {
      headroomBytes: headroom,
      freeDiskBytes: freeDiskBytes ?? undefined,
      accountingDegraded: snap.isDegraded,
      ownerId: ownerToken,
    },
  })

  if (!decision.admitted) {
    return {
      ok: false,
      code: 'quota-denied',
      error: decision.error ?? 'Storage quota denied OCR persistence',
    }
  }

  try {
    store.ocr.savePages(path, meta, sanitized.pages)
  } finally {
    await executePostWriteAccounting({
      maintScheduler, admission, reservationId, ownerToken, context: 'ocr-persistence-terminal',
      isStopped: params.isStopped,
    })
  }

  return {
    ok: true,
    savedCount: sanitized.pages.length,
  }
}

export interface ReserveOcrRenderParams {
  admission: StorageAdmissionController
  maintScheduler: MaintenanceScheduler
  budgetCoord: StorageBudgetCoordinator
  dbDir: string
  path: string
  request: OcrRenderRequest
  isStopped?: () => boolean
  isEnabled?: () => boolean
  workerTimeoutMs?: number
  askWorker: (req: any, timeoutMs?: number) => Promise<any>
}

/**
 * Gated OCR render execution in worker.
 * Bounded page count from actual OcrRenderRequest (count/maxPages/done).
 * Unique owner token prevents same-path collision.
 */
export async function executeOcrRenderGated(
  params: ReserveOcrRenderParams,
): Promise<OcrRenderResult | null> {
  const { admission, maintScheduler, budgetCoord, path, request, askWorker, workerTimeoutMs } =
    params

  if (params.isStopped?.() || (params.isEnabled && !params.isEnabled())) {
    return { ok: false, code: 'render', message: 'Document memory stopped or disabled' }
  }

  if (!budgetCoord.isWriteReady()) {
    return {
      ok: false,
      code: 'render',
      message: 'Storage quota config pending worker confirmation',
    }
  }

  const boundedCount = validateBoundedRenderCount(request)
  const estBytes = Math.max(64 * 1024, boundedCount * ESTIMATED_RENDER_RAM_BYTES_PER_PAGE)

  const snap = maintScheduler.checkStorageBudget()
  const currentUsage = snap.totalManagedBytes ?? snap.databaseBytes
  const budgetBytes = hardCapBytes(maintScheduler.budget)
  const ownerToken = randomUUID()
  const resId = `ocr-render:${path}:${ownerToken}`

  const dec = admission.reserve({
    reservationId: resId,
    type: 'ocr',
    estimatedBytes: estBytes,
    currentUsageBytes: currentUsage,
    budgetBytes,
    ttlMs: Math.max(60_000, (workerTimeoutMs ?? 60_000) + 10_000),
    ownerId: ownerToken,
    holdUntilJobEnds: true,
    isAlive: () => !(params.isStopped?.() ?? false),
    options: {
      accountingDegraded: snap.isDegraded,
      ownerId: ownerToken,
    },
  })

  if (!dec.admitted) {
    return {
      ok: false,
      code: 'render',
      message: dec.error ?? 'Storage quota denied OCR render',
    }
  }

  try {
    const reply = await askWorker({ type: 'ocr-render', path, ocr: { ...request, count: boundedCount } }, workerTimeoutMs)
    if (params.isStopped?.()) {
      return { ok: false, code: 'render', message: 'Render cancelled because document memory was stopped' }
    }
    return reply && 'result' in reply
      ? (reply.result as OcrRenderResult)
      : {
          ok: false,
          code: 'render',
          message:
            reply && 'error' in reply && typeof (reply as any).error === 'string'
              ? (reply as any).error
              : 'Render failed',
        }
  } finally {
    safeReleaseOcrLease(admission, resId, ownerToken)
  }
}
