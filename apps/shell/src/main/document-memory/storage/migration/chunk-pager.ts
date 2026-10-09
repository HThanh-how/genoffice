import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { MIGRATION_FTS_MULTIPLIER, MIGRATION_WAL_MULTIPLIER } from '../../runtime/backup-write-budget'
import { chunkVectorColumns, isLegacyVectorCopyable } from './legacy-vector-policy'

/**
 * Bounded, keyset-paged reading of one document's chunks / OCR pages for the V2 -> V3 migration.
 *
 * A document is never loaded whole: it is read in pages and written in byte-bounded slices, so a single huge
 * document (thousands of chunks) cannot block the migration or exceed MAX_MIGRATION_BATCH_BYTES in one transaction.
 * Rows that are individually larger than the per-row caps below are truncated deterministically (the document is
 * then flagged with the normal truncation metadata) instead of aborting the migration. The V2 source is read-only
 * throughout, and survives untouched in the backup the cutover keeps.
 */

export const MIGRATION_PAGE_ROWS = 256
/** Per-chunk text cap (UTF-8 bytes). Real chunks are a few KB; a lone capped row always fits one slice. */
export const MAX_MIGRATION_CHUNK_TEXT_BYTES = 256 * 1024
/** Per-OCR-page text cap (UTF-8 bytes). */
export const MAX_MIGRATION_OCR_TEXT_BYTES = 1024 * 1024

export interface ChunkCursor {
  ordinal: number
  id: number
}
export const CHUNK_CURSOR_START: ChunkCursor = { ordinal: Number.MIN_SAFE_INTEGER, id: 0 }

export interface MigrationChunk {
  id: number
  chunkSetId: number | null
  ordinal: number
  text: string
  location: string
  /** Vector to write into chunk_embeddings (active space only), or null. */
  vec: Uint8Array | null
  dim: number
  truncated: boolean
  growthBytes: number
}

/** Conservative on-disk bytes of one chunk row (row + text + 2x FTS expansion + optional vector), WAL not applied. */
export function chunkRowBytes(textBytes: number, vectorBytes: number): number {
  const bytes = 256 + textBytes + Math.ceil(textBytes * MIGRATION_FTS_MULTIPLIER) + vectorBytes
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Chunk growth estimate overflowed safe integer limit')
  return bytes
}

/** Applies the WAL amplification factor to a summed slice (same rule as estimateBatchMigrationGrowth). */
export function withWalAmplification(bytes: number): number {
  const total = Math.ceil(bytes * MIGRATION_WAL_MULTIPLIER)
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error('Slice growth estimate overflowed safe integer limit')
  return total
}

export interface ChunkSource {
  read(cursor: ChunkCursor, limit: number): MigrationChunk[]
}

export function openChunkSource(
  sourceDb: DatabaseSync,
  selectActiveEmbedding: StatementSync | null,
  doc: { id: number; embedding_model?: string | null },
  activeChunkSetId: number | null,
  activeSpaceId: string,
  activeDimensions: number,
): ChunkSource {
  const cols = chunkVectorColumns(sourceDb)
  const legacy = cols.hasVector && doc.embedding_model === activeSpaceId
  const dimExpr = cols.hasVectorDim ? 'coalesce(c.vector_dim, length(c.vector) / 4)' : 'length(c.vector) / 4'
  const vecSelect = legacy
    ? `CASE WHEN length(c.vector) = ? AND ${dimExpr} = ? THEN c.vector END AS vec, ${dimExpr} AS vdim`
    : 'NULL AS vec, NULL AS vdim'
  const textBytesSql = 'length(CAST(c.text AS BLOB))'
  const stmt = sourceDb.prepare(
    `SELECT c.id, ${cols.hasChunkSetId ? 'c.chunk_set_id' : 'NULL AS chunk_set_id'}, c.ordinal, c.location,
            CASE WHEN ${textBytesSql} > ${MAX_MIGRATION_CHUNK_TEXT_BYTES} THEN substr(c.text, 1, ${MAX_MIGRATION_CHUNK_TEXT_BYTES / 4}) ELSE c.text END AS text,
            ${textBytesSql} > ${MAX_MIGRATION_CHUNK_TEXT_BYTES} AS cut,
            ${vecSelect}
     FROM chunks c
     WHERE c.document_id = ? ${activeChunkSetId !== null && cols.hasChunkSetId ? 'AND c.chunk_set_id = ?' : ''}
       AND (c.ordinal > ? OR (c.ordinal = ? AND c.id > ?))
     ORDER BY c.ordinal ASC, c.id ASC LIMIT ?`,
  )
  const vectorBytes = activeDimensions * 4 + 64
  return {
    read(cursor, limit) {
      const params: Array<number | bigint> = []
      if (legacy) params.push(activeDimensions * 4, activeDimensions)
      params.push(doc.id)
      if (activeChunkSetId !== null && cols.hasChunkSetId) params.push(activeChunkSetId)
      params.push(cursor.ordinal, cursor.ordinal, cursor.id, limit)
      const rows = stmt.all(...params) as Array<{
        id: number
        chunk_set_id: number | null
        ordinal: number
        location: string
        text: string
        cut: number
        vec: Uint8Array | null
        vdim: number | null
      }>
      return rows.map((r) => {
        let vec: Uint8Array | null = null
        let dim = 0
        const active = selectActiveEmbedding?.get(r.id, activeSpaceId) as
          | { vector?: Uint8Array; vector_dim?: number }
          | undefined
        if (active?.vector) {
          vec = active.vector
          dim = active.vector_dim ?? activeDimensions
        } else if (isLegacyVectorCopyable(doc.embedding_model, r.vec, r.vdim, activeSpaceId, activeDimensions)) {
          vec = r.vec
          dim = r.vdim ?? (r.vec as Uint8Array).byteLength / 4
        }
        return {
          id: r.id,
          chunkSetId: r.chunk_set_id ?? null,
          ordinal: r.ordinal,
          text: r.text,
          location: r.location,
          vec,
          dim,
          truncated: r.cut === 1,
          growthBytes: chunkRowBytes(Buffer.byteLength(r.text, 'utf8'), vec ? vectorBytes : 0),
        }
      })
    },
  }
}

