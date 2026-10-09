import type { DatabaseSync } from 'node:sqlite'
import { hasSkeletonTable } from '../storage/redundancy-schema'
import { clearVectorEvictions } from '../storage/vector-eviction-marker'
import {
  VECTOR_RELEASE_MAX_DOCUMENTS,
  VECTOR_RELEASE_PROJECTED_RATIO,
  VECTOR_RELEASE_USAGE_RATIO,
  type VectorReleaseUsage,
} from './vector-eviction-release'

/**
 * Re-hydration of skeleton documents (F), the counterpart of releaseEvictedVectorsIfRoom().
 *
 * Explicit paths need no code here: retryDocument / readNowDocument / open set status 'pending' and the worker
 * re-extracts the ORIGINAL file; the new active chunk set removes the document_skeleton row by trigger.
 *
 * Automatic path: when usage is far below the retention band (same 60% / 75% rule as evicted vectors, so a
 * re-hydrated document can never push usage back over the 90% trigger), the most recently relevant skeleton
 * documents are queued for re-extraction, bounded by the regrowth recorded when they were compacted
 * (document_skeleton.dropped_bytes). No evict -> re-extract oscillation, by construction.
 */
export interface SkeletonReleaseResult {
  documents: number
  estimatedBytes: number
  paths: string[]
}

export function releaseSkeletonsIfRoom(db: DatabaseSync, usage: VectorReleaseUsage): SkeletonReleaseResult {
  const none: SkeletonReleaseResult = { documents: 0, estimatedBytes: 0, paths: [] }
  if (!hasSkeletonTable(db)) return none
  if (usage.isDegraded || (usage.measurementStatus && usage.measurementStatus !== 'fresh')) return none
  if (usage.limitState !== 'ok') return none
  if (!(usage.budgetBytes > 0) || !Number.isFinite(usage.usedBytes) || usage.usedBytes < 0) return none
  if (usage.usedBytes / usage.budgetBytes >= VECTOR_RELEASE_USAGE_RATIO) return none
  const room = usage.budgetBytes * VECTOR_RELEASE_PROJECTED_RATIO - usage.usedBytes
  if (room <= 0) return none
  const rows = db
    .prepare(
      `SELECT d.id, d.path, s.dropped_bytes AS bytes
       FROM document_skeleton s JOIN documents d ON d.id = s.document_id
       WHERE s.stage = 'skeleton' AND d.excluded = 0 AND d.status IN ('ready', 'text-only')
       ORDER BY max(d.last_opened_at, coalesce(d.mtime_ms, 0)) DESC, d.id DESC LIMIT ?`,
    )
    .all(VECTOR_RELEASE_MAX_DOCUMENTS) as Array<{ id: number; path: string; bytes: number }>
  const ids: number[] = []
  const paths: string[] = []
  let bytes = 0
  for (const r of rows) {
    if (bytes + r.bytes > room) break
    ids.push(r.id)
    paths.push(r.path)
    bytes += r.bytes
  }
  if (ids.length === 0) return none
  const ph = ids.map(() => '?').join(',')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`UPDATE documents SET status = 'pending', error = NULL WHERE id IN (${ph}) AND excluded = 0`).run(...ids)
    clearVectorEvictions(db, ids)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return { documents: ids.length, estimatedBytes: bytes, paths }
}
