import { readFileSync, statSync, statfsSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { HARD_LIMIT_RATIO, DEFAULT_STORAGE_BUDGET } from '../storage-budget'
import {
  STORAGE_SETTINGS_FILENAME,
  STORAGE_PRESET_BYTES,
  validateStorageBudgetBytes,
  isValidStoragePreset,
  type StorageBudgetPreset,
} from '../storage/storage-settings'
import { collectStorageAccounting } from './storage-accounting'

export const MIGRATION_CONSERVATIVE_HEADROOM_BYTES = 20 * 1024 * 1024 // 20 MB headroom
export const MIGRATION_WAL_MULTIPLIER = 1.5
export const MIGRATION_FTS_MULTIPLIER = 2.0
export const MIGRATION_OVERHEAD_BASE_BYTES = 64 * 1024 // 64 KB base metadata overhead
export const MAX_MIGRATION_BATCH_DOCS = 100
export const MAX_MIGRATION_BATCH_BYTES = 2 * 1024 * 1024 // 2 MB target batch byte limit

export interface EffectiveStorageBudgetResult {
  budgetBytes: number
  valid: boolean
  preset?: StorageBudgetPreset
  source: 'persisted' | 'default'
  error?: string
}

export interface MigrationAdmissionParams {
  sourceDbPath: string
  currentUsageBytes: number
  budgetBytes: number
  estimatedGrowthBytes: number
  freeDiskBytes?: number | null
  accountingDegraded?: boolean
  headroomBytes?: number
  existingProtectedBackupBytes?: number
}

export type MigrationAdmissionRejectionReason =
  | 'quota-exhausted'
  | 'disk-space-insufficient'
  | 'accounting-unknown'
  | 'budget-zero'
  | 'invalid-parameters'
  | 'concurrent-writer-detected'

export interface MigrationAdmissionDecision {
  admitted: boolean
  reason: 'ok' | MigrationAdmissionRejectionReason
  estimatedGrowthBytes: number
  currentUsageBytes: number
  projectedBytes: number
  budgetBytes: number
  projectedUsageRatio: number
  remainingBytes: number
  error?: string
}

/**
 * Reads and strictly validates persisted UI storage budget from settingsDir.
 * Enforces validated 1GB/3GB/5GB/custom limits.
 * Fails closed on corrupted JSON or invalid/unknown budget values (NO default bypass on corruption).
 * Distinguishes ENOENT (expected absent settings file) from EACCES/EIO (fails closed).
 */
export function getEffectiveStorageBudget(settingsDir?: string): EffectiveStorageBudgetResult {
  const dir = settingsDir ? resolve(settingsDir) : undefined
  if (!dir) {
    return {
      budgetBytes: DEFAULT_STORAGE_BUDGET.maxDatabaseBytes,
      valid: true,
      source: 'default',
    }
  }

  const filePath = join(dir, STORAGE_SETTINGS_FILENAME)
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (err: any) {
    if (err && err.code === 'ENOENT') {
      return {
        budgetBytes: DEFAULT_STORAGE_BUDGET.maxDatabaseBytes,
        valid: true,
        source: 'default',
      }
    }
    return {
      budgetBytes: 0,
      valid: false,
      source: 'persisted',
      error: `Failed to read storage settings at ${filePath}: ${err?.message || String(err)}`,
    }
  }

  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch (err: any) {
    return {
      budgetBytes: 0,
      valid: false,
      source: 'persisted',
      error: `Storage settings at ${filePath} contains invalid JSON: ${err?.message || String(err)}`,
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      budgetBytes: 0,
      valid: false,
      source: 'persisted',
      error: `Storage settings at ${filePath} is not a valid configuration object`,
    }
  }

  const preset: unknown = parsed.preset
  const bytes = parsed.maxDatabaseBytes

  if (preset && (preset === '1gb' || preset === '3gb' || preset === '5gb')) {
    const presetBytes = STORAGE_PRESET_BYTES[preset]
    if (bytes === undefined || bytes === presetBytes) {
      return {
        budgetBytes: presetBytes,
        preset,
        valid: true,
        source: 'persisted',
      }
    }
  }

  if (validateStorageBudgetBytes(bytes) && Number.isSafeInteger(bytes) && bytes > 0) {
    return {
      budgetBytes: bytes,
      preset: isValidStoragePreset(preset) ? preset : 'custom',
      valid: true,
      source: 'persisted',
    }
  }

  return {
    budgetBytes: 0,
    valid: false,
    source: 'persisted',
    error: `Storage settings at ${filePath} has invalid maxDatabaseBytes: ${bytes}`,
  }
}

/**
 * Asynchronously checks and validates available disk space via statfs.
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
    // Non-fatal if statfs unsupported
  }
  return null
}

/**
 * Synchronously checks and validates available disk space via statfsSync.
 */
export function getValidatedFreeDiskBytesSync(dirPath: string): number | null {
  try {
    const stat = statfsSync(dirPath)
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
    // Non-fatal
  }
  return null
}

/**
 * Estimates conservative on-disk byte footprint for the new Schema V3 temp database.
 * Analyzes documents, chunk sets, embeddings, FTS5 indexes, and OCR tables.
 * Uses length(CAST(text AS BLOB)) to count actual UTF-8 bytes instead of character length.
 * Includes stored text, FTS expansion, chunk metadata, vectors, and WAL amplification.
 * Fails closed on arithmetic overflow or invalid values.
 */
export function estimateMigrationGrowthBytes(
  sourceDb: DatabaseSync,
  activeSpaceId: string,
  activeDimensions: number,
): number {
  if (!Number.isSafeInteger(activeDimensions) || activeDimensions <= 0) {
    throw new Error(`Invalid activeDimensions: ${activeDimensions}`)
  }

  let estimated = MIGRATION_OVERHEAD_BASE_BYTES

  const tables = (
    sourceDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  ).map((t) => t.name)

  if (tables.includes('documents')) {
    const docRow = sourceDb.prepare('SELECT COUNT(*) as count FROM documents').get() as { count: number }
    const docCount = docRow?.count ?? 0
    if (!Number.isSafeInteger(docCount) || docCount < 0) {
      throw new Error('Invalid document count in source database')
    }
    // ~512 bytes per document row + SQLite B-tree indices
    estimated += docCount * 512
  }

  let chunkCount = 0
  let chunkTextBytes: number

  if (tables.includes('chunks')) {
    const chunkStats = sourceDb
      .prepare('SELECT COUNT(*) as count, SUM(length(CAST(text AS BLOB))) as totalText FROM chunks')
      .get() as { count: number; totalText: number | null }
    chunkCount = chunkStats?.count ?? 0
    chunkTextBytes = chunkStats?.totalText ?? 0
    if (!Number.isSafeInteger(chunkCount) || chunkCount < 0 || !Number.isSafeInteger(chunkTextBytes) || chunkTextBytes < 0) {
      throw new Error('Invalid chunk count or byte length in source database')
    }
    // Stored text + FTS5 index expansion (2x text bytes) + chunk row overhead
    const ftsBytes = Math.ceil(chunkTextBytes * MIGRATION_FTS_MULTIPLIER)
    const chunkBytes = chunkCount * 256 + chunkTextBytes + ftsBytes
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 0) {
      throw new Error('Chunk growth estimate overflowed safe integer limit')
    }
    estimated += chunkBytes
  }

  if (tables.includes('chunk_embeddings')) {
    const embStats = sourceDb
      .prepare('SELECT COUNT(*) as count FROM chunk_embeddings WHERE space_id = ?')
      .get(activeSpaceId) as { count: number }
    const embCount = embStats?.count ?? 0
    if (!Number.isSafeInteger(embCount) || embCount < 0) {
      throw new Error('Invalid embedding count in source database')
    }
    // Float32Array blob (dim * 4) + row overhead
    const vectorBytes = activeDimensions * 4 + 64
    estimated += embCount * vectorBytes
  } else if (chunkCount > 0) {
    // Legacy fallback: vector embedded in chunk rows
    const vectorBytes = activeDimensions * 4 + 64
    estimated += chunkCount * vectorBytes
  }

  if (tables.includes('ocr_pages')) {
    const ocrStats = sourceDb
      .prepare('SELECT COUNT(*) as count, SUM(length(CAST(text AS BLOB))) as totalText FROM ocr_pages')
      .get() as { count: number; totalText: number | null }
    const ocrCount = ocrStats?.count ?? 0
    const ocrText = ocrStats?.totalText ?? 0
    if (!Number.isSafeInteger(ocrCount) || ocrCount < 0 || !Number.isSafeInteger(ocrText) || ocrText < 0) {
      throw new Error('Invalid OCR count or byte length in source database')
    }
    const ocrBytes = ocrCount * 512 + ocrText
    if (!Number.isSafeInteger(ocrBytes) || ocrBytes < 0) {
      throw new Error('OCR growth estimate overflowed safe integer limit')
    }
    estimated += ocrBytes
  }

  // WAL write amplification factor (1.5x)
  const totalWithWal = Math.ceil(estimated * MIGRATION_WAL_MULTIPLIER)
  if (!Number.isSafeInteger(totalWithWal) || totalWithWal <= 0) {
    throw new Error('Migration growth estimation overflowed safe integer limit')
  }

  return Math.max(totalWithWal, MIGRATION_OVERHEAD_BASE_BYTES)
}

