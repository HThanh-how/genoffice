import type { DatabaseSync } from 'node:sqlite'
import { documentIndexFields } from '../../normalization'
import type { DocumentPlan } from '../../runtime/redundancy-plan'
import { markVectorsEvicted } from '../vector-eviction-marker'
import { ensureRedundancySchema, hasSkeletonTable } from '../redundancy-schema'
import type { AnnSpaceDirtySpec } from './cache-retention-repository'

/** Shown next to a hit whose document is a skeleton ("open to read fully" re-extracts it from the original). */
export const SKELETON_NOTICE = 'Skeleton index - open the file to read it fully'

export interface SkeletonTarget {
  documentId: number
  /** documents.hash / active_chunk_set_id the plan was computed against (stale plans are skipped). */
  hash: string | null
  activeChunkSetId: number | null
  familyKey: string
}

export interface VectorDropItem extends SkeletonTarget {
  chunkIds: number[]
}

export interface SkeletonItem extends SkeletonTarget {
  plan: DocumentPlan
}

export interface CompactionBatchResult {
  documents: number
  skippedStale: number
  vectorsDeleted: number
  vectorBytesDeleted: number
  chunksKept: number
  chunksRewritten: number
  chunksDropped: number
  /** Logical bytes removed from chunks.text and chunk_fts (the physical gain shows after vacuum). */
  textBytesRemoved: number
  affectedDocumentIds: number[]
  affectedSpaces: AnnSpaceDirtySpec[]
}

function emptyResult(): CompactionBatchResult {
  return {
    documents: 0,
    skippedStale: 0,
    vectorsDeleted: 0,
    vectorBytesDeleted: 0,
    chunksKept: 0,
    chunksRewritten: 0,
    chunksDropped: 0,
    textBytesRemoved: 0,
    affectedDocumentIds: [],
    affectedSpaces: [],
  }
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',')
}

function isCurrent(db: DatabaseSync, t: SkeletonTarget): boolean {
  const row = db
    .prepare(
      `SELECT hash, active_chunk_set_id AS set_id, status, excluded FROM documents WHERE id = ?`,
    )
    .get(t.documentId) as { hash: string | null; set_id: number | null; status: string; excluded: number } | undefined
  return Boolean(
    row &&
      row.excluded === 0 &&
      (row.status === 'ready' || row.status === 'text-only') &&
      row.hash === t.hash &&
      row.set_id === t.activeChunkSetId,
  )
}

/** Delete vectors of the given chunks; returns how many and how many bytes, plus the spaces touched. */
function deleteVectors(
  db: DatabaseSync,
  chunkIds: number[],
  spaces: Set<string>,
): { count: number; bytes: number } {
  let count = 0
  let bytes = 0
  for (let i = 0; i < chunkIds.length; i += 400) {
    const slice = chunkIds.slice(i, i + 400)
    const ph = placeholders(slice.length)
    for (const r of db
      .prepare(`SELECT DISTINCT space_id FROM chunk_embeddings WHERE chunk_id IN (${ph})`)
      .all(...slice) as Array<{ space_id: string }>)
      spaces.add(r.space_id)
    const b = db
      .prepare(`SELECT coalesce(sum(length(vector)), 0) AS b FROM chunk_embeddings WHERE chunk_id IN (${ph})`)
      .get(...slice) as { b: number }
    bytes += b.b
    count += Number(db.prepare(`DELETE FROM chunk_embeddings WHERE chunk_id IN (${ph})`).run(...slice).changes)
  }
  return { count, bytes }
}

/**
 * Re-sync document_embedding_counts / chunk_done / status after vectors or chunks were removed. Same rules as
 * CacheRetentionRepository.evictEmbeddingsBatch: a document left without vectors becomes 'text-only' and is
 * marked "vectors evicted" so poll() / budget callbacks do not re-embed it (no evict -> re-embed thrash).
 */
