/**
 * Storage for text that the scanned-PDF reader (Antigravity) transcribed, kept beside the
 * document index in the same SQLite file.
 *
 * Why a side table instead of writing chunks directly: the normal pipeline owns chunks, vectors,
 * the per-document counters and their triggers. OCR text is therefore only *stored* here, keyed
 * by path and file hash; the index worker's extraction step turns it into chunks (see
 * `extractDocument` in worker.ts) and the usual replace/embed queue does the rest. A re-extraction
 * (file edited, retry, "clear index" and re-scan) can never lose or double the OCR text, and the
 * counters stay exact because only the existing writers touch `chunks`.
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { capChunks, chunkDocumentText, type DocumentChunk } from './chunks'

export const OCR_LOCATION_PREFIX = 'OCR page '

/** True for chunks that came from OCR (their location is `OCR page N`). */
export function isOcrLocation(location: string): boolean {
  return location.startsWith(OCR_LOCATION_PREFIX)
}

export const OCR_SCHEMA = `
CREATE TABLE IF NOT EXISTS ocr_pages (
  path TEXT NOT NULL,
  page INTEGER NOT NULL,
  hash TEXT NOT NULL,
  mtime_ms REAL NOT NULL,
  size_bytes INTEGER NOT NULL,
  total_pages INTEGER NOT NULL,
  text TEXT NOT NULL,
  model TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (path, page)
) WITHOUT ROWID;
`

export interface OcrPageText {
  page: number
  text: string
}

export interface OcrFileMeta {
  /** SHA-256 of the PDF bytes that were read */
  hash: string
  mtimeMs: number
  sizeBytes: number
  totalPages: number
  model?: string | undefined
}

export interface OcrStoredPages {
  totalPages: number
  pages: OcrPageText[]
}

export interface OcrDocRow {
  id: number
  path: string
  sizeBytes: number
  mtimeMs: number
  lastOpenedAt: number
  /** pages already transcribed for the file as it is now */
  pagesDone: number
  /** known after the first render */
  totalPages?: number
}

/** Look up stored OCR pages of the file with this content hash (worker side). */
export type OcrLookup = (path: string, hash: string) => OcrStoredPages | null

/**
 * The hash a document with OCR text carries in the index. It changes whenever pages are added,
 * so the manager's "same hash = vectors can be resumed" shortcut never skips new OCR text.
 */
export function ocrDocumentHash(fileHash: string, pages: readonly OcrPageText[]): string {
  const h = createHash('sha256').update(fileHash).update('|ocr|')
  for (const page of pages) h.update(`${page.page}:${page.text.length}:`).update(page.text)
  return h.digest('hex')
}

/** Chunks (location `OCR page N`) from stored pages; `truncated` when pages or chunks were left out. */
export function ocrChunksFromPages(stored: OcrStoredPages): {
  chunks: DocumentChunk[]
  truncated: boolean
} {
  const chunks: DocumentChunk[] = []
  for (const page of stored.pages) {
    const parts = chunkDocumentText(page.text)
    parts.forEach((part, index) =>
      chunks.push({
        text: part.text,
        location: `${OCR_LOCATION_PREFIX}${page.page}${parts.length > 1 ? ` (${index + 1}/${parts.length})` : ''}`,
      }),
    )
  }
  const capped = capChunks(chunks)
  return {
    chunks: capped.chunks,
    truncated: capped.truncated || stored.pages.length < stored.totalPages,
  }
}

/** All OCR SQL. Works on whatever connection the document store already has open. */
export class OcrSidecar {
  constructor(private readonly db: DatabaseSync) {}

  static ensureSchema(db: DatabaseSync): void {
    db.exec(OCR_SCHEMA)
  }

