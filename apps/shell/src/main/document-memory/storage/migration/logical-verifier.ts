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

export interface EmbeddingVerifierOptions {
  activeSpaceId: string
  activeDimensions: number
}

export interface EmbeddingIntegrityResult {
  ok: boolean
  reasons: string[]
  activeSpaceId?: string
  activeDimensions?: number
  totalActiveVectors?: number
}

/**
 * Rigorously verifies active embedding integrity before cutover:
 * - Target space exists in embedding_spaces
 * - Active vectors in chunk_embeddings have exact dimensions (dim == activeDimensions)
 * - No active vector wrong dimensionality (exact blob byte length matching dimensions)
 * - document_embedding_counts rows match actual chunk_embeddings vectors count
 */
export function verifyEmbeddingIntegrity(
  targetDb: DatabaseSync,
  activeSpaceId: string,
  activeDimensions: number,
): EmbeddingIntegrityResult
export function verifyEmbeddingIntegrity(
  targetDb: DatabaseSync,
  options: EmbeddingVerifierOptions,
): EmbeddingIntegrityResult
export function verifyEmbeddingIntegrity(
  options: EmbeddingVerifierOptions & { targetDb?: DatabaseSync; db?: DatabaseSync },
): EmbeddingIntegrityResult
export function verifyEmbeddingIntegrity(
  targetDbOrOptions: DatabaseSync | (EmbeddingVerifierOptions & { targetDb?: DatabaseSync; db?: DatabaseSync }),
  activeSpaceIdOrOptions?: string | EmbeddingVerifierOptions,
  maybeDimensions?: number,
): EmbeddingIntegrityResult {
  let targetDb: DatabaseSync
  let activeSpaceId: string
  let activeDimensions: number

  if ('prepare' in targetDbOrOptions) {
    targetDb = targetDbOrOptions
    if (typeof activeSpaceIdOrOptions === 'string') {
      activeSpaceId = activeSpaceIdOrOptions
      activeDimensions = typeof maybeDimensions === 'number' ? maybeDimensions : 0
    } else if (activeSpaceIdOrOptions && typeof activeSpaceIdOrOptions === 'object') {
      activeSpaceId = activeSpaceIdOrOptions.activeSpaceId
      activeDimensions = activeSpaceIdOrOptions.activeDimensions
    } else {
      throw new Error('Invalid arguments to verifyEmbeddingIntegrity: missing activeSpaceId and activeDimensions')
    }
  } else {
    const opts = targetDbOrOptions
    const resolvedDb = opts.targetDb ?? opts.db
    if (!resolvedDb) {
      throw new Error('Invalid arguments to verifyEmbeddingIntegrity: missing targetDb or db')
    }
    targetDb = resolvedDb
    activeSpaceId = opts.activeSpaceId
    activeDimensions = opts.activeDimensions
  }

  const reasons: string[] = []

  // 1. Target space exists in embedding_spaces
  const spaceRow = targetDb
    .prepare('SELECT id, dimensions FROM embedding_spaces WHERE id = ?')
    .get(activeSpaceId) as { id: string; dimensions?: number } | undefined

  if (!spaceRow) {
    reasons.push(`Target embedding space '${activeSpaceId}' does not exist in embedding_spaces`)
  } else if (typeof spaceRow.dimensions === 'number' && spaceRow.dimensions !== activeDimensions) {
    reasons.push(
      `Target embedding space '${activeSpaceId}' declared dimensions (${spaceRow.dimensions}) does not match activeDimensions (${activeDimensions})`,
    )
  }

  // 2. Active vectors in chunk_embeddings have exact dimensions (dim == activeDimensions)
  const exactDimMismatchRow = targetDb
    .prepare(`
      SELECT count(*) AS n FROM chunk_embeddings
      WHERE space_id = ? AND (vector_dim IS NULL OR vector_dim != ?)
    `)
    .get(activeSpaceId, activeDimensions) as { n: number }

  if (exactDimMismatchRow.n > 0) {
    reasons.push(
      `Active vectors in chunk_embeddings do not have exact dimensions: ${exactDimMismatchRow.n} record(s) have vector_dim != ${activeDimensions}`,
    )
  }

  // 3. No active vector wrong dimensionality (exact blob byte length == activeDimensions * 4 and matches vector_dim * 4)
  const wrongDimRow = targetDb
    .prepare(`
      SELECT count(*) AS n FROM chunk_embeddings
      WHERE space_id = ? AND (
        length(vector) != ? * 4
        OR length(vector) != vector_dim * 4
        OR vector_dim <= 0
        OR vector IS NULL
      )
    `)
    .get(activeSpaceId, activeDimensions) as { n: number }

  if (wrongDimRow.n > 0) {
    reasons.push(
      `Active vectors in chunk_embeddings have wrong dimensionality: ${wrongDimRow.n} record(s) violate expected dimension ${activeDimensions} or blob byte length (${activeDimensions * 4} bytes)`,
    )
  }

  // 4. document_embedding_counts rows match actual chunk_embeddings vectors count
  // 4a. Per-document completed_chunks matches actual chunk_embeddings vectors count for activeSpaceId
  const docCountMismatchRow = targetDb
    .prepare(`
      SELECT count(*) AS n FROM (
        SELECT d.document_id, d.space_id, d.completed_chunks,
               (
                 SELECT count(*)
                 FROM chunks c
                 JOIN chunk_embeddings ce ON ce.chunk_id = c.id
                 WHERE c.document_id = d.document_id AND ce.space_id = d.space_id
               ) AS actual_chunks
        FROM document_embedding_counts d
        WHERE d.space_id = ?
      )
      WHERE completed_chunks != actual_chunks
    `)
    .get(activeSpaceId) as { n: number }

  if (docCountMismatchRow.n > 0) {
    reasons.push(
      `Mismatch in document_embedding_counts for space '${activeSpaceId}': ${docCountMismatchRow.n} document(s) have completed_chunks not matching actual chunk_embeddings count`,
    )
  }

  // 4b. No documents with chunk_embeddings missing from document_embedding_counts
  const missingDocCountsRow = targetDb
    .prepare(`
      SELECT count(*) AS n FROM (
        SELECT c.document_id
        FROM chunks c
        JOIN chunk_embeddings ce ON ce.chunk_id = c.id
        WHERE ce.space_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM document_embedding_counts d
            WHERE d.document_id = c.document_id AND d.space_id = ce.space_id
          )
        GROUP BY c.document_id
      )
    `)
    .get(activeSpaceId) as { n: number }

  if (missingDocCountsRow.n > 0) {
    reasons.push(
      `Missing document_embedding_counts records for space '${activeSpaceId}': ${missingDocCountsRow.n} document(s) have chunk_embeddings but no document_embedding_counts record`,
    )
  }

  // 4c. Total document_embedding_counts sum matches total chunk_embeddings count for activeSpaceId
  const totalCountRow = targetDb
    .prepare(`
      SELECT 
        (SELECT coalesce(sum(completed_chunks), 0) FROM document_embedding_counts WHERE space_id = ?) AS counted_total,
        (SELECT count(*) FROM chunk_embeddings WHERE space_id = ?) AS actual_total
    `)
    .get(activeSpaceId, activeSpaceId) as { counted_total: number; actual_total: number }

  if (totalCountRow.counted_total !== totalCountRow.actual_total) {
    reasons.push(
      `document_embedding_counts total (${totalCountRow.counted_total}) does not match actual chunk_embeddings vectors count (${totalCountRow.actual_total}) for space '${activeSpaceId}'`,
    )
  }

  const totalActiveVectorsRow = targetDb
    .prepare('SELECT count(*) AS n FROM chunk_embeddings WHERE space_id = ?')
    .get(activeSpaceId) as { n: number }
  const totalActiveVectors = totalActiveVectorsRow?.n ?? 0

  return {
    ok: reasons.length === 0,
    reasons,
    activeSpaceId,
    activeDimensions,
    totalActiveVectors,
  }
}

