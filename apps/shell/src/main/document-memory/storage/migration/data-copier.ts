import type { DatabaseSync } from 'node:sqlite'
import { documentIndexFields } from '../../normalization'
import { LEGACY_E5_EMBEDDING_ID, LEGACY_VIETNAMESE_EMBEDDING_ID } from '../../embedding-profiles'

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
    insertOcrPage: sTables.includes('ocr_pages') ? tempDb.prepare('INSERT OR REPLACE INTO ocr_pages (path, page, hash, mtime_ms, size_bytes, total_pages, text, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)') : null,
    insertPdfScan: sTables.includes('pdf_scan_info') ? tempDb.prepare('INSERT OR REPLACE INTO pdf_scan_info (path, mtime_ms, size_bytes, total_pages, scanned) VALUES (?, ?, ?, ?, ?)') : null,
  }
}

export function copyDocumentActiveChunks(
  sourceDb: DatabaseSync,
  tempDb: DatabaseSync,
  doc: any,
  stmts: ReturnType<typeof prepareMigrationStatements>,
  activeSpaceId: string,
  activeDimensions: number,
): { chunks: number; embeddings: number } {
  let chunks: any[] = []
  const hasChunkSets = stmts.sTables.includes('chunk_sets')
  if (!stmts.sTables.includes('chunks')) return { chunks: 0, embeddings: 0 }

  if (doc.active_chunk_set_id != null && hasChunkSets) {
    const activeSet = sourceDb.prepare('SELECT id, chunker_version, state, created_at FROM chunk_sets WHERE id = ?').get(doc.active_chunk_set_id) as any
    if (activeSet) stmts.insertChunkSet.run(activeSet.id, doc.id, activeSet.chunker_version, 'active', activeSet.created_at)
    chunks = sourceDb.prepare('SELECT * FROM chunks WHERE document_id = ? AND chunk_set_id = ? ORDER BY ordinal ASC').all(doc.id, doc.active_chunk_set_id) as any[]
  } else {
    chunks = sourceDb.prepare('SELECT * FROM chunks WHERE document_id = ? ORDER BY ordinal ASC').all(doc.id) as any[]
  }

  let chunkCount = 0, embCount = 0
  for (const c of chunks) {
    chunkCount++
    stmts.insertChunk.run(c.id, doc.id, c.chunk_set_id ?? null, c.ordinal, c.text, c.location)
    stmts.insertFts.run(c.id, documentIndexFields(c.text).searchText)

    let vec: Uint8Array | null = null, dim = 0, space = activeSpaceId
    if (stmts.sTables.includes('chunk_embeddings')) {
      const e = sourceDb.prepare('SELECT space_id, vector, vector_dim FROM chunk_embeddings WHERE chunk_id = ? AND space_id = ?').get(c.id, activeSpaceId) as any
      if (e?.vector) { vec = e.vector; dim = e.vector_dim ?? activeDimensions; space = e.space_id }
    }
    if (!vec && c.vector) {
      const legacyDim = c.vector_dim ?? (c.vector.byteLength / 4)
      if (legacyDim === activeDimensions || (!stmts.sTables.includes('chunk_embeddings') && !doc.embedding_model)) {
        vec = c.vector
        dim = legacyDim
      }
    }
    if (vec && dim > 0) {
      stmts.ensureEmbeddingSpace.run(space, space, dim)
      stmts.insertEmbedding.run(c.id, space, vec, dim)
      embCount++
      tempDb.prepare('INSERT INTO document_embedding_counts (document_id, space_id, completed_chunks) VALUES (?, ?, 1) ON CONFLICT(document_id, space_id) DO UPDATE SET completed_chunks = document_embedding_counts.completed_chunks + 1').run(doc.id, space)
    }
  }
  if (embCount > 0) tempDb.prepare('UPDATE documents SET chunk_done = ? WHERE id = ?').run(embCount, doc.id)
  return { chunks: chunkCount, embeddings: embCount }
}

export function copyOcrData(sourceDb: DatabaseSync, path: string, stmts: ReturnType<typeof prepareMigrationStatements>): void {
  if (stmts.insertOcrPage) {
    for (const o of sourceDb.prepare('SELECT * FROM ocr_pages WHERE path = ?').all(path) as any[]) {
      stmts.insertOcrPage.run(o.path, o.page, o.hash, o.mtime_ms, o.size_bytes, o.total_pages, o.text, o.model ?? null, o.created_at)
    }
  }
  if (stmts.insertPdfScan) {
    for (const p of sourceDb.prepare('SELECT * FROM pdf_scan_info WHERE path = ?').all(path) as any[]) {
      stmts.insertPdfScan.run(p.path, p.mtime_ms, p.size_bytes, p.total_pages, p.scanned)
    }
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
