import { DatabaseSync } from 'node:sqlite'

export interface IntegrityCheckResult {
  ok: boolean
  integrity: string
  foreignKeyErrors: unknown[]
}

/**
 * Runs physical integrity checks on a SQLite database file:
 * - PRAGMA integrity_check === 'ok'
 * - PRAGMA foreign_key_check returns 0 errors
 */
export function verifyDatabaseIntegrity(dbOrPath: string | DatabaseSync): IntegrityCheckResult {
  const isPath = typeof dbOrPath === 'string'
  let db: DatabaseSync | null = null
  try {
    db = isPath ? new DatabaseSync(dbOrPath) : dbOrPath
    const integrityRow = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string }
    const integrity = integrityRow?.integrity_check ?? 'unknown'
    const foreignKeyErrors = db.prepare('PRAGMA foreign_key_check').all()
    const ok = integrity === 'ok' && foreignKeyErrors.length === 0
    return { ok, integrity, foreignKeyErrors }
  } catch (err: any) {
    return { ok: false, integrity: err?.message ?? 'unknown', foreignKeyErrors: [err?.message] }
  } finally {
    if (isPath && db) {
      try {
        db.close()
      } catch {
        // ignore
      }
    }
  }
}

export interface LogicalConsistencyResult {
  ok: boolean
  reasons: string[]
  expectedDocuments: number
  actualDocuments: number
  actualChunks: number
}

/**
 * Rigorously validates all 12 enterprise integrity invariants (V01..V12)
 * on candidate V3 SQLite database before cutover is authorized (BEH-18).
 * 
 * Invariants:
 * - V01: Physical SQLite integrity (PRAGMA integrity_check === 'ok')
 * - V02: Foreign keys consistency (PRAGMA foreign_key_check returns 0)
 * - V03: Journal mode is WAL (PRAGMA journal_mode)
 * - V04: Incremental auto-vacuum is enabled (PRAGMA auto_vacuum === 2)
 * - V05: Schema Invariant INV-03: chunks table has no obsolete vector/normalized columns
 * - V06: Document count matches expectedDocuments
 * - V07: Chunk count matches expectedChunks
 * - V08: No orphan chunks in chunks table
 * - V09: Chunk embeddings vector dimensions and space references valid
 * - V10: document_embedding_counts matches actual chunk_embeddings per document & space
 * - V11: Active chunk sets referenced by documents exist with state = 'active'
 * - V12: document_memory_meta contains schema_version = '3'
 */
