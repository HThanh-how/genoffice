import type { DatabaseSync } from 'node:sqlite'
import { runIncrementalVacuum, type VacuumResult } from '../storage-gc'

/** Upper bound of pages reclaimed per call (64 MiB at 4 KiB pages) so a huge freelist cannot freeze the thread. */
export const RETENTION_COMPACTION_MAX_PAGES = 16_384

export interface RetentionCompactionResult {
  vacuum: VacuumResult
  walTruncated: boolean
}

/**
 * Make the on-disk footprint reflect a retention batch before it is re-measured.
 *
 * Deleting rows only grows the freelist (the file keeps its size until pages are vacuumed), and in WAL mode the
 * vacuumed/deleted pages sit in the -wal file until a checkpoint truncates it. Usage counts db + wal + shm, so
 * without this the policy keeps evicting against a measurement that has not moved (over-eviction).
 *
 * Order matters: vacuum first (it writes into the WAL), then checkpoint(TRUNCATE) to shrink db and WAL.
 * Never throws: a busy checkpoint (a reader holds a snapshot) simply leaves the WAL for the next call.
 */
export function compactAfterRetentionBatch(
  db: DatabaseSync,
  options: { maxPages?: number } = {},
): RetentionCompactionResult {
  let vacuum: VacuumResult = {
    vacuumed: false,
    initialFreelistPages: 0,
    finalFreelistPages: 0,
    pagesReclaimed: 0,
    bytesReclaimed: 0,
  }
  try {
    vacuum = runIncrementalVacuum(db, { force: true, maxPages: options.maxPages ?? RETENTION_COMPACTION_MAX_PAGES })
  } catch {
    // keep going: the checkpoint below is still useful and retention must not fail on compaction
  }
  let walTruncated: boolean
  try {
    const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number } | undefined
    walTruncated = !row || Number(row.busy ?? 0) === 0
  } catch {
    walTruncated = false
  }
  return { vacuum, walTruncated }
}
