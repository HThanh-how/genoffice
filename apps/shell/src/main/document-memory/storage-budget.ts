import { existsSync, statSync } from 'node:fs'

/**
 * Enterprise Storage Budget Specification for Document Index V3.
 * Centralizes all storage thresholds, preventing scattered hardcoded limits.
 */
export interface DocumentIndexStorageBudget {
  /** Maximum allowable bytes for all managed document index storage (default: 4 GiB). Kept as maxDatabaseBytes for backward compatibility. */
  maxDatabaseBytes: number
  /** Maximum allowable single file size for text extraction (default: 128 MiB). */
  maxFileBytes: number
  /** Maximum extracted characters per file before content truncation (default: 8M chars). */
  maxExtractedCharactersPerFile: number
  /** Maximum generated chunks per file before chunk truncation (default: 4,096 chunks). */
  maxChunksPerFile: number
  /** Maximum pages processed by OCR sidecar per file (default: 50 pages). */
  maxOcrPagesPerFile: number
  /** Monotonic configuration version for worker synchronization and live updates. */
  version?: number
  /**
   * Grace-zone overshoot above the soft quota (fraction of maxDatabaseBytes, clamped to [0, OVERSHOOT_RATIO]).
   * maxDatabaseBytes stays the user-facing SOFT quota; the index may physically grow to hardCapBytes(budget)
   * so that embeddings and new files keep working while compaction brings usage back. Absent = OVERSHOOT_RATIO.
   * Travels with the budget in every worker/main handshake (set-storage-budget), see normalizeOvershootRatio.
   */
  overshootRatio?: number
  /**
   * Age policy ("recent matters", see runtime/value-density.ts): documents neither opened nor modified for this
   * many months are 'archive' tier, the first victims of compaction after boilerplate. Default 12.
   */
  archiveAfterMonths?: number
  /** Documents touched within this many days are 'fresh' and protected from non-critical eviction. Default 30. */
  freshWindowDays?: number
}

/** Maximum (and default) grace overshoot above the soft quota: the index may bloat at most 10% over it. */
export const OVERSHOOT_RATIO = 0.10

/**
 * Normalizes an untrusted/optional overshoot ratio: missing or non-numeric -> OVERSHOOT_RATIO (default),
 * otherwise clamped to [0, OVERSHOOT_RATIO]. 0 disables the grace zone (legacy "full at 100%").
 */
export function normalizeOvershootRatio(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return OVERSHOOT_RATIO
  return Math.min(OVERSHOOT_RATIO, Math.max(0, value))
}

/**
 * Hard cap in bytes = floor(maxDatabaseBytes x (1 + overshoot)). Physical growth admissions (writes, content,
 * embeddings, ANN) are reserved against this value, never against the soft quota.
 * Accepts a budget or a bare soft quota in bytes (+ optional overshoot, default OVERSHOOT_RATIO).
 */
export function hardCapBytes(
  budget: { maxDatabaseBytes: number; overshootRatio?: number } | number,
  overshootRatio?: number,
): number {
  const soft = typeof budget === 'number' ? budget : budget.maxDatabaseBytes
  const ratio = normalizeOvershootRatio(typeof budget === 'number' ? overshootRatio : (overshootRatio ?? budget.overshootRatio))
  if (!Number.isFinite(soft) || soft <= 0) return soft
  // integer split avoids float error of floor(soft * 1.1)
  return soft + Math.floor(soft * ratio)
}

/** True when usage is at/over the soft quota but still under the hard cap (the 100%..110% grace zone). */
export function isInGrace(
  usedBytes: number,
  budget: { maxDatabaseBytes: number; overshootRatio?: number } | number,
  overshootRatio?: number,
): boolean {
  const soft = typeof budget === 'number' ? budget : budget.maxDatabaseBytes
  if (!Number.isFinite(usedBytes) || !Number.isFinite(soft) || soft <= 0 || usedBytes <= 0) return false
  return usedBytes >= soft && usedBytes < hardCapBytes(budget, overshootRatio)
}