  /** Store transcribed pages; rows of an older version of the file are dropped first. */
  savePages(path: string, meta: OcrFileMeta, pages: readonly OcrPageText[]): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM ocr_pages WHERE path = ? AND hash <> ?').run(path, meta.hash)
      const upsert = this.db.prepare(
        `INSERT INTO ocr_pages(path, page, hash, mtime_ms, size_bytes, total_pages, text, model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path, page) DO UPDATE SET hash = excluded.hash, mtime_ms = excluded.mtime_ms,
          size_bytes = excluded.size_bytes, total_pages = excluded.total_pages,
          text = excluded.text, model = excluded.model, created_at = unixepoch()`,
      )
      for (const page of pages)
        upsert.run(
          path,
          page.page,
          meta.hash,
          meta.mtimeMs,
          meta.sizeBytes,
          meta.totalPages,
          page.text,
          meta.model ?? null,
        )
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Stored pages of the file with this content hash, in page order; null when there are none. */
  pages(path: string, hash: string): OcrStoredPages | null {
    const rows = this.db
      .prepare(
        'SELECT page, text, total_pages FROM ocr_pages WHERE path = ? AND hash = ? ORDER BY page',
      )
      .all(path, hash) as unknown as Array<{ page: number; text: string; total_pages: number }>
    if (!rows.length) return null
    return {
      totalPages: Math.max(...rows.map((row) => row.total_pages)),
      pages: rows.map((row) => ({ page: row.page, text: row.text })),
    }
  }

  /** Page numbers already transcribed for the file as it is on disk now (mtime + size). */
  pagesDone(path: string, mtimeMs: number, sizeBytes: number): number[] {
    return (
      this.db
        .prepare(
          'SELECT page FROM ocr_pages WHERE path = ? AND mtime_ms = ? AND size_bytes = ? ORDER BY page',
        )
        .all(path, mtimeMs, sizeBytes) as unknown as Array<{ page: number }>
    ).map((row) => row.page)
  }

  remove(path: string): void {
    this.db.prepare('DELETE FROM ocr_pages WHERE path = ?').run(path)
  }

  rename(oldPath: string, newPath: string): void {
    this.db.prepare('DELETE FROM ocr_pages WHERE path = ?').run(newPath)
    this.db.prepare('UPDATE ocr_pages SET path = ? WHERE path = ?').run(newPath, oldPath)
  }

  clearAll(): void {
    this.db.exec('DELETE FROM ocr_pages')
  }

  /**
   * Scanned PDFs that still have pages to read: `empty` documents whose only problem is "no
   * readable text", plus partly read ones whose limit was raised. A file whose pages up to the
   * limit are all read is not a candidate (even if the pages turned out blank).
   */
  candidates(maxPagesPerFile: number): OcrDocRow[] {
    const same = 'o.path = d.path AND o.mtime_ms = d.mtime_ms AND o.size_bytes = d.size_bytes'
    const rows = this.db
      .prepare(
        `SELECT d.id, d.path, coalesce(d.size_bytes, 0) AS size_bytes, coalesce(d.mtime_ms, 0) AS mtime_ms,
          d.last_opened_at,
          (SELECT count(*) FROM ocr_pages o WHERE ${same}) AS done,
          (SELECT max(o.total_pages) FROM ocr_pages o WHERE ${same}) AS total
        FROM documents d
        WHERE d.excluded = 0 AND lower(d.path) LIKE '%.pdf' AND (
          (d.status = 'empty' AND d.error LIKE 'No readable text%')
          OR (d.status IN ('pending', 'text-only', 'ready') AND d.truncated = 1
              AND EXISTS (SELECT 1 FROM ocr_pages o WHERE o.path = d.path)))
        ORDER BY d.priority_at DESC, d.id DESC`,
      )
      .all() as unknown as Array<{
      id: number
      path: string
      size_bytes: number
      mtime_ms: number
      last_opened_at: number
      done: number
      total: number | null
    }>
    const out: OcrDocRow[] = []
    for (const row of rows) {
      if (row.total !== null && Math.min(row.total, maxPagesPerFile) - row.done <= 0) continue
      out.push({
        id: row.id,
        path: row.path,
        sizeBytes: row.size_bytes,
        mtimeMs: row.mtime_ms,
        lastOpenedAt: row.last_opened_at,
        pagesDone: row.done,
        ...(row.total !== null ? { totalPages: row.total } : {}),
      })
    }
    return out
  }
}
