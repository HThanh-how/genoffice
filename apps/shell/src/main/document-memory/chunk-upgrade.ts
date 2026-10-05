import type { DatabaseSync } from 'node:sqlite'
import { activateSet, createBuildingSet, retireOldSets } from './chunk-sets'
import { capChunks, chunkDocumentTextV2 } from './chunks'
import { documentIndexFields } from './normalization'
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

  /**
   * Retrieves documents requiring upgrade to Chunker V2, prioritized by:
   * 1. priority_at DESC (recently accessed/opened first)
   * 2. size_bytes ASC (small documents first)
   * 3. id ASC (stable tie-breaker)
   */
  getDocumentsNeedingUpgrade(limit = 100): DocumentNeedingUpgrade[] {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.path, d.name, d.priority_at, d.size_bytes
         FROM documents d
         LEFT JOIN chunk_sets s ON s.id = d.active_chunk_set_id
         WHERE d.excluded = 0
           AND d.status = 'ready'
           AND (
             d.active_chunk_set_id IS NULL
             OR s.chunker_version < 2
             OR s.state <> 'active'
           )
           AND EXISTS (SELECT 1 FROM chunks c WHERE c.document_id = d.id)
         ORDER BY d.priority_at DESC, coalesce(d.size_bytes, 0) ASC, d.id ASC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      id: number
      path: string
      name: string
      priority_at: number
      size_bytes: number
    }>

    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      name: r.name,
      priorityAt: r.priority_at,
      sizeBytes: r.size_bytes,
    }))
  }

  /**
   * Upgrades a single document's chunks from legacy/V1 to Chunker V2 atomically.
   * Preserves existing searchability until the new set is activated (Zero Downtime / MIG-1, MIG-5).
   */
  upgradeDocument(documentId: number): boolean {
    const doc = this.db
      .prepare(
        `SELECT d.id, d.path, d.name, d.active_chunk_set_id
         FROM documents d
         LEFT JOIN chunk_sets s ON s.id = d.active_chunk_set_id
         WHERE d.id = ? AND d.excluded = 0 AND d.status = 'ready'
           AND (d.active_chunk_set_id IS NULL OR s.chunker_version < 2 OR s.state <> 'active')`,
      )
      .get(documentId) as
      | { id: number; path: string; name: string; active_chunk_set_id: number | null }
      | undefined

    if (!doc) return false

    // Fetch existing active/legacy chunks
    const oldChunks = this.db
      .prepare(
        `SELECT text, location, ordinal
         FROM chunks
         WHERE document_id = ?
           AND (chunk_set_id IS NULL OR chunk_set_id = ?)
         ORDER BY ordinal ASC`,
      )
      .all(documentId, doc.active_chunk_set_id ?? -1) as Array<{
      text: string
      location: string
      ordinal: number
    }>

    if (!oldChunks.length) return false

    // Join text without rescanning from disk (MIG-1, MIG-5)
    const fullText = oldChunks.map((c) => c.text).join('\n')
    const v2Chunks = capChunks(
      chunkDocumentTextV2(fullText, {
        title: doc.name || doc.path.split(/[\\/]/).pop(),
      }),
    ).chunks

    if (!v2Chunks.length && fullText.trim().length > 0) {
      v2Chunks.push({ text: fullText.trim(), location: 'Chunk 1' })
    }

    this.db.exec('BEGIN IMMEDIATE')
    try {
      // 1. Create building set for Chunker V2
      const chunkSetId = createBuildingSet(this.db, documentId, 2)
      const addChunk = this.db.prepare(
        `INSERT INTO chunks(document_id, chunk_set_id, ordinal, text, normalized, location)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      const addFts = this.db.prepare('INSERT INTO chunk_fts(rowid, text) VALUES (?, ?)')

      v2Chunks.forEach((chunk, ordinal) => {
        const fields = documentIndexFields(chunk.text)
        const result = addChunk.run(
          documentId,
          chunkSetId,
          ordinal,
          chunk.text,
          fields.normalized,
          chunk.location || `Chunk ${ordinal + 1}`,
        )
        addFts.run(result.lastInsertRowid, fields.searchText)
      })

      // 2. Atomically activate V2 chunk set
      activateSet(this.db, documentId, chunkSetId)

      // 3. Delete old V1 chunks and FTS rows
      const oldChunkIds = this.db
        .prepare(
          'SELECT id FROM chunks WHERE document_id = ? AND (chunk_set_id IS NULL OR chunk_set_id <> ?)',
        )
        .all(documentId, chunkSetId) as Array<{ id: number }>

      const delFts = this.db.prepare('DELETE FROM chunk_fts WHERE rowid = ?')
      const delChunk = this.db.prepare('DELETE FROM chunks WHERE id = ?')
      for (const { id } of oldChunkIds) {
        delFts.run(id)
        delChunk.run(id)
      }
      retireOldSets(this.db, documentId)

      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    this.updateCounters()
    return true
  }

  /**
   * Processes the next batch of documents needing upgrade according to MIG-4 priority.
   */
  nextBatch(limit = 10): number {
    if (this.isPaused || limit <= 0) return 0

    const targets = this.getDocumentsNeedingUpgrade(limit)
    if (!targets.length) {
      this.updateCounters()
      return 0
    }

    // Mark running
    this.db
      .prepare(
        `UPDATE chunk_migrations
         SET state = 'running', updated_at = unixepoch()
         WHERE version = 2 AND state IN ('pending', 'paused')`,
      )
      .run()

    let upgraded = 0
    for (const doc of targets) {
      if (this.isPaused) break
      if (this.upgradeDocument(doc.id)) {
        upgraded++
      }
    }

    this.updateCounters()
    return upgraded
  }

  /**
   * Continuously upgrades documents in batches until all are completed or migration is paused.
   */
  upgradeAll(batchSize = 10): number {
    let total = 0
    while (!this.isPaused) {
      const count = this.nextBatch(batchSize)
      total += count
      if (count === 0 || this.isComplete()) break
    }
    return total
  }

  updateCounters(): ChunkUpgradeProgress {
    const totalRow = this.db
      .prepare(
        `SELECT count(DISTINCT d.id) AS total
         FROM documents d
         JOIN chunks c ON c.document_id = d.id
         WHERE d.excluded = 0 AND d.status = 'ready'`,
      )
      .get() as { total: number }

    const completedRow = this.db
      .prepare(
        `SELECT count(DISTINCT d.id) AS completed
         FROM documents d
         JOIN chunk_sets s ON s.id = d.active_chunk_set_id
         WHERE d.excluded = 0 AND d.status = 'ready'
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