/** True when usage has reached the hard cap: every growing write is refused (limitState 'full'). */
export function isHardStop(
  usedBytes: number,
  budget: { maxDatabaseBytes: number; overshootRatio?: number } | number,
  overshootRatio?: number,
): boolean {
  const soft = typeof budget === 'number' ? budget : budget.maxDatabaseBytes
  if (!Number.isFinite(usedBytes) || !Number.isFinite(soft) || soft <= 0 || usedBytes <= 0) return false
  return usedBytes >= hardCapBytes(budget, overshootRatio)
}

/** Standard enterprise storage budget defaults. */
export const DEFAULT_STORAGE_BUDGET: Readonly<DocumentIndexStorageBudget> = Object.freeze({
  maxDatabaseBytes: 4 * 1024 * 1024 * 1024, // 4 GiB global index storage budget
  maxFileBytes: 128 * 1024 * 1024,          // 128 MiB per-file limit
  maxExtractedCharactersPerFile: 8 * 1024 * 1024, // 8M chars (~1,500-2,000 pages)
  maxChunksPerFile: 4096,                    // 4,096 chunks
  maxOcrPagesPerFile: 50,                   // 50 pages OCR limit per file
  overshootRatio: OVERSHOOT_RATIO,           // grace zone: up to 10% physical overshoot above the soft quota
})

/**
 * Creates a DocumentIndexStorageBudget instance, applying custom maxDatabaseBytes or overrides.
 */
export function createStorageBudget(
  maxDatabaseBytesOrPartial?: number | Partial<DocumentIndexStorageBudget>,
): DocumentIndexStorageBudget {
  if (typeof maxDatabaseBytesOrPartial === 'number') {
    return {
      ...DEFAULT_STORAGE_BUDGET,
      maxDatabaseBytes:
        maxDatabaseBytesOrPartial > 0
          ? maxDatabaseBytesOrPartial
          : DEFAULT_STORAGE_BUDGET.maxDatabaseBytes,
    }
  }
  const merged = {
    ...DEFAULT_STORAGE_BUDGET,
    ...(maxDatabaseBytesOrPartial ?? {}),
  }
  merged.overshootRatio = normalizeOvershootRatio(merged.overshootRatio)
  return merged
}

/**
 * Limit threshold ratios (relative to the SOFT quota maxDatabaseBytes):
 * - SOFT_LIMIT_RATIO (80%): triggers warning state and initiates background maintenance.
 * - HARD_LIMIT_RATIO (100%): the soft quota itself. Reaching it starts the GRACE zone (graceActive, urgent
 *   compaction) - writes and embeddings are still admitted. 'full' (hard stop) is reached at
 *   hardCapBytes(budget) = max x (1 + overshootRatio), i.e. 110% by default.
 * Admission controllers compare projected usage against HARD_LIMIT_RATIO x <budgetBytes they are given>;
 * callers that protect physical growth must pass hardCapBytes(budget), not maxDatabaseBytes.
 *
 * Zones by physical managed bytes:  <80% ok | 80-100% warning | 100-110% grace (limitState 'warning',
 * graceActive) | >=110% hard stop (limitState 'full').
 */
export const SOFT_LIMIT_RATIO = 0.80
export const HARD_LIMIT_RATIO = 1.00

/**
 * Cache retention hysteresis constants:
 * - CACHE_RETENTION_HIGH_WATERMARK (90%): triggers eviction cleanup.
 * - CACHE_RETENTION_LOW_WATERMARK (80%): target floor after cleanup.
 */
export const CACHE_RETENTION_HIGH_WATERMARK = 0.90
export const CACHE_RETENTION_LOW_WATERMARK = 0.80

/**
 * 'full' means HARD STOP (usage >= hard cap). The grace zone (soft quota <= usage < hard cap) is reported as
 * 'warning' plus StorageBudgetSnapshot.graceActive so renderer code switching on this union keeps working.
 */
export type StorageLimitState = 'ok' | 'warning' | 'full'

export type StorageMeasurementStatus =
  | 'unknown'
  | 'measuring'
  | 'fresh'
  | 'stale'
  | 'degraded'

