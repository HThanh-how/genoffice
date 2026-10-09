import type { DatabaseSync } from 'node:sqlite'
import { existsSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { measureSqlite } from '../../sqlite-timing'
import { USearchIndex } from '../../usearch-index'
import { blobVector, EmbeddingRepository, type RepairInvalidCanonicalEmbeddingsResult } from './embedding-repository'
import {
  garbageCollectObsoleteStorage,
  getStorageFreelistStats,
  runIncrementalVacuum,
  type GarbageCollectionStats,
  type StorageFreelistStats,
  type IncrementalVacuumOptions,
  type VacuumResult,
} from '../../storage-gc'
import {
  type DocumentIndexStorageBudget,
  type StorageBudgetSnapshot,
  DEFAULT_STORAGE_BUDGET,
  createStorageBudgetSnapshot,
  contentWriteCapBytes,
} from '../../storage-budget'
import {
  collectStorageAccounting,
  type StorageAccountingOptions,
  type StorageAccountingReport,
} from '../../runtime/storage-accounting'
import { collectStorageAccountingAsync } from '../../runtime/storage-accounting-async'
import { type AnnPreauthorizedPermit, validateAnnPreauthorizedPermit } from '../../ann-index'
import {
  executeCacheRetentionPolicy,
  type CacheRetentionOptions,
  type CacheRetentionReport,
} from '../../runtime/cache-retention-policy'
import {
  estimateAnnIndexBytes,
  getValidatedFreeDiskBytes,
  checkAnnWriteAdmission,
  AnnWriteAdmissionGuard,
} from '../../runtime/ann-write-budget'

export interface StorageMaintenanceResult {
  gc: GarbageCollectionStats
  vacuum: VacuumResult
  limitStateBefore: 'ok' | 'warning' | 'full'
  limitStateAfter: 'ok' | 'warning' | 'full'
  reclaimedBytes: number
}

export const FTS_MERGE_PAGES = 8

export class MaintenanceRepository {
  private readonly annIndexes = new Map<string, USearchIndex>()
  private isClosed = false

  private storageBudget: DocumentIndexStorageBudget = DEFAULT_STORAGE_BUDGET
  private getStorageBudgetFn?: () => DocumentIndexStorageBudget
  private getConfigVersionFn?: () => number | null
  private readonly annAdmissionGuard = new AnnWriteAdmissionGuard()

  constructor(
    private readonly db: DatabaseSync,
    private readonly dbPath: string,
    private readonly role: 'search' | 'worker',
  ) {}

  close(): void {
    this.isClosed = true
    this.annAdmissionGuard.clear()
    for (const ann of this.annIndexes.values()) {
      void ann.close()
    }
  }

  setStorageBudget(budget: DocumentIndexStorageBudget): void {
    if (
      budget &&
      typeof budget === 'object' &&
      Number.isFinite(budget.maxDatabaseBytes) &&
      Number.isSafeInteger(budget.maxDatabaseBytes) &&
      budget.maxDatabaseBytes >= 500 * 1_000_000
    ) {
      this.storageBudget = budget
    }
  }

  getStorageBudget(): DocumentIndexStorageBudget {
    const b = this.getStorageBudgetFn?.()
    if (
      b &&
      typeof b === 'object' &&
      Number.isFinite(b.maxDatabaseBytes) &&
      Number.isSafeInteger(b.maxDatabaseBytes) &&
      b.maxDatabaseBytes >= 500 * 1_000_000
    ) {
      return b
    }
    return this.storageBudget
  }

  setStorageBudgetProvider(
    getBudget: () => DocumentIndexStorageBudget,
    getVersion?: () => number | null,
  ): void {
    this.getStorageBudgetFn = getBudget
    if (getVersion) this.getConfigVersionFn = getVersion
  }

  mergeFtsStep(pages = FTS_MERGE_PAGES): boolean {
    return measureSqlite('FTS step', () => {
      const changes = () => (this.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
      const before = changes()
      this.db.exec(`INSERT INTO chunk_fts(chunk_fts, rank) VALUES('merge', ${Math.trunc(pages)})`)
      return changes() - before > 1
    })
  }

  runMaintenanceGc(): GarbageCollectionStats {
    return garbageCollectObsoleteStorage(this.db)
  }

  getStorageFreelistStats(): StorageFreelistStats {
    return getStorageFreelistStats(this.db)
  }

  runIncrementalVacuum(options?: IncrementalVacuumOptions): VacuumResult {
    return runIncrementalVacuum(this.db, options)
  }

  getAnnIndex(spaceId: string, dimensions: number): USearchIndex {
    let idx = this.annIndexes.get(spaceId)
    if (!idx) {
      const sanitized = spaceId.replace(/[^a-zA-Z0-9_.-]/g, '_')
      const indexPath = join(dirname(this.dbPath), `ann-${sanitized}.usearch`)
      idx = new USearchIndex(dimensions, indexPath, {
        failClosed: true,
        rebuildAdmissionHook: async (_path, count, dim) => {
          return this.checkAdmissionForRebuild(spaceId, count, dim)
        },
      })
      this.annIndexes.set(spaceId, idx)
    }
    return idx
  }

  async checkAdmissionForRebuild(
    spaceId: string,
    vectorCount: number,
    dimensions: number,
  ): Promise<{ admitted: boolean; reason?: string }> {
    if (this.isClosed) return { admitted: false, reason: 'closed' }
    const report = await collectStorageAccountingAsync({
      dbPath: this.dbPath,
      db: this.isClosed ? undefined : this.db,
    })
    const freeDiskBytes = await getValidatedFreeDiskBytes(dirname(this.dbPath))
    const budget = this.getStorageBudget()

    const isBootstrapMissingAnn =
      report.isDegraded &&
      report.measurementErrors.length > 0 &&
      report.measurementErrors.every(
        (e) => e.code === 'ENOENT' && e.error.includes('ANN metadata'),
      )
    const effectiveDegraded = report.isDegraded && !isBootstrapMissingAnn

    const decision = checkAnnWriteAdmission({
      spaceId,
      vectorCount,
      dimensions,
      currentUsageBytes: report.totalManagedBytes,
      // Grace zone: the ANN rebuild may use the overshoot room but never exceeds the HARD cap
      budgetBytes: contentWriteCapBytes(budget),
      freeDiskBytes,
      accountingDegraded: effectiveDegraded,
      otherReservedBytes: this.annAdmissionGuard.getTotalReservedBytes(spaceId),
    })
    return { admitted: decision.admitted, reason: decision.reason }
  }

  getAnnIndexes(): Map<string, USearchIndex> {
    return this.annIndexes
  }

  markAnnDirty(spaceId: string): void {
    if (this.isClosed) return
    try {
      this.db
        .prepare(
          `INSERT INTO ann_indexes (space_id, generation, desired_generation, indexed_count, state, updated_at)
           VALUES (?, 0, 1, 0, 'dirty', unixepoch())
           ON CONFLICT(space_id)
           DO UPDATE SET
             desired_generation = desired_generation + 1,
             state = 'dirty',
             updated_at = unixepoch()`,
        )
        .run(spaceId)
    } catch {
      // Non-blocking
    }
  }

  /**
   * Failure path for a rebuild fenced to `targetGeneration`. If a concurrent mutation already advanced
   * desired_generation, that mutation owns the bump: only keep the state dirty so we do not burn a
   * second generation (which would invalidate the permit a retry is about to be issued for).
   */
  private markAnnDirtyAfterFailedRebuild(spaceId: string, targetGeneration: number): void {
    if (this.isClosed) return
    try {
      const meta = this.db
        .prepare('SELECT desired_generation FROM ann_indexes WHERE space_id = ?')
        .get(spaceId) as { desired_generation?: number } | undefined
      if (meta?.desired_generation !== undefined && meta.desired_generation > targetGeneration) {
        this.db
          .prepare("UPDATE ann_indexes SET state = 'dirty', updated_at = unixepoch() WHERE space_id = ?")
          .run(spaceId)
        return
      }
    } catch {
      // fall through to the regular fail-closed bump
    }
    this.markAnnDirty(spaceId)
  }

  onAnnVectorsAdded(spaceId: string, chunkIds: number[], vectors: number[][]): void {
    if (this.role === 'worker') {
      try {
        const ann = this.getAnnIndex(spaceId, vectors[0]!.length)
        if (ann.isAvailable()) {
          ann.addSync(chunkIds, vectors)
          if (!ann.isHealthy()) {
            this.markAnnDirty(spaceId)
          } else {
            this.db
              .prepare(
                `INSERT INTO ann_indexes (space_id, generation, desired_generation, indexed_count, state, updated_at)
                 VALUES (?, 0, 0, (SELECT count(*) FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id JOIN documents d ON d.id = c.document_id WHERE e.space_id = ? AND d.excluded = 0 AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)), 'ready', unixepoch())
                 ON CONFLICT(space_id) DO UPDATE SET
                   indexed_count = (SELECT count(*) FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id JOIN documents d ON d.id = c.document_id WHERE e.space_id = ? AND d.excluded = 0 AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)),
                   updated_at = unixepoch()`,
              )
              .run(spaceId, spaceId, spaceId)
          }
        }
      } catch {
        this.markAnnDirty(spaceId)
      }
    } else {
      this.markAnnDirty(spaceId)
    }
  }

  onAnnVectorsRemoved(chunkIds: number[]): void {
    if (this.role === 'worker') {
      for (const [spaceId, ann] of this.annIndexes.entries()) {
        try {
          if (ann.isAvailable()) {
            ann.removeSync(chunkIds)
            if (!ann.isHealthy()) this.markAnnDirty(spaceId)
          }
        } catch {
          this.markAnnDirty(spaceId)
        }
      }
    } else {
      for (const spaceId of this.annIndexes.keys()) {
        this.markAnnDirty(spaceId)
      }
    }
  }

  getAnnCanonicalMeta(spaceId: string): { canonicalCount: number; desiredGeneration: number; currentGeneration: number } {
    if (this.isClosed) return { canonicalCount: 0, desiredGeneration: 1, currentGeneration: 0 }
    let count = 0
    let desiredGen = 1
    let currentGen = 0
    try {
      const meta = this.db
        .prepare('SELECT generation, desired_generation FROM ann_indexes WHERE space_id = ?')
        .get(spaceId) as { generation?: number; desired_generation?: number } | undefined
      currentGen = meta?.generation ?? 0
      desiredGen = meta?.desired_generation && meta.desired_generation > 0 ? meta.desired_generation : (currentGen > 0 ? currentGen : 1)
    } catch {
      // Non-blocking
    }
    try {
      const r = this.db
        .prepare(
          `SELECT count(*) as cnt
           FROM chunk_embeddings e
           JOIN chunks c ON c.id = e.chunk_id
           JOIN documents d ON d.id = c.document_id
           WHERE e.space_id = ? AND d.excluded = 0
             AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)`,
        )
        .get(spaceId) as { cnt: number } | undefined
      count = r?.cnt ?? 0
    } catch {
      // Non-blocking
    }
    return { canonicalCount: count, desiredGeneration: desiredGen, currentGeneration: currentGen }
  }

  async rebuildAnnIndex(
    spaceId: string,
    hostPermit?: AnnPreauthorizedPermit,
  ): Promise<{ ok: boolean; count: number }> {
    if (this.isClosed) return { ok: false, count: 0 }

    const liveBudget = this.getStorageBudget()
    if (!liveBudget || !Number.isFinite(liveBudget.maxDatabaseBytes) || liveBudget.maxDatabaseBytes <= 0) {
      this.markAnnDirty(spaceId)
      return { ok: false, count: 0 }
    }
    const liveConfigVersion = this.getConfigVersionFn?.() ?? liveBudget.version

    // Determine canonical count and desired generation via typed storage API before any DB mutation
    const canonicalMeta = this.getAnnCanonicalMeta(spaceId)
    const targetGeneration = canonicalMeta.desiredGeneration
    const canonicalCount = canonicalMeta.canonicalCount

    // Direct worker writes without coordinated hostPermit fail closed
    if (this.role === 'worker' && !hostPermit) {
      this.markAnnDirty(spaceId)
      return { ok: false, count: 0 }
    }

    // BEH-INV: Validate BEFORE first DB mutation
    // Complete host permit: unexpired, valid token and ID, exact live configVersion (valid including 0),
    // live budget, generation fenced to targetGeneration, dimensions, vectorCount, and reservedBytes >= estimate actual.
    // Reject empty {}, foreign config, small central lease, and arbitrary permissive permits.
    if (hostPermit) {
      const isValid = validateAnnPreauthorizedPermit(
        hostPermit,
        hostPermit.dimensions,
        undefined,
        undefined,
        targetGeneration,
        liveConfigVersion,
        contentWriteCapBytes(liveBudget), // permit.budgetBytes protects physical growth: the HARD cap
      )
      if (!isValid) {
        this.markAnnDirty(spaceId)
        return { ok: false, count: 0 }
      }

      // Check central lease bounds canonical estimate actual
      if (canonicalCount > 0) {
        const estActual = estimateAnnIndexBytes(canonicalCount, hostPermit.dimensions!)
        if (estActual <= 0 || (hostPermit.reservedBytes ?? 0) < estActual) {
          this.markAnnDirty(spaceId)
          return { ok: false, count: 0 }
        }
      }
    }

    let rows: Array<{ chunk_id: number; vector: Uint8Array; vector_dim: number }>
    try {
      rows = this.db
        .prepare(
          `SELECT e.chunk_id, e.vector, e.vector_dim
           FROM chunk_embeddings e
           JOIN chunks c ON c.id = e.chunk_id
           JOIN documents d ON d.id = c.document_id
           WHERE e.space_id = ? AND d.excluded = 0
             AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)`,
        )
        .all(spaceId) as Array<{ chunk_id: number; vector: Uint8Array; vector_dim: number }>
    } catch {
      return { ok: false, count: 0 }
    }

    const sanitized = spaceId.replace(/[^a-zA-Z0-9_.-]/g, '_')
    const fileName = `ann-${sanitized}.usearch`

    if (!rows.length) {
      if (this.isClosed) return { ok: false, count: 0 }
      // Clean up old native file from disk so stale vectors are not advertised
      const fullPath = join(dirname(this.dbPath), fileName)
      try {
        if (existsSync(fullPath)) unlinkSync(fullPath)
      } catch {
        // Non-blocking
      }
      // Clear in-memory instance safely and fail-closed to exact fallback
      const ann = this.annIndexes.get(spaceId)
      if (ann) {
        ann.clearSavePermit?.()
        if (typeof ann.markDirty === 'function') ann.markDirty()
        void ann.close?.()
        this.annIndexes.delete(spaceId)
      }
      // Logical metadata only: update generation and count 0, file_path NULL, state 'dirty'
      // Honestly do not mark native ready
      try {
        const info = this.db
          .prepare(
            `UPDATE ann_indexes
             SET generation = ?,
                 desired_generation = ?,
                 indexed_count = 0,
                 file_path = NULL,
                 state = 'dirty',
                 updated_at = unixepoch()
             WHERE space_id = ? AND desired_generation = ?`,
          )
          .run(targetGeneration, targetGeneration, spaceId, targetGeneration)
        if (info.changes === 0) {
          this.db
            .prepare("UPDATE ann_indexes SET state = 'dirty', updated_at = unixepoch() WHERE space_id = ?")
            .run(spaceId)
          return { ok: false, count: 0 }
        }
        return { ok: true, count: 0 }
      } catch {
        try {
          this.db
            .prepare("UPDATE ann_indexes SET state = 'dirty', updated_at = unixepoch() WHERE space_id = ?")
            .run(spaceId)
        } catch {}
        return { ok: false, count: 0 }
      }
    }

    const dim = rows[0]!.vector_dim
    if (hostPermit && hostPermit.dimensions !== dim) {
      this.markAnnDirty(spaceId)
      return { ok: false, count: 0 }
    }

    const estActualRows = estimateAnnIndexBytes(rows.length, dim)
    if (estActualRows <= 0) {
      this.markAnnDirty(spaceId)
      return { ok: false, count: 0 }
    }

    if (hostPermit && (hostPermit.reservedBytes ?? 0) < estActualRows) {
      this.markAnnDirty(spaceId)
      return { ok: false, count: 0 }
    }

    // First DB mutation: set state to 'rebuilding' fenced to targetGeneration
    try {
      this.db
        .prepare(
          `INSERT INTO ann_indexes (space_id, generation, desired_generation, file_path, indexed_count, state, updated_at)
           VALUES (?, 0, ?, ?, 0, 'rebuilding', unixepoch())
           ON CONFLICT (space_id) DO UPDATE SET
             file_path = excluded.file_path,
             state = 'rebuilding',
             updated_at = unixepoch()`,
        )
        .run(spaceId, targetGeneration, fileName)
    } catch {
      return { ok: false, count: 0 }
    }

    const ann = this.getAnnIndex(spaceId, dim)
    const chunkIds = rows.map((r) => r.chunk_id)
    const vectors = rows.map((r) => Array.from(blobVector(r.vector, r.vector_dim)))

    // --- Physical ANN Prewrite Admission Boundary ---
    const report = await collectStorageAccountingAsync({
      dbPath: this.dbPath,
      db: this.isClosed ? undefined : this.db,
    })
    if (this.isClosed) return { ok: false, count: 0 }

    const isBootstrapMissingAnn =
      report.isDegraded &&
      report.measurementErrors.length > 0 &&
      report.measurementErrors.every(
        (e) => e.code === 'ENOENT' && e.error.includes('ANN metadata'),
      )
    const effectiveDegraded = report.isDegraded && !isBootstrapMissingAnn

    const freeDiskBytes = await getValidatedFreeDiskBytes(dirname(this.dbPath))
    if (this.isClosed) return { ok: false, count: 0 }

    const admission = this.annAdmissionGuard.acquirePermit({
      spaceId,
      vectorCount: rows.length,
      dimensions: dim,
      currentUsageBytes: report.totalManagedBytes,
      budgetBytes: contentWriteCapBytes(liveBudget),
      freeDiskBytes,
      accountingDegraded: effectiveDegraded,
      ownerToken: hostPermit?.ownerToken,
      indexPath: ann.indexPath,
      generation: targetGeneration,
      configVersion: liveConfigVersion,
    })

    if (!admission.admitted || !admission.permit) {
      this.markAnnDirty(spaceId)
      if (typeof ann.markDirty === 'function') ann.markDirty()
      return { ok: false, count: 0 }
    }

    try {
      if (typeof ann.preauthorizeSave === 'function') {
        ann.preauthorizeSave(admission.permit)
      }

      // Fresh accounting + freeDisk after await, live budget/version/generation/permit check, guard DB close
      const beforeSaveHook = async (_tempPath: string, permit: AnnPreauthorizedPermit): Promise<boolean> => {
        if (this.isClosed) return false

        const freshReport = await collectStorageAccountingAsync({
          dbPath: this.dbPath,
          db: this.isClosed ? undefined : this.db,
        })
        if (this.isClosed) return false

        const freshFreeDisk = await getValidatedFreeDiskBytes(dirname(this.dbPath))
        if (this.isClosed) return false
        if (
          freshFreeDisk === null ||
          !Number.isFinite(freshFreeDisk) ||
          !Number.isSafeInteger(freshFreeDisk) ||
          freshFreeDisk < (permit.reservedBytes ?? 0)
        ) {
          return false
        }

        const currentLiveBudget = this.getStorageBudget()
        if (
          !currentLiveBudget ||
          !Number.isFinite(currentLiveBudget.maxDatabaseBytes) ||
          currentLiveBudget.maxDatabaseBytes <= 0
        ) {
          return false
        }

        const currentLiveConfigVersion = this.getConfigVersionFn?.() ?? currentLiveBudget.version
        if (permit.configVersion !== undefined && permit.configVersion !== currentLiveConfigVersion) {
          return false
        }

        try {
          const meta = this.db
            .prepare('SELECT desired_generation FROM ann_indexes WHERE space_id = ?')
            .get(spaceId) as { desired_generation?: number } | undefined
          if (meta?.desired_generation !== targetGeneration) {
            return false
          }
        } catch {
          return false
        }

        if (!this.annAdmissionGuard.recheckPermit(spaceId, contentWriteCapBytes(currentLiveBudget), freshReport.totalManagedBytes)) {
          return false
        }

        this.annAdmissionGuard.markWriting(spaceId, true)
        return true
      }

      // Fresh accounting + freeDisk after await; own new temp already in physical totalManagedBytes (don't add actualBytes twice);
      // live budget, version, generation checks and guard DB close
      const beforeRenameHook = async (_tempPath: string, permit: AnnPreauthorizedPermit, _actualBytes: number): Promise<boolean> => {
        if (this.isClosed) return false

        const freshReport = await collectStorageAccountingAsync({
          dbPath: this.dbPath,
          db: this.isClosed ? undefined : this.db,
        })
        if (this.isClosed) return false

        const freshFreeDisk = await getValidatedFreeDiskBytes(dirname(this.dbPath))
        if (this.isClosed) return false
        if (
          freshFreeDisk === null ||
          !Number.isFinite(freshFreeDisk) ||
          !Number.isSafeInteger(freshFreeDisk) ||
          freshFreeDisk < 0
        ) {
          return false
        }

        const currentLiveBudget = this.getStorageBudget()
        if (
          !currentLiveBudget ||
          !Number.isFinite(currentLiveBudget.maxDatabaseBytes) ||
          currentLiveBudget.maxDatabaseBytes <= 0
        ) {
          return false
        }

        // Own new temp already measured in freshReport.totalManagedBytes (via tempSizeBytes); do not add actualBytes twice
        if (freshReport.totalManagedBytes > contentWriteCapBytes(currentLiveBudget)) {
          return false
        }

        const currentLiveConfigVersion = this.getConfigVersionFn?.() ?? currentLiveBudget.version
        if (permit.configVersion !== undefined && permit.configVersion !== currentLiveConfigVersion) {
          return false
        }

        try {
          const meta = this.db
            .prepare('SELECT desired_generation FROM ann_indexes WHERE space_id = ?')
            .get(spaceId) as { desired_generation?: number } | undefined
          if (meta?.desired_generation !== targetGeneration) {
            return false
          }
        } catch {
          return false
        }

        return true
      }

      const success = await ann.rebuildAtomic(chunkIds, vectors, targetGeneration, {
        precheckedAdmission: true,
        permit: admission.permit,
        beforeSaveHook,
        beforeRenameHook,
      })

      if (this.isClosed) return { ok: false, count: 0 }

      if (success) {
        // Snapshot canonical generation and rows recheck before commit (No await inside DB transaction)
        try {
          const metaBeforeCommit = this.db
            .prepare('SELECT desired_generation FROM ann_indexes WHERE space_id = ?')
            .get(spaceId) as { desired_generation?: number } | undefined
          if (metaBeforeCommit?.desired_generation !== targetGeneration) {
            this.markAnnDirtyAfterFailedRebuild(spaceId, targetGeneration)
            if (typeof ann.markDirty === 'function') ann.markDirty()
            return { ok: false, count: 0 }
          }
        } catch {
          this.markAnnDirty(spaceId)
          if (typeof ann.markDirty === 'function') ann.markDirty()
          return { ok: false, count: 0 }
        }

        let currentCanonicalCount = 0
        try {
          const countRow = this.db
            .prepare(
              `SELECT count(*) as cnt
               FROM chunk_embeddings e
               JOIN chunks c ON c.id = e.chunk_id
               JOIN documents d ON d.id = c.document_id
               WHERE e.space_id = ? AND d.excluded = 0
                 AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)`,
            )
            .get(spaceId) as { cnt: number } | undefined
          currentCanonicalCount = countRow?.cnt ?? 0
        } catch {
          this.markAnnDirty(spaceId)
          if (typeof ann.markDirty === 'function') ann.markDirty()
          return { ok: false, count: 0 }
        }

        if (currentCanonicalCount !== rows.length) {
          this.markAnnDirty(spaceId)
          if (typeof ann.markDirty === 'function') ann.markDirty()
          return { ok: false, count: 0 }
        }

        const info = this.db
          .prepare(
            `UPDATE ann_indexes
             SET generation = ?,
                 indexed_count = ?,
                 state = 'ready',
                 updated_at = unixepoch()
             WHERE space_id = ?
               AND desired_generation = ?`,
          )
          .run(targetGeneration, rows.length, spaceId, targetGeneration)

        if (info.changes === 0) {
          this.markAnnDirty(spaceId)
          if (typeof ann.markDirty === 'function') ann.markDirty()
          return { ok: false, count: 0 }
        }
        return { ok: true, count: rows.length }
      } else {
        this.markAnnDirtyAfterFailedRebuild(spaceId, targetGeneration)
        if (typeof ann.markDirty === 'function') ann.markDirty()
        return { ok: false, count: 0 }
      }
    } catch {
      this.markAnnDirty(spaceId)
      if (typeof ann.markDirty === 'function') ann.markDirty()
      return { ok: false, count: 0 }
    } finally {
      this.annAdmissionGuard.markWriting(spaceId, false)
      this.annAdmissionGuard.releasePermit(spaceId, admission.permit?.ownerToken)
    }
  }

  async syncAnnIndex(spaceId: string, hostPermit?: AnnPreauthorizedPermit): Promise<{ ok: boolean; count: number }> {
    return this.rebuildAnnIndex(spaceId, hostPermit)
  }

  getStorageAccounting(options?: Partial<StorageAccountingOptions>): StorageAccountingReport {
    return collectStorageAccounting({
      dbPath: this.dbPath,
      db: this.db,
      ...options,
    })
  }

  async executeCacheRetention(
    budget?: DocumentIndexStorageBudget,
    options?: CacheRetentionOptions,
  ): Promise<CacheRetentionReport> {
    const budgetBytes = budget?.maxDatabaseBytes ?? DEFAULT_STORAGE_BUDGET.maxDatabaseBytes
    return executeCacheRetentionPolicy(this.db, this.dbPath, budgetBytes, {
      ...options,
      onPostCommitAnnDirty: (affectedSpaces) => {
        for (const { spaceId } of affectedSpaces) {
          const ann = this.annIndexes.get(spaceId)
          if (ann && typeof ann.markDirty === 'function') {
            ann.markDirty()
          }
        }
        if (options?.onPostCommitAnnInvalidation) {
          options.onPostCommitAnnInvalidation(affectedSpaces)
        } else if (options?.onPostCommitAnnDirty) {
          options.onPostCommitAnnDirty(affectedSpaces)
        }
      },
    })
  }

  /**
   * Invalidates in-memory ANN index instance without writing/incrementing desired_generation in SQLite.
   */
  invalidateAnnInMemory(spaceId: string): void {
    const ann = this.annIndexes.get(spaceId)
    if (ann && typeof ann.markDirty === 'function') {
      ann.markDirty()
    }
  }

  checkStorageBudget(budget: DocumentIndexStorageBudget = DEFAULT_STORAGE_BUDGET): StorageBudgetSnapshot {
    const freelist = this.getStorageFreelistStats()
    const accounting = this.getStorageAccounting()

    let chunksBytes = 0
    let embeddingsBytes = 0
    let ftsBytes = 0
    let ocrBytes = 0
    try {
      const dbstatRows = this.db
        .prepare('SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name')
        .all() as Array<{ name: string; bytes: number }>
      for (const row of dbstatRows) {
        if (row.name === 'chunks' || row.name.startsWith('chunks_')) chunksBytes += row.bytes
        else if (row.name === 'chunk_embeddings' || row.name.startsWith('chunk_embeddings_')) embeddingsBytes += row.bytes
        else if (row.name.includes('fts')) ftsBytes += row.bytes
        else if (row.name.includes('ocr')) ocrBytes += row.bytes
      }
    } catch {
      // Non-blocking if dbstat is not enabled
    }

    return createStorageBudgetSnapshot({
      activeDbSizeBytes: accounting.dbSizeBytes,
      walSizeBytes: accounting.walSizeBytes,
      budgetBytes: budget.maxDatabaseBytes,
      overshootRatio: budget.overshootRatio,
      chunksBytes,
      embeddingsBytes,
      ftsBytes,
      ocrBytes,
      backupBytes: accounting.backupSizeBytes,
      reclaimableBytes: freelist.reclaimableBytes,
      totalManagedBytes: accounting.totalManagedBytes,
      protectedBytes: accounting.protectedBytes,
      reusableFreelistBytes: accounting.reusableFreelistBytes,
      breakdown: accounting.breakdown,
      modelBytes: accounting.modelWeightsBytes,
      configVersion: budget.version,
    })
  }

  runStorageBudgetMaintenance(options?: {
    budget?: DocumentIndexStorageBudget
    forceVacuum?: boolean
  }): StorageMaintenanceResult {
    const budget = options?.budget ?? DEFAULT_STORAGE_BUDGET
    const beforeSnapshot = this.checkStorageBudget(budget)
    const limitStateBefore = beforeSnapshot.limitState

    // 1. Run garbage collection on retired sets and obsolete embeddings
    const gc = this.runMaintenanceGc()

    // 2. Run incremental vacuum to reclaim freelist pages
    const freelist = this.getStorageFreelistStats()
    const shouldVacuum = options?.forceVacuum || freelist.shouldVacuum || limitStateBefore !== 'ok'
    const vacuum = shouldVacuum
      ? this.runIncrementalVacuum({ force: options?.forceVacuum })
      : {
          vacuumed: false,
          initialFreelistPages: freelist.freelistCount,
          finalFreelistPages: freelist.freelistCount,
          pagesReclaimed: 0,
          bytesReclaimed: 0,
        }

    // 3. Compact FTS
    this.mergeFtsStep(FTS_MERGE_PAGES)

    const afterSnapshot = this.checkStorageBudget(budget)
    const limitStateAfter = afterSnapshot.limitState
    const reclaimedBytes = Math.max(0, beforeSnapshot.databaseBytes - afterSnapshot.databaseBytes) + vacuum.bytesReclaimed

    return {
      gc,
      vacuum,
      limitStateBefore,
      limitStateAfter,
      reclaimedBytes,
    }
  }

  repairInvalidCanonicalEmbeddings(targetSpaceId?: string): RepairInvalidCanonicalEmbeddingsResult {
    const embRepo = new EmbeddingRepository(this.db)
    return embRepo.repairInvalidCanonicalEmbeddings((spaceId) => this.markAnnDirty(spaceId), targetSpaceId)
  }
}