/**
 * Estimates conservative on-disk write bytes for a specific batch of documents.
 * Uses length(CAST(text AS BLOB)) to measure actual UTF-8 bytes.
 * Crucial for bounding batch growth when tiny doc rows have massive OCR, vectors, or FTS text.
 * Fails closed on overflow or invalid IDs.
 */
export function estimateBatchMigrationGrowth(
  sourceDb: DatabaseSync,
  docIds: number[],
  activeDimensions: number,
): number {
  if (docIds.length === 0) return 1024
  for (const id of docIds) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`Invalid document ID in batch: ${id}`)
    }
  }
  if (!Number.isSafeInteger(activeDimensions) || activeDimensions <= 0) {
    throw new Error(`Invalid activeDimensions: ${activeDimensions}`)
  }

  const tables = (
    sourceDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  ).map((t) => t.name)

  let batchEstimated = docIds.length * 512 // Document metadata row overhead

  const placeholders = docIds.map(() => '?').join(',')

  if (tables.includes('chunks')) {
    const chunkStats = sourceDb
      .prepare(
        `SELECT COUNT(*) as count, SUM(length(CAST(text AS BLOB))) as totalText FROM chunks WHERE document_id IN (${placeholders})`,
      )
      .get(...docIds) as { count: number; totalText: number | null }
    const count = chunkStats?.count ?? 0
    const textBytes = chunkStats?.totalText ?? 0
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(textBytes) || textBytes < 0) {
      throw new Error('Invalid chunk count or byte length in batch')
    }
    const ftsBytes = Math.ceil(textBytes * MIGRATION_FTS_MULTIPLIER)
    const chunkBytes = count * 256 + textBytes + ftsBytes
    const vectorBytes = count * (activeDimensions * 4 + 64)
    batchEstimated += chunkBytes + vectorBytes
  }

  if (tables.includes('ocr_pages') && tables.includes('documents')) {
    const docPaths = (
      sourceDb
        .prepare(`SELECT path FROM documents WHERE id IN (${placeholders})`)
        .all(...docIds) as Array<{ path: string }>
    ).map((d) => d.path)

    if (docPaths.length > 0) {
      const pathPlaceholders = docPaths.map(() => '?').join(',')
      const ocrStats = sourceDb
        .prepare(
          `SELECT COUNT(*) as count, SUM(length(CAST(text AS BLOB))) as totalText FROM ocr_pages WHERE path IN (${pathPlaceholders})`,
        )
        .get(...docPaths) as { count: number; totalText: number | null }
      const count = ocrStats?.count ?? 0
      const textBytes = ocrStats?.totalText ?? 0
      if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(textBytes) || textBytes < 0) {
        throw new Error('Invalid OCR count or byte length in batch')
      }
      batchEstimated += count * 512 + textBytes
    }
  }

  const totalWithWal = Math.ceil(batchEstimated * MIGRATION_WAL_MULTIPLIER)
  if (!Number.isSafeInteger(totalWithWal) || totalWithWal <= 0) {
    throw new Error('Batch migration growth estimate overflowed safe integer limit')
  }

  return totalWithWal
}

