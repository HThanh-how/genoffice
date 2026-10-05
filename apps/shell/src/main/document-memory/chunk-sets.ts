import type { DatabaseSync } from 'node:sqlite'

export type ChunkSetState = 'building' | 'active' | 'retired'

export interface ChunkSetRow {
  id: number
  document_id: number
  chunker_version: number
  state: ChunkSetState
  created_at: number
}

/**
 * Creates a new chunk set in 'building' state for the given document and chunker version.
 */
export function createBuildingSet(
  db: DatabaseSync,
  documentId: number,
  chunkerVersion: number,
): number {
  const stmt = db.prepare(`
    INSERT INTO chunk_sets (document_id, chunker_version, state, created_at)
    VALUES (?, ?, 'building', unixepoch())
  `)
  const result = stmt.run(documentId, chunkerVersion)
  return Number(result.lastInsertRowid)
}

/**
 * Atomically marks the new chunk set as 'active', retires previous active sets for this document,
 * and sets active_chunk_set_id on documents table.
 */
export function activateSet(db: DatabaseSync, documentId: number, chunkSetId: number): void {
  // Retire any current active sets
  db.prepare(`
    UPDATE chunk_sets
    SET state = 'retired'
    WHERE document_id = ? AND id <> ? AND state = 'active'
  `).run(documentId, chunkSetId)

  // Activate the target set
  db.prepare(`
    UPDATE chunk_sets
    SET state = 'active'
    WHERE id = ? AND document_id = ?
  `).run(chunkSetId, documentId)

  // Update documents pointer
  db.prepare(`
    UPDATE documents
    SET active_chunk_set_id = ?
    WHERE id = ?
  `).run(chunkSetId, documentId)
}

/**
 * Retires all old chunk sets for a document that are not the active one,
 * and optionally deletes their orphaned chunks.
 */
export function retireOldSets(db: DatabaseSync, documentId: number): void {
  const activeRow = db.prepare(`
    SELECT active_chunk_set_id FROM documents WHERE id = ?
  `).get(documentId) as { active_chunk_set_id?: number | null } | undefined

  const activeId = activeRow?.active_chunk_set_id ?? null

  if (activeId !== null) {
    db.prepare(`
      UPDATE chunk_sets
      SET state = 'retired'
      WHERE document_id = ? AND id <> ? AND state <> 'retired'
    `).run(documentId, activeId)
  }
}
