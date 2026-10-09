import { statfs } from 'node:fs/promises'
import type { DocumentMemoryStore } from '../store'
import {
  type StorageAdmissionController,
  type ResizeDecision,
  safeReleaseExactOwnerReservation,
} from './storage-admission'
import type { MaintenanceScheduler } from './maintenance-scheduler'
import type { StorageBudgetCoordinator } from './storage-budget-coordinator'
import { hardCapBytes, contentWriteCapBytes, type StorageBudgetSnapshot } from '../storage-budget'
import type { ExtractResult } from './extraction-coordinator'
import type {
  SliceOptions,
  BatchSliceInfo,
  BatchCommitInfo,
  BatchHookDecision,
} from '../storage/repositories/document-repository'
import { extractedStatus } from './extraction-coordinator'
import { safeError } from '../issues'
import type { ImportanceClass } from './value-density'

export const CONTENT_BATCH_MAX_BYTES = 256 * 1024 // 256 KB estimated per batch
export const CONTENT_BATCH_MAX_CHUNKS = 50 // 50 chunks per batch
export const CONTENT_WRITE_SLICE_MS = 8 // 8 ms time budget per batch
export const MAX_SINGLE_CHUNK_TEXT_CHARS = 32_768 // Truthful ceiling for single chunk
export const CONSERVATIVE_HEADROOM_BYTES = 10 * 1024 * 1024 // 10 MB conservative headroom
export const STALE_ACCOUNTING_CUTOFF_MS = 60_000 // 1 minute stale cutoff
export const FTS_TEXT_MULTIPLIER = 2.0
export const WAL_WRITE_MULTIPLIER = 1.5
export const BASE_CHUNK_ROW_BYTES = 256
export const BASE_METADATA_WRITE_BYTES = 1024 // Conservative overhead for document row, set, and WAL

export interface ExtractWriteResult {
  written: boolean
  error?: string
  reason?: string
  isDiskFull?: boolean
  deferred?: boolean
}

export interface SanitizeChunksResult {
  chunks: Array<{ text: string; location: string; vector?: number[] }>
  truncated: boolean
  truncatedReason?: 'content-limit' | 'chunk-limit'
}

/**
 * Calculates conservative on-disk byte footprint for a single chunk.
 * Includes UTF-8 text, location, vector metadata, FTS5 index expansion,
 * table row / B-tree overhead, and SQLite WAL write amplification.
 */
export function estimateSingleChunkBytes(chunk: {
  text: string
  location?: string
  vector?: number[]
}): number {
  const textBytes = Buffer.byteLength(chunk.text || '', 'utf8')
  const locBytes = Buffer.byteLength(chunk.location || '', 'utf8')
  const vectorBytes = chunk.vector && Array.isArray(chunk.vector) ? chunk.vector.length * 4 + 64 : 0
  const ftsBytes = Math.ceil(textBytes * FTS_TEXT_MULTIPLIER) + 128
  const rowBytes = textBytes + locBytes + vectorBytes + BASE_CHUNK_ROW_BYTES + ftsBytes
  const est = Math.ceil(rowBytes * WAL_WRITE_MULTIPLIER)
  return Number.isSafeInteger(est) && est > 512 ? est : 512
}

/**
 * Calculates total conservative on-disk write bytes for remaining chunks,
 * including base metadata/FTS/WAL growth overhead.
 */
export function estimateTotalChunksBytes(
  chunks: Array<{ text: string; location?: string; vector?: number[] }>,
  startIndex = 0,
): number {
  let total = BASE_METADATA_WRITE_BYTES
  for (let i = startIndex; i < chunks.length; i++) {
    const chunk = chunks[i]
    if (chunk) {
      total += estimateSingleChunkBytes(chunk)
    }
  }
  return total
}

/**
 * Truthfully bounds oversized individual chunks without corrupting raw files.
 * Marks truncation flag and truthful reason ('content-limit') if text was capped.
 * Enforces both character limit and single-chunk byte limit.
 */