/**
 * Preflight quota and disk space admission check for V2->V3 storage migration.
 * Verifies that the host system can accommodate the peak footprint of:
 * [Current physical managed storage] + [Projected new temp DB & WAL growth] + [Headroom]
 * without exceeding hard budget limits or free disk space.
 * Fails closed on unmeasured disk space, non-safe integers, zero growth, or overflow.
 */
export function checkMigrationAdmission(params: MigrationAdmissionParams): MigrationAdmissionDecision {
  const {
    currentUsageBytes,
    budgetBytes,
    estimatedGrowthBytes,
    freeDiskBytes,
    accountingDegraded,
    headroomBytes = MIGRATION_CONSERVATIVE_HEADROOM_BYTES,
  } = params

  // 1. Parameter validation: strict safe integers
  if (
    !Number.isSafeInteger(currentUsageBytes) ||
    currentUsageBytes < 0 ||
    !Number.isSafeInteger(budgetBytes) ||
    budgetBytes < 0 ||
    !Number.isSafeInteger(estimatedGrowthBytes) ||
    estimatedGrowthBytes <= 0 ||
    !Number.isSafeInteger(headroomBytes) ||
    headroomBytes < 0
  ) {
    return {
      admitted: false,
      reason: 'invalid-parameters',
      estimatedGrowthBytes: typeof estimatedGrowthBytes === 'number' && Number.isFinite(estimatedGrowthBytes) ? Math.max(0, estimatedGrowthBytes) : 0,
      currentUsageBytes: typeof currentUsageBytes === 'number' && Number.isFinite(currentUsageBytes) ? Math.max(0, currentUsageBytes) : 0,
      projectedBytes: 0,
      budgetBytes: typeof budgetBytes === 'number' && Number.isFinite(budgetBytes) ? Math.max(0, budgetBytes) : 0,
      projectedUsageRatio: 1.0,
      remainingBytes: 0,
      error: 'Migration admission parameters must be non-negative safe integers (growth must be > 0)',
    }
  }

  if (budgetBytes === 0) {
    return {
      admitted: false,
      reason: 'budget-zero',
      estimatedGrowthBytes,
      currentUsageBytes,
      projectedBytes: currentUsageBytes + estimatedGrowthBytes,
      budgetBytes: 0,
      projectedUsageRatio: 1.0,
      remainingBytes: 0,
      error: 'Storage budget is zero',
    }
  }

  // 2. Accounting degraded check (fail-closed)
  if (accountingDegraded === true) {
    return {
      admitted: false,
      reason: 'accounting-unknown',
      estimatedGrowthBytes,
      currentUsageBytes,
      projectedBytes: currentUsageBytes + estimatedGrowthBytes,
      budgetBytes,
      projectedUsageRatio: (currentUsageBytes + estimatedGrowthBytes) / budgetBytes,
      remainingBytes: 0,
      error: 'Storage accounting is in an unknown or degraded state due to I/O or permission errors',
    }
  }

  // 3. Physical free disk space check: unavailable disk deny (fail-closed)
  if (freeDiskBytes === null || freeDiskBytes === undefined || !Number.isSafeInteger(freeDiskBytes) || freeDiskBytes < 0) {
    return {
      admitted: false,
      reason: 'disk-space-insufficient',
      estimatedGrowthBytes,
      currentUsageBytes,
      projectedBytes: currentUsageBytes + estimatedGrowthBytes,
      budgetBytes,
      projectedUsageRatio: (currentUsageBytes + estimatedGrowthBytes) / budgetBytes,
      remainingBytes: 0,
      error: 'Free disk space is unavailable or unmeasurable (fail-closed)',
    }
  }

  const requiredFree = estimatedGrowthBytes + headroomBytes
  if (!Number.isSafeInteger(requiredFree) || requiredFree < 0) {
    return {
      admitted: false,
      reason: 'invalid-parameters',
      estimatedGrowthBytes,
      currentUsageBytes,
      projectedBytes: 0,
      budgetBytes,
      projectedUsageRatio: 1.0,
      remainingBytes: 0,
      error: 'Required free disk calculation overflowed safe integer limit',
    }
  }

  if (freeDiskBytes < requiredFree) {
    return {
      admitted: false,
      reason: 'disk-space-insufficient',
      estimatedGrowthBytes,
      currentUsageBytes,
      projectedBytes: currentUsageBytes + estimatedGrowthBytes,
      budgetBytes,
      projectedUsageRatio: (currentUsageBytes + estimatedGrowthBytes) / budgetBytes,
      remainingBytes: 0,
      error: `Insufficient free disk space for migration: required ${requiredFree} bytes, available ${freeDiskBytes} bytes`,
    }
  }

  // 4. Projected quota check & overflow safety
  const projectedBytes = currentUsageBytes + estimatedGrowthBytes + headroomBytes
  if (!Number.isSafeInteger(projectedBytes) || projectedBytes < 0) {
    return {
      admitted: false,
      reason: 'quota-exhausted',
      estimatedGrowthBytes,
      currentUsageBytes,
      projectedBytes: Number.MAX_SAFE_INTEGER,
      budgetBytes,
      projectedUsageRatio: Infinity,
      remainingBytes: 0,
      error: 'Projected storage bytes calculation overflowed safe integer limit',
    }
  }

  const projectedUsageRatio = projectedBytes / budgetBytes
  if (projectedUsageRatio > HARD_LIMIT_RATIO) {
    return {
      admitted: false,
      reason: 'quota-exhausted',
      estimatedGrowthBytes,
      currentUsageBytes,
      projectedBytes,
      budgetBytes,
      projectedUsageRatio,
      remainingBytes: Math.max(0, budgetBytes - currentUsageBytes),
      error: `Storage budget exceeded: projected storage (${projectedBytes} bytes) exceeds budget (${budgetBytes} bytes)`,
    }
  }

  return {
    admitted: true,
    reason: 'ok',
    estimatedGrowthBytes,
    currentUsageBytes,
    projectedBytes,
    budgetBytes,
    projectedUsageRatio,
    remainingBytes: Math.max(0, budgetBytes - projectedBytes),
  }
}

