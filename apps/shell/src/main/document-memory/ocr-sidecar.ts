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
import { basename } from 'node:path'
import { capChunks, chunkDocumentText, type DocumentChunk } from './chunks'
import { isSensitiveName } from './media/sensitive-names'

/** Failed local attempts (same file version) after which the local pass stops trying a file. */
export const LOCAL_OCR_MAX_ATTEMPTS = 3

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
  -- quality tier (additive; NULL / 'cloud' = read by the cloud reader or an old row)
  engine TEXT,
  quality REAL,
  tier TEXT,
  escalate INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (path, page)
) WITHOUT ROWID;
-- local-OCR attempts that failed, so a broken file is not retried at every start
CREATE TABLE IF NOT EXISTS ocr_local_failures (
  path TEXT PRIMARY KEY,
  mtime_ms REAL NOT NULL,
  size_bytes INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  code TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
) WITHOUT ROWID;
-- which pages of a PDF have no text layer of their own (written by the index worker's result)
CREATE TABLE IF NOT EXISTS pdf_scan_info (
  path TEXT PRIMARY KEY,
  mtime_ms REAL NOT NULL,
  size_bytes INTEGER NOT NULL,
  total_pages INTEGER NOT NULL,
  scanned TEXT NOT NULL
) WITHOUT ROWID;
`

export interface OcrPageText {
  page: number
  text: string
}

/**
 * Who read the pages. 'cloud' (default, and what every row written before this column existed is)
 * counts as done for the cloud pass. A 'local' row counts as done too, unless the local engine's
 * verdict was "escalate": then the cloud reader still wants that page and its text replaces ours.
 */
export type OcrTier = 'local' | 'cloud'

export interface OcrFileMeta {
  /** SHA-256 of the PDF bytes that were read */
  hash: string
  mtimeMs: number
  sizeBytes: number
  totalPages: number
  model?: string | undefined
  tier?: OcrTier | undefined
  /** local tier: engine id and its score S (0..1) for the pages in this call */
  engine?: string | undefined
  quality?: number | undefined
  /** local tier: the pages in this call should be re-read by the cloud reader */
  escalate?: boolean | undefined
}

/** Which list `candidates` builds. */
export type OcrCandidateMode =
  /** cloud reader, automatic: files the local pass handled only offer their escalated pages */
  | 'cloud'
  /** cloud reader, person asked for the file: every page that is not already good */
  | 'cloud-all'
  /** local light pass: the first pages that have no row yet, sensitive files included */
  | 'local'

export interface OcrCandidateOptions {
  includeSensitive?: boolean
  mode?: OcrCandidateMode
  /**
   * Cloud modes: leave files that have no OCR row and no failed local attempt to the local pass,
   * which has not reached them yet (set only while a local engine can actually run).
   */
  leaveToLocal?: boolean
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
  /** pages that already have a text layer: never sent to OCR (mixed PDFs) */
  skipPages?: number[]
}

/** Result of the local text pass over a PDF: which pages have no text and need OCR. */
export interface PdfScanInfo {
  totalPages: number
  scannedPages: number[]
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

function parseScanned(value: string | null): number[] | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((p) => Number.isInteger(p))
      ? (parsed as number[])
      : null
  } catch {
    return null
  }
}

/** All OCR SQL. Works on whatever connection the document store already has open. */
export class OcrSidecar {
  constructor(private readonly db: DatabaseSync) {}

  static ensureSchema(db: DatabaseSync): void {
    db.exec(OCR_SCHEMA)
    // databases created before the quality tier existed get the columns added in place
    const have = new Set(
      (db.prepare('PRAGMA table_info(ocr_pages)').all() as unknown as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    )
    for (const [name, definition] of [
      ['engine', 'TEXT'],
      ['quality', 'REAL'],
      ['tier', 'TEXT'],
      ['escalate', 'INTEGER NOT NULL DEFAULT 0'],
    ] as const)
      if (!have.has(name)) db.exec(`ALTER TABLE ocr_pages ADD COLUMN ${name} ${definition}`)
  }

  /** Store transcribed pages; rows of an older version of the file are dropped first. */
  savePages(path: string, meta: OcrFileMeta, pages: readonly OcrPageText[]): void {
    if (!path || typeof path !== 'string' || !Array.isArray(pages) || pages.length === 0) return
    if (!meta || typeof meta.hash !== 'string' || !Number.isFinite(meta.mtimeMs) || !Number.isSafeInteger(meta.sizeBytes)) return

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM ocr_pages WHERE path = ? AND hash <> ?').run(path, meta.hash)
      const tier: OcrTier = meta.tier === 'local' ? 'local' : 'cloud'
      // a local read never overwrites a page the cloud reader already transcribed; cloud text always wins
      const upsert = this.db.prepare(
        `INSERT INTO ocr_pages(path, page, hash, mtime_ms, size_bytes, total_pages, text, model, engine, quality, tier, escalate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path, page) DO UPDATE SET hash = excluded.hash, mtime_ms = excluded.mtime_ms,
          size_bytes = excluded.size_bytes, total_pages = excluded.total_pages,
          text = excluded.text, model = excluded.model, engine = excluded.engine,
          quality = excluded.quality, tier = excluded.tier, escalate = excluded.escalate,
          created_at = unixepoch()
        WHERE excluded.tier = 'cloud' OR coalesce(ocr_pages.tier, 'cloud') = 'local'
          OR ocr_pages.hash <> excluded.hash`,
      )
      for (const page of pages) {
        if (!page || typeof page.page !== 'number' || !Number.isSafeInteger(page.page) || page.page < 1) continue
        const text = typeof page.text === 'string' ? page.text.slice(0, 32_768) : ''
        upsert.run(
          path,
          page.page,
          meta.hash,
          meta.mtimeMs,
          meta.sizeBytes,
          meta.totalPages,
          text,
          meta.model ?? null,
          tier === 'local' ? (meta.engine ?? null) : null,
          tier === 'local' && Number.isFinite(meta.quality) ? (meta.quality as number) : null,
          tier,
          tier === 'local' && meta.escalate === true ? 1 : 0,
        )
      }
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

  /**
   * Page numbers that are DONE for the cloud pass, for the file as it is on disk now (mtime + size):
   * cloud rows, old rows, and local rows the local engine was satisfied with. A local row whose
   * verdict was "escalate" is not done: the cloud reader still wants that page.
   */
  pagesDone(path: string, mtimeMs: number, sizeBytes: number): number[] {
    return (
      this.db
        .prepare(
          `SELECT page FROM ocr_pages WHERE path = ? AND mtime_ms = ? AND size_bytes = ?
             AND NOT (tier = 'local' AND escalate = 1) ORDER BY page`,
        )
        .all(path, mtimeMs, sizeBytes) as unknown as Array<{ page: number }>
    ).map((row) => row.page)
  }

  /** Every page that has a row of any tier (the local pass never redoes a page that has one). */
  pagesPresent(path: string, mtimeMs: number, sizeBytes: number): number[] {
    return (
      this.db
        .prepare('SELECT page FROM ocr_pages WHERE path = ? AND mtime_ms = ? AND size_bytes = ? ORDER BY page')
        .all(path, mtimeMs, sizeBytes) as unknown as Array<{ page: number }>
    ).map((row) => row.page)
  }

  /** Pages the local engine read but was not satisfied with (still waiting for the cloud reader). */
  escalatedPages(path: string, mtimeMs: number, sizeBytes: number): number[] {
    return (
      this.db
        .prepare(
          `SELECT page FROM ocr_pages WHERE path = ? AND mtime_ms = ? AND size_bytes = ?
             AND tier = 'local' AND escalate = 1 ORDER BY page`,
        )
        .all(path, mtimeMs, sizeBytes) as unknown as Array<{ page: number }>
    ).map((row) => row.page)
  }

  /** Quality tier of one stored page (null when there is no row). Diagnostics and tests. */
  pageTier(
    path: string,
    page: number,
  ): { tier: OcrTier; engine: string | null; quality: number | null; escalate: boolean } | null {
    const row = this.db
      .prepare('SELECT tier, engine, quality, escalate FROM ocr_pages WHERE path = ? AND page = ?')
      .get(path, page) as
      | { tier: string | null; engine: string | null; quality: number | null; escalate: number }
      | undefined
    return row
      ? {
          tier: row.tier === 'local' ? 'local' : 'cloud',
          engine: row.engine,
          quality: row.quality,
          escalate: row.escalate === 1,
        }
      : null
  }

  /** A local attempt on this file version failed; after `LOCAL_OCR_MAX_ATTEMPTS` it is left alone. */
  recordLocalFailure(
    path: string,
    meta: { mtimeMs: number; sizeBytes: number },
    code: string,
    permanent = false,
  ): void {
    this.db
      .prepare(
        `INSERT INTO ocr_local_failures(path, mtime_ms, size_bytes, attempts, code) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           attempts = CASE WHEN ocr_local_failures.mtime_ms = excluded.mtime_ms
                            AND ocr_local_failures.size_bytes = excluded.size_bytes
                           THEN min(ocr_local_failures.attempts + excluded.attempts, ${LOCAL_OCR_MAX_ATTEMPTS})
                           ELSE excluded.attempts END,
           mtime_ms = excluded.mtime_ms, size_bytes = excluded.size_bytes, code = excluded.code,
           updated_at = unixepoch()`,
      )
      .run(path, meta.mtimeMs, meta.sizeBytes, permanent ? LOCAL_OCR_MAX_ATTEMPTS : 1, code)
  }

  localFailure(
    path: string,
  ): { attempts: number; code: string; mtimeMs: number; sizeBytes: number } | null {
    const row = this.db
      .prepare('SELECT attempts, code, mtime_ms, size_bytes FROM ocr_local_failures WHERE path = ?')
      .get(path) as { attempts: number; code: string; mtime_ms: number; size_bytes: number } | undefined
    return row
      ? { attempts: row.attempts, code: row.code, mtimeMs: row.mtime_ms, sizeBytes: row.size_bytes }
      : null
  }

  /** Remember (or forget, when `info` is null) which pages of the file lack a text layer. */
  saveScanInfo(
    path: string,
    meta: { mtimeMs: number; sizeBytes: number },
    info: PdfScanInfo | null,
  ): void {
    if (!info || info.scannedPages.length === 0) {
      this.db.prepare('DELETE FROM pdf_scan_info WHERE path = ?').run(path)
      return
    }
    this.db
      .prepare(
        `INSERT INTO pdf_scan_info(path, mtime_ms, size_bytes, total_pages, scanned) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size_bytes = excluded.size_bytes,
          total_pages = excluded.total_pages, scanned = excluded.scanned`,
      )
      .run(path, meta.mtimeMs, meta.sizeBytes, info.totalPages, JSON.stringify(info.scannedPages))
  }

  remove(path: string): void {
    this.db.prepare('DELETE FROM ocr_pages WHERE path = ?').run(path)
    this.db.prepare('DELETE FROM pdf_scan_info WHERE path = ?').run(path)
    this.db.prepare('DELETE FROM ocr_local_failures WHERE path = ?').run(path)
  }

  evictOcrPages(path: string): number {
    const res = this.db.prepare('DELETE FROM ocr_pages WHERE path = ?').run(path)
    return Number(res.changes)
  }

  rename(oldPath: string, newPath: string): void {
    this.db.prepare('DELETE FROM ocr_pages WHERE path = ?').run(newPath)
    this.db.prepare('UPDATE ocr_pages SET path = ? WHERE path = ?').run(newPath, oldPath)
    this.db.prepare('DELETE FROM pdf_scan_info WHERE path = ?').run(newPath)
    this.db.prepare('UPDATE pdf_scan_info SET path = ? WHERE path = ?').run(newPath, oldPath)
    this.db.prepare('DELETE FROM ocr_local_failures WHERE path = ?').run(newPath)
    this.db.prepare('UPDATE ocr_local_failures SET path = ? WHERE path = ?').run(newPath, oldPath)
  }

  clearAll(): void {
    this.db.exec('DELETE FROM ocr_pages')
    this.db.exec('DELETE FROM pdf_scan_info')
    this.db.exec('DELETE FROM ocr_local_failures')
  }

  /**
   * Scanned PDFs that still have pages to read. Media rows (images, video) are never in this list:
   * images are read by the local pass through `selectImageOcrCandidates` (media/media-ocr-gate.ts),
   * which is local-only unless the user opted in.
   *
   * `mode` (default 'cloud') says who asks:
   *  - 'cloud': the Antigravity reader. Sensitive documents are left out unless `includeSensitive`.
   *    A file the local pass already read offers ONLY the pages the local engine escalated (every
   *    other page is reported as `skipPages`), whatever the document status has become since.
   *  - 'cloud-all': the same for a read the person asked for: all pages that are not already good.
   *  - 'local': the light pass, `maxPagesPerFile` = the number of leading pages to read. A page that
   *    has a row of any tier is done. Sensitive documents ARE included: they never leave the device.
   *
   * A file whose pages up to the limit are all read is not a candidate (even if they were blank).
   */
  candidates(maxPagesPerFile: number, options: OcrCandidateOptions = {}): OcrDocRow[] {
    const mode: OcrCandidateMode = options.mode ?? 'cloud'
    const local = mode === 'local'
    const same = 'o.path = d.path AND o.mtime_ms = d.mtime_ms AND o.size_bytes = d.size_bytes'
    const scanSame = 's.path = d.path AND s.mtime_ms = d.mtime_ms AND s.size_bytes = d.size_bytes'
    // pages that count as read for the asker: the cloud does not count escalated local rows
    const doneFilter = local ? '' : "AND NOT (o.tier = 'local' AND o.escalate = 1)"
    // Media rows are never OCR work here (a bare database without the media table has none).
    const hasMedia = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'document_media'").get()
    const notMedia = hasMedia ? 'AND NOT EXISTS (SELECT 1 FROM document_media dm WHERE dm.document_id = d.id)' : ''
    // a file with escalated local pages is cloud work whatever its status became after the local text arrived
    const escalatedBranch =
      mode === 'cloud'
        ? `OR EXISTS (SELECT 1 FROM ocr_pages o WHERE ${same} AND o.tier = 'local' AND o.escalate = 1)`
        : ''
    const rows = this.db
      .prepare(
        `SELECT d.id, d.path, coalesce(d.size_bytes, 0) AS size_bytes, coalesce(d.mtime_ms, 0) AS mtime_ms,
          d.last_opened_at,
          (SELECT count(*) FROM ocr_pages o WHERE ${same} ${doneFilter}) AS done,
          (SELECT max(o.total_pages) FROM ocr_pages o WHERE ${same}) AS total,
          (SELECT count(*) FROM ocr_pages o WHERE ${same} AND o.tier = 'local') AS local_rows,
          (SELECT s.total_pages FROM pdf_scan_info s WHERE ${scanSame}) AS scan_total,
          (SELECT s.scanned FROM pdf_scan_info s WHERE ${scanSame}) AS scan_pages,
          (SELECT f.attempts FROM ocr_local_failures f
            WHERE f.path = d.path AND f.mtime_ms = d.mtime_ms AND f.size_bytes = d.size_bytes) AS failed_attempts
        FROM documents d
        WHERE d.excluded = 0 AND lower(d.path) LIKE '%.pdf'
          ${notMedia} AND (
          (d.status = 'empty' AND d.error LIKE 'No readable text%')
          OR (d.status IN ('pending', 'text-only', 'ready') AND d.truncated = 1
              AND EXISTS (SELECT 1 FROM ocr_pages o WHERE o.path = d.path))
          OR (d.status IN ('text-only', 'ready')
              AND EXISTS (SELECT 1 FROM pdf_scan_info s WHERE ${scanSame}))
          ${escalatedBranch})
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
      local_rows: number
      scan_total: number | null
      scan_pages: string | null
      failed_attempts: number | null
    }>
    const escalatedOf = this.db.prepare(
      `SELECT o.page FROM ocr_pages o WHERE o.path = ? AND o.mtime_ms = ? AND o.size_bytes = ?
         AND o.tier = 'local' AND o.escalate = 1 ORDER BY o.page`,
    )
    const out: OcrDocRow[] = []
    for (const row of rows) {
      // The cloud lists feed Antigravity: pages of identity / legal / credential papers
      // (cccd, passport, sổ hộ khẩu ...) are never sent unless the caller explicitly opts in.
      // The local pass reads them too (on this device only).
      if (!local && !options.includeSensitive && isSensitiveName(basename(row.path), row.path)) continue
      if (local && (row.failed_attempts ?? 0) >= LOCAL_OCR_MAX_ATTEMPTS) continue
      const base = {
        id: row.id,
        path: row.path,
        sizeBytes: row.size_bytes,
        mtimeMs: row.mtime_ms,
        lastOpenedAt: row.last_opened_at,
      }
      if (!local && options.leaveToLocal && row.done === 0 && row.local_rows === 0 && row.failed_attempts === null)
        continue // the local pass has not reached this file yet
      if (mode === 'cloud' && row.local_rows > 0) {
        // the local pass handled this file: the cloud reader only gets the pages it escalated
        const wanted = (escalatedOf.all(row.path, row.mtime_ms, row.size_bytes) as unknown as Array<{ page: number }>)
          .map((r) => r.page)
          .filter((page) => page <= maxPagesPerFile)
        if (wanted.length === 0) continue
        const total = Math.max(row.total ?? 0, row.scan_total ?? 0, ...wanted)
        const wantedSet = new Set(wanted)
        const skipPages: number[] = []
        for (let page = 1; page <= total; page++) if (!wantedSet.has(page)) skipPages.push(page)
        out.push({
          ...base,
          pagesDone: Math.max(0, Math.min(total, maxPagesPerFile) - wanted.length),
          totalPages: total,
          skipPages,
        })
        continue
      }
      const scanned = parseScanned(row.scan_pages)
      if (scanned && row.scan_total !== null) {
        // A PDF with a text layer on some pages: only the pages without text are OCR work.
        const done = new Set(this.pagesDoneFor(path_(row), local))
        const wanted = local
          ? scanned.slice(0, maxPagesPerFile)
          : scanned.filter((page) => page <= maxPagesPerFile)
        if (wanted.every((page) => done.has(page))) continue
        const isWanted = new Set(local ? wanted : scanned)
        const skipPages: number[] = []
        for (let page = 1; page <= row.scan_total; page++) if (!isWanted.has(page)) skipPages.push(page)
        out.push({
          ...base,
          pagesDone: wanted.filter((page) => done.has(page)).length,
          totalPages: row.scan_total,
          ...(skipPages.length ? { skipPages } : {}),
        })
        continue
      }
      if (row.total !== null && Math.min(row.total, maxPagesPerFile) - row.done <= 0) continue
      out.push({
        ...base,
        pagesDone: row.done,
        ...(row.total !== null ? { totalPages: row.total } : {}),
      })
    }
    return out
  }

  private pagesDoneFor(file: { path: string; mtimeMs: number; sizeBytes: number }, any: boolean): number[] {
    return any
      ? this.pagesPresent(file.path, file.mtimeMs, file.sizeBytes)
      : this.pagesDone(file.path, file.mtimeMs, file.sizeBytes)
  }
}

function path_(row: { path: string; mtime_ms: number; size_bytes: number }): {
  path: string
  mtimeMs: number
  sizeBytes: number
} {
  return { path: row.path, mtimeMs: row.mtime_ms, sizeBytes: row.size_bytes }
}