export function sanitizeReplacementChunks(
  rawChunks: Array<{ text: string; location: string; vector?: number[] }>,
  maxCharsPerChunk = MAX_SINGLE_CHUNK_TEXT_CHARS,
  maxBytesPerChunk = CONTENT_BATCH_MAX_BYTES,
): SanitizeChunksResult {
  let truncated = false
  let truncatedReason: 'content-limit' | 'chunk-limit' | undefined = undefined
  const safeChunks: Array<{ text: string; location: string; vector?: number[] }> = []

  for (let i = 0; i < rawChunks.length; i++) {
    const c = rawChunks[i]!
    let text = c.text ?? ''
    if (text.length > maxCharsPerChunk) {
      text = text.slice(0, maxCharsPerChunk)
      truncated = true
      truncatedReason = 'content-limit'
    }

    const testChunk = {
      ...c,
      text,
      location: c.location ?? `Chunk ${i + 1}`,
    }

    while (testChunk.text.length > 0 && estimateSingleChunkBytes(testChunk) > maxBytesPerChunk) {
      const excess = estimateSingleChunkBytes(testChunk) - maxBytesPerChunk
      const charsToRemove = Math.max(1, Math.ceil(excess / 4))
      testChunk.text = testChunk.text.slice(0, Math.max(0, testChunk.text.length - charsToRemove))
      truncated = true
      truncatedReason = 'content-limit'
    }

    safeChunks.push(testChunk)
  }

  return {
    chunks: safeChunks,
    truncated,
    truncatedReason,
  }
}

/**
 * Asynchronously checks and validates available disk space via statfs.
 * Strictly validates safe non-negative integer product; returns null on unreadable or unsafe bounds.
 */
export async function getValidatedFreeDiskBytes(dirPath: string): Promise<number | null> {
  try {
    const stat = await statfs(dirPath)
    const bavail = Number(stat.bavail)
    const bsize = Number(stat.bsize)
    if (
      Number.isSafeInteger(bavail) &&
      Number.isSafeInteger(bsize) &&
      bavail >= 0 &&
      bsize > 0
    ) {
      const product = bavail * bsize
      if (Number.isSafeInteger(product) && product >= 0) {
        return product
      }
    }
  } catch {
    // Non-fatal if statfs unsupported on platform
  }
  return null
}

/**
 * Retrieves fresh accounting snapshot from MaintenanceScheduler contract.
 * Automatically refreshes if snapshot is stale, unknown, or if forceRefresh is requested.
 * Strictly refuses unknown/degraded states without assuming a false zero usage.
 */
export async function getFreshValidatedAccounting(
  maintScheduler: MaintenanceScheduler,
  forceRefresh = false,
): Promise<{
  snapshot: StorageBudgetSnapshot | null
  valid: boolean
  error?: string
}> {
  let snap = maintScheduler.getLastBudgetSnapshot()
  const now = Date.now()
  const isStale = !snap || !snap.measuredAt || now - snap.measuredAt > STALE_ACCOUNTING_CUTOFF_MS
  const isUnknownOrDegraded = !snap || snap.measurementStatus === 'unknown' || snap.isDegraded === true

  if (forceRefresh || isStale || isUnknownOrDegraded) {
    try {
      snap = await maintScheduler.refreshAccountingAsync()
    } catch (err) {
      return {
        snapshot: null,
        valid: false,
        error: `Failed to refresh storage accounting: ${safeError(err)}`,
      }
    }
  }

  if (!snap) {
    return {
      snapshot: null,
      valid: false,
      error: 'Storage accounting snapshot is null',
    }
  }

  if (snap.isDegraded === true || snap.measurementStatus === 'unknown') {
    return {
      snapshot: snap,
      valid: false,
      error: 'Storage accounting is in an unknown or degraded state',
    }
  }

  // 'full' = hard stop (usage >= hard cap = soft quota + overshoot). The grace zone (soft quota <= usage < hard
  // cap) stays valid: content writes are still admitted, but every reservation is projected against the hard cap.
  const usedBytes = snap.totalManagedBytes ?? snap.databaseBytes
  const liveBudget = maintScheduler.budget
  if (snap.limitState === 'full' || (liveBudget && usedBytes >= hardCapBytes(liveBudget))) {
    return {
      snapshot: snap,
      valid: false,
      error: 'Storage limit reached: database is full',
    }
  }

  return {
    snapshot: snap,
    valid: true,
  }
}

