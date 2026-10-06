import type { DatabaseSync } from 'node:sqlite'

export interface GarbageCollectionStats {
  retiredSetsDeleted: number
  orphanChunksDeleted: number
  obsoleteEmbeddingsDeleted: number
  ftsRowsCleaned: number
}

export interface StorageFreelistStats {
  pageCount: number
  freelistCount: number
  pageSize: number
  freelistRatio: number
  reclaimableBytes: number
  shouldVacuum: boolean
}

export interface IncrementalVacuumOptions {
  batchPages?: number
  maxPages?: number
  force?: boolean
}

export interface VacuumResult {
  vacuumed: boolean
  initialFreelistPages: number
  finalFreelistPages: number
  pagesReclaimed: number
  bytesReclaimed: number
}

export const INCREMENTAL_VACUUM_BATCH_PAGES = 256
export const VACUUM_FREELIST_RATIO_THRESHOLD = 0.15
export const VACUUM_RECLAIMABLE_BYTES_THRESHOLD = 512 * 1024 * 1024 // 512MB

/**
 * Reclaims obsolete storage:
 * - Purges retired chunk sets and their chunks + FTS rows.
 * - Purges orphan chunks not attached to a valid document or active chunk set.
 * - Purges obsolete embeddings that no longer belong to active chunks or known spaces.
 * - Resynchronizes document_embedding_counts.
 */
export function garbageCollectObsoleteStorage(db: DatabaseSync): GarbageCollectionStats {
  let retiredSetsDeleted = 0
  let orphanChunksDeleted = 0
  let obsoleteEmbeddingsDeleted = 0
  let ftsRowsCleaned = 0

  db.exec('BEGIN IMMEDIATE')
  try {
    const delFts = db.prepare('DELETE FROM chunk_fts WHERE rowid = ?')

    // 1. Dọn dẹp retired chunk sets
    const retiredSets = db
      .prepare("SELECT id FROM chunk_sets WHERE state = 'retired'")
      .all() as Array<{ id: number }>

    if (retiredSets.length > 0) {
      const setIds = retiredSets.map((s) => s.id)
      const placeholders = setIds.map(() => '?').join(',')

      const chunksInRetiredSets = db
        .prepare(`SELECT id FROM chunks WHERE chunk_set_id IN (${placeholders})`)
        .all(...setIds) as Array<{ id: number }>

      for (const { id } of chunksInRetiredSets) {
        delFts.run(id)
        ftsRowsCleaned++
      }

      const delChunks = db
        .prepare(`DELETE FROM chunks WHERE chunk_set_id IN (${placeholders})`)
        .run(...setIds)
      orphanChunksDeleted += Number(delChunks.changes)

      const delSets = db
        .prepare(`DELETE FROM chunk_sets WHERE id IN (${placeholders})`)
        .run(...setIds)
      retiredSetsDeleted += Number(delSets.changes)
    }

    // 2. Dọn dẹp orphan chunks
    // - Chunks không thuộc document nào
    // - Chunks có chunk_set_id nhưng chunk_set không tồn tại
    // - Chunks thuộc document có active_chunk_set_id nhưng chunk_set_id <> active_chunk_set_id
    const orphanChunks = db
      .prepare(`
        SELECT c.id FROM chunks c
        WHERE c.document_id NOT IN (SELECT id FROM documents)
           OR (c.chunk_set_id IS NOT NULL AND c.chunk_set_id NOT IN (SELECT id FROM chunk_sets))
           OR EXISTS (
             SELECT 1 FROM documents d
             WHERE d.id = c.document_id
               AND d.active_chunk_set_id IS NOT NULL
               AND c.chunk_set_id <> d.active_chunk_set_id
           )
      `)
      .all() as Array<{ id: number }>

    if (orphanChunks.length > 0) {
      const orphanIds = orphanChunks.map((c) => c.id)
      for (const id of orphanIds) {
        delFts.run(id)
        ftsRowsCleaned++
      }
      const placeholders = orphanIds.map(() => '?').join(',')
      const delOrphans = db
        .prepare(`DELETE FROM chunks WHERE id IN (${placeholders})`)
        .run(...orphanIds)
      orphanChunksDeleted += Number(delOrphans.changes)
    }

    // 3. Dọn dẹp obsolete embeddings
    // - Embeddings không còn chunk tương ứng
    // - Embeddings có space_id không tồn tại trong embedding_spaces
    const delOrphanEmbs = db
      .prepare(`
        DELETE FROM chunk_embeddings
        WHERE chunk_id NOT IN (SELECT id FROM chunks)
           OR space_id NOT IN (SELECT id FROM embedding_spaces)
      `)
      .run()
    obsoleteEmbeddingsDeleted += Number(delOrphanEmbs.changes)

    // 4. Resync document_embedding_counts
    db.exec(`
      DELETE FROM document_embedding_counts WHERE document_id NOT IN (SELECT id FROM documents);
      DELETE FROM document_embedding_counts WHERE space_id NOT IN (SELECT id FROM embedding_spaces);
    `)

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  return {
    retiredSetsDeleted,
    orphanChunksDeleted,
    obsoleteEmbeddingsDeleted,
    ftsRowsCleaned,
  }
}

/**
 * Inspects database freelist pages and assesses vacuum readiness.
 */
export function getStorageFreelistStats(db: DatabaseSync): StorageFreelistStats {
  const pageCountRow = db.prepare('PRAGMA page_count').get() as { page_count: number }
  const freelistCountRow = db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }
  const pageSizeRow = db.prepare('PRAGMA page_size').get() as { page_size: number }

  const pageCount = Number(pageCountRow.page_count ?? 0)
  const freelistCount = Number(freelistCountRow.freelist_count ?? 0)
  const pageSize = Number(pageSizeRow.page_size ?? 4096)

  const freelistRatio = pageCount > 0 ? freelistCount / pageCount : 0
  const reclaimableBytes = freelistCount * pageSize

  const shouldVacuum =
    freelistRatio >= VACUUM_FREELIST_RATIO_THRESHOLD ||
    reclaimableBytes >= VACUUM_RECLAIMABLE_BYTES_THRESHOLD

  return {
    pageCount,
    freelistCount,
    pageSize,
    freelistRatio,
    reclaimableBytes,
    shouldVacuum,
  }
}

