import { existsSync, statSync } from 'node:fs'

/**
 * Enterprise Storage Budget Specification for Document Index V3.
 * Centralizes all storage thresholds, preventing scattered hardcoded limits.
 */
export interface DocumentIndexStorageBudget {
  /** Maximum allowable bytes for the active SQLite index file + WAL (default: 4 GiB). */
  maxDatabaseBytes: number
  /** Maximum allowable single file size for text extraction (default: 128 MiB). */
  maxFileBytes: number
  /** Maximum extracted characters per file before content truncation (default: 8M chars). */
  maxExtractedCharactersPerFile: number
  /** Maximum generated chunks per file before chunk truncation (default: 4,096 chunks). */
  maxChunksPerFile: number
  /** Maximum pages processed by OCR sidecar per file (default: 50 pages). */
  maxOcrPagesPerFile: number
}

/** Standard enterprise storage budget defaults. */
export const DEFAULT_STORAGE_BUDGET: Readonly<DocumentIndexStorageBudget> = Object.freeze({
  maxDatabaseBytes: 4 * 1024 * 1024 * 1024, // 4 GiB global index storage budget
  maxFileBytes: 128 * 1024 * 1024,          // 128 MiB per-file limit
  maxExtractedCharactersPerFile: 8 * 1024 * 1024, // 8M chars (~1,500-2,000 pages)
  maxChunksPerFile: 4096,                    // 4,096 chunks
  maxOcrPagesPerFile: 50,                   // 50 pages OCR limit per file
})

/**
 * Limit threshold ratios:
 * - SOFT_LIMIT_RATIO (80%): triggers warning state and initiates background maintenance.
 * - HARD_LIMIT_RATIO (100%): triggers full state and stops expensive operations (semantic embeddings).
 */
export const SOFT_LIMIT_RATIO = 0.80
export const HARD_LIMIT_RATIO = 1.00

export type StorageLimitState = 'ok' | 'warning' | 'full'

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
}

/** Result of checking per-file safety budget. */
export interface FileSafetyBudgetResult {
  accepted: boolean
  truncated: boolean
  truncatedReason?: 'content-limit' | 'chunk-limit' | 'pdf-page-limit' | 'tabular-sampling'
  rejectionReason?: 'file-too-large' | 'storage-budget-exceeded'
  error?: string
}

/** Calculates limit state from active database bytes vs budget bytes. */
export function calculateStorageLimitState(
  databaseBytes: number,
  budgetBytes: number = DEFAULT_STORAGE_BUDGET.maxDatabaseBytes,
): StorageLimitState {
  if (budgetBytes <= 0 || databaseBytes <= 0) return 'ok'
  const ratio = databaseBytes / budgetBytes
  if (ratio >= HARD_LIMIT_RATIO) return 'full'
  if (ratio >= SOFT_LIMIT_RATIO) return 'warning'
  return 'ok'
}

/**
 * Constructs a consolidated StorageBudgetSnapshot ensuring Limit C isolation:
 * backupBytes is tracked separately and NEVER added to databaseBytes when evaluating global quota.
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
}): StorageBudgetSnapshot {
  const databaseBytes = Math.max(0, (params.activeDbSizeBytes || 0) + (params.walSizeBytes || 0))
  const budgetBytes = params.budgetBytes && params.budgetBytes > 0
    ? params.budgetBytes
    : DEFAULT_STORAGE_BUDGET.maxDatabaseBytes
  const usageRatio = budgetBytes > 0 ? Number((databaseBytes / budgetBytes).toFixed(4)) : 0
  const limitState = calculateStorageLimitState(databaseBytes, budgetBytes)

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
  // Hard limit strictly halts expensive semantic embeddings to protect storage
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