export const verifyActiveEmbeddingIntegrity = verifyEmbeddingIntegrity

export interface LogicalConsistencyOptions {
  activeSpaceId?: string
  activeDimensions?: number
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
  options?: LogicalConsistencyOptions,
): LogicalConsistencyResult
export function verifyLogicalConsistency(
  targetDb: DatabaseSync,
  expectedDocuments: number,
  expectedChunks: number,
  activeSpaceId: string,
  activeDimensions: number,
): LogicalConsistencyResult
export function verifyLogicalConsistency(
  targetDb: DatabaseSync,
  expectedDocuments: number,
  expectedChunks: number,
  optionsOrActiveSpaceId?: LogicalConsistencyOptions | string,
  maybeActiveDimensions?: number,
): LogicalConsistencyResult {
  const reasons: string[] = []

  let activeSpaceId: string | undefined
  let activeDimensions: number | undefined
  if (typeof optionsOrActiveSpaceId === 'string') {
    activeSpaceId = optionsOrActiveSpaceId
    activeDimensions = maybeActiveDimensions
  } else if (optionsOrActiveSpaceId && typeof optionsOrActiveSpaceId === 'object') {
    activeSpaceId = optionsOrActiveSpaceId.activeSpaceId
    activeDimensions = optionsOrActiveSpaceId.activeDimensions
  }

  if (activeSpaceId && typeof activeDimensions === 'number') {
    const embResult = verifyEmbeddingIntegrity(targetDb, activeSpaceId, activeDimensions)
    if (!embResult.ok) {
      reasons.push(...embResult.reasons)
    }
  }

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

  // V13: FTS Consistency & Completeness
  const ftsResult = verifyFtsIntegrity(targetDb)
  if (!ftsResult.ok) {
    reasons.push(...ftsResult.reasons)
  }

  // V14: OCR Sidecar Integrity
  const ocrResult = verifyOcrIntegrity(targetDb)
  if (!ocrResult.ok) {
    reasons.push(...ocrResult.reasons)
  }

  return {
    ok: reasons.length === 0,
    reasons,
    expectedDocuments,
    actualDocuments: actualDocs,
    actualChunks,
  }
}