function resyncEmbeddingState(db: DatabaseSync, documentIds: number[]): void {
  if (documentIds.length === 0) return
  const ph = placeholders(documentIds.length)
  db.prepare(`DELETE FROM document_embedding_counts WHERE document_id IN (${ph})`).run(...documentIds)
  db.prepare(
    `INSERT INTO document_embedding_counts (document_id, space_id, completed_chunks)
     SELECT c.document_id, ce.space_id, count(*)
     FROM chunks c JOIN documents d ON d.id = c.document_id
     JOIN chunk_embeddings ce ON ce.chunk_id = c.id
     WHERE c.document_id IN (${ph}) AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)
     GROUP BY c.document_id, ce.space_id`,
  ).run(...documentIds)
  db.prepare(
    `UPDATE documents SET
       chunk_done = coalesce((SELECT completed_chunks FROM document_embedding_counts ec
                              WHERE ec.document_id = documents.id AND ec.space_id = documents.embedding_model), 0),
       status = CASE
         WHEN (SELECT count(*) FROM chunks c WHERE c.document_id = documents.id
               AND (c.chunk_set_id IS NULL OR c.chunk_set_id = documents.active_chunk_set_id)) = 0 THEN 'empty'
         WHEN coalesce((SELECT completed_chunks FROM document_embedding_counts ec
                        WHERE ec.document_id = documents.id AND ec.space_id = documents.embedding_model), 0) > 0 THEN status
         ELSE 'text-only'
       END
     WHERE id IN (${ph})`,
  ).run(...documentIds)
  const noVectors = db
    .prepare(
      `SELECT id FROM documents WHERE id IN (${ph}) AND status = 'text-only'
         AND NOT EXISTS (SELECT 1 FROM chunks c JOIN chunk_embeddings ce ON ce.chunk_id = c.id WHERE c.document_id = documents.id)`,
    )
    .all(...documentIds) as Array<{ id: number }>
  markVectorsEvicted(
    db,
    noVectors.map((r) => r.id),
  )
}

function markAnnDirty(db: DatabaseSync, spaces: Set<string>): AnnSpaceDirtySpec[] {
  const out: AnnSpaceDirtySpec[] = []
  for (const spaceId of spaces) {
    db.prepare(
      `INSERT INTO ann_indexes (space_id, generation, desired_generation, indexed_count, state, updated_at)
       VALUES (?, 0, 1, 0, 'dirty', unixepoch())
       ON CONFLICT(space_id) DO UPDATE SET desired_generation = desired_generation + 1, state = 'dirty', updated_at = unixepoch()`,
    ).run(spaceId)
    const row = db.prepare('SELECT desired_generation AS g FROM ann_indexes WHERE space_id = ?').get(spaceId) as
      | { g?: number }
      | undefined
    out.push({ spaceId, desiredGeneration: row?.g ?? 1 })
  }
  return out
}

function upsertState(
  db: DatabaseSync,
  t: SkeletonTarget,
  stage: 'vectors' | 'skeleton',
  kept: number,
  droppedChunks: number,
  droppedBytes: number,
): void {
  db.prepare(
    `INSERT INTO document_skeleton (document_id, stage, hash, family_key, kept_chunks, dropped_chunks, dropped_bytes, compacted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(document_id) DO UPDATE SET
       stage = CASE WHEN document_skeleton.stage = 'skeleton' THEN 'skeleton' ELSE excluded.stage END,
       kept_chunks = excluded.kept_chunks,
       dropped_chunks = document_skeleton.dropped_chunks + excluded.dropped_chunks,
       dropped_bytes = document_skeleton.dropped_bytes + excluded.dropped_bytes,
       compacted_at = excluded.compacted_at`,
  ).run(t.documentId, stage, t.hash, t.familyKey, kept, droppedChunks, droppedBytes, Date.now())
}

function transact<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // already rolled back
    }
    throw err
  }
}

/**
 * Tier T-A: drop the VECTORS of boilerplate-evictable chunks; text, FTS and identity stay (lexical recall is
 * untouched). One transaction for the whole batch.
 */
export function dropBoilerplateVectors(db: DatabaseSync, items: VectorDropItem[]): CompactionBatchResult {
  const result = emptyResult()
  if (items.length === 0) return result
  ensureRedundancySchema(db)
  const spaces = new Set<string>()
  transact(db, () => {
    const done: number[] = []
    for (const item of items) {
      if (!isCurrent(db, item)) {
        result.skippedStale++
        continue
      }
      const del = deleteVectors(db, item.chunkIds, spaces)
      result.vectorsDeleted += del.count
      result.vectorBytesDeleted += del.bytes
      done.push(item.documentId)
      const total = (
        db.prepare('SELECT count(*) AS c FROM chunks WHERE document_id = ?').get(item.documentId) as { c: number }
      ).c
      upsertState(db, item, 'vectors', total, 0, del.bytes)
    }
    resyncEmbeddingState(db, done)
    result.affectedDocumentIds = done
    result.documents = done.length
    result.affectedSpaces = markAnnDirty(db, spaces)
  })
  return result
}

/**
 * Tier T-B: apply a skeleton plan. Template lines leave `chunks.text` and `chunk_fts`; chunks that lose every
 * line are deleted (their vectors/fingerprints cascade); rewritten chunks lose their now-stale vector. The
 * document row (path, name, hash, mtime, importance) is untouched, so a rescan does not re-index it and
 * name search keeps working. Re-hydration = any re-extraction (retry / read-now / open): the new active chunk
 * set removes the document_skeleton row by trigger.
 */