/**
 * Takes the next slice of chunks whose summed growth (with WAL amplification) stays within `maxBytes`
 * (at least one row, so progress is guaranteed; a lone row is bounded by the per-row caps). `Infinity` = whole rest.
 */
export function nextChunkSlice(
  source: ChunkSource,
  start: ChunkCursor,
  maxBytes: number,
): { chunks: MigrationChunk[]; cursor: ChunkCursor; bytes: number; done: boolean } {
  const chunks: MigrationChunk[] = []
  let raw = 0
  let cursor = start
  for (;;) {
    const page = source.read(cursor, MIGRATION_PAGE_ROWS)
    for (const c of page) {
      if (chunks.length > 0 && withWalAmplification(raw + c.growthBytes) > maxBytes) {
        return { chunks, cursor, bytes: withWalAmplification(raw), done: false }
      }
      chunks.push(c)
      raw += c.growthBytes
      cursor = { ordinal: c.ordinal, id: c.id }
    }
    if (page.length < MIGRATION_PAGE_ROWS) {
      return { chunks, cursor, bytes: raw > 0 ? withWalAmplification(raw) : 0, done: true }
    }
  }
}

export interface OcrPageRow {
  path: string
  page: number
  hash: string
  mtime_ms: number
  size_bytes: number
  total_pages: number
  text: string
  model?: string | null
  created_at: number
  engine?: string | null
  quality?: number | null
  tier?: string | null
  escalate?: number | null
  cut: number
}

export interface OcrSliceResult {
  rows: OcrPageRow[]
  lastPage: number
  bytes: number
  done: boolean
  truncated: boolean
}

/** Next byte-bounded slice of a document's OCR pages (keyset on page). Same truncation rules as chunks. */
export function nextOcrSlice(sourceDb: DatabaseSync, path: string, afterPage: number, maxBytes: number): OcrSliceResult {
  const textBytesSql = 'length(CAST(text AS BLOB))'
  // older sources lack the local-OCR verdict columns: select only what exists (the copier defaults the rest)
  const present = new Set((sourceDb.prepare('PRAGMA table_info(ocr_pages)').all() as Array<{ name: string }>).map((c) => c.name))
  const wanted = ['path', 'page', 'hash', 'mtime_ms', 'size_bytes', 'total_pages', 'model', 'created_at', 'engine', 'quality', 'tier', 'escalate']
  const stmt = sourceDb.prepare(
    `SELECT ${wanted.filter((c) => present.has(c)).join(', ')},
            CASE WHEN ${textBytesSql} > ${MAX_MIGRATION_OCR_TEXT_BYTES} THEN substr(text, 1, ${MAX_MIGRATION_OCR_TEXT_BYTES / 4}) ELSE text END AS text,
            ${textBytesSql} > ${MAX_MIGRATION_OCR_TEXT_BYTES} AS cut
     FROM ocr_pages WHERE path = ? AND page > ? ORDER BY page ASC LIMIT ?`,
  )
  const rows: OcrPageRow[] = []
  let raw = 0
  let last = afterPage
  let truncated = false
  for (;;) {
    const page = stmt.all(path, last, MIGRATION_PAGE_ROWS) as unknown as OcrPageRow[]
    for (const o of page) {
      const rowBytes = 512 + Buffer.byteLength(o.text, 'utf8')
      if (rows.length > 0 && withWalAmplification(raw + rowBytes) > maxBytes) {
        return { rows, lastPage: last, bytes: withWalAmplification(raw), done: false, truncated }
      }
      rows.push(o)
      raw += rowBytes
      last = o.page
      if (o.cut === 1) truncated = true
    }
    if (page.length < MIGRATION_PAGE_ROWS) {
      return { rows, lastPage: last, bytes: raw > 0 ? withWalAmplification(raw) : 0, done: true, truncated }
    }
  }
}
