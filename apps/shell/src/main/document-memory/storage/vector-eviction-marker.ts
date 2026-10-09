import type { DatabaseSync } from 'node:sqlite'
import { ensureRedundancySchema } from './redundancy-schema'

/**
 * Durable marker "vectors of this document were evicted by cache retention".
 *
 * Without it an evicted document is indistinguishable from one whose embedding simply has not run yet
 * (status 'text-only', content_evicted = 0), so poll() / onBudgetStateChange re-embed it as soon as usage
 * drops below 'full' and retention evicts it again: a permanent evict -> re-embed cycle.
 *
 * Rules (see incompletePaths / releaseVectorEvictions):
 * - a marked document is NOT part of the incomplete-work set while the marker applies;
 * - the marker stops applying when the file content changed (hash differs), when the user opens/reads it
 *   after the eviction (last_opened_at > evicted_at), when it is retried explicitly, when vectors are
 *   re-created (trigger below) or when the maintenance step releases it because usage is far below budget.
 *
 * Additive: a separate table (not a documents column) so no row-copy/INSERT column list has to change.
 */
export const VECTOR_EVICTION_MIGRATION_ID = '20261009_document_vector_evictions'

export const VECTOR_EVICTION_DDL = `
CREATE TABLE IF NOT EXISTS document_vector_evictions (
  document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  evicted_at INTEGER NOT NULL,
  hash TEXT
);
CREATE TRIGGER IF NOT EXISTS document_vector_evictions_revive
AFTER INSERT ON chunk_embeddings
BEGIN
  DELETE FROM document_vector_evictions
  WHERE document_id = (SELECT document_id FROM chunks WHERE id = NEW.chunk_id);
END;
`

/**
 * SQL fragment (for a query on `documents` without alias) selecting documents whose vector eviction still
 * applies. Callers must only use it when hasVectorEvictionTable() is true.
 */
export const VECTOR_EVICTION_APPLIES_SQL = `EXISTS (
  SELECT 1 FROM document_vector_evictions m
  WHERE m.document_id = documents.id AND m.hash IS documents.hash AND documents.last_opened_at <= m.evicted_at)`

export function hasVectorEvictionTable(db: DatabaseSync): boolean {
  try {
    return Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'document_vector_evictions'").get(),
    )
  } catch {
    return false
  }
}

/** Idempotent. Requires `documents`, `chunks` and `chunk_embeddings` to exist. */
export function ensureVectorEvictionSchema(db: DatabaseSync): void {
  const needed = db
    .prepare(
      "SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name IN ('documents', 'chunks', 'chunk_embeddings')",
    )
    .get() as { c: number }
  if (needed.c < 3) return
  db.exec(VECTOR_EVICTION_DDL)
  // Redundancy/skeleton compaction tables ride on the same migration hook (additive, idempotent). A failure here
  // must never fail the cache-retention migration: the compaction code re-ensures the schema before it writes.
  try {
    ensureRedundancySchema(db)
  } catch {
    // ignore
  }
}

function placeholders(ids: number[]): string {
  return ids.map(() => '?').join(',')
}

/** Mark documents whose vectors were just evicted. Call inside the eviction transaction, after the delete. */
export function markVectorsEvicted(db: DatabaseSync, documentIds: number[], nowMs: number = Date.now()): void {
  if (documentIds.length === 0 || !hasVectorEvictionTable(db)) return
  db.prepare(
    `INSERT INTO document_vector_evictions (document_id, evicted_at, hash)
     SELECT id, ?, hash FROM documents WHERE id IN (${placeholders(documentIds)})
     ON CONFLICT(document_id) DO UPDATE SET evicted_at = excluded.evicted_at, hash = excluded.hash`,
  ).run(nowMs, ...documentIds)
}

export function clearVectorEvictions(db: DatabaseSync, documentIds: number[]): number {
  if (documentIds.length === 0 || !hasVectorEvictionTable(db)) return 0
  return Number(
    db.prepare(`DELETE FROM document_vector_evictions WHERE document_id IN (${placeholders(documentIds)})`).run(...documentIds)
      .changes,
  )
}

export function countVectorEvictions(db: DatabaseSync): number {
  if (!hasVectorEvictionTable(db)) return 0
  return (db.prepare('SELECT count(*) AS c FROM document_vector_evictions').get() as { c: number }).c
}

export interface VectorEvictionReleaseResult {
  documents: number
  chunks: number
}

/**
 * Release (delete the marker of) the most recently relevant evicted documents, bounded by a document
 * count and a chunk budget, so the regular poll() re-embeds them. Never releases more chunks than allowed.
 */
export function releaseVectorEvictions(
  db: DatabaseSync,
  limits: { maxDocuments: number; maxChunks: number },
): VectorEvictionReleaseResult {
  const none = { documents: 0, chunks: 0 }
  if (limits.maxDocuments <= 0 || limits.maxChunks <= 0 || !hasVectorEvictionTable(db)) return none
  const rows = db
    .prepare(
      `SELECT d.id, coalesce(d.chunk_total, 0) AS chunk_total
       FROM document_vector_evictions m JOIN documents d ON d.id = m.document_id
       ORDER BY max(d.last_opened_at, coalesce(d.mtime_ms, 0)) DESC, d.id DESC
       LIMIT ?`,
    )
    .all(limits.maxDocuments) as Array<{ id: number; chunk_total: number }>
  const ids: number[] = []
  let chunks = 0
  for (const r of rows) {
    if (ids.length > 0 && chunks + r.chunk_total > limits.maxChunks) break
    if (ids.length === 0 && r.chunk_total > limits.maxChunks) break
    ids.push(r.id)
    chunks += r.chunk_total
  }
  if (ids.length === 0) return none
  clearVectorEvictions(db, ids)
  return { documents: ids.length, chunks }
}