/**
 * Resizes the extraction lease `extract:<path>` via C2 `checkedResize`.
 * Excludes own lease from projected usage, incorporates all other active leases,
 * enforces conservative headroom, and checks validated free disk space.
 * Fails closed if free disk space cannot be verified (disk unknown).
 */
export interface ResizeExtractionLeaseParams {
  admission: StorageAdmissionController
  reservationId: string
  remainingBytes: number
  maintScheduler: MaintenanceScheduler
  dbDir: string
  forceRefresh?: boolean
  ownerToken?: string
  isCurrent?: () => boolean
  isWriteReady?: () => boolean
}

/**
 * Resizes the extraction lease `extract:<path>` via C2 `checkedResize`.
 * Excludes own lease from projected usage, incorporates all other active leases,
 * enforces conservative headroom, and checks validated free disk space.
 * Fails closed if free disk space cannot be verified (disk unknown) or lifecycle invalid.
 */
export async function resizeExtractionLease(
  params: ResizeExtractionLeaseParams,
): Promise<ResizeDecision> {
  const {
    admission,
    reservationId,
    remainingBytes,
    maintScheduler,
    dbDir,
    forceRefresh,
    ownerToken,
    isCurrent,
    isWriteReady,
  } = params

  if (isCurrent && !isCurrent()) {
    return {
      admitted: false,
      resized: false,
      reason: 'invalid-parameters',
      reservationId,
      previousBytes: 0,
      newBytes: remainingBytes,
      currentBytes: 0,
      reservedBytes: admission.getReservedBytes(),
      budgetBytes: contentWriteCapBytes(maintScheduler.budget),
      projectedBytes: 0,
      projectedUsageRatio: 1.0,
      error: 'Task is no longer current (cancelled or superseded)',
    }
  }

  if (isWriteReady && !isWriteReady()) {
    return {
      admitted: false,
      resized: false,
      reason: 'quota-exhausted',
      reservationId,
      previousBytes: 0,
      newBytes: remainingBytes,
      currentBytes: 0,
      reservedBytes: admission.getReservedBytes(),
      budgetBytes: contentWriteCapBytes(maintScheduler.budget),
      projectedBytes: 0,
      projectedUsageRatio: 1.0,
      error: 'Write gate closed pending quota confirmation',
    }
  }

  const accounting = await getFreshValidatedAccounting(maintScheduler, forceRefresh)

  if (isCurrent && !isCurrent()) {
    return {
      admitted: false,
      resized: false,
      reason: 'invalid-parameters',
      reservationId,
      previousBytes: 0,
      newBytes: remainingBytes,
      currentBytes: 0,
      reservedBytes: admission.getReservedBytes(),
      budgetBytes: contentWriteCapBytes(maintScheduler.budget),
      projectedBytes: 0,
      projectedUsageRatio: 1.0,
      error: 'Task is no longer current after accounting refresh',
    }
  }

  if (isWriteReady && !isWriteReady()) {
    return {
      admitted: false,
      resized: false,
      reason: 'quota-exhausted',
      reservationId,
      previousBytes: 0,
      newBytes: remainingBytes,
      currentBytes: 0,
      reservedBytes: admission.getReservedBytes(),
      budgetBytes: contentWriteCapBytes(maintScheduler.budget),
      projectedBytes: 0,
      projectedUsageRatio: 1.0,
      error: 'Write gate closed after accounting refresh',
    }
  }

  if (!accounting.valid || !accounting.snapshot) {
    return {
      admitted: false,
      resized: false,
      reason: 'accounting-unknown',
      reservationId,
      previousBytes: 0,
      newBytes: remainingBytes,
      currentBytes: 0,
      reservedBytes: admission.getReservedBytes(),
      budgetBytes: contentWriteCapBytes(maintScheduler.budget),
      projectedBytes: 0,
      projectedUsageRatio: 1.0,
      error: accounting.error ?? 'Storage accounting is unknown or degraded',
    }
  }

  const snap = accounting.snapshot
  const freeDiskBytes = await getValidatedFreeDiskBytes(dbDir)

  if (isCurrent && !isCurrent()) {
    return {
      admitted: false,
      resized: false,
      reason: 'invalid-parameters',
      reservationId,
      previousBytes: 0,
      newBytes: remainingBytes,
      currentBytes: 0,
      reservedBytes: admission.getReservedBytes(),
      budgetBytes: contentWriteCapBytes(maintScheduler.budget),
      projectedBytes: 0,
      projectedUsageRatio: 1.0,
      error: 'Task is no longer current after disk check',
    }
  }

  if (isWriteReady && !isWriteReady()) {
    return {
      admitted: false,
      resized: false,
      reason: 'quota-exhausted',
      reservationId,
      previousBytes: 0,
      newBytes: remainingBytes,
      currentBytes: 0,
      reservedBytes: admission.getReservedBytes(),
      budgetBytes: contentWriteCapBytes(maintScheduler.budget),
      projectedBytes: 0,
      projectedUsageRatio: 1.0,
      error: 'Write gate closed after disk check',
    }
  }

  // Live budget captured strictly after all asynchronous checks
  const budgetBytes = contentWriteCapBytes(maintScheduler.budget)
  const currentUsageBytes = snap.totalManagedBytes ?? snap.databaseBytes

  // Fail-closed if disk space could not be verified
  if (freeDiskBytes === null) {
    return {
      admitted: false,
      resized: false,
      reason: 'disk-space-insufficient',
      reservationId,
      previousBytes: 0,
      newBytes: remainingBytes,
      currentBytes: currentUsageBytes,
      reservedBytes: admission.getReservedBytes(),
      budgetBytes,
      projectedBytes: currentUsageBytes + remainingBytes,
      projectedUsageRatio: 1.0,
      error: 'Free disk space could not be verified (statfs unreadable or unsafe)',
    }
  }

  const activeReservations = admission.listReservations()
  const existing = activeReservations.find((r) => r.id === reservationId)

  if (existing) {
    return admission.checkedResize({
      reservationId,
      newBytes: remainingBytes,
      currentUsageBytes,
      budgetBytes,
      options: {
        headroomBytes: CONSERVATIVE_HEADROOM_BYTES,
        freeDiskBytes,
        accountingDegraded: snap.isDegraded,
        ownerId: ownerToken,
      },
    })
  }

  // Fallback reservation if called without prior reservation (e.g. interactive read)
  const res = admission.reserve(
    reservationId,
    'extract',
    remainingBytes,
    currentUsageBytes,
    budgetBytes,
    60_000,
    {
      headroomBytes: CONSERVATIVE_HEADROOM_BYTES,
      freeDiskBytes,
      accountingDegraded: snap.isDegraded,
      holdUntilJobEnds: true,
      ownerId: ownerToken,
    },
  )

  return {
    ...res,
    resized: res.admitted,
    reservationId,
    previousBytes: 0,
    newBytes: remainingBytes,
  }
}

