import type { DatabaseSync } from 'node:sqlite'
import { basename, resolve } from 'node:path'
import { MIN_IMAGE_BYTES, mediaKindOfPath } from './media-kinds'
import {
  buildDocumentProjection,
  estimateDocumentProjectionBytes,
  estimateNewDocumentMetadataBytes,
  isProjectionUpToDate,
  syncProjectionInsert,
} from '../name-search-projection'
import type { SyncMetadataGuard } from '../runtime/sync-metadata-admission'
import { cached } from './media-repository'
import { isSensitiveName } from './sensitive-names'

export type MediaEnrollOutcome =
  | 'created' // a new row
  | 'updated' // the file changed (mtime/size): header will be re-read
  | 'unchanged' // known row, same mtime and size: nothing written
  | 'refused' // storage admission said no (see `error`)
  | 'skipped' // not media, or an image below the noise floor
  | 'excluded' // the user excluded this path

export interface MediaEnrollResult {
  outcome: MediaEnrollOutcome
  error?: string
}

interface ExistingRow {
  id: number
  status: string
  excluded: number
  mtime_ms: number | null
  size_bytes: number | null
  media_id: number | null
}

/**
 * Enroll one image/video from a metadata-only listing: identity (path, name, mtime, size) + the
 * compact media side row + the same name projection documents get. No file is opened.
 *
 * Status is 'ready' on purpose: the existing counters then treat it as finished work (done in totals,
 * never `pending`, never in `incompletePaths()`, never queued for extraction) and `documents.mtime_ms/
 * size_bytes` are set at enrollment, so an unchanged file is a no-op and only a changed one is touched.
 * `priority_at` stays 0: media never rank among the recent / priority documents.
 *
 * Admission uses the existing sync-metadata guard with `lowPriority`: media is admitted only below the
 * cache-retention high watermark (90% of the soft quota), so it can neither trigger compaction of document
 * content nor eat the grace zone up to the hard cap, which stays reserved for documents.
 */
export function enrollMediaRow(
  db: DatabaseSync,
  guard: SyncMetadataGuard | null,
  path: string,
  mtimeMs: number,
  sizeBytes: number,
): MediaEnrollResult {
  const kind = mediaKindOfPath(path)
  if (!kind) return { outcome: 'skipped' }
  const normalized = resolve(path)
  const name = basename(normalized)
  const lookup = cached(
    db,
    `SELECT d.id AS id, d.status AS status, d.excluded AS excluded, d.mtime_ms AS mtime_ms,
            d.size_bytes AS size_bytes, m.document_id AS media_id
     FROM documents d LEFT JOIN document_media m ON m.document_id = d.id WHERE d.path = ?`,
  )
  const peek = lookup.get(normalized) as unknown as ExistingRow | undefined
  if (peek && (peek.excluded === 1 || peek.status === 'excluded')) return { outcome: 'excluded' }
  if (peek?.media_id != null && peek.mtime_ms === mtimeMs && peek.size_bytes === sizeBytes) return { outcome: 'unchanged' }
  if (!peek && kind === 'image' && sizeBytes < MIN_IMAGE_BYTES) return { outcome: 'skipped' }

  let reservationId: string | undefined
  let ownerToken: string | undefined
  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = lookup.get(normalized) as unknown as ExistingRow | undefined
    if (existing && (existing.excluded === 1 || existing.status === 'excluded')) {
      db.exec('COMMIT')
      return { outcome: 'excluded' }
    }
    const projection = buildDocumentProjection(name, normalized)
    const projectionCurrent = existing ? isProjectionUpToDate(db, existing.id, projection) : false
    if (guard && (!existing || !projectionCurrent)) {
      const bytes = existing
        ? estimateDocumentProjectionBytes(name, normalized)
        : estimateNewDocumentMetadataBytes(name, normalized)
      const decision = guard.canAdmitNewDocument({ name, path: normalized, lowPriority: true }, bytes)
      if (!decision.admitted) {
        db.exec('ROLLBACK')
        return { outcome: 'refused', error: decision.error ?? decision.reason }
      }
      reservationId = decision.reservationId
      ownerToken = decision.ownerToken
    }

    let id: number
    let outcome: MediaEnrollOutcome
    if (existing) {
      id = existing.id
      // A path that earlier failed as an "unreadable document" becomes a normal finished media row.
      cached(
        db,
        `UPDATE documents SET mtime_ms = ?, size_bytes = ?, status = 'ready', error = NULL, hash = NULL,
           embedding_model = NULL, priority_at = 0, updated_at = unixepoch() WHERE id = ?`,
      ).run(mtimeMs, sizeBytes, id)
      outcome = existing.media_id == null ? 'created' : 'updated'
    } else {
      const inserted = cached(
        db,
        `INSERT INTO documents(path, name, status, mtime_ms, size_bytes, last_opened_at, priority_at, chunk_counted)
         VALUES (?, ?, 'ready', ?, ?, 0, 0, 1)`,
      ).run(normalized, name, mtimeMs, sizeBytes)
      id = Number(inserted.lastInsertRowid)
      outcome = 'created'
    }
    // Reset on every (re)enroll: facts of the previous file contents must not survive a change.
    cached(
      db,
      `INSERT INTO document_media(document_id, kind, ts_ms, sensitive, ocr_candidate)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(document_id) DO UPDATE SET kind = excluded.kind, container = NULL, width = NULL,
         height = NULL, duration_ms = NULL, taken_ms = NULL, ts_ms = excluded.ts_ms, meta_state = 0,
         sensitive = excluded.sensitive, ocr_candidate = excluded.ocr_candidate, ocr_state = 0`,
    ).run(id, kind, Math.round(mtimeMs), isSensitiveName(name, normalized) ? 1 : 0, kind === 'image' ? 1 : 0)
    if (!existing || !projectionCurrent) {
      syncProjectionInsert(db, { id, path: normalized, name }, guard ?? undefined)
    }
    db.exec('COMMIT')
    if (guard && reservationId && ownerToken) guard.settleCommit(reservationId, ownerToken)
    return { outcome }
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // already rolled back
    }
    if (guard && reservationId && ownerToken) guard.rollbackCommit(reservationId, ownerToken)
    throw error
  }
}