/** User-visible and IPC-exposed storage snapshot. */
export interface StorageBudgetSnapshot {
  databaseBytes: number
  budgetBytes: number
  usageRatio: number
  chunksBytes: number
  embeddingsBytes: number
  ftsBytes: number
  ocrBytes: number
  backupBytes: number
  reclaimableBytes: number
  limitState: StorageLimitState
  totalManagedBytes?: number
  protectedBytes?: number
  reusableFreelistBytes?: number
  breakdown?: {
    activeDbBytes: number
    walBytes: number
    shmBytes: number
    annBytes: number
    ocrExternalBytes: number
    tempBytes: number
    backupBytes: number
    protectedBackupBytes: number
    reusableFreelistBytes: number
    modelWeightsBytes: number
  }
  modelBytes?: number
  configVersion?: number
  measurementStatus?: StorageMeasurementStatus
  isDegraded?: boolean
  measuredAt?: number
  lastAttemptAt?: number
  measurementError?: string
  /** True while soft quota <= totalManagedBytes < hardCapBytes (writes/embeddings admitted, compaction urgent). */
  graceActive?: boolean
  /** Bytes above the soft quota (0 when under it). */
  overQuotaBytes?: number
  /** Physical hard stop: floor(softBudgetBytes x (1 + overshootRatio)). */
  hardCapBytes?: number
  /** The user-facing soft quota (same value as budgetBytes). */
  softBudgetBytes?: number
  overshootRatio?: number
}

/** Result of checking per-file safety budget. */
export interface FileSafetyBudgetResult {
  accepted: boolean
  truncated: boolean
  truncatedReason?: 'content-limit' | 'chunk-limit' | 'pdf-page-limit' | 'tabular-sampling'
  rejectionReason?: 'file-too-large' | 'storage-budget-exceeded'
  error?: string
}

/**
 * Calculates limit state from active storage bytes vs the SOFT budget bytes:
 * ok (<80%), warning (80% .. hard cap, includes the grace zone), full (>= hard cap = hard stop).
 * overshootRatio defaults to OVERSHOOT_RATIO; pass 0 for the legacy "full at 100%" behaviour.
 */
export function calculateStorageLimitState(
  currentBytes: number,
  budgetBytes: number = DEFAULT_STORAGE_BUDGET.maxDatabaseBytes,
  overshootRatio?: number,
): StorageLimitState {
  if (!Number.isFinite(currentBytes) || !Number.isFinite(budgetBytes)) return 'ok'
  if (budgetBytes <= 0 || currentBytes <= 0) return 'ok'
  if (currentBytes >= hardCapBytes(budgetBytes, overshootRatio)) return 'full'
  if (currentBytes / budgetBytes >= SOFT_LIMIT_RATIO) return 'warning'
  return 'ok'
}

export type CompactionUrgency = 'none' | 'normal' | 'urgent'

export interface CompactionTarget {
  urgency: CompactionUrgency
  /** Bytes to reclaim to get back to the retention floor (80% of the soft quota). 0 when urgency is 'none'. */
  reclaimToFloorBytes: number
  /** Bytes to reclaim to get back under the soft quota (the minimum that ends the grace zone). */
  reclaimToSoftBytes: number
}

type UrgencyInput = Pick<StorageBudgetSnapshot, 'databaseBytes' | 'budgetBytes'> &
  Partial<Pick<StorageBudgetSnapshot, 'totalManagedBytes' | 'softBudgetBytes' | 'isDegraded' | 'measurementStatus'>>

/**
 * Compaction urgency for the maintenance scheduler:
 * - 'urgent': usage >= soft quota (grace zone or hard stop) - reclaim as fast as safely possible;
 * - 'normal': usage >= 90% (CACHE_RETENTION_HIGH_WATERMARK) - the existing 90 -> 80 retention hysteresis;
 * - 'none': below 90%, or accounting unknown/degraded (nothing trustworthy to act on).
 */
export function compactionUrgency(snapshot: UrgencyInput): CompactionUrgency {
  return compactionTarget(snapshot).urgency
}

