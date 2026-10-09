import type { DatabaseSync } from 'node:sqlite'

/**
 * Which legacy (V2) vectors the V2 -> V3 migration carries over.
 *
 * A V2 `chunks.vector` belongs to the space named by its document's `embedding_model`. The runtime can only query the
 * ACTIVE profile's space, so a vector of any other space (the old Vietnamese-Embedding fp32 1024d or the e5-small q8
 * 384d spaces have no query-time model in the app) is dead weight: copying it would only waste hundreds of MB and
 * inflate the migration. Such chunks are migrated without a vector and the document becomes `text-only`, which the
 * normal pipeline (`incompletePaths()`) re-embeds in the background with the active profile.
 *
 * This is the single definition shared by the growth estimators (SQL) and the copier (JS) so that what is
 * budgeted is exactly what is written.
 */

export interface ChunkVectorColumns {
  hasVector: boolean
  hasVectorDim: boolean
  /** very old sources have no chunk sets at all */
  hasChunkSetId: boolean
}

export function chunkVectorColumns(db: DatabaseSync): ChunkVectorColumns {
  const cols = new Set((db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>).map((c) => c.name))
  return { hasVector: cols.has('vector'), hasVectorDim: cols.has('vector_dim'), hasChunkSetId: cols.has('chunk_set_id') }
}

/**
 * SQL predicate (alias `c` = chunks, `d` = documents) true when the chunk's inline legacy vector is copied.
 * Positional parameters, in order: activeSpaceId, activeDimensions * 4 (bytes), activeDimensions.
 */
export function legacyVectorCopySql(cols: ChunkVectorColumns, c = 'c', d = 'd'): string {
  if (!cols.hasVector) return '0'
  const dim = cols.hasVectorDim ? `coalesce(${c}.vector_dim, length(${c}.vector) / 4)` : `length(${c}.vector) / 4`
  return `(${d}.embedding_model = ? AND ${c}.vector IS NOT NULL AND length(${c}.vector) = ? AND ${dim} = ?)`
}

/** JS twin of {@link legacyVectorCopySql} for one already-loaded row. */
export function isLegacyVectorCopyable(
  documentEmbeddingModel: string | null | undefined,
  vector: { byteLength: number } | null | undefined,
  vectorDim: number | null | undefined,
  activeSpaceId: string,
  activeDimensions: number,
): boolean {
  if (!vector || documentEmbeddingModel !== activeSpaceId) return false
  const byteLen = vector.byteLength
  const legacyDim = vectorDim ?? byteLen / 4
  return legacyDim === activeDimensions && byteLen === activeDimensions * 4
}