/**
 * Migration budget contract ensuring thread-safe, strict preauthorized execution.
 * Enforces per-batch admission and post-commit physical reconciliation.
 * Throws before mutation on bad constructor arguments.
 * Recomputes live base usage and free disk before each batch.
 * Reconciles physical files with fail-closed I/O error checking.
 */
export class MigrationBudgetContract {
  private currentTempPhysicalBytes = 0
  private batchReservedBytes = 0
  private currentBaseUsageBytes: number

  constructor(
    public readonly sourceDbPath: string,
    baseUsageBytes: number,
    public readonly budgetBytes: number,
    public readonly headroomBytes = MIGRATION_CONSERVATIVE_HEADROOM_BYTES,
  ) {
    if (!sourceDbPath || typeof sourceDbPath !== 'string') {
      throw new Error('MigrationBudgetContract: invalid sourceDbPath')
    }
    if (!Number.isSafeInteger(baseUsageBytes) || baseUsageBytes < 0) {
      throw new Error('MigrationBudgetContract: baseUsageBytes must be a non-negative safe integer')
    }
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= 0) {
      throw new Error('MigrationBudgetContract: budgetBytes must be a positive safe integer')
    }
    if (!Number.isSafeInteger(headroomBytes) || headroomBytes < 0) {
      throw new Error('MigrationBudgetContract: headroomBytes must be a non-negative safe integer')
    }
    if (baseUsageBytes + headroomBytes > Number.MAX_SAFE_INTEGER) {
      throw new Error('MigrationBudgetContract: baseUsageBytes + headroomBytes calculation overflow')
    }
    this.currentBaseUsageBytes = baseUsageBytes
  }

  get baseUsageBytes(): number {
    return this.currentBaseUsageBytes
  }

  /**
   * Updates base usage measurement from fresh live storage accounting.
   */
  updateBaseUsage(newUsage: number): void {
    if (!Number.isSafeInteger(newUsage) || newUsage < 0) {
      throw new Error('MigrationBudgetContract.updateBaseUsage: invalid newUsage')
    }
    this.currentBaseUsageBytes = newUsage
  }

  /**
   * Admits planned growth for the next batch before BEGIN IMMEDIATE.
   * Re-evaluates disk and quota live. Zero or invalid growth is rejected.
   */
  admitBatch(
    estimatedBatchBytes: number,
    freeDiskBytes?: number | null,
    liveBaseUsageBytes?: number,
  ): { admitted: boolean; reason?: string } {
    if (!Number.isSafeInteger(estimatedBatchBytes) || estimatedBatchBytes <= 0) {
      return { admitted: false, reason: 'Invalid or zero growth byte estimate' }
    }

    if (freeDiskBytes === null || freeDiskBytes === undefined || !Number.isSafeInteger(freeDiskBytes) || freeDiskBytes < 0) {
      return { admitted: false, reason: 'Free disk space unavailable or unmeasurable' }
    }

    const requiredDisk = estimatedBatchBytes + this.headroomBytes
    if (!Number.isSafeInteger(requiredDisk) || freeDiskBytes < requiredDisk) {
      return {
        admitted: false,
        reason: `Insufficient free disk space for batch: required ${requiredDisk} bytes, available ${freeDiskBytes} bytes`,
      }
    }

    if (liveBaseUsageBytes !== undefined) {
      if (!Number.isSafeInteger(liveBaseUsageBytes) || liveBaseUsageBytes < 0) {
        return { admitted: false, reason: 'Invalid live base usage parameter' }
      }
      this.currentBaseUsageBytes = liveBaseUsageBytes
    } else {
      try {
        const report = collectStorageAccounting({ dbPath: this.sourceDbPath })
        if (report.isDegraded) {
          return { admitted: false, reason: 'Storage accounting degraded during live batch remeasurement' }
        }
        this.currentBaseUsageBytes = Math.max(this.currentBaseUsageBytes, report.totalManagedBytes)
      } catch (err: any) {
        return { admitted: false, reason: `Failed to remeasure live base usage: ${err?.message || String(err)}` }
      }
    }

    const projectedTemp = this.currentTempPhysicalBytes + this.batchReservedBytes + estimatedBatchBytes
    if (!Number.isSafeInteger(projectedTemp)) {
      return { admitted: false, reason: 'Projected temp database size overflowed safe integer limit' }
    }

    const projectedTotal = this.currentBaseUsageBytes + projectedTemp + this.headroomBytes
    if (!Number.isSafeInteger(projectedTotal)) {
      return { admitted: false, reason: 'Projected total storage overflowed safe integer limit' }
    }

    if (projectedTotal / this.budgetBytes > HARD_LIMIT_RATIO) {
      return {
        admitted: false,
        reason: `Storage budget exceeded during batch admission: projected ${projectedTotal} bytes exceeds budget ${this.budgetBytes} bytes`,
      }
    }

    this.batchReservedBytes += estimatedBatchBytes
    return { admitted: true }
  }

  /**
   * Reconciles fresh physical bytes after COMMIT.
   * Distinguishes expected missing files (ENOENT) from I/O or permission errors (fails closed).
   */
  reconcileBatch(tempPath: string): void {
    const measure = (p: string): number => {
      try {
        const st = statSync(p)
        if (!Number.isSafeInteger(st.size) || st.size < 0) {
          throw new Error(`Invalid file size for ${p}: ${st.size}`)
        }
        return st.size
      } catch (err: any) {
        if (err && err.code === 'ENOENT') {
          return 0
        }
        throw new Error(`reconcileBatch failed to stat ${p}: ${err?.message || String(err)}`, { cause: err })
      }
    }

    const mainSize = measure(tempPath)
    const walSize = measure(`${tempPath}-wal`)
    const shmSize = measure(`${tempPath}-shm`)
    const physicalBytes = mainSize + walSize + shmSize

    if (!Number.isSafeInteger(physicalBytes) || physicalBytes < 0) {
      throw new Error('Physical bytes calculation overflow in reconcileBatch')
    }

    this.currentTempPhysicalBytes = Math.max(this.currentTempPhysicalBytes, physicalBytes)
    this.batchReservedBytes = 0
  }

  getCurrentTempPhysicalBytes(): number {
    return this.currentTempPhysicalBytes
  }
}