export function compactionTarget(snapshot: UrgencyInput): CompactionTarget {
  const none: CompactionTarget = { urgency: 'none', reclaimToFloorBytes: 0, reclaimToSoftBytes: 0 }
  if (snapshot.isDegraded === true || snapshot.measurementStatus === 'unknown') return none
  const used = snapshot.totalManagedBytes ?? snapshot.databaseBytes
  const soft = snapshot.softBudgetBytes ?? snapshot.budgetBytes
  if (!Number.isFinite(used) || !Number.isFinite(soft) || used <= 0 || soft <= 0) return none
  const urgency: CompactionUrgency =
    used >= soft * HARD_LIMIT_RATIO ? 'urgent' : used >= soft * CACHE_RETENTION_HIGH_WATERMARK ? 'normal' : 'none'
  if (urgency === 'none') return none
  return {
    urgency,
    reclaimToFloorBytes: Math.max(0, Math.ceil(used - soft * CACHE_RETENTION_LOW_WATERMARK)),
    reclaimToSoftBytes: Math.max(0, Math.ceil(used - soft)),
  }
}

/**
 * Constructs a consolidated StorageBudgetSnapshot ensuring unified quota decisions:
 * - totalManagedBytes governs usageRatio and limitState across DB, WAL, SHM, ANN, OCR, temp, and backups.
 * - databaseBytes is preserved for physical SQLite diagnostics.
 * - model weights are reported separately and never counted toward managed index quota.
 */
export function createStorageBudgetSnapshot(params: {
  activeDbSizeBytes: number
  walSizeBytes?: number
  budgetBytes?: number
  chunksBytes?: number
  embeddingsBytes?: number
  ftsBytes?: number
  ocrBytes?: number
  backupBytes?: number | null
  reclaimableBytes?: number
  totalManagedBytes?: number
  protectedBytes?: number
  reusableFreelistBytes?: number
  breakdown?: {
    activeDbBytes: number
    walBytes: number
    shmBytes: number
    annBytes: number
    ocrExternalBytes: number
    tempBytes: number
    backupBytes: number
    protectedBackupBytes: number
    reusableFreelistBytes: number
    modelWeightsBytes: number
  }
  modelBytes?: number
  configVersion?: number
  measurementStatus?: StorageMeasurementStatus
  isDegraded?: boolean
  measuredAt?: number
  lastAttemptAt?: number
  measurementError?: string
  /** Grace overshoot of the budget the snapshot is built for; absent = OVERSHOOT_RATIO. */
  overshootRatio?: number
}): StorageBudgetSnapshot {
  const databaseBytes = Math.max(0, (params.activeDbSizeBytes || 0) + (params.walSizeBytes || 0))
  const budgetBytes = params.budgetBytes && params.budgetBytes > 0
    ? params.budgetBytes
    : DEFAULT_STORAGE_BUDGET.maxDatabaseBytes

  // Determine single total managed storage bytes:
  // If totalManagedBytes is explicitly provided, it governs quota decisions.
  // Else if breakdown is provided, sum the managed components.
  // Otherwise fall back to databaseBytes for backwards compatibility.
  let effectiveManagedBytes: number
  if (typeof params.totalManagedBytes === 'number' && Number.isFinite(params.totalManagedBytes)) {
    effectiveManagedBytes = Math.max(0, params.totalManagedBytes)
  } else if (params.breakdown) {
    const b = params.breakdown
    effectiveManagedBytes = Math.max(
      0,
      b.activeDbBytes + b.walBytes + b.shmBytes + b.annBytes + b.ocrExternalBytes + b.tempBytes + b.backupBytes,
    )
  } else {
    effectiveManagedBytes = databaseBytes
  }

  const usageRatio = budgetBytes > 0 ? Number((effectiveManagedBytes / budgetBytes).toFixed(4)) : 0
  const overshootRatio = normalizeOvershootRatio(params.overshootRatio)
  const limitState = calculateStorageLimitState(effectiveManagedBytes, budgetBytes, overshootRatio)
  const hardCap = hardCapBytes(budgetBytes, overshootRatio)

  const isDegraded = params.isDegraded ?? (params.measurementStatus === 'degraded' || false)
  let measurementStatus = params.measurementStatus
  if (!measurementStatus) {
    if (isDegraded) {
      measurementStatus = 'degraded'
    } else if (typeof params.totalManagedBytes === 'number' && Number.isFinite(params.totalManagedBytes)) {
      const age = params.measuredAt ? Date.now() - params.measuredAt : 0
      measurementStatus = age > 5 * 60_000 ? 'stale' : 'fresh'
    } else {
      measurementStatus = 'unknown'
    }
  }

  return {
    databaseBytes,
    budgetBytes,
    usageRatio,
    chunksBytes: Math.max(0, params.chunksBytes ?? 0),
    embeddingsBytes: Math.max(0, params.embeddingsBytes ?? 0),
    ftsBytes: Math.max(0, params.ftsBytes ?? 0),
    ocrBytes: Math.max(0, params.ocrBytes ?? 0),
    backupBytes: Math.max(0, params.backupBytes ?? 0),
    reclaimableBytes: Math.max(0, params.reclaimableBytes ?? 0),
    limitState,
    totalManagedBytes: effectiveManagedBytes,
    protectedBytes: params.protectedBytes,
    reusableFreelistBytes: params.reusableFreelistBytes ?? params.reclaimableBytes,
    breakdown: params.breakdown,
    modelBytes: params.modelBytes,
    configVersion: params.configVersion,
    measurementStatus,
    isDegraded,
    measuredAt: params.measuredAt,
    lastAttemptAt: params.lastAttemptAt ?? params.measuredAt,
    measurementError: params.measurementError,
    graceActive: isInGrace(effectiveManagedBytes, budgetBytes, overshootRatio),
    overQuotaBytes: Math.max(0, effectiveManagedBytes - budgetBytes),
    hardCapBytes: hardCap,
    softBudgetBytes: budgetBytes,
    overshootRatio,
  }
}