/**
 * Runs incremental vacuum in batches of 256 pages:
 * Runs when idle and freelist >= 15% or reclaimable >= 512MB (unless force=true).
 */
export function runIncrementalVacuum(
  db: DatabaseSync,
  options: IncrementalVacuumOptions = {},
): VacuumResult {
  const batchPages = options.batchPages ?? INCREMENTAL_VACUUM_BATCH_PAGES
  const initialStats = getStorageFreelistStats(db)

  if (!options.force && !initialStats.shouldVacuum) {
    return {
      vacuumed: false,
      initialFreelistPages: initialStats.freelistCount,
      finalFreelistPages: initialStats.freelistCount,
      pagesReclaimed: 0,
      bytesReclaimed: 0,
    }
  }

  let remaining = initialStats.freelistCount
  let pagesReclaimed = 0
  const maxPages = options.maxPages ?? Infinity

  while (remaining > 0 && pagesReclaimed < maxPages) {
    const step = Math.min(batchPages, remaining, maxPages - pagesReclaimed)
    if (step <= 0) break

    db.exec(`PRAGMA incremental_vacuum(${step});`)

    const currentStats = getStorageFreelistStats(db)
    const reclaimedInStep = remaining - currentStats.freelistCount
    if (reclaimedInStep <= 0) {
      break
    }
    pagesReclaimed += reclaimedInStep
    remaining = currentStats.freelistCount
  }

  const finalStats = getStorageFreelistStats(db)
  return {
    vacuumed: pagesReclaimed > 0,
    initialFreelistPages: initialStats.freelistCount,
    finalFreelistPages: finalStats.freelistCount,
    pagesReclaimed,
    bytesReclaimed: pagesReclaimed * initialStats.pageSize,
  }
}
