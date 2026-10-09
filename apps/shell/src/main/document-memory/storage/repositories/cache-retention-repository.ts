import type { DatabaseSync } from 'node:sqlite'
import { hasContentEvictedColumn } from '../migration/cache-retention'
import { markVectorsEvicted } from '../vector-eviction-marker'

export interface EvictionCandidateDoc {
  id: number
  path: string
  name: string
  chunkTotal: number
  lastOpenedAt: number
  importanceOverride: string
  importanceSuggestion: string
}

/**
 * Age scopes of the retention age policy (runtime/value-density.ts), always excluding protected documents:
 *   archive           neither opened nor modified since archiveCutMs (known age only), low and normal documents
 *   normal-non-fresh  'normal' documents (not low, not important) last touched before freshCutMs
 *   normal-fresh      'normal' documents touched at/after freshCutMs (last resort only)
 */
export type AgeEvictionScope = 'archive' | 'normal-non-fresh' | 'normal-fresh'

const AGE_PROTECTED_SQL = `(d.importance_override = 'important'
  OR ((d.importance_override = 'auto' OR d.importance_override IS NULL) AND d.importance_suggestion = 'important'))`
const AGE_NORMAL_SQL = `((d.importance_override = 'auto' OR d.importance_override IS NULL)
  AND (d.importance_suggestion = 'normal' OR d.importance_suggestion = 'unknown' OR d.importance_suggestion IS NULL))`
/** Same expression as LAST_TOUCH_SQL in runtime/value-density.ts (opened or modified, ms; updated_at as fallback). */
const AGE_TOUCH_SQL = `CASE WHEN max(coalesce(d.last_opened_at, 0), coalesce(d.mtime_ms, 0)) > 0 THEN max(coalesce(d.last_opened_at, 0), coalesce(d.mtime_ms, 0)) WHEN coalesce(d.updated_at, 0) BETWEEN 1 AND 99999999999 THEN d.updated_at * 1000 ELSE 0 END`

export interface AgeEvictionCutoffs {
  freshCutMs: number
  archiveCutMs: number
}

export interface AnnSpaceDirtySpec {
  spaceId: string
  desiredGeneration: number
}

export interface EvictionBatchResult {
  deletedEmbeddings: number
  affectedDocumentIds: number[]
  affectedSpaces: AnnSpaceDirtySpec[]
}

export interface CacheContentEvictionBatchResult {
  deletedChunks: number
  deletedFtsRows: number
  deletedOcrPages: number
  affectedDocumentIds: number[]
  affectedSpaces: AnnSpaceDirtySpec[]
}

/**
 * Enterprise Cache Retention Repository.
 *
 * Provides transactional primitives for document cache pruning:
 * - Tiered candidate selection obeying strict importance hierarchy:
 *   Override 'important' wins; override 'low' wins; auto/null + suggestion 'important' is protected.
 * - Eviction order: obsolete/orphan -> low importance -> normal LRU -> important last (critical only).
 * - Document identity, name, path, and importance overrides are ALWAYS preserved.
 * - Transactional mutations: Each batch mutation executes in an isolated transaction.
 * - Invariant integrity: Respects foreign keys, trigger counters, and active chunk set IDs.
 * - Post-commit ANN invalidation: Returns affectedSpaceIds and new generation numbers ONLY after commit.
 */
