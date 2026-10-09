import type { DatabaseSync } from 'node:sqlite'
import { documentIndexFields } from '../../normalization'
import { EMBEDDING_PROFILES, LEGACY_E5_EMBEDDING_ID, LEGACY_VIETNAMESE_EMBEDDING_ID } from '../../embedding-profiles'
import {
  CHUNK_CURSOR_START,
  nextChunkSlice,
  nextOcrSlice,
  openChunkSource,
  type ChunkSource,
  type MigrationChunk,
  type OcrPageRow,
} from './chunk-pager'

export function copyEmbeddingSpaces(sourceDb: DatabaseSync, tempDb: DatabaseSync): void {
  const tables = (sourceDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name)
  if (tables.includes('embedding_spaces')) {
    const spaces = sourceDb.prepare('SELECT id, model_repo, model_revision, pooling, dimensions, quantization FROM embedding_spaces').all() as Array<any>
    const ins = tempDb.prepare('INSERT OR IGNORE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization) VALUES (?, ?, ?, ?, ?, ?)')
    for (const s of spaces) ins.run(s.id, s.model_repo, s.model_revision, s.pooling, s.dimensions, s.quantization)
  } else {
    tempDb.prepare('INSERT OR IGNORE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)')
      .run(LEGACY_E5_EMBEDDING_ID, 'Xenova/multilingual-e5-small', '761b726dd34fb83930e26aab4e9ac3899aa1fa78', 'mean', 384, 'q8',
           LEGACY_VIETNAMESE_EMBEDDING_ID, 'AITeamVN/Vietnamese_Embedding', 'dea33aa1ab339f38d66ae0a40e6c40e0a9249568', 'sentence', 1024, 'fp32')
  }
}