export function applySkeletonBatch(db: DatabaseSync, items: SkeletonItem[]): CompactionBatchResult {
  const result = emptyResult()
  if (items.length === 0) return result
  ensureRedundancySchema(db)
  const spaces = new Set<string>()
  transact(db, () => {
    const done: number[] = []
    const rewrite = db.prepare('UPDATE chunks SET text = ? WHERE id = ? AND document_id = ?')
    const ftsLen = db.prepare('SELECT length(text) AS n FROM chunk_fts WHERE rowid = ?')
    const ftsDelete = db.prepare('DELETE FROM chunk_fts WHERE rowid = ?')
    const ftsInsert = db.prepare('INSERT INTO chunk_fts(rowid, text) VALUES (?, ?)')
    const fpDelete = db.prepare('DELETE FROM chunk_fingerprints WHERE chunk_id = ?')
    const chunkDelete = db.prepare('DELETE FROM chunks WHERE id = ? AND document_id = ?')
    for (const item of items) {
      if (!isCurrent(db, item) || item.plan.chunks.length < 2) {
        result.skippedStale++
        continue
      }
      // vectors first (bytes are counted before a chunk delete would cascade them away)
      const del = deleteVectors(
        db,
        item.plan.chunks.filter((a) => a.action !== 'keep').map((a) => a.chunkId),
        spaces,
      )
      let removed = 0
      let rewritten = 0
      let dropped = 0
      for (const a of item.plan.chunks) {
        if (a.action === 'keep') continue
        const oldFts = (ftsLen.get(a.chunkId) as { n: number } | undefined)?.n ?? 0
        if (a.action === 'rewrite' && a.newText) {
          const search = documentIndexFields(a.newText).searchText
          rewrite.run(a.newText, a.chunkId, item.documentId)
          ftsDelete.run(a.chunkId)
          ftsInsert.run(a.chunkId, search)
          fpDelete.run(a.chunkId)
          removed += a.oldChars - a.newChars + Math.max(0, oldFts - search.length)
          rewritten++
        } else {
          ftsDelete.run(a.chunkId)
          chunkDelete.run(a.chunkId, item.documentId)
          removed += a.oldChars + oldFts
          dropped++
        }
      }
      result.vectorsDeleted += del.count
      result.vectorBytesDeleted += del.bytes
      result.chunksKept += item.plan.counts.keep
      result.chunksRewritten += rewritten
      result.chunksDropped += dropped
      result.textBytesRemoved += removed
      const left = (
        db.prepare('SELECT count(*) AS c FROM chunks WHERE document_id = ?').get(item.documentId) as { c: number }
      ).c
      upsertState(db, item, 'skeleton', left, rewritten + dropped, removed + del.bytes)
      done.push(item.documentId)
    }
    resyncEmbeddingState(db, done)
    result.affectedDocumentIds = done
    result.documents = done.length
    result.affectedSpaces = markAnnDirty(db, spaces)
  })
  return result
}

/** Documents (of `ids`) whose index is a skeleton: search should show "skeleton index - open to read fully". */
export function skeletonDocumentIds(db: DatabaseSync, ids: number[]): Set<number> {
  const out = new Set<number>()
  if (ids.length === 0 || !hasSkeletonTable(db)) return out
  const unique = [...new Set(ids)]
  for (let i = 0; i < unique.length; i += 500) {
    const slice = unique.slice(i, i + 500)
    for (const r of db
      .prepare(`SELECT document_id FROM document_skeleton WHERE stage = 'skeleton' AND document_id IN (${placeholders(slice.length)})`)
      .all(...slice) as Array<{ document_id: number }>)
      out.add(r.document_id)
  }
  return out
}

/**
 * Flag search hits of skeleton documents (adds `skeletonIndex: true` and a notice). Integration point for the
 * search layer: call it on the final hit list (one indexed query for all hits).
 */
export function annotateSkeletonHits<T extends { documentId: number }>(
  db: DatabaseSync,
  hits: T[],
): Array<T & { skeletonIndex?: true; skeletonNotice?: string }> {
  const flagged = skeletonDocumentIds(
    db,
    hits.map((h) => h.documentId),
  )
  if (flagged.size === 0) return hits
  return hits.map((h) => (flagged.has(h.documentId) ? { ...h, skeletonIndex: true as const, skeletonNotice: SKELETON_NOTICE } : h))
}