/**
 * Checks per-file safety budget (Limit A):
 * Enforces file size limit, character cap, chunk cap, and OCR page limit.
 */
export function checkFileSafetyBudget(
  stats: {
    sizeBytes: number
    charCount?: number
    chunkCount?: number
    ocrPages?: number
  },
  budget: DocumentIndexStorageBudget = DEFAULT_STORAGE_BUDGET,
): FileSafetyBudgetResult {
  // 1. File size check
  if (stats.sizeBytes > budget.maxFileBytes) {
    return {
      accepted: false,
      truncated: false,
      rejectionReason: 'file-too-large',
      error: `Document exceeds the ${(budget.maxFileBytes / (1024 * 1024)).toFixed(0)} MB indexing limit`,
    }
  }

  // 2. Character limit check
  if (stats.charCount !== undefined && stats.charCount > budget.maxExtractedCharactersPerFile) {
    return {
      accepted: true,
      truncated: true,
      truncatedReason: 'content-limit',
    }
  }

  // 3. Chunk count check
  if (stats.chunkCount !== undefined && stats.chunkCount > budget.maxChunksPerFile) {
    return {
      accepted: true,
      truncated: true,
      truncatedReason: 'chunk-limit',
    }
  }

  // 4. OCR page budget check
  if (stats.ocrPages !== undefined && stats.ocrPages > budget.maxOcrPagesPerFile) {
    return {
      accepted: true,
      truncated: true,
      truncatedReason: 'pdf-page-limit',
    }
  }

  return { accepted: true, truncated: false }
}

/** Determines if semantic embedding work can be accepted under current limit state. */
export function canAcceptSemanticWork(limitState: StorageLimitState): boolean {
  // Only the HARD STOP ('full' = hard cap reached) halts semantic embeddings; the grace zone keeps them running
  return limitState !== 'full'
}

/** Determines if expensive background work can run. */
export function canAcceptExpensiveWork(limitState: StorageLimitState): boolean {
  return limitState !== 'full'
}

/** Determines if maintenance should be scheduled based on storage state. */
export function shouldTriggerStorageMaintenance(limitState: StorageLimitState): boolean {
  return limitState === 'warning' || limitState === 'full'
}

/** Resolves physical file size on disk safely. */
export function safeGetFileSize(filePath: string): number {
  try {
    if (existsSync(filePath)) {
      return statSync(filePath).size
    }
  } catch {
    // ignore
  }
  return 0
}
