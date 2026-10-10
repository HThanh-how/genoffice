import type { DatabaseSync } from 'node:sqlite'

export const DOCUMENT_MEDIA_MIGRATION_ID = '20261009_document_media'

/**
 * Additive, idempotent: images and videos are ordinary `documents` rows (identity: path, name, mtime,
 * size; status 'ready', no chunks) plus ONE compact side row here. The side table keeps the hot
 * `documents` table and every document query untouched; `ON DELETE CASCADE` removes the metadata with
 * the document (tombstone, clear, exclude-by-delete).
 *
 *  - kind          'image' | 'video'
 *  - container     png / jpeg / mp4 / mkv ... (from the header, else the extension)
 *  - ts_ms         date used for date search: taken_ms (EXIF / container creation) else file mtime
 *  - meta_state    0 header not read yet (the only state that is ever polled), 1 read, 2 unreadable
 *  - sensitive     name/path suggests identity / legal / credential papers: never sent off device
 *  - ocr_candidate image a later local light-OCR package may read
 *  - ocr_state     0 never attempted; owned by the OCR package (hook, not used here)
 */
export const DOCUMENT_MEDIA_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS document_media (
  document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  container TEXT,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  taken_ms INTEGER,
  ts_ms INTEGER NOT NULL DEFAULT 0,
  meta_state INTEGER NOT NULL DEFAULT 0,
  sensitive INTEGER NOT NULL DEFAULT 0,
  ocr_candidate INTEGER NOT NULL DEFAULT 0,
  ocr_state INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS document_media_kind_ts ON document_media(kind, ts_ms);
CREATE INDEX IF NOT EXISTS document_media_ts ON document_media(ts_ms);
CREATE INDEX IF NOT EXISTS document_media_pending ON document_media(document_id) WHERE meta_state = 0;
`

export function ensureDocumentMediaSchema(db: DatabaseSync): void {
  db.exec(DOCUMENT_MEDIA_SCHEMA_SQL)
  try {
    db.prepare(
      'INSERT INTO schema_migrations (id, applied_at) VALUES (?, unixepoch()) ON CONFLICT(id) DO NOTHING',
    ).run(DOCUMENT_MEDIA_MIGRATION_ID)
  } catch {
    // schema_migrations is bookkeeping only
  }
}
