import type { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { issueReason, type IndexIssue } from '../../issues'
import { measureSqlite } from '../../sqlite-timing'
import { toDocument, type DocRow, type StoredDocument } from './document-repository'
import { hasContentEvictedColumn } from '../migration/cache-retention'
import { hasVectorEvictionTable } from '../vector-eviction-marker'

export interface DocumentChunkProgress {
  document: StoredDocument | null
  completedChunks: number
  totalChunks: number
}

export interface FolderChunkProgress {
  totalFiles: number
  readyFiles: number
  /**
   * Files that truly still wait for extraction / embedding. Excludes `releasedFiles`.
   * Invariant (excluded = 0 rows): waitingFiles + releasedFiles + readyFiles + errorFiles = totalFiles.
   */
  pendingFiles: number
  /** Same as pendingFiles; only set together with releasedFiles (absent = nothing released). */
  waitingFiles?: number
  /**
   * Files whose vectors/content were released by cache retention (or compacted): still searchable by
   * name/text, reloaded when opened, intentionally NOT re-embedded. Their chunks are left out of
   * totalChunks / completedChunks / semanticCoverage.
   */
  releasedFiles?: number
  errorFiles: number
  emptyFiles?: number
  /** Images/videos (name + metadata only). They are 'ready' rows, so already inside totalFiles / readyFiles. */
  mediaFiles?: number
  completedChunks: number
  totalChunks: number
  partialFileProgress: number
  truncatedFiles: number
  semanticCoverage?: number
  activeEmbeddingSpace?: string
}

export interface DocumentMemoryStats {
  docs: number
  /** documents whose vectors were released (see FolderChunkProgress.releasedFiles) */
  releasedDocs?: number
  chunks: number
  vectors: number
  errors: number
  semanticCoverage?: number
  activeEmbeddingSpace?: string
}

/**
 * Released = a document that would otherwise be incomplete work (pending / text-only) but is deliberately
 * not re-embedded: content_evicted, or a durable `document_vector_evictions` marker that still applies
 * (same hash, not opened since). Mirrors DocumentRepository.incompletePaths(), so waiting == incompletePaths.
 * The marker row is read defensively: only presence / hash / evicted_at are used, any extra column or state
 * (e.g. a 'skeleton' compaction state) counts as released. SQL expression over alias `d`.
 */
export function releasedDocumentSql(db: DatabaseSync, alias = 'd'): string {
  const parts: string[] = []
  if (hasContentEvictedColumn(db)) parts.push(`${alias}.content_evicted = 1`)
  if (hasVectorEvictionTable(db)) {
    let strict: boolean
    try {
      const cols = new Set(
        (db.prepare('PRAGMA table_info(document_vector_evictions)').all() as Array<{ name: string }>).map((c) => c.name),
      )
      strict = cols.has('hash') && cols.has('evicted_at')
    } catch {
      strict = false
    }
    parts.push(
      `EXISTS (SELECT 1 FROM document_vector_evictions m WHERE m.document_id = ${alias}.id` +
        (strict ? ` AND m.hash IS ${alias}.hash AND ${alias}.last_opened_at <= m.evicted_at` : '') +
        ')',
    )
  }
  return parts.length ? `(${alias}.status IN ('pending', 'text-only') AND (${parts.join(' OR ')}))` : '0'
}

export class ProgressRepository {
  constructor(private readonly db: DatabaseSync) {}

  hasUncountedDocuments(): boolean {
    return !!this.db.prepare('SELECT 1 FROM documents WHERE chunk_counted = 0 LIMIT 1').get()
  }

  backfillCounters(activeSpaceId?: string, maxDocuments = 200): boolean {
    return measureSqlite('embedding-count rebuild', () => {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const ids = (
          this.db
            .prepare('SELECT id FROM documents WHERE chunk_counted = 0 ORDER BY id LIMIT ?')
            .all(maxDocuments) as Array<{ id: number }>
        ).map((row) => row.id)
        if (!ids.length) {
          this.db.exec('COMMIT')
          return false
        }
        const first = ids[0]!
        const last = ids[ids.length - 1]!
        const totals = new Map<number, number>()
        for (const row of this.db
          .prepare(
            'SELECT document_id, count(*) AS n FROM chunks WHERE document_id BETWEEN ? AND ? GROUP BY document_id',
          )
          .all(first, last) as Array<{ document_id: number; n: number }>)
          totals.set(row.document_id, row.n)

        const done = new Map<number, number>()
        // Scope to active space or document's embedding_model, DO NOT sum across all spaces (BEH-20)
        const counts = this.db
          .prepare(
            `SELECT ec.document_id, ec.completed_chunks AS n 
             FROM document_embedding_counts ec
             JOIN documents d ON d.id = ec.document_id
             WHERE ec.document_id BETWEEN ? AND ? 
               AND ec.space_id = coalesce(?, d.embedding_model)`,
          )
          .all(first, last, activeSpaceId ?? null) as Array<{ document_id: number; n: number }>
        for (const hit of counts) {
          done.set(hit.document_id, hit.n)
        }

        const update = this.db.prepare(
          'UPDATE documents SET chunk_total = ?, chunk_done = ?, chunk_counted = 1 WHERE id = ?',
        )
        for (const id of ids) {
          const tot = Math.max(0, totals.get(id) ?? 0)
          const d = Math.min(Math.max(0, done.get(id) ?? 0), tot)
          update.run(tot, d, id)
        }
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
      return this.hasUncountedDocuments()
    })
  }

  /** Scopes document chunk progress to active embedding space (BEH-20). */
  chunkProgress(path: string, activeSpaceId?: string): DocumentChunkProgress {
    const targetSpace = activeSpaceId ?? null
    const row = this.db
      .prepare(
        `SELECT d.id, d.path, d.name, d.status, d.mtime_ms, d.size_bytes, d.hash, d.error, d.truncated, d.truncated_reason,
          CASE WHEN d.chunk_counted = 1 THEN d.chunk_total
            ELSE (SELECT count(*) FROM chunks c WHERE c.document_id = d.id) END AS total_chunks,
          coalesce(
            (SELECT ec.completed_chunks FROM document_embedding_counts ec 
             WHERE ec.document_id = d.id AND ec.space_id = coalesce(?, d.embedding_model)),
            CASE WHEN d.chunk_counted = 1 AND (? IS NULL OR ? = d.embedding_model) THEN d.chunk_done ELSE 0 END
          ) AS completed_chunks
        FROM documents d WHERE d.path = ?`,
      )
      .get(targetSpace, targetSpace, targetSpace, resolve(path)) as
      | (DocRow & { total_chunks: number; completed_chunks: number | null })
      | undefined
    const totalChunks = Math.max(0, row?.total_chunks ?? 0)
    const rawCompleted = Math.max(0, row?.completed_chunks ?? 0)
    const completedChunks = Math.min(rawCompleted, totalChunks)
    return {
      document: row ? toDocument(row) : null,
      completedChunks,
      totalChunks,
    }
  }

  folderChunkProgress(root?: string, activeSpaceId?: string): FolderChunkProgress {
    return measureSqlite('folderChunkProgress', () => {
      const normalized = root === undefined ? null : resolve(root)
      const prefix =
        normalized === null
          ? null
          : normalized.endsWith('/') || normalized.endsWith('\\')
            ? normalized
            : `${normalized}${normalized.includes('\\') ? '\\' : '/'}`
      const targetSpace = activeSpaceId ?? null
      const released = releasedDocumentSql(this.db)

      const row = this.db
        .prepare(
          `SELECT count(*) AS total_files,
            sum(CASE WHEN status IN ('ready', 'empty') THEN 1 ELSE 0 END) AS ready_files,
            sum(CASE WHEN status IN ('pending', 'text-only') AND released = 0 THEN 1 ELSE 0 END) AS pending_files,
            sum(released) AS released_files,
            sum(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_files,
            sum(CASE WHEN status = 'empty' THEN 1 ELSE 0 END) AS empty_files,
            coalesce(sum(is_media), 0) AS media_files,
            coalesce(sum(truncated), 0) AS truncated_files,
            coalesce(sum(CASE WHEN released = 1 THEN 0 ELSE done_chunks END), 0) AS completed_chunks,
            coalesce(sum(CASE WHEN released = 1 THEN 0 ELSE total_chunks END), 0) AS total_chunks,
            coalesce(sum(CASE WHEN status IN ('ready','empty') OR released = 1 THEN 1.0
              WHEN status = 'text-only' AND total_chunks > 0
                THEN min(1.0, max(0.0, done_chunks * 1.0 / total_chunks))
              ELSE 0.0 END), 0.0) AS partial_file_progress
          FROM (
            SELECT d.status, d.truncated,
              CASE WHEN EXISTS (SELECT 1 FROM document_media dm WHERE dm.document_id = d.id) THEN 1 ELSE 0 END AS is_media,
              CASE WHEN ${released} THEN 1 ELSE 0 END AS released,
              CASE WHEN d.chunk_counted = 1 THEN d.chunk_total
                ELSE (SELECT count(*) FROM chunks c WHERE c.document_id = d.id) END AS total_chunks,
              min(
                CASE WHEN d.chunk_counted = 1 THEN d.chunk_total
                  ELSE (SELECT count(*) FROM chunks c WHERE c.document_id = d.id) END,
                coalesce(
                  (SELECT ec.completed_chunks FROM document_embedding_counts ec 
                   WHERE ec.document_id = d.id AND ec.space_id = coalesce(?, d.embedding_model)),
                  CASE WHEN d.chunk_counted = 1 AND (? IS NULL OR ? = d.embedding_model) THEN d.chunk_done ELSE 0 END
                )
              ) AS done_chunks
            FROM documents d
            WHERE d.excluded = 0 ${normalized === null ? '' : 'AND (d.path = ? OR substr(d.path, 1, length(?)) = ?)'}
          )`,
        )
        .get(
          targetSpace,
          targetSpace,
          targetSpace,
          ...(normalized === null ? [] : [normalized, prefix!, prefix!]),
        ) as
        | {
            total_files: number
            ready_files: number
            pending_files: number
            released_files: number | null
            error_files: number
            empty_files: number
            media_files: number
            truncated_files: number
            completed_chunks: number
            total_chunks: number
            partial_file_progress: number
          }
        | undefined

      const totalChunks = Math.max(0, row?.total_chunks ?? 0)
      const rawCompleted = Math.max(0, row?.completed_chunks ?? 0)
      const completedChunks = Math.min(rawCompleted, totalChunks)
      let semanticCoverage: number | undefined
      if (activeSpaceId !== undefined) {
        semanticCoverage = totalChunks > 0 ? Math.min(1, Math.max(0, completedChunks) / totalChunks) : 1
      }

      return {
        totalFiles: row?.total_files ?? 0,
        readyFiles: row?.ready_files ?? 0,
        pendingFiles: row?.pending_files ?? 0,
        // only present when something was released, so the payload of libraries without released files is unchanged
        ...(row?.released_files
          ? { waitingFiles: row.pending_files ?? 0, releasedFiles: row.released_files }
          : {}),
        errorFiles: row?.error_files ?? 0,
        emptyFiles: row?.empty_files ?? 0,
        ...(row?.media_files ? { mediaFiles: row.media_files } : {}),
        completedChunks,
        totalChunks,
        partialFileProgress: row?.partial_file_progress ?? 0,
        truncatedFiles: row?.truncated_files ?? 0,
        ...(semanticCoverage !== undefined ? { semanticCoverage } : {}),
        ...(activeSpaceId ? { activeEmbeddingSpace: activeSpaceId } : {}),
      }
    })
  }

  indexIssues(root: string, offset = 0): { total: number; items: IndexIssue[] } {
    const normalized = resolve(root)
    const prefix = normalized + (normalized.includes('\\') ? '\\' : '/')
    const where =
      "excluded = 0 AND status IN ('error', 'empty') AND (path = ? OR substr(path, 1, length(?)) = ?)"
    const total = (
      this.db
        .prepare(`SELECT count(*) n FROM documents WHERE ${where}`)
        .get(normalized, prefix, prefix) as { n: number }
    ).n
    const rows = this.db
      .prepare(
        `SELECT id, path, name, status, error FROM documents WHERE ${where}
      ORDER BY status ASC, priority_at DESC, id DESC LIMIT 10 OFFSET ?`,
      )
      .all(normalized, prefix, prefix, offset) as Array<{
      id: number
      path: string
      name: string
      status: string
      error: string | null
    }>
    return {
      total,
      items: rows.map(({ status, error, ...row }) => ({
        ...row,
        reason: issueReason(error, status),
        ...(error ? { error } : {}),
      })),
    }
  }

  stats(activeEmbeddingSpace?: string): DocumentMemoryStats {
    return measureSqlite('stats', () => {
      const targetSpace = activeEmbeddingSpace ?? null
      const released = releasedDocumentSql(this.db)
      const row = this.db
        .prepare(
          `SELECT count(*) AS docs,
            coalesce(sum(CASE WHEN ${released} THEN 1 ELSE 0 END), 0) AS released_docs,
            coalesce(sum(CASE WHEN d.chunk_counted = 1 THEN d.chunk_total ELSE (SELECT count(*) FROM chunks c WHERE c.document_id = d.id) END), 0) AS chunks,
            coalesce(sum(CASE WHEN ${released} THEN 0 WHEN d.chunk_counted = 1 THEN d.chunk_total ELSE (SELECT count(*) FROM chunks c WHERE c.document_id = d.id) END), 0) AS wanted_chunks,
            coalesce(sum(
              min(
                CASE WHEN d.chunk_counted = 1 THEN d.chunk_total ELSE (SELECT count(*) FROM chunks c WHERE c.document_id = d.id) END,
                coalesce(
                  (SELECT ec.completed_chunks FROM document_embedding_counts ec 
                   WHERE ec.document_id = d.id AND ec.space_id = coalesce(?, d.embedding_model)),
                  CASE WHEN d.chunk_counted = 1 AND (? IS NULL OR ? = d.embedding_model) THEN d.chunk_done ELSE 0 END
                )
              )
            ), 0) AS vectors,
            coalesce(sum(CASE WHEN d.status = 'error' THEN 1 ELSE 0 END), 0) AS errors
          FROM documents d WHERE d.excluded = 0`,
        )
        .get(targetSpace, targetSpace, targetSpace) as {
          docs: number
          released_docs: number
          chunks: number
          wanted_chunks: number
          vectors: number
          errors: number
        }

      const chunks = Math.max(0, row?.chunks ?? 0)
      const vectors = Math.min(Math.max(0, row?.vectors ?? 0), chunks)
      let semanticCoverage: number | undefined
      // Coverage is measured over the chunks we still intend to embed (released documents are left out).
      const wanted = Math.min(chunks, Math.max(0, row?.wanted_chunks ?? chunks))
      if (activeEmbeddingSpace && wanted > 0) {
        semanticCoverage = Math.min(1, Math.max(0, vectors) / wanted)
      } else if (activeEmbeddingSpace && wanted === 0) {
        semanticCoverage = 1
      }

      return {
        docs: row?.docs ?? 0,
        ...(row?.released_docs ? { releasedDocs: row.released_docs } : {}),
        chunks,
        vectors,
        errors: row?.errors ?? 0,
        ...(semanticCoverage !== undefined ? { semanticCoverage } : {}),
        ...(activeEmbeddingSpace ? { activeEmbeddingSpace } : {}),
      }
    })
  }
}