export interface FtsIntegrityResult {
  ok: boolean
  reasons: string[]
  totalFtsChunks?: number
}

export function verifyFtsIntegrity(targetDb: DatabaseSync): FtsIntegrityResult {
  const reasons: string[] = []

  // Check chunk_fts virtual table exists and is readable
  try {
    const ftsCheck = targetDb.prepare("INSERT INTO chunk_fts(chunk_fts) VALUES('integrity-check')")
    ftsCheck.run()
  } catch (err: any) {
    reasons.push(`[V13] chunk_fts virtual table integrity check failed: ${err?.message ?? 'unknown error'}`)
  }

  // Check missing chunk_fts for chunks
  try {
    const missingFtsRow = targetDb
      .prepare(`
        SELECT count(*) AS n FROM chunks c
        WHERE c.id NOT IN (SELECT rowid FROM chunk_fts)
      `)
      .get() as { n: number }
    if (missingFtsRow.n > 0) {
      reasons.push(`[V13] FTS completeness failed: ${missingFtsRow.n} chunk(s) lack chunk_fts records`)
    }
  } catch (err: any) {
    reasons.push(`[V13] Could not query chunk_fts completeness: ${err?.message}`)
  }

  // Check orphan chunk_fts rows
  try {
    const orphanFtsRow = targetDb
      .prepare(`
        SELECT count(*) AS n FROM chunk_fts f
        WHERE f.rowid NOT IN (SELECT id FROM chunks)
      `)
      .get() as { n: number }
    if (orphanFtsRow.n > 0) {
      reasons.push(`[V13] Orphan FTS rows detected: ${orphanFtsRow.n} record(s) in chunk_fts do not correspond to any chunk`)
    }
  } catch (err: any) {
    reasons.push(`[V13] Could not query orphan chunk_fts: ${err?.message}`)
  }

  // Check document_name_fts completeness
  try {
    const missingDocNameRow = targetDb
      .prepare(`
        SELECT count(*) AS n FROM documents d
        WHERE d.excluded = 0 AND d.id NOT IN (SELECT rowid FROM document_name_fts)
      `)
      .get() as { n: number }
    if (missingDocNameRow.n > 0) {
      reasons.push(`[V13] Document name FTS mismatch: ${missingDocNameRow.n} document(s) missing from document_name_fts`)
    }
  } catch (err: any) {
    reasons.push(`[V13] Could not query document_name_fts: ${err?.message}`)
  }

  let totalFtsChunks = 0
  try {
    const totalRow = targetDb.prepare('SELECT count(*) AS n FROM chunk_fts').get() as { n: number }
    totalFtsChunks = totalRow.n
  } catch {
    // ignore
  }

  return {
    ok: reasons.length === 0,
    reasons,
    totalFtsChunks,
  }
}

export interface OcrIntegrityResult {
  ok: boolean
  reasons: string[]
  totalOcrPages?: number
}

export function verifyOcrIntegrity(targetDb: DatabaseSync): OcrIntegrityResult {
  const reasons: string[] = []

  // Check table presence (if ocr_pages exists)
  const hasOcrPages = !!targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ocr_pages'").get()
  if (!hasOcrPages) {
    return { ok: true, reasons: [], totalOcrPages: 0 }
  }

  let totalOcrPages = 0
  try {
    const totalRow = targetDb.prepare('SELECT count(*) AS n FROM ocr_pages').get() as { n: number }
    totalOcrPages = totalRow.n

    // Check invalid page numbers
    const invalidPageRow = targetDb
      .prepare(`
        SELECT count(*) AS n FROM ocr_pages
        WHERE page <= 0 OR (total_pages > 0 AND page > total_pages)
      `)
      .get() as { n: number }
    if (invalidPageRow.n > 0) {
      reasons.push(`[V14] OCR page range violation: ${invalidPageRow.n} page(s) have invalid page <= 0 or page > total_pages`)
    }
  } catch (err: any) {
    reasons.push(`[V14] Failed to inspect ocr_pages: ${err?.message}`)
  }

  // Check pdf_scan_info if present
  const hasScanInfo = !!targetDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pdf_scan_info'").get()
  if (hasScanInfo) {
    try {
      const invalidScanRow = targetDb
        .prepare(`
          SELECT count(*) AS n FROM pdf_scan_info
          WHERE total_pages < 0 OR size_bytes < 0
        `)
        .get() as { n: number }
      if (invalidScanRow.n > 0) {
        reasons.push(`[V14] PDF scan info integrity violation: ${invalidScanRow.n} invalid records`)
      }
    } catch (err: any) {
      reasons.push(`[V14] Failed to inspect pdf_scan_info: ${err?.message}`)
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    totalOcrPages,
  }
}
