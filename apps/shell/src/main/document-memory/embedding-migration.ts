import type { DatabaseSync } from 'node:sqlite'

export interface MigrationBatchItem {
  chunkId: number
  documentId: number
  text: string
}

export interface MigrationBatch {
  spaceId: string
  chunks: MigrationBatchItem[]
}

export interface MigrationProgress {
  targetSpaceId: string
  totalChunks: number
  completedChunks: number
  state: 'pending' | 'running' | 'paused' | 'complete' | 'failed'
}

export class EmbeddingMigration {
  private targetSpaceId = ''
  private isPaused = false

  constructor(private readonly db: DatabaseSync) {}

  setTarget(spaceId: string): void {
    if (!spaceId) return
    this.targetSpaceId = spaceId

    // Ensure record exists in embedding_migrations table
    this.db.prepare(`
      INSERT INTO embedding_migrations (target_space_id, state, updated_at)
      VALUES (?, 'pending', unixepoch())
      ON CONFLICT(target_space_id) DO UPDATE SET
        state = CASE WHEN state = 'complete' THEN 'complete' ELSE state END,
        updated_at = unixepoch()
    `).run(spaceId)

    this.updateCounters()
  }

  getTarget(): string {
    return this.targetSpaceId
  }

  pause(): void {
    this.isPaused = true
    if (this.targetSpaceId) {
      this.db.prepare(`
        UPDATE embedding_migrations
        SET state = 'paused', updated_at = unixepoch()
        WHERE target_space_id = ? AND state <> 'complete'
      `).run(this.targetSpaceId)
    }
  }

  resume(): void {
    this.isPaused = false
    if (this.targetSpaceId) {
      this.db.prepare(`
        UPDATE embedding_migrations
        SET state = 'running', updated_at = unixepoch()
        WHERE target_space_id = ? AND state = 'paused'
      `).run(this.targetSpaceId)
    }
  }

  nextBatch(limit: number): MigrationBatch {
    if (!this.targetSpaceId || this.isPaused || limit <= 0) {
      return { spaceId: this.targetSpaceId, chunks: [] }
    }

    // Mark running
    this.db.prepare(`
      UPDATE embedding_migrations
      SET state = 'running', updated_at = unixepoch()
      WHERE target_space_id = ? AND state IN ('pending', 'paused', 'complete')
    `).run(this.targetSpaceId)

    // Select chunks that lack an embedding for targetSpaceId
    // Prioritize by documents.priority_at DESC (only V2 active chunks - MIG-9)
    const rows = this.db.prepare(`
      SELECT c.id AS chunk_id, c.document_id, c.text
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      JOIN chunk_sets s ON s.id = c.chunk_set_id
      LEFT JOIN chunk_embeddings e
        ON e.chunk_id = c.id
        AND e.space_id = ?
      WHERE
        d.excluded = 0
        AND s.state = 'active'
        AND s.chunker_version = 2
        AND e.chunk_id IS NULL
      ORDER BY d.priority_at DESC, d.id DESC, c.ordinal ASC
      LIMIT ?
    `).all(this.targetSpaceId, limit) as Array<{
      chunk_id: number
      document_id: number
      text: string
    }>

    const chunks = rows.map((r) => ({
      chunkId: r.chunk_id,
      documentId: r.document_id,
      text: r.text,
    }))

    if (!chunks.length) {
      // Completed if no more chunks need embedding
      this.db.prepare(`
        UPDATE embedding_migrations
        SET state = 'complete', updated_at = unixepoch()
        WHERE target_space_id = ?
      `).run(this.targetSpaceId)
    }

    return {
      spaceId: this.targetSpaceId,
      chunks,
    }
  }

  markCompleted(_chunkIds: number[]): void {
    this.updateCounters()
  }

  updateCounters(): void {
    if (!this.targetSpaceId) return

    const totalRow = this.db.prepare(`
      SELECT count(*) AS total
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      JOIN chunk_sets s ON s.id = c.chunk_set_id
      WHERE d.excluded = 0 AND s.state = 'active' AND s.chunker_version = 2
    `).get() as { total: number }

    const doneRow = this.db.prepare(`
      SELECT count(DISTINCT e.chunk_id) AS done
      FROM chunk_embeddings e
      JOIN chunks c ON c.id = e.chunk_id
      JOIN documents d ON d.id = c.document_id
      JOIN chunk_sets s ON s.id = c.chunk_set_id
      WHERE e.space_id = ? AND d.excluded = 0 AND s.state = 'active' AND s.chunker_version = 2
    `).get(this.targetSpaceId) as { done: number }

    const total = totalRow.total
    const done = doneRow.done
    const isComplete = total > 0 && done >= total

    this.db.prepare(`
      UPDATE embedding_migrations
      SET total_chunks = ?,
          completed_chunks = ?,
          state = CASE
            WHEN ? THEN 'complete'
            WHEN state = 'complete' AND ? = 0 THEN (CASE WHEN ? THEN 'paused' ELSE 'pending' END)
            ELSE state
          END,
          updated_at = unixepoch()
      WHERE target_space_id = ?
    `).run(total, done, isComplete ? 1 : 0, isComplete ? 1 : 0, this.isPaused ? 1 : 0, this.targetSpaceId)
  }

  progress(): MigrationProgress {
    if (!this.targetSpaceId) {
      return {
        targetSpaceId: '',
        totalChunks: 0,
        completedChunks: 0,
        state: 'pending',
      }
    }

    const row = this.db.prepare(`
      SELECT total_chunks, completed_chunks, state
      FROM embedding_migrations
      WHERE target_space_id = ?
    `).get(this.targetSpaceId) as {
      total_chunks: number
      completed_chunks: number
      state: 'pending' | 'running' | 'paused' | 'complete' | 'failed'
    } | undefined

    if (!row) {
      return {
        targetSpaceId: this.targetSpaceId,
        totalChunks: 0,
        completedChunks: 0,
        state: 'pending',
      }
    }

    return {
      targetSpaceId: this.targetSpaceId,
      totalChunks: row.total_chunks,
      completedChunks: row.completed_chunks,
      state: row.state,
    }
  }

  getProgress(): MigrationProgress {
    return this.progress()
  }

  isComplete(): boolean {
    return this.progress().state === 'complete'
  }
}

export { EmbeddingMigration as EmbeddingMigrationCoordinator }