export class CacheRetentionRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Counts protected Tier 4 documents:
   * override = 'important' OR (override IN ('auto', NULL) AND suggestion = 'important')
   */
  countProtectedDocuments(): number {
    try {
      const row = this.db
        .prepare(`
          SELECT count(*) AS c FROM documents
          WHERE importance_override = 'important'
             OR (importance_override = 'auto' AND importance_suggestion = 'important')
             OR (importance_override IS NULL AND importance_suggestion = 'important')
        `)
        .get() as { c: number } | undefined
      return row?.c ?? 0
    } catch {
      return 0
    }
  }

  /**
   * Retrieves bounded batch of eviction candidate documents with active embeddings to prune.
   */
  getEmbeddingEvictionCandidates(
    tier: 'low' | 'normal' | 'important',
    limit = 25,
    offset = 0,
  ): EvictionCandidateDoc[] {
    const safeLimit = Math.max(1, Math.min(limit, 500))
    const safeOffset = Math.max(0, offset)

    let sql: string
    if (tier === 'low') {
      // Tier 2: Low importance (override='low' strictly; suggestion='low' does not exist in schema)
      sql = `
        SELECT d.id, d.path, d.name, coalesce(d.chunk_total, 0) AS chunk_total,
               d.last_opened_at, d.importance_override, d.importance_suggestion
        FROM documents d
        WHERE d.importance_override = 'low'
          AND d.excluded = 0
          AND EXISTS (
            SELECT 1 FROM chunk_embeddings ce
            JOIN chunks c ON c.id = ce.chunk_id
            WHERE c.document_id = d.id
          )
        ORDER BY
          CASE
            WHEN coalesce(d.last_opened_at, 0) > coalesce(d.mtime_ms, 0) THEN d.last_opened_at
            WHEN coalesce(d.mtime_ms, 0) > 0 THEN d.mtime_ms
            ELSE coalesce(d.updated_at, 0)
          END ASC,
          d.id ASC
        LIMIT ? OFFSET ?
      `
    } else if (tier === 'normal') {
      // Tier 3: Normal documents LRU (oldest last_opened_at first).
      // Strictly excludes Tier 4 (important) and Tier 2 (override='low').
      sql = `
        SELECT d.id, d.path, d.name, coalesce(d.chunk_total, 0) AS chunk_total,
               d.last_opened_at, d.importance_override, d.importance_suggestion
        FROM documents d
        WHERE (d.importance_override = 'auto' OR d.importance_override IS NULL)
          AND (d.importance_suggestion = 'normal' OR d.importance_suggestion = 'unknown' OR d.importance_suggestion IS NULL)
          AND d.excluded = 0
          AND EXISTS (
            SELECT 1 FROM chunk_embeddings ce
            JOIN chunks c ON c.id = ce.chunk_id
            WHERE c.document_id = d.id
          )
        ORDER BY
          CASE
            WHEN coalesce(d.last_opened_at, 0) > coalesce(d.mtime_ms, 0) THEN d.last_opened_at
            WHEN coalesce(d.mtime_ms, 0) > 0 THEN d.mtime_ms
            ELSE coalesce(d.updated_at, 0)
          END ASC,
          d.id ASC
        LIMIT ? OFFSET ?
      `
    } else {
      // Tier 4: Important documents (only pruned in critical emergencies / explicit force mode)
      sql = `
        SELECT d.id, d.path, d.name, coalesce(d.chunk_total, 0) AS chunk_total,
               d.last_opened_at, d.importance_override, d.importance_suggestion
        FROM documents d
        WHERE (
          d.importance_override = 'important'
          OR ((d.importance_override = 'auto' OR d.importance_override IS NULL) AND d.importance_suggestion = 'important')
        )
          AND d.excluded = 0
          AND EXISTS (
            SELECT 1 FROM chunk_embeddings ce
            JOIN chunks c ON c.id = ce.chunk_id
            WHERE c.document_id = d.id
          )
        ORDER BY
          CASE
            WHEN coalesce(d.last_opened_at, 0) > coalesce(d.mtime_ms, 0) THEN d.last_opened_at
            WHEN coalesce(d.mtime_ms, 0) > 0 THEN d.mtime_ms
            ELSE coalesce(d.updated_at, 0)
          END ASC,
          d.id ASC
        LIMIT ? OFFSET ?
      `
    }

    const rows = this.db.prepare(sql).all(safeLimit, safeOffset) as Array<{
      id: number
      path: string
      name: string
      chunk_total: number
      last_opened_at: number
      importance_override: string
      importance_suggestion: string
    }>

    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      name: r.name,
      chunkTotal: r.chunk_total,
      lastOpenedAt: r.last_opened_at,
      importanceOverride: r.importance_override,
      importanceSuggestion: r.importance_suggestion,
    }))
  }

  /**
   * Retrieves bounded batch of candidate documents with cached chunks/content to prune.
   */
  getContentEvictionCandidates(
    tier: 'low' | 'normal' | 'important',
    limit = 25,
    offset = 0,
  ): EvictionCandidateDoc[] {
    const safeLimit = Math.max(1, Math.min(limit, 500))
    const safeOffset = Math.max(0, offset)

    let sql: string
    if (tier === 'low') {
      sql = `
        SELECT d.id, d.path, d.name, coalesce(d.chunk_total, 0) AS chunk_total,
               d.last_opened_at, d.importance_override, d.importance_suggestion
        FROM documents d
        WHERE d.importance_override = 'low'
          AND d.excluded = 0
          AND (d.chunk_total > 0 OR EXISTS (SELECT 1 FROM chunks c WHERE c.document_id = d.id))
        ORDER BY
          CASE
            WHEN coalesce(d.last_opened_at, 0) > coalesce(d.mtime_ms, 0) THEN d.last_opened_at
            WHEN coalesce(d.mtime_ms, 0) > 0 THEN d.mtime_ms
            ELSE coalesce(d.updated_at, 0)
          END ASC,
          d.id ASC
        LIMIT ? OFFSET ?
      `
    } else if (tier === 'normal') {
      sql = `
        SELECT d.id, d.path, d.name, coalesce(d.chunk_total, 0) AS chunk_total,
               d.last_opened_at, d.importance_override, d.importance_suggestion
        FROM documents d
        WHERE (d.importance_override = 'auto' OR d.importance_override IS NULL)
          AND (d.importance_suggestion = 'normal' OR d.importance_suggestion = 'unknown' OR d.importance_suggestion IS NULL)
          AND d.excluded = 0
          AND (d.chunk_total > 0 OR EXISTS (SELECT 1 FROM chunks c WHERE c.document_id = d.id))
        ORDER BY
          CASE
            WHEN coalesce(d.last_opened_at, 0) > coalesce(d.mtime_ms, 0) THEN d.last_opened_at
            WHEN coalesce(d.mtime_ms, 0) > 0 THEN d.mtime_ms
            ELSE coalesce(d.updated_at, 0)
          END ASC,
          d.id ASC
        LIMIT ? OFFSET ?
      `
    } else {
      sql = `
        SELECT d.id, d.path, d.name, coalesce(d.chunk_total, 0) AS chunk_total,
               d.last_opened_at, d.importance_override, d.importance_suggestion
        FROM documents d
        WHERE (
          d.importance_override = 'important'
          OR ((d.importance_override = 'auto' OR d.importance_override IS NULL) AND d.importance_suggestion = 'important')
        )
          AND d.excluded = 0
          AND (d.chunk_total > 0 OR EXISTS (SELECT 1 FROM chunks c WHERE c.document_id = d.id))
        ORDER BY
          CASE
            WHEN coalesce(d.last_opened_at, 0) > coalesce(d.mtime_ms, 0) THEN d.last_opened_at
            WHEN coalesce(d.mtime_ms, 0) > 0 THEN d.mtime_ms
            ELSE coalesce(d.updated_at, 0)
          END ASC,
          d.id ASC
        LIMIT ? OFFSET ?
      `
    }

    const rows = this.db.prepare(sql).all(safeLimit, safeOffset) as Array<{
      id: number
      path: string
      name: string
      chunk_total: number
      last_opened_at: number
      importance_override: string
      importance_suggestion: string
    }>

    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      name: r.name,
      chunkTotal: r.chunk_total,
      lastOpenedAt: r.last_opened_at,
      importanceOverride: r.importance_override,
      importanceSuggestion: r.importance_suggestion,
    }))
  }

  /**
   * Age-scoped, bounded candidate page (oldest touch first) for the retention age policy. `kind` selects the
   * work that must exist: 'vectors' = has embeddings, 'content' = has chunks. Never returns protected documents.
   */
  getAgeScopedCandidates(
    kind: 'vectors' | 'content',
    scope: AgeEvictionScope,
    cutoffs: AgeEvictionCutoffs,
    limit = 25,
  ): EvictionCandidateDoc[] {
    const safeLimit = Math.max(1, Math.min(limit, 500))
    const scopeSql =
      scope === 'archive'
        ? `NOT ${AGE_PROTECTED_SQL} AND ${AGE_TOUCH_SQL} > 0 AND ${AGE_TOUCH_SQL} < ?`
        : scope === 'normal-non-fresh'
          ? `${AGE_NORMAL_SQL} AND ${AGE_TOUCH_SQL} < ?`
          : `${AGE_NORMAL_SQL} AND ${AGE_TOUCH_SQL} >= ?`
    const cut = scope === 'archive' ? cutoffs.archiveCutMs : cutoffs.freshCutMs
    const workSql =
      kind === 'vectors'
        ? `EXISTS (SELECT 1 FROM chunk_embeddings ce JOIN chunks c ON c.id = ce.chunk_id WHERE c.document_id = d.id)`
        : `(d.chunk_total > 0 OR EXISTS (SELECT 1 FROM chunks c WHERE c.document_id = d.id))`
    const rows = this.db
      .prepare(
        `SELECT d.id, d.path, d.name, coalesce(d.chunk_total, 0) AS chunk_total,
                d.last_opened_at, d.importance_override, d.importance_suggestion
         FROM documents d
         WHERE d.excluded = 0 AND ${scopeSql} AND ${workSql}
         ORDER BY ${AGE_TOUCH_SQL} ASC, d.id ASC
         LIMIT ?`,
      )
      .all(cut, safeLimit) as Array<{
      id: number
      path: string
      name: string
      chunk_total: number
      last_opened_at: number
      importance_override: string
      importance_suggestion: string
    }>
    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      name: r.name,
      chunkTotal: r.chunk_total,
      lastOpenedAt: r.last_opened_at,
      importanceOverride: r.importance_override,
      importanceSuggestion: r.importance_suggestion,
    }))
  }

  /**
   * Transactional eviction of canonical embeddings for a batch of documents.
   *
   * In a single atomic transaction:
   * 1. Deletes canonical embeddings in chunk_embeddings.
   * 2. Recalculates document_embedding_counts to exact remaining active vectors.
   * 3. Updates chunk_done and status on documents (sets 'text-only' when vectors reach 0).
   * 4. Marks ann_indexes dirty and increments desired_generation once per affected space.
   * 5. COMMITS transaction.
   *
   * Only AFTER commit:
   * Returns affected spaces and generation info so the caller can invalidate in-memory ANN indexes.
   */
  evictEmbeddingsBatch(documentIds: number[]): EvictionBatchResult {
    if (documentIds.length === 0) {
      return { deletedEmbeddings: 0, affectedDocumentIds: [], affectedSpaces: [] }
    }

    const placeholders = documentIds.map(() => '?').join(',')
    const affectedSpacesMap = new Map<string, number>()
    let deletedEmbeddings: number

    this.db.exec('BEGIN IMMEDIATE')
    try {
      // 1. Discover affected spaces across this document batch
      const spaceRows = this.db
        .prepare(`
          SELECT DISTINCT ce.space_id
          FROM chunk_embeddings ce
          JOIN chunks c ON c.id = ce.chunk_id
          WHERE c.document_id IN (${placeholders})
        `)
        .all(...documentIds) as Array<{ space_id: string }>

      const affectedSpaceIds = spaceRows.map((r) => r.space_id)

      // 2. Delete canonical embeddings
      const delResult = this.db
        .prepare(`
          DELETE FROM chunk_embeddings
          WHERE chunk_id IN (
            SELECT id FROM chunks WHERE document_id IN (${placeholders})
          )
        `)
        .run(...documentIds)

      deletedEmbeddings = Number(delResult.changes)

      // 3. Resynchronize document_embedding_counts for affected documents and spaces
      for (const docId of documentIds) {
        for (const spaceId of affectedSpaceIds) {
          const remainingRow = this.db
            .prepare(`
              SELECT count(ce.chunk_id) AS c
              FROM chunks c
              JOIN documents d ON d.id = c.document_id
              JOIN chunk_embeddings ce ON ce.chunk_id = c.id AND ce.space_id = ?
              WHERE c.document_id = ?
                AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)
            `)
            .get(spaceId, docId) as { c: number } | undefined

          const remaining = remainingRow?.c ?? 0
          if (remaining > 0) {
            this.db
              .prepare(`
                INSERT INTO document_embedding_counts (document_id, space_id, completed_chunks)
                VALUES (?, ?, ?)
                ON CONFLICT (document_id, space_id)
                DO UPDATE SET completed_chunks = excluded.completed_chunks
              `)
              .run(docId, spaceId, remaining)
          } else {
            this.db
              .prepare('DELETE FROM document_embedding_counts WHERE document_id = ? AND space_id = ?')
              .run(docId, spaceId)
          }
        }
      }

      // 4. Update documents chunk_done & status
      this.db
        .prepare(`
          UPDATE documents
          SET chunk_done = coalesce(
                (SELECT completed_chunks FROM document_embedding_counts ec
                 WHERE ec.document_id = documents.id AND ec.space_id = documents.embedding_model),
                0
              ),
              status = CASE
                WHEN (SELECT count(*) FROM chunks c WHERE c.document_id = documents.id AND (c.chunk_set_id IS NULL OR c.chunk_set_id = documents.active_chunk_set_id)) = 0 THEN 'empty'
                WHEN coalesce((SELECT completed_chunks FROM document_embedding_counts ec WHERE ec.document_id = documents.id AND ec.space_id = documents.embedding_model), 0) > 0 THEN status
                ELSE 'text-only'
              END,
              updated_at = unixepoch()
          WHERE id IN (${placeholders})
        `)
        .run(...documentIds)

      // 4b. Durable marker: these vectors were evicted by retention (not "embedding still pending"),
      // so poll()/budget callbacks must not re-embed them straight away (evict -> re-embed thrash).
      markVectorsEvicted(this.db, documentIds)

      // 5. Mark ann_indexes dirty and increment desired_generation once per affected space
      for (const spaceId of affectedSpaceIds) {
        this.db
          .prepare(`
            INSERT INTO ann_indexes (space_id, generation, desired_generation, indexed_count, state, updated_at)
            VALUES (?, 0, 1, 0, 'dirty', unixepoch())
            ON CONFLICT(space_id)
            DO UPDATE SET
              desired_generation = desired_generation + 1,
              state = 'dirty',
              updated_at = unixepoch()
          `)
          .run(spaceId)

        const metaRow = this.db
          .prepare('SELECT desired_generation FROM ann_indexes WHERE space_id = ?')
          .get(spaceId) as { desired_generation?: number } | undefined
        affectedSpacesMap.set(spaceId, metaRow?.desired_generation ?? 1)
      }

      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    const affectedSpaces: AnnSpaceDirtySpec[] = Array.from(affectedSpacesMap.entries()).map(
      ([spaceId, desiredGeneration]) => ({ spaceId, desiredGeneration }),
    )

    return {
      deletedEmbeddings,
      affectedDocumentIds: documentIds,
      affectedSpaces,
    }
  }

  /**
   * Transactional eviction of document cache content (OCR pages, chunks, and FTS).
   *
   * Used when physical storage is still full after vector pruning:
   * - Preserves document identity row, name, path, hash, mtime, and importance overrides.
   * - Sets content_evicted state (or 'content-evicted' status).
   * - Cleans FTS rows and cascades chunks deletion.
   */
  evictCacheContentBatch(documentIds: number[]): CacheContentEvictionBatchResult {
    if (documentIds.length === 0) {
      return {
        deletedChunks: 0,
        deletedFtsRows: 0,
        deletedOcrPages: 0,
        affectedDocumentIds: [],
        affectedSpaces: [],
      }
    }

    const placeholders = documentIds.map(() => '?').join(',')
    const affectedSpacesMap = new Map<string, number>()
    let deletedChunks: number
    let deletedFtsRows = 0
    let deletedOcrPages = 0

    const hasContentEvicted = hasContentEvictedColumn(this.db)

    this.db.exec('BEGIN IMMEDIATE')
    try {
      // 1. Collect affected space IDs
      const spaceRows = this.db
        .prepare(`
          SELECT DISTINCT ce.space_id
          FROM chunk_embeddings ce
          JOIN chunks c ON c.id = ce.chunk_id
          WHERE c.document_id IN (${placeholders})
        `)
        .all(...documentIds) as Array<{ space_id: string }>

      const affectedSpaceIds = spaceRows.map((r) => r.space_id)

      // 2. Collect chunk IDs to clean from FTS
      const chunkRows = this.db
        .prepare(`SELECT id FROM chunks WHERE document_id IN (${placeholders})`)
        .all(...documentIds) as Array<{ id: number }>

      if (chunkRows.length > 0) {
        const delFts = this.db.prepare('DELETE FROM chunk_fts WHERE rowid = ?')
        for (const { id } of chunkRows) {
          delFts.run(id)
          deletedFtsRows++
        }
      }

      // 3. Delete OCR pages for these documents
      const docPaths = this.db
        .prepare(`SELECT path FROM documents WHERE id IN (${placeholders})`)
        .all(...documentIds) as Array<{ path: string }>

      if (docPaths.length > 0) {
        const pathPlaceholders = docPaths.map(() => '?').join(',')
        const paths = docPaths.map((d) => d.path)
        try {
          const delOcr = this.db
            .prepare(`DELETE FROM ocr_pages WHERE path IN (${pathPlaceholders})`)
            .run(...paths)
          deletedOcrPages = Number(delOcr.changes)
        } catch {
          // ocr_pages may not exist
        }
      }

      // 4. Delete chunks (triggers chunks_counter_delete will update chunk_total)
      const delChunks = this.db
        .prepare(`DELETE FROM chunks WHERE document_id IN (${placeholders})`)
        .run(...documentIds)
      deletedChunks = Number(delChunks.changes)

      // 5. Delete document_embedding_counts
      this.db
        .prepare(`DELETE FROM document_embedding_counts WHERE document_id IN (${placeholders})`)
        .run(...documentIds)

      // 6. Update document row state
      if (hasContentEvicted) {
        this.db
          .prepare(`
            UPDATE documents
            SET content_evicted = 1,
                status = 'text-only',
                chunk_done = 0,
                chunk_total = 0,
                updated_at = unixepoch()
            WHERE id IN (${placeholders})
          `)
          .run(...documentIds)
      } else {
        this.db
          .prepare(`
            UPDATE documents
            SET status = 'text-only',
                chunk_done = 0,
                chunk_total = 0,
                updated_at = unixepoch()
            WHERE id IN (${placeholders})
          `)
          .run(...documentIds)
      }

      // 7. Mark ann_indexes dirty
      for (const spaceId of affectedSpaceIds) {
        this.db
          .prepare(`
            INSERT INTO ann_indexes (space_id, generation, desired_generation, indexed_count, state, updated_at)
            VALUES (?, 0, 1, 0, 'dirty', unixepoch())
            ON CONFLICT(space_id)
            DO UPDATE SET
              desired_generation = desired_generation + 1,
              state = 'dirty',
              updated_at = unixepoch()
          `)
          .run(spaceId)

        const metaRow = this.db
          .prepare('SELECT desired_generation FROM ann_indexes WHERE space_id = ?')
          .get(spaceId) as { desired_generation?: number } | undefined
        affectedSpacesMap.set(spaceId, metaRow?.desired_generation ?? 1)
      }

      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    const affectedSpaces: AnnSpaceDirtySpec[] = Array.from(affectedSpacesMap.entries()).map(
      ([spaceId, desiredGeneration]) => ({ spaceId, desiredGeneration }),
    )

    return {
      deletedChunks,
      deletedFtsRows,
      deletedOcrPages,
      affectedDocumentIds: documentIds,
      affectedSpaces,
    }
  }
}
