import type { DatabaseSync, StatementSync } from 'node:sqlite'
import {
  MEDIA_META_PENDING,
  MEDIA_META_READ,
  MEDIA_META_UNREADABLE,
  type MediaHitInfo,
  type MediaKind,
  type MediaMetadata,
} from './media-types'

interface MediaRow {
  document_id: number
  kind: MediaKind
  container: string | null
  width: number | null
  height: number | null
  duration_ms: number | null
  taken_ms: number | null
  ocr_candidate: number
  sensitive: number
}

export function toMediaHitInfo(row: MediaRow): MediaHitInfo {
  return {
    kind: row.kind,
    container: row.container,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    takenMs: row.taken_ms,
    ocrCandidate: row.ocr_candidate === 1,
    sensitive: row.sensitive === 1,
  }
}

const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>()

/** Prepared statements live as long as their connection (enrolling 100k files must not re-parse SQL per file). */
export function cached(db: DatabaseSync, sql: string): StatementSync {
  let perDb = statements.get(db)
  if (!perDb) statements.set(db, (perDb = new Map()))
  let statement = perDb.get(sql)
  if (!statement) perDb.set(sql, (statement = db.prepare(sql)))
  return statement
}

/** Media facts for a set of document ids (one query). Ids that are not media are absent from the map. */
export function mediaInfoFor(db: DatabaseSync, ids: readonly number[]): Map<number, MediaHitInfo> {
  const out = new Map<number, MediaHitInfo>()
  const unique = [...new Set(ids)].slice(0, 200)
  if (!unique.length) return out
  const rows = db
    .prepare(
      `SELECT document_id, kind, container, width, height, duration_ms, taken_ms, ocr_candidate, sensitive
       FROM document_media WHERE document_id IN (${unique.map(() => '?').join(',')})`,
    )
    .all(...unique) as unknown as MediaRow[]
  for (const row of rows) out.set(row.document_id, toMediaHitInfo(row))
  return out
}

export function isMediaDocument(db: DatabaseSync, documentId: number): boolean {
  return cached(db, 'SELECT 1 FROM document_media WHERE document_id = ?').get(documentId) !== undefined
}

export interface PendingMedia {
  id: number
  path: string
  kind: MediaKind
  mtimeMs: number | null
}

/** Rows whose header has not been read yet: the only media rows background work ever looks at. */
export function pendingMediaBatch(db: DatabaseSync, limit: number): PendingMedia[] {
  return cached(
    db,
    `SELECT m.document_id AS id, d.path AS path, m.kind AS kind, d.mtime_ms AS mtimeMs
     FROM document_media m JOIN documents d ON d.id = m.document_id
     WHERE m.meta_state = ${MEDIA_META_PENDING} AND d.excluded = 0
     ORDER BY m.document_id LIMIT ?`,
  ).all(limit) as unknown as PendingMedia[]
}

/**
 * Store the header facts of one row. `expectedMtimeMs` guards against the file having changed since it
 * was read (a re-enroll resets the row to pending and the stale facts must not win). `meta === null`
 * marks the row unreadable: it keeps its name/date search and is not polled again until it changes.
 */
export function saveMediaMetadata(
  db: DatabaseSync,
  id: number,
  expectedMtimeMs: number | null,
  meta: MediaMetadata | null,
): boolean {
  const result = cached(
    db,
    `UPDATE document_media SET container = coalesce(?, container), width = ?, height = ?, duration_ms = ?,
       taken_ms = ?, ts_ms = coalesce(?, ts_ms), meta_state = ?
     WHERE document_id = ? AND meta_state = ${MEDIA_META_PENDING}
       AND EXISTS (SELECT 1 FROM documents d WHERE d.id = document_media.document_id AND d.mtime_ms IS ?)`,
  ).run(
    meta?.container ?? null,
    meta?.width ?? null,
    meta?.height ?? null,
    meta?.durationMs ?? null,
    meta?.takenMs ?? null,
    meta?.takenMs ?? null,
    meta ? MEDIA_META_READ : MEDIA_META_UNREADABLE,
    id,
    expectedMtimeMs,
  )
  return Number(result.changes) > 0
}

export interface MediaCounts {
  images: number
  videos: number
  pendingMetadata: number
  ocrCandidates: number
  sensitive: number
}

export function mediaCounts(db: DatabaseSync): MediaCounts {
  const row = db
    .prepare(
      `SELECT coalesce(sum(kind = 'image'), 0) AS images, coalesce(sum(kind = 'video'), 0) AS videos,
              coalesce(sum(meta_state = ${MEDIA_META_PENDING}), 0) AS pendingMetadata,
              coalesce(sum(ocr_candidate = 1 AND ocr_state = 0), 0) AS ocrCandidates,
              coalesce(sum(sensitive = 1), 0) AS sensitive
       FROM document_media`,
    )
    .get() as unknown as MediaCounts
  return row
}
