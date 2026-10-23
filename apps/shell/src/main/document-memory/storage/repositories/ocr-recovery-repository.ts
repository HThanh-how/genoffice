import type { DatabaseSync } from 'node:sqlite'

const READABLE_OCR = "length(trim(o.text, char(9) || char(10) || char(13) || ' ')) > 0"
const MATCHING_OCR =
  'o.path = d.path AND o.hash = d.hash AND o.mtime_ms = d.mtime_ms AND o.size_bytes = d.size_bytes'

/** Called inside the page-save / document-replacement transaction: either write order leaves work durable. */
export function requestCachedOcrIndexing(db: DatabaseSync, path: string): void {
  db.prepare(
    `UPDATE documents AS d SET status = 'pending', error = NULL, updated_at = unixepoch()
     WHERE d.path = ? AND d.excluded = 0 AND d.status = 'empty'
       AND EXISTS (SELECT 1 FROM ocr_pages o WHERE ${MATCHING_OCR} AND ${READABLE_OCR})`,
  ).run(path)
}

export interface OcrRecoveryPage {
  paths: string[]
  afterId: number
  done: boolean
}

/** A keyset page, run in the indexing worker. Never returns text to the main process. */
export function readOcrRecoveryPage(db: DatabaseSync, afterId: number): OcrRecoveryPage {
  const limit = 128
  const rows = db
    .prepare(
      `WITH candidates AS MATERIALIZED (
         SELECT id, path, hash, mtime_ms, size_bytes FROM documents
         WHERE id > ? AND excluded = 0 AND status = 'empty' ORDER BY id LIMIT ?
       )
       SELECT d.id, d.path,
         EXISTS (SELECT 1 FROM ocr_pages o WHERE ${MATCHING_OCR}
           GROUP BY o.path HAVING min(o.total_pages) > 0
             AND min(o.total_pages) = max(o.total_pages)
             AND count(*) = max(o.total_pages) AND min(o.page) = 1
             AND max(o.page) = max(o.total_pages)
             AND sum(CASE WHEN ${READABLE_OCR} THEN 1 ELSE 0 END) > 0) AS recoverable
       FROM candidates d ORDER BY d.id`,
    )
    .all(afterId, limit) as Array<{ id: number; path: string; recoverable: number }>
  return {
    paths: rows.filter((row) => row.recoverable === 1).map((row) => row.path),
    afterId: rows.at(-1)?.id ?? afterId,
    done: rows.length < limit,
  }
}
