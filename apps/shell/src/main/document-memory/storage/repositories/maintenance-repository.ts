import type { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { measureSqlite } from '../../sqlite-timing'
import { USearchIndex } from '../../usearch-index'
import { blobVector } from './embedding-repository'
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
  safeGetFileSize,
} from '../../storage-budget'

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

  constructor(
    private readonly db: DatabaseSync,
    private readonly dbPath: string,
    private readonly role: 'search' | 'worker',
  ) {}

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
      idx = new USearchIndex(dimensions, indexPath)
      this.annIndexes.set(spaceId, idx)
    }
    return idx
  }

  getAnnIndexes(): Map<string, USearchIndex> {
    return this.annIndexes
  }

  markAnnDirty(spaceId: string): void {
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

  async rebuildAnnIndex(spaceId: string): Promise<{ ok: boolean; count: number }> {
    const sanitized = spaceId.replace(/[^a-zA-Z0-9_.-]/g, '_')
    const fileName = `ann-${sanitized}.usearch`
    this.db
      .prepare(
        `INSERT INTO ann_indexes (space_id, generation, desired_generation, file_path, indexed_count, state, updated_at)
         VALUES (?, 0, 1, ?, 0, 'rebuilding', unixepoch())
         ON CONFLICT (space_id) DO UPDATE SET
           file_path = excluded.file_path,
           desired_generation = CASE WHEN ann_indexes.desired_generation = 0 THEN 1 ELSE ann_indexes.desired_generation END,
           state = 'rebuilding',
           updated_at = unixepoch()`,
      )
      .run(spaceId, fileName)

    const currentMeta = this.db
      .prepare('SELECT generation, desired_generation FROM ann_indexes WHERE space_id = ?')
      .get(spaceId) as { generation?: number; desired_generation?: number } | undefined
    const targetGeneration = currentMeta?.desired_generation ?? 1

    const rows = this.db
      .prepare(
        `SELECT e.chunk_id, e.vector, e.vector_dim
         FROM chunk_embeddings e
         JOIN chunks c ON c.id = e.chunk_id
         JOIN documents d ON d.id = c.document_id
         WHERE e.space_id = ? AND d.excluded = 0
           AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)`,
      )
      .all(spaceId) as Array<{ chunk_id: number; vector: Uint8Array; vector_dim: number }>

    if (!rows.length) {
      const info = this.db
        .prepare(
          `UPDATE ann_indexes
           SET generation = ?,
               indexed_count = 0,
               state = 'ready',
               updated_at = unixepoch()
           WHERE space_id = ? AND desired_generation = ?`,
        )
        .run(targetGeneration, spaceId, targetGeneration)
      if (info.changes === 0) {
        this.db
          .prepare("UPDATE ann_indexes SET state = 'dirty', updated_at = unixepoch() WHERE space_id = ?")
          .run(spaceId)
        return { ok: false, count: 0 }
      }
      return { ok: true, count: 0 }
    }
    const dim = rows[0]!.vector_dim
    const ann = this.getAnnIndex(spaceId, dim)
    const chunkIds = rows.map((r) => r.chunk_id)
    const vectors = rows.map((r) => Array.from(blobVector(r.vector, r.vector_dim)))

    try {
      const success = await ann.rebuildAtomic(chunkIds, vectors, targetGeneration)
      if (success) {
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
          this.db
            .prepare("UPDATE ann_indexes SET state = 'dirty', updated_at = unixepoch() WHERE space_id = ?")
            .run(spaceId)
          if (typeof ann.markDirty === 'function') ann.markDirty()
          return { ok: false, count: 0 }
        }
        return { ok: true, count: rows.length }
      } else {
        this.db
          .prepare("UPDATE ann_indexes SET state = 'dirty', updated_at = unixepoch() WHERE space_id = ?")
          .run(spaceId)
        if (typeof ann.markDirty === 'function') ann.markDirty()
        return { ok: false, count: 0 }
      }
    } catch {
      this.db
        .prepare("UPDATE ann_indexes SET state = 'dirty', updated_at = unixepoch() WHERE space_id = ?")
        .run(spaceId)
      if (typeof ann.markDirty === 'function') ann.markDirty()
      return { ok: false, count: 0 }
    }
  }

  async syncAnnIndex(spaceId: string): Promise<{ ok: boolean; count: number }> {
    return this.rebuildAnnIndex(spaceId)
  }

  checkStorageBudget(budget: DocumentIndexStorageBudget = DEFAULT_STORAGE_BUDGET): StorageBudgetSnapshot {
    const activeDbSizeBytes = safeGetFileSize(this.dbPath)
    const walSizeBytes = safeGetFileSize(`${this.dbPath}-wal`)
    const freelist = this.getStorageFreelistStats()

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
      activeDbSizeBytes,
      walSizeBytes,
      budgetBytes: budget.maxDatabaseBytes,
      chunksBytes,
      embeddingsBytes,
      ftsBytes,
      ocrBytes,
      backupBytes: safeGetFileSize(`${this.dbPath}.v2.backup.db`),
      reclaimableBytes: freelist.reclaimableBytes,
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
}