const QUOTA_REASONS: ReadonlySet<string> = new Set(['quota-exhausted', 'hard-limit-exceeded'])

/** True when a refusal is about quota (not disk, accounting or lifecycle), i.e. displacement could change it. */
export function isQuotaRefusal(decision: { admitted: boolean; reason: string }): boolean {
  return !decision.admitted && QUOTA_REASONS.has(decision.reason)
}

function incomingImportance(store: DocumentMemoryStore, path: string): ImportanceClass | undefined {
  try {
    const eff = store.getImportance(path)?.effective
    return eff === 'important' || eff === 'low' || eff === 'normal' ? eff : undefined
  } catch {
    return undefined
  }
}

/**
 * Admission by displacement for the content path: when the lease is refused for quota, ask the scheduler to free the
 * shortfall from the lowest value content (in the worker), then retry the SAME admission once. Never loops, never
 * exceeds the hard cap (the retry is the normal admission against contentWriteCapBytes), refuses only if still impossible.
 */
async function resizeWithDisplacement(
  attempt: () => Promise<ResizeDecision>,
  maintScheduler: MaintenanceScheduler,
  alreadyDisplaced: { value: boolean },
  isCurrent: () => boolean,
  importance: ImportanceClass | undefined,
): Promise<ResizeDecision> {
  let decision = await attempt()
  if (decision.admitted || alreadyDisplaced.value || !isQuotaRefusal(decision) || !isCurrent()) return decision
  if (typeof maintScheduler.makeRoom !== 'function') return decision
  alreadyDisplaced.value = true
  const shortfall = Math.max(1, Math.ceil(decision.projectedBytes - decision.budgetBytes))
  const room = await maintScheduler.makeRoom({ admissionDenied: true, neededBytes: shortfall, importance, reason: 'content' })
  if (room.retry && isCurrent()) decision = await attempt()
  return decision
}

