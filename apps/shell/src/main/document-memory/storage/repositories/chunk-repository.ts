import type { DatabaseSync } from 'node:sqlite'
import { activateSet, retireOldSets } from '../../chunk-sets'
import { documentIndexFields } from '../../normalization'
import { measureSqlite } from '../../sqlite-timing'
import { isOcrLocation } from '../../ocr-sidecar'
import { floatBlob } from './embedding-repository'
import type { DocumentMemoryHit, ReplacementDocument, TruncatedReason } from './document-repository'

interface HitRow {
  document_id: number
  path: string
  name: string
  hash: string | null
  mtime_ms: number | null
  size_bytes: number | null
  updated_at: number | null
  truncated: number
  truncated_reason?: string | null
  chunk_id: number
  text: string
  location: string
}

function indexedAt(updatedAtSeconds: number | null): number | null {
  return typeof updatedAtSeconds === 'number' ? updatedAtSeconds * 1000 : null
}

export class ChunkRepository {
  constructor(private readonly db: DatabaseSync) {}

  chunkInserter(
    documentId: number,
    embeddingModel?: string | null,
    chunkSetId?: number | null,
    onAnnVector?: (chunkId: number, vector: number[]) => void,
  ): (chunk: ReplacementDocument['chunks'][number], ordinal: number) => number {
    const addChunk = this.db
      .prepare(`INSERT INTO chunks(document_id, chunk_set_id, ordinal, text, location)
        VALUES (?, ?, ?, ?, ?)`)
    const addFts = this.db.prepare('INSERT INTO chunk_fts(rowid, text) VALUES (?, ?)')
    const addChunkEmbedding = this.db.prepare(`
      INSERT OR REPLACE INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim)
      VALUES (?, ?, ?, ?)
    `)
    const ensureSpace = this.db.prepare(`
      INSERT OR IGNORE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES (?, ?, 'pinned', 'last-token', ?, 'q8')
    `)
    const addEmbeddingCount = this.db.prepare(`
      INSERT INTO document_embedding_counts (document_id, space_id, completed_chunks)
      VALUES (?, ?, 1)
      ON CONFLICT (document_id, space_id)
      DO UPDATE SET completed_chunks = document_embedding_counts.completed_chunks + 1
    `)
    const updateDone = this.db.prepare(
      'UPDATE documents SET chunk_done = chunk_done + 1 WHERE id = ?',
    )

    return (chunk, ordinal) => {
      const fields = documentIndexFields(chunk.text)
      const result = addChunk.run(
        documentId,
        chunkSetId ?? null,
        ordinal,
        chunk.text,
        chunk.location,
      )
      const chunkId = Number(result.lastInsertRowid)
      addFts.run(chunkId, fields.searchText)

      if (chunk.vector && embeddingModel) {
        ensureSpace.run(embeddingModel, embeddingModel, chunk.vector.length)
        addChunkEmbedding.run(
          chunkId,
          embeddingModel,
          floatBlob(chunk.vector),
          chunk.vector.length,
        )
        addEmbeddingCount.run(documentId, embeddingModel)
        updateDone.run(documentId)
        if (onAnnVector) {
          onAnnVector(chunkId, chunk.vector)
        }
      }

      return chunkId
    }
  }

  deleteOldChunksForDocument(
    documentId: number,
    activeChunkSetId: number,
    onRemovedChunkIds?: (chunkIds: number[]) => void,
  ): void {
    const oldChunkIds = this.db
      .prepare(
        'SELECT id FROM chunks WHERE document_id = ? AND (chunk_set_id IS NULL OR chunk_set_id <> ?)',
      )
      .all(documentId, activeChunkSetId) as Array<{ id: number }>
    if (!oldChunkIds.length) return

    const delFts = this.db.prepare('DELETE FROM chunk_fts WHERE rowid = ?')
    const delChunk = this.db.prepare('DELETE FROM chunks WHERE id = ?')
    for (const { id } of oldChunkIds) {
      delFts.run(id)
      delChunk.run(id)
    }

    retireOldSets(this.db, documentId)
    this.db.prepare('DELETE FROM document_embedding_counts WHERE document_id = ?').run(documentId)
    this.db.prepare(`
      INSERT INTO document_embedding_counts (document_id, space_id, completed_chunks)
      SELECT c.document_id, e.space_id, count(e.chunk_id)
      FROM chunks c
      JOIN chunk_embeddings e ON e.chunk_id = c.id
      JOIN documents d ON d.id = c.document_id
      WHERE c.document_id = ? AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)
      GROUP BY c.document_id, e.space_id
    `).run(documentId)

    this.db.prepare(`
      UPDATE documents SET chunk_done = coalesce((
        SELECT count(e.chunk_id)
        FROM chunks c
        JOIN chunk_embeddings e ON e.chunk_id = c.id
        JOIN documents d ON d.id = c.document_id
        WHERE c.document_id = ? AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)
      ), 0) WHERE id = ?
    `).run(documentId, documentId)

    const chunkIds = oldChunkIds.map((c) => c.id)
    if (onRemovedChunkIds) {
      onRemovedChunkIds(chunkIds)
    }
  }

