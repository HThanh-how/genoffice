import type { DatabaseSync } from 'node:sqlite'
import type { DocumentMemoryStore } from './store'

export interface ChunkUpgradeProgress {
  version: number
  totalDocuments: number
  completedDocuments: number
  state: 'pending' | 'running' | 'paused' | 'complete' | 'failed'
}

export interface DocumentNeedingUpgrade {
  id: number
  path: string
  name: string
  priorityAt: number
  sizeBytes: number
}

export interface ChunkUpgradeOptions {
  autoRecover?: boolean
}

export class ChunkUpgradeCoordinator {
  private readonly db: DatabaseSync
  private isPaused = false

  constructor(
    dbOrStore: DatabaseSync | DocumentMemoryStore,
    options: ChunkUpgradeOptions = {},
  ) {
    this.db = 'db' in dbOrStore ? (dbOrStore as unknown as { db: DatabaseSync }).db : dbOrStore

    // Ensure migration tables exist
    this.ensureTables()

    // Crash / Restart Recovery: Purge dangling building sets (MIG-14)
    if (options.autoRecover !== false) {
      this.recover()
    }

    this.updateCounters()
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunk_migrations (
        version INTEGER PRIMARY KEY,
        total_documents INTEGER NOT NULL,
        completed_documents INTEGER NOT NULL,
        state TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES ('v2_chunk_migrations', unixepoch());
    `)
  }

  /**
   * Cleans up orphaned or incomplete building chunk sets created before an interruption/crash (MIG-14).
   * Restores database state cleanly and preserves all active / legacy sets.
   */
  recover(): number {
    const danglingSets = this.db
      .prepare("SELECT id, document_id FROM chunk_sets WHERE state = 'building'")
      .all() as Array<{ id: number; document_id: number }>

    if (!danglingSets.length) return 0

    this.db.exec('BEGIN IMMEDIATE')
    try {
      const delFts = this.db.prepare('DELETE FROM chunk_fts WHERE rowid = ?')
      const delChunk = this.db.prepare('DELETE FROM chunks WHERE id = ?')
      const delSet = this.db.prepare('DELETE FROM chunk_sets WHERE id = ?')

      for (const set of danglingSets) {
        const chunks = this.db
          .prepare('SELECT id FROM chunks WHERE chunk_set_id = ?')
          .all(set.id) as Array<{ id: number }>
        for (const c of chunks) {
          delFts.run(c.id)
          delChunk.run(c.id)
        }
        delSet.run(set.id)
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    return danglingSets.length
  }

  /**
   * Alias for recover (MIG-14).
   */
  cleanupDanglingSets(): number {
    return this.recover()
  }

  pause(): void {
    this.isPaused = true
    this.db
      .prepare(
        `UPDATE chunk_migrations
         SET state = 'paused', updated_at = unixepoch()
         WHERE version = 2 AND state <> 'complete'`,
      )
      .run()
  }

  resume(): void {
    this.isPaused = false
    this.db
      .prepare(
        `UPDATE chunk_migrations
         SET state = 'running', updated_at = unixepoch()
         WHERE version = 2 AND state = 'paused'`,
      )
      .run()
  }

  get paused(): boolean {
    return this.isPaused
  }

  /**
   * Retrieves documents requiring upgrade to Chunker V2, prioritized by:
   * 1. priority_at DESC (recently accessed/opened first)
   * 2. size_bytes ASC (small documents first)
   * 3. id ASC (stable tie-breaker)
   */
  getDocumentsNeedingUpgrade(limit = 100, excludedIds?: Iterable<number>): DocumentNeedingUpgrade[] {
    if (this.isPaused || limit <= 0) return []

    const excludedSet = excludedIds instanceof Set ? excludedIds : new Set(excludedIds ?? [])
    const fetchLimit = limit + excludedSet.size

    const rows = this.db
      .prepare(
        `SELECT d.id, d.path, d.name, d.priority_at, d.size_bytes
         FROM documents d
         LEFT JOIN chunk_sets s ON s.id = d.active_chunk_set_id
         WHERE d.excluded = 0
           AND d.status IN ('ready', 'text-only')
           AND (
             d.active_chunk_set_id IS NULL
             OR s.chunker_version < 2
             OR s.state <> 'active'
           )
           AND EXISTS (SELECT 1 FROM chunks c WHERE c.document_id = d.id)
         ORDER BY d.priority_at DESC, coalesce(d.size_bytes, 0) ASC, d.id ASC
         LIMIT ?`,
      )
      .all(fetchLimit) as Array<{
      id: number
      path: string
      name: string
      priority_at: number
      size_bytes: number
    }>

    const result: DocumentNeedingUpgrade[] = []
    for (const r of rows) {
      if (!excludedSet.has(r.id)) {
        result.push({
          id: r.id,
          path: r.path,
          name: r.name,
          priorityAt: r.priority_at,
          sizeBytes: r.size_bytes,
        })
        if (result.length >= limit) break
      }
    }

    return result
  }

  /**
   * Ghi nhận hoàn thành cho 1 tài liệu sau khi upgrade thành công.
   */
  markDocumentUpgraded(documentId: number): void {
    if (!this.isPaused) {
      this.db
        .prepare(
          `UPDATE chunk_migrations
           SET state = 'running', updated_at = unixepoch()
           WHERE version = 2 AND state IN ('pending', 'paused')`,
        )
        .run()
    }
    this.updateCounters()
  }

  updateCounters(): ChunkUpgradeProgress {
    const totalRow = this.db
      .prepare(
        `SELECT count(DISTINCT d.id) AS total
         FROM documents d
         JOIN chunks c ON c.document_id = d.id
         WHERE d.excluded = 0 AND d.status IN ('ready', 'text-only')`,
      )
      .get() as { total: number }

    const completedRow = this.db
      .prepare(
        `SELECT count(DISTINCT d.id) AS completed
         FROM documents d
         JOIN chunk_sets s ON s.id = d.active_chunk_set_id
         WHERE d.excluded = 0 AND d.status IN ('ready', 'text-only')
           AND s.state = 'active' AND s.chunker_version >= 2`,
      )
      .get() as { completed: number }

    const total = totalRow.total
    const completed = completedRow.completed
    const isComplete = total > 0 && completed >= total

    const currentState = this.isPaused
      ? 'paused'
      : isComplete
        ? 'complete'
        : 'pending'

    this.db
      .prepare(
        `INSERT INTO chunk_migrations (version, total_documents, completed_documents, state, updated_at)
         VALUES (2, ?, ?, ?, unixepoch())
         ON CONFLICT(version) DO UPDATE SET
           total_documents = excluded.total_documents,
           completed_documents = excluded.completed_documents,
           state = CASE
             WHEN excluded.total_documents > 0 AND excluded.completed_documents >= excluded.total_documents THEN 'complete'
             WHEN state = 'complete' AND excluded.completed_documents < excluded.total_documents THEN (CASE WHEN ? THEN 'paused' ELSE 'pending' END)
             ELSE (CASE WHEN ? THEN 'paused' ELSE state END)
           END,
           updated_at = unixepoch()`,
      )
      .run(total, completed, currentState, this.isPaused ? 1 : 0, this.isPaused ? 1 : 0)

    return this.getProgress()
  }

  getProgress(): ChunkUpgradeProgress {
    const row = this.db
      .prepare(
        `SELECT version, total_documents, completed_documents, state
         FROM chunk_migrations WHERE version = 2`,
      )
      .get() as
      | {
          version: number
          total_documents: number
          completed_documents: number
          state: 'pending' | 'running' | 'paused' | 'complete' | 'failed'
        }
      | undefined

    if (!row) {
      return {
        version: 2,
        totalDocuments: 0,
        completedDocuments: 0,
        state: 'pending',
      }
    }

    return {
      version: row.version,
      totalDocuments: row.total_documents,
      completedDocuments: row.completed_documents,
      state: row.state,
    }
  }

  isComplete(): boolean {
    return this.getProgress().state === 'complete'
  }
}