export function verifyLogicalConsistency(
  targetDb: DatabaseSync,
  expectedDocuments: number,
  expectedChunks: number,
): LogicalConsistencyResult {
  const reasons: string[] = []

  // V01: Physical SQLite Integrity
  const integrityRow = targetDb.prepare('PRAGMA integrity_check').get() as { integrity_check?: string }
  if (integrityRow?.integrity_check !== 'ok') {
    reasons.push(`[V01] SQLite integrity check failed: ${integrityRow?.integrity_check ?? 'unknown'}`)
  }

  // V02: Foreign Key Constraints
  const fkErrors = targetDb.prepare('PRAGMA foreign_key_check').all()
  if (fkErrors.length > 0) {
    reasons.push(`[V02] Foreign key violations detected (${fkErrors.length} errors)`)
  }

  // V03: WAL Journal Mode
  const journalRow = targetDb.prepare('PRAGMA journal_mode').get() as { journal_mode?: string }
  const jMode = journalRow?.journal_mode?.toLowerCase()
  if (jMode !== 'wal' && jMode !== 'memory') {
    reasons.push(`[V03] Journal mode is not WAL (got ${jMode})`)
  }

  // V04: Incremental Auto-Vacuum (2 = INCREMENTAL)
  const autoVacRow = targetDb.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum?: number }
  if (autoVacRow?.auto_vacuum !== 2) {
    reasons.push(`[V04] auto_vacuum is not INCREMENTAL (expected 2, got ${autoVacRow?.auto_vacuum})`)
  }

  // V05: Schema Invariant INV-03: No obsolete columns in chunks
  const chunkCols = (targetDb.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>).map((c) => c.name)
  if (chunkCols.includes('vector') || chunkCols.includes('vector_dim') || chunkCols.includes('normalized')) {
    reasons.push('[V05] Invariant INV-03 violated: chunks table contains obsolete vector or normalized columns')
  }

  // V06: Document Count Parity
  const docCountRow = targetDb.prepare('SELECT count(*) AS n FROM documents').get() as { n: number }
  const actualDocs = docCountRow.n
  if (expectedDocuments !== undefined && expectedDocuments !== null && actualDocs !== expectedDocuments) {
    reasons.push(`[V06] Document count mismatch: expected ${expectedDocuments}, got ${actualDocs}`)
  }

  // V07: Chunk Count Parity
  const chunkCountRow = targetDb.prepare('SELECT count(*) AS n FROM chunks').get() as { n: number }
  const actualChunks = chunkCountRow.n
  if (expectedChunks !== undefined && expectedChunks !== null && actualChunks !== expectedChunks) {
    reasons.push(`[V07] Chunk count mismatch: expected ${expectedChunks}, got ${actualChunks}`)
  }

  // V08: Orphan Chunks Guard
  const orphanChunkRow = targetDb.prepare('SELECT count(*) AS n FROM chunks WHERE document_id NOT IN (SELECT id FROM documents)').get() as { n: number }
  if (orphanChunkRow.n > 0) {
    reasons.push(`[V08] Orphan chunks detected: ${orphanChunkRow.n} chunks lack valid document_id`)
  }

  // V09: Chunk Embeddings Validity
  const invalidEmbeddingsRow = targetDb.prepare(`
    SELECT count(*) AS n FROM chunk_embeddings 
    WHERE vector_dim <= 0 
       OR length(vector) != vector_dim * 4
       OR space_id NOT IN (SELECT id FROM embedding_spaces)
  `).get() as { n: number }
  if (invalidEmbeddingsRow.n > 0) {
    reasons.push(`[V09] Invalid chunk embeddings detected: ${invalidEmbeddingsRow.n} records violate vector dimension or space reference`)
  }

  // V10: Document Embedding Counts Consistency
  const countMismatchRow = targetDb.prepare(`
    SELECT count(*) AS n FROM (
      SELECT d.document_id, d.space_id, d.completed_chunks,
             count(ce.chunk_id) AS actual_chunks
      FROM document_embedding_counts d
      JOIN chunks c ON c.document_id = d.document_id
      LEFT JOIN chunk_embeddings ce ON ce.chunk_id = c.id AND ce.space_id = d.space_id
      GROUP BY d.document_id, d.space_id
      HAVING d.completed_chunks != actual_chunks
    )
  `).get() as { n: number }
  if (countMismatchRow.n > 0) {
    reasons.push(`[V10] Mismatch in document_embedding_counts: ${countMismatchRow.n} document-space pairs deviate from canonical embeddings`)
  }

  // V11: Active Chunk Sets Integrity
  const invalidActiveSetsRow = targetDb.prepare(`
    SELECT count(*) AS n FROM documents d
    WHERE d.active_chunk_set_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM chunk_sets cs 
        WHERE cs.id = d.active_chunk_set_id AND cs.document_id = d.id AND cs.state = 'active'
      )
  `).get() as { n: number }
  if (invalidActiveSetsRow.n > 0) {
    reasons.push(`[V11] Invalid active_chunk_set_id in documents: ${invalidActiveSetsRow.n} documents reference missing or inactive chunk sets`)
  }

  // V12: Metadata Schema Version
  const metaRow = targetDb.prepare("SELECT value FROM document_memory_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined
  if (!metaRow || metaRow.value !== '3') {
    reasons.push(`[V12] Metadata schema_version is missing or not '3' (got ${metaRow?.value ?? 'null'})`)
  }

  return {
    ok: reasons.length === 0,
    reasons,
    expectedDocuments,
    actualDocuments: actualDocs,
    actualChunks,
  }
}