  deleteChunks(documentId: number, onRemovedChunkIds?: (chunkIds: number[]) => void): void {
    const ids = this.db
      .prepare('SELECT id FROM chunks WHERE document_id = ?')
      .all(documentId) as Array<{ id: number }>
    const delFts = this.db.prepare('DELETE FROM chunk_fts WHERE rowid = ?')
    for (const { id } of ids) delFts.run(id)
    this.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId)
    this.db.prepare('DELETE FROM document_embedding_counts WHERE document_id = ?').run(documentId)
    this.db.prepare('UPDATE documents SET chunk_done = 0 WHERE id = ?').run(documentId)
    if (ids.length > 0 && onRemovedChunkIds) {
      onRemovedChunkIds(ids.map((c) => c.id))
    }
  }

  deleteChunksBudgeted(
    documentId: number,
    outOfBudget: () => boolean,
    onRemovedChunkId?: (chunkId: number) => void,
  ): boolean {
    const delFts = this.db.prepare('DELETE FROM chunk_fts WHERE rowid = ?')
    const delChunk = this.db.prepare('DELETE FROM chunks WHERE id = ?')
    const list = this.db.prepare('SELECT id FROM chunks WHERE document_id = ? LIMIT 64')
    for (;;) {
      const ids = list.all(documentId) as Array<{ id: number }>
      if (!ids.length) return true
      for (const { id } of ids) {
        delFts.run(id)
        delChunk.run(id)
        if (onRemovedChunkId) onRemovedChunkId(id)
        if (outOfBudget()) return false
      }
    }
  }

  cleanupDanglingBuildingSets(): number {
    return measureSqlite('GC step', () => {
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
    })
  }

  getDocumentsNeedingChunkUpgrade(limit = 100): Array<{
    id: number
    path: string
    name: string
    priorityAt: number
    sizeBytes: number
  }> {
    return measureSqlite('migration copy batch', () => {
      const rows = this.db
        .prepare(
          `SELECT d.id, d.path, d.name, d.priority_at, d.size_bytes
           FROM documents d
           LEFT JOIN chunk_sets s ON s.id = d.active_chunk_set_id
           WHERE d.excluded = 0 AND d.status = 'ready'
             AND (d.active_chunk_set_id IS NULL OR s.chunker_version < 2 OR s.state <> 'active')
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
    })
  }

  getChunkMigrationProgress(version = 2): {
    version: number
    totalDocuments: number
    completedDocuments: number
    state: 'pending' | 'running' | 'paused' | 'complete' | 'failed'
    updatedAt: number
  } | null {
    const row = this.db
      .prepare(
        `SELECT version, total_documents, completed_documents, state, updated_at
         FROM chunk_migrations WHERE version = ?`,
      )
      .get(version) as
      | {
          version: number
          total_documents: number
          completed_documents: number
          state: 'pending' | 'running' | 'paused' | 'complete' | 'failed'
          updated_at: number
        }
      | undefined

    if (!row) return null
    return {
      version: row.version,
      totalDocuments: row.total_documents,
      completedDocuments: row.completed_documents,
      state: row.state,
      updatedAt: row.updated_at,
    }
  }

  readChunk(chunkId: number): DocumentMemoryHit | null {
    const row = this.db
      .prepare(
        `SELECT d.id AS document_id, d.path, d.name, d.hash, d.mtime_ms, d.size_bytes, d.updated_at, d.truncated, d.truncated_reason, c.id AS chunk_id, c.text, c.location
      FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.id = ? AND d.excluded = 0
        AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)`,
      )
      .get(chunkId) as HitRow | undefined
    return row
      ? {
          documentId: row.document_id,
          path: row.path,
          name: row.name,
          chunkId: row.chunk_id,
          text: row.text,
          location: row.location,
          score: 0,
          hash: row.hash,
          mtimeMs: row.mtime_ms,
          sizeBytes: row.size_bytes,
          indexedAt: indexedAt(row.updated_at),
          truncated: !!row.truncated,
          truncatedReason: (row.truncated_reason as TruncatedReason | undefined) ?? null,
          ...(isOcrLocation(row.location) ? { ocr: true } : {}),
        }
      : null
  }
}