/**
 * Orchestrates batched lexical/content replacement with typed lifecycle hooks.
 * - Enforces bounded chunk batches (max chunks & max bytes per SQLite transaction).
 * - Checks write readiness and admission quota before each batch outside transactions.
 * - Resizes extraction lease as unwritten chunks decrease.
 * - Reconciles lease on post-commit only after fresh physical accounting measurement.
 * - Handles disk full / quota rejection cleanly without activating incomplete sets.
 * - Releases fallback interactive lease in finally if created locally, preserving caller leases.
 * - Refreshes physical disk accounting after commit before releasing reservation.
 */
export async function writeExtractedContentSliced(params: {
  store: DocumentMemoryStore
  admission: StorageAdmissionController
  maintScheduler: MaintenanceScheduler
  budgetCoord: StorageBudgetCoordinator
  dbDir: string
  path: string
  ext: ExtractResult
  isCurrent: () => boolean
}): Promise<ExtractWriteResult> {
  const { store, admission, maintScheduler, budgetCoord, dbDir, path, ext, isCurrent } = params

  if (!isCurrent()) {
    return { written: false }
  }

  if (!budgetCoord.isWriteReady()) {
    return { written: false, deferred: true }
  }

  // 1. Truthfully sanitize chunks
  const sanitized = sanitizeReplacementChunks(ext.chunks)
  if (sanitized.truncated) {
    ext.truncated = true
    ext.truncatedReason = ext.truncatedReason ?? sanitized.truncatedReason ?? 'content-limit'
    ext.chunks = sanitized.chunks
  }

  // 2. Track reservation ownership with unique token for safe cleanup
  const reserveId = `extract:${path}`
  const ownerToken = `extract:${path}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const hadExistingReservation = Boolean(admission.listReservations().find((r) => r.id === reserveId))
  const createdFallbackLease = !hadExistingReservation

  const totalRemainingBytes = estimateTotalChunksBytes(ext.chunks)

  try {
    const displaced = { value: false }
    const importance = incomingImportance(store, path)
    const resizeLease = (remainingBytes: number): Promise<ResizeDecision> =>
      resizeWithDisplacement(
        () =>
          resizeExtractionLease({
            admission,
            reservationId: reserveId,
            remainingBytes,
            maintScheduler,
            dbDir,
            forceRefresh: true,
            ownerToken: createdFallbackLease ? ownerToken : undefined,
            isCurrent,
            isWriteReady: () => budgetCoord.isWriteReady(),
          }),
        maintScheduler,
        displaced,
        isCurrent,
        importance,
      )
    const initialResize = await resizeLease(totalRemainingBytes)

    // Recheck lifecycle and gate after awaits
    if (!isCurrent()) {
      return { written: false }
    }
    if (!budgetCoord.isWriteReady()) {
      return { written: false, deferred: true }
    }

    if (!initialResize.admitted) {
      return {
        written: false,
        reason: initialResize.reason,
        error: `Storage quota exceeded: cannot commit indexed content (${initialResize.reason})`,
      }
    }

    let batchDenialReason: string | undefined

    // 3. Typed SliceOptions with pre-transaction and post-commit hooks
    const sliceOptions: SliceOptions = {
      budgetMs: CONTENT_WRITE_SLICE_MS,
      maxBatchBytes: CONTENT_BATCH_MAX_BYTES,
      maxBatchChunks: CONTENT_BATCH_MAX_CHUNKS,
      estimateChunkBytes: estimateSingleChunkBytes,
      shouldContinue: () => isCurrent() && budgetCoord.isWriteReady(),
      beforeBatch: async (info: BatchSliceInfo): Promise<BatchHookDecision> => {
        // Recheck write readiness and lifecycle before awaiting
        if (!isCurrent()) return { proceed: false, reason: 'generation-changed' }
        if (!budgetCoord.isWriteReady()) return { proceed: false, reason: 'write-gate-closed' }

        // Remeasure physical accounting and resize extraction lease outside txn
        const batchResize = await resizeLease(Math.max(info.totalEstimatedRemainingBytes, BASE_METADATA_WRITE_BYTES))

        // Recheck lifecycle and write readiness after await
        if (!isCurrent()) return { proceed: false, reason: 'generation-changed' }
        if (!budgetCoord.isWriteReady()) return { proceed: false, reason: 'write-gate-closed' }

        if (!batchResize.admitted) {
          batchDenialReason = batchResize.reason
          return { proceed: false, reason: batchResize.reason }
        }

        return { proceed: true }
      },
      postCommit: async (info: BatchCommitInfo): Promise<void> => {
        // 1. Fresh physical measurement first to capture committed WAL/DB bytes on disk
        let snap: StorageBudgetSnapshot | null
        try {
          snap = await maintScheduler.refreshAccountingAsync()
        } catch (err) {
          // If measurement refresh throws, invalidate scheduler and keep reservation charged
          maintScheduler.invalidateAccounting(`content-write-postCommit: ${safeError(err)}`)
          return
        }

        // Keep charged and fail closed if measurement is unknown or degraded
        if (!snap || snap.measurementStatus !== 'fresh' || snap.isDegraded === true) {
          maintScheduler.invalidateAccounting(
            `content-write-postCommit: measurement ${snap?.measurementStatus ?? 'unknown'}`,
          )
          return
        }

        // 2. Only after fresh physical measurement is valid, reconcile remaining reservation
        const targetLeaseBytes =
          info.remainingChunks > 0 ? Math.max(info.remainingBytes, BASE_METADATA_WRITE_BYTES) : 0
        admission.reconcile(reserveId, { remainingBytes: targetLeaseBytes })
      },
    }

    // 4. Perform sliced database write
    const replacementDoc = {
      hash: ext.hash,
      mtimeMs: ext.mtimeMs,
      sizeBytes: ext.sizeBytes,
      chunks: ext.chunks,
      embeddingModel: null,
      status: extractedStatus(ext),
      error: ext.error,
      truncated: ext.truncated,
      truncatedReason: ext.truncatedReason ?? null,
    }

    const written = await store.replaceDocumentSliced(path, replacementDoc, sliceOptions)

    // Truthfully propagate truncation back to ext
    if (replacementDoc.truncated) {
      ext.truncated = true
      ext.truncatedReason = replacementDoc.truncatedReason ?? ext.truncatedReason ?? 'content-limit'
    }

    if (!written) {
      if (batchDenialReason) {
        return {
          written: false,
          reason: batchDenialReason,
          error: `Storage quota exceeded: cannot commit indexed content (${batchDenialReason})`,
        }
      }
      if (!budgetCoord.isWriteReady()) {
        return { written: false, deferred: true }
      }
      return { written: false }
    }

    return { written: true }
  } catch (err) {
    const msg = safeError(err)
    const isDiskFull = /disk\s*full|sqlite_full|enospc/i.test(msg)
    return {
      written: false,
      error: msg,
      isDiskFull,
    }
  } finally {
    // Fresh accounting after write commits before lease is released
    try {
      const snap = await maintScheduler.refreshAccountingAsync()
      if (!snap || snap.measurementStatus !== 'fresh' || snap.isDegraded) {
        maintScheduler.invalidateAccounting(
          `content-write-terminal: measurement ${snap?.measurementStatus ?? 'unknown'}`,
        )
      }
    } catch (err) {
      maintScheduler.invalidateAccounting(`content-write-terminal: ${safeError(err)}`)
    }
    // Only release lease if created locally as fallback, preserving caller's lease ownership
    // Exact lease owner release: ownerToken MUST be present and match cur.ownerId
    if (createdFallbackLease) {
      safeReleaseExactOwnerReservation(admission, reserveId, ownerToken)
    }
  }
}