export function prepareMigrationStatements(sourceDb: DatabaseSync, tempDb: DatabaseSync) {
  const sTables = (sourceDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name)
  return {
    sTables,
    insertDoc: tempDb.prepare('INSERT INTO documents (id, path, name, status, mtime_ms, size_bytes, hash, embedding_model, active_chunk_set_id, error, excluded, truncated, truncated_reason, last_opened_at, priority_at, updated_at, chunk_total, chunk_done, chunk_counted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    insertChunkSet: tempDb.prepare('INSERT OR REPLACE INTO chunk_sets (id, document_id, chunker_version, state, created_at) VALUES (?, ?, ?, ?, ?)'),
    insertChunk: tempDb.prepare('INSERT INTO chunks (id, document_id, chunk_set_id, ordinal, text, location) VALUES (?, ?, ?, ?, ?, ?)'),
    insertFts: tempDb.prepare('INSERT INTO chunk_fts (rowid, text) VALUES (?, ?)'),
    insertEmbedding: tempDb.prepare('INSERT OR REPLACE INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim, created_at) VALUES (?, ?, ?, ?, unixepoch())'),
    ensureEmbeddingSpace: tempDb.prepare("INSERT OR IGNORE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization) VALUES (?, ?, 'legacy', 'mean', ?, 'fp32')"),
    // completed_chunks is accumulated per written slice (a large document spans several transactions)
    insertDocEmbeddingCount: tempDb.prepare('INSERT INTO document_embedding_counts (document_id, space_id, completed_chunks) VALUES (?, ?, ?) ON CONFLICT(document_id, space_id) DO UPDATE SET completed_chunks = document_embedding_counts.completed_chunks + excluded.completed_chunks'),
    // a row or OCR page cut to the per-row cap marks the document with the normal truncation metadata (never overwrites an existing reason)
    markTruncated: tempDb.prepare("UPDATE documents SET truncated_reason = CASE WHEN truncated = 1 THEN truncated_reason ELSE 'content-limit' END, truncated = 1 WHERE id = ?"),
    updateDocStatusAndModel: tempDb.prepare('UPDATE documents SET status = ?, embedding_model = ?, chunk_done = ? WHERE id = ?'),
    updateDocChunkDone: tempDb.prepare('UPDATE documents SET chunk_done = ? WHERE id = ?'),
    selectChunkEmbedding: sTables.includes('chunk_embeddings') ? sourceDb.prepare('SELECT vector, vector_dim FROM chunk_embeddings WHERE chunk_id = ? AND space_id = ?') : null,
    // engine / quality / tier / escalate carry the local-OCR verdict: dropping them would turn a local row into a cloud one
    insertOcrPage: sTables.includes('ocr_pages') ? tempDb.prepare('INSERT OR REPLACE INTO ocr_pages (path, page, hash, mtime_ms, size_bytes, total_pages, text, model, created_at, engine, quality, tier, escalate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)') : null,
    insertLocalFailure: sTables.includes('ocr_local_failures') ? tempDb.prepare('INSERT OR REPLACE INTO ocr_local_failures (path, mtime_ms, size_bytes, attempts, code, updated_at) VALUES (?, ?, ?, ?, ?, ?)') : null,
    insertMedia: sTables.includes('document_media') ? tempDb.prepare('INSERT OR REPLACE INTO document_media (document_id, kind, container, width, height, duration_ms, taken_ms, ts_ms, meta_state, sensitive, ocr_candidate, ocr_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)') : null,
    insertPdfScan: sTables.includes('pdf_scan_info') ? tempDb.prepare('INSERT OR REPLACE INTO pdf_scan_info (path, mtime_ms, size_bytes, total_pages, scanned) VALUES (?, ?, ?, ?, ?)') : null,
  }
}

/**
 * Resolves the document's active chunk set (writing its chunk_sets row, so call it inside the temp transaction) and
 * returns a paged reader over its chunks, or null when the source has no chunks table.
 */
export function beginDocumentChunks(
  sourceDb: DatabaseSync,
  doc: any,
  stmts: ReturnType<typeof prepareMigrationStatements>,
  activeSpaceId: string,
  activeDimensions: number,
): ChunkSource | null {
  if (!stmts.sTables.includes('chunks')) return null
  let activeSetId: number | null = null
  if (doc.active_chunk_set_id != null && stmts.sTables.includes('chunk_sets')) {
    const activeSet = sourceDb.prepare('SELECT id, chunker_version, state, created_at FROM chunk_sets WHERE id = ?').get(doc.active_chunk_set_id) as any
    if (activeSet) stmts.insertChunkSet.run(activeSet.id, doc.id, activeSet.chunker_version, 'active', activeSet.created_at)
    activeSetId = doc.active_chunk_set_id
  }
  return openChunkSource(sourceDb, stmts.selectChunkEmbedding, doc, activeSetId, activeSpaceId, activeDimensions)
}

/** Writes one slice of chunks (row + FTS + active-space vector + its completed-count) into the temp database. */
export function writeChunkSlice(
  stmts: ReturnType<typeof prepareMigrationStatements>,
  doc: any,
  chunks: MigrationChunk[],
  activeSpaceId: string,
): { chunks: number; embeddings: number; truncated: boolean } {
  let embeddings = 0
  let truncated = false
  for (const c of chunks) {
    stmts.insertChunk.run(c.id, doc.id, c.chunkSetId, c.ordinal, c.text, c.location)
    stmts.insertFts.run(c.id, documentIndexFields(c.text).searchText)
    if (c.truncated) truncated = true
    if (c.vec && c.dim > 0) {
      stmts.ensureEmbeddingSpace.run(activeSpaceId, activeSpaceId, c.dim)
      stmts.insertEmbedding.run(c.id, activeSpaceId, c.vec, c.dim)
      embeddings++
    }
  }
  if (embeddings > 0) stmts.insertDocEmbeddingCount.run(doc.id, activeSpaceId, embeddings)
  return { chunks: chunks.length, embeddings, truncated }
}

/**
 * Settles a document's status / counters once ALL its chunks are written (chunk_total is trigger-maintained):
 * every chunk vectorised in the active space -> 'ready'; otherwise 'text-only' (searchable by text at once, and
 * re-embedded in the background by the normal pipeline, newest / opened first). 'pending' documents stay pending
 * (they still need extraction); excluded / error documents keep their meaning.
 */
export function finalizeDocumentChunks(
  stmts: ReturnType<typeof prepareMigrationStatements>,
  doc: any,
  activeSpaceId: string,
  totals: { chunks: number; embeddings: number; truncated: boolean },
): void {
  const { chunks: chunkCount, embeddings: embCount } = totals
  if (totals.truncated) stmts.markTruncated.run(doc.id)
  if (chunkCount === 0) return
  const keepsStatus = doc.status === 'excluded' || doc.status === 'error'
  if (keepsStatus) stmts.updateDocChunkDone.run(embCount, doc.id)
  else if (embCount === chunkCount) stmts.updateDocStatusAndModel.run('ready', activeSpaceId, embCount, doc.id)
  else stmts.updateDocStatusAndModel.run(doc.status === 'pending' ? 'pending' : 'text-only', embCount > 0 ? activeSpaceId : null, embCount, doc.id)
}

/** Copies a (bounded-size) document's whole active chunk set inside the caller's transaction. */
export function copyDocumentActiveChunks(
  sourceDb: DatabaseSync,
  _tempDb: DatabaseSync,
  doc: any,
  stmts: ReturnType<typeof prepareMigrationStatements>,
  activeSpaceId: string,
  activeDimensions: number,
): { chunks: number; embeddings: number } {
  const source = beginDocumentChunks(sourceDb, doc, stmts, activeSpaceId, activeDimensions)
  if (!source) return { chunks: 0, embeddings: 0 }
  const slice = nextChunkSlice(source, CHUNK_CURSOR_START, Infinity)
  const totals = writeChunkSlice(stmts, doc, slice.chunks, activeSpaceId)
  finalizeDocumentChunks(stmts, doc, activeSpaceId, totals)
  return { chunks: totals.chunks, embeddings: totals.embeddings }
}

/** Writes OCR pages of one slice; returns whether any page text had to be truncated. */
export function writeOcrPages(stmts: ReturnType<typeof prepareMigrationStatements>, rows: OcrPageRow[]): void {
  if (!stmts.insertOcrPage) return
  for (const o of rows) {
    stmts.insertOcrPage.run(o.path, o.page, o.hash, o.mtime_ms, o.size_bytes, o.total_pages, o.text, o.model ?? null, o.created_at, o.engine ?? null, o.quality ?? null, o.tier ?? null, o.escalate ?? 0)
  }
}

/** Small per-document OCR side rows: local-OCR failure markers and the PDF scan verdict. */
export function copyOcrSideRows(sourceDb: DatabaseSync, path: string, stmts: ReturnType<typeof prepareMigrationStatements>): void {
  if (stmts.insertLocalFailure) {
    for (const f of sourceDb.prepare('SELECT * FROM ocr_local_failures WHERE path = ?').all(path) as any[]) {
      stmts.insertLocalFailure.run(f.path, f.mtime_ms, f.size_bytes, f.attempts, f.code, f.updated_at ?? Math.floor(Date.now() / 1000))
    }
  }
  if (stmts.insertPdfScan) {
    for (const p of sourceDb.prepare('SELECT * FROM pdf_scan_info WHERE path = ?').all(path) as any[]) {
      stmts.insertPdfScan.run(p.path, p.mtime_ms, p.size_bytes, p.total_pages, p.scanned)
    }
  }
}

/** Copies a (bounded-size) document's OCR rows inside the caller's transaction. */
export function copyOcrData(sourceDb: DatabaseSync, path: string, stmts: ReturnType<typeof prepareMigrationStatements>, doc?: any): void {
  if (stmts.insertOcrPage) {
    const slice = nextOcrSlice(sourceDb, path, -1, Infinity)
    writeOcrPages(stmts, slice.rows)
    if (slice.truncated && doc) stmts.markTruncated.run(doc.id)
  }
  copyOcrSideRows(sourceDb, path, stmts)
}

/** The media side row (kind, header facts, sensitive marker, OCR candidate / state) of a copied image or video. */
export function copyMediaRow(sourceDb: DatabaseSync, documentId: number, stmts: ReturnType<typeof prepareMigrationStatements>): void {
  if (!stmts.insertMedia) return
  for (const m of sourceDb.prepare('SELECT * FROM document_media WHERE document_id = ?').all(documentId) as any[]) {
    stmts.insertMedia.run(m.document_id, m.kind, m.container ?? null, m.width ?? null, m.height ?? null, m.duration_ms ?? null, m.taken_ms ?? null, m.ts_ms ?? 0, m.meta_state ?? 0, m.sensitive ?? 0, m.ocr_candidate ?? 0, m.ocr_state ?? 0)
  }
}

export function copyAnnMetadata(sourceDb: DatabaseSync, tempDb: DatabaseSync): void {
  const tables = (sourceDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name)
  if (tables.includes('ann_indexes')) {
    const annRows = sourceDb.prepare('SELECT space_id, file_path, generation, desired_generation FROM ann_indexes').all() as any[]
    const ins = tempDb.prepare("INSERT OR REPLACE INTO ann_indexes (space_id, generation, desired_generation, file_path, indexed_count, state, updated_at) VALUES (?, ?, ?, ?, 0, 'dirty', unixepoch())")
    for (const a of annRows) ins.run(a.space_id, a.generation ?? 0, a.desired_generation ?? 0, a.file_path ?? null)
  }
}

export function ensureActiveEmbeddingSpaceMetadata(
  db: DatabaseSync,
  activeSpaceId: string,
  activeDimensions: number,
): void {
  const profile =
    activeSpaceId === EMBEDDING_PROFILES.standard.embeddingId
      ? EMBEDDING_PROFILES.standard
      : activeSpaceId === EMBEDDING_PROFILES.high.embeddingId
        ? EMBEDDING_PROFILES.high
        : null

  const existing = db
    .prepare(
      `SELECT id, model_repo, model_revision, pooling, dimensions, quantization
       FROM embedding_spaces WHERE id = ?`,
    )
    .get(activeSpaceId) as
    | {
        id: string
        model_repo: string
        model_revision: string
        pooling: string
        dimensions: number
        quantization: string
      }
    | undefined

  if (profile) {
    const expectedRepo = profile.repo
    const expectedRevision = profile.revision
    const expectedPooling = profile.pooling
    const expectedDimensions = profile.dimensions
    const expectedQuantization = 'q8'

    if (!existing) {
      db.prepare(
        `INSERT INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        profile.embeddingId,
        expectedRepo,
        expectedRevision,
        expectedPooling,
        expectedDimensions,
        expectedQuantization,
      )
      return
    }

    if (
      existing.model_repo !== expectedRepo ||
      existing.model_revision !== expectedRevision ||
      existing.pooling !== expectedPooling ||
      existing.dimensions !== expectedDimensions ||
      existing.quantization !== expectedQuantization
    ) {
      throw new Error(
        `Embedding space metadata mismatch for canonical space '${activeSpaceId}': ` +
          `expected repo='${expectedRepo}', revision='${expectedRevision}', pooling='${expectedPooling}', dimensions=${expectedDimensions}, quantization='${expectedQuantization}'; ` +
          `found repo='${existing.model_repo}', revision='${existing.model_revision}', pooling='${existing.pooling}', dimensions=${existing.dimensions}, quantization='${existing.quantization}'`,
      )
    }
  } else {
    if (!existing) {
      db.prepare(
        `INSERT INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
         VALUES (?, ?, 'legacy', 'mean', ?, 'fp32')`,
      ).run(activeSpaceId, activeSpaceId, activeDimensions)
    }
  }
}
