import { issueReason, type IndexIssue } from './issues'
import { topVectors } from './top-vectors'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync } from 'node:fs'
import { basename, resolve, sep } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import {
  documentIndexFields,
  matchedNameWords,
  nameWords,
  normalizeDocumentText,
  queryTokens,
} from './normalization'
import { OcrSidecar, isOcrLocation } from './ocr-sidecar'

export type DocumentStatus = 'pending' | 'ready' | 'text-only' | 'empty' | 'error' | 'excluded'
export interface StoredDocument {
  id: number
  path: string
  name: string
  status: DocumentStatus
  mtimeMs: number | null
  sizeBytes: number | null
  hash: string | null
  error: string | null
  /** The index holds only part of this file (chunk cap or sampled tabular rows). */
  truncated: boolean
}
export interface ReplacementDocument {
  hash: string
  mtimeMs: number
  sizeBytes: number
  chunks: Array<{ text: string; location: string; vector?: number[] }>
  embeddingModel: string | null
  status: 'ready' | 'text-only' | 'empty' | 'error'
  error?: string
  truncated?: boolean
}
export interface DocumentMemoryHit {
  documentId: number
  path: string
  name: string
  chunkId: number
  text: string
  location: string
  score: number
  hash: string | null
  mtimeMs: number | null
  sizeBytes: number | null
  /** Epoch ms of the last index write for this document (null when unknown). */
  indexedAt: number | null
  /** The document is only partially indexed (chunk cap or sampled rows). */
  truncated: boolean
  /** The text was transcribed from page images (OCR) and may contain recognition errors. */
  ocr?: boolean
  /** Matched by file name only: the file's content has not been read (scanned PDF, unreadable). */
  contentUnread?: boolean
}
/** Options for the time-sliced write paths (large documents are written in short turns). */
export interface SliceOptions {
  /** Let the event loop run between slices (default: setImmediate). */
  yield?: () => Promise<void>
  /** Return false to abandon a half-finished write; the document stays `pending` and resumes. */
  shouldContinue?: () => boolean
  /** Longest one write transaction may run (default {@link WRITE_SLICE_MS}). */
  budgetMs?: number
}
export interface DocumentMemoryStats {
  docs: number
  chunks: number
  vectors: number
  errors: number
}
export interface DocumentChunkProgress {
  document: StoredDocument | null
  completedChunks: number
  totalChunks: number
}
export interface FolderChunkProgress {
  totalFiles: number
  readyFiles: number
  pendingFiles: number
  errorFiles: number
  emptyFiles?: number
  completedChunks: number
  totalChunks: number
  partialFileProgress: number
  /** Files that are only partially indexed (chunk cap or sampled rows). */
  truncatedFiles: number
}

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  mtime_ms REAL,
  size_bytes INTEGER,
  hash TEXT,
  embedding_model TEXT,
  error TEXT,
  excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
  truncated INTEGER NOT NULL DEFAULT 0,
  last_opened_at INTEGER NOT NULL DEFAULT 0,
  priority_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  chunk_total INTEGER NOT NULL DEFAULT 0,
  chunk_done INTEGER NOT NULL DEFAULT 0,
  chunk_counted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  normalized TEXT NOT NULL,
  location TEXT NOT NULL,
  vector BLOB,
  vector_dim INTEGER,
  UNIQUE(document_id, ordinal),
  CHECK ((vector IS NULL AND vector_dim IS NULL) OR (vector IS NOT NULL AND vector_dim > 0))
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(text, tokenize='unicode61 remove_diacritics 2');
CREATE INDEX IF NOT EXISTS chunks_document_id ON chunks(document_id);
CREATE INDEX IF NOT EXISTS chunks_vector_lookup ON chunks(vector_dim, document_id) WHERE vector IS NOT NULL;
CREATE INDEX IF NOT EXISTS documents_excluded_status ON documents(excluded, status);
`

/**
 * Per-document chunk counters (`documents.chunk_total` / `chunk_done`) are maintained by triggers
 * on `chunks`, so every writer (replace, embedding batches, delete, tombstone, exclude, retry,
 * either process, even an older build) keeps them exact inside the writer's own transaction.
 * Progress aggregates then read the small documents table instead of scanning the vector BLOBs
 * of every chunk (hundreds of milliseconds on a store with ~100k chunks).
 */
const COUNTER_TRIGGER_NAMES = [
  'chunks_counter_insert',
  'chunks_counter_delete',
  'chunks_counter_vector',
] as const
const COUNTER_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS chunks_counter_insert AFTER INSERT ON chunks
BEGIN
  UPDATE documents SET chunk_total = chunk_total + 1,
    chunk_done = chunk_done + (new.vector IS NOT NULL) WHERE id = new.document_id;
END;
CREATE TRIGGER IF NOT EXISTS chunks_counter_delete AFTER DELETE ON chunks
BEGIN
  UPDATE documents SET chunk_total = chunk_total - 1,
    chunk_done = chunk_done - (old.vector IS NOT NULL) WHERE id = old.document_id;
END;
CREATE TRIGGER IF NOT EXISTS chunks_counter_vector AFTER UPDATE OF vector ON chunks
WHEN (old.vector IS NULL) <> (new.vector IS NULL)
BEGIN
  UPDATE documents SET chunk_done = chunk_done + (new.vector IS NOT NULL) - (old.vector IS NOT NULL)
  WHERE id = new.document_id;
END;
`
/**
 * FTS5 merges segments while it commits a write ("automerge"). On a store with ~100k chunks a
 * merge of the larger levels takes 50-400 ms inside one commit, which stalled the main thread
 * every few dozen documents. Automerge is switched off (the setting persists in the database)
 * and {@link DocumentMemoryStore.mergeFtsStep} merges a few pages at a time between writes.
 */
export const FTS_MERGE_PAGES = 8
/** Documents handled per backfill slice; each slice is one short transaction. */
export const COUNTER_BACKFILL_SLICE = 200
/** Time budget of one sliced write transaction (replace / delete of a large document). */
export const WRITE_SLICE_MS = 8

/** Bound semantic work on large stores; weak results widen the scan to protect recall. */
export const SEMANTIC_RECENT_SCAN = 12_000
export const SEMANTIC_WIDE_SCAN = 48_000
export const SEMANTIC_FULL_SCAN_THRESHOLD = 15_000
export const SEMANTIC_RELEVANCE_THRESHOLD = 0.82
export const SEMANTIC_RELEVANCE_MARGIN = 0.12
export const SEMANTIC_RECENT_DOCUMENTS = 1_024
export const SEMANTIC_WIDE_DOCUMENTS = 4_096
export interface DocumentMemorySearchOptions {
  semanticRecentScan?: number
  semanticWideScan?: number
  semanticFullScanThreshold?: number
  semanticRelevanceThreshold?: number
  semanticRecentDocuments?: number
  semanticWideDocuments?: number
}

/** Durable memory for explicitly opened documents. Only enrolled documents are searchable. */
export class DocumentMemoryStore {
  private readonly db: DatabaseSync
  private readonly searchOptions: Required<DocumentMemorySearchOptions>
  private ocrSidecar: OcrSidecar | null = null

  /** Text transcribed by the scanned-PDF reader (see ocr-sidecar.ts). */
  get ocr(): OcrSidecar {
    return (this.ocrSidecar ??= new OcrSidecar(this.db))
  }

  constructor(dbPath: string, options: DocumentMemorySearchOptions = {}) {
    this.searchOptions = {
      semanticRecentScan: options.semanticRecentScan ?? SEMANTIC_RECENT_SCAN,
      semanticWideScan: options.semanticWideScan ?? SEMANTIC_WIDE_SCAN,
      semanticFullScanThreshold: options.semanticFullScanThreshold ?? SEMANTIC_FULL_SCAN_THRESHOLD,
      semanticRelevanceThreshold:
        options.semanticRelevanceThreshold ?? SEMANTIC_RELEVANCE_THRESHOLD,
      semanticRecentDocuments: options.semanticRecentDocuments ?? SEMANTIC_RECENT_DOCUMENTS,
      semanticWideDocuments: options.semanticWideDocuments ?? SEMANTIC_WIDE_DOCUMENTS,
    }
    this.db = new DatabaseSync(dbPath)
    this.db.exec(
      'PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;',
    )
    this.db.exec(SCHEMA)
    OcrSidecar.ensureSchema(this.db)
    // Older databases predate explicit open timestamps. Preserve all existing rows and vectors.
    const columns = this.db.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'last_opened_at'))
      this.db.exec('ALTER TABLE documents ADD COLUMN last_opened_at INTEGER NOT NULL DEFAULT 0')
    if (!columns.some((column) => column.name === 'truncated'))
      this.db.exec('ALTER TABLE documents ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0')
    if (!columns.some((column) => column.name === 'priority_at')) {
      this.db.exec('ALTER TABLE documents ADD COLUMN priority_at INTEGER NOT NULL DEFAULT 0')
      this.db.exec(`UPDATE documents SET priority_at = max(last_opened_at,
        coalesce(mtime_ms, 0))`)
    }
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS documents_priority ON documents(excluded, priority_at DESC)',
    )
    this.migrateChunkCounters()
    try {
      chmodSync(resolve(dbPath), 0o600)
    } catch {
      // Some filesystems and in-memory databases do not support chmod.
    }
  }

  /**
   * Add the counter columns and triggers. Idempotent and safe when the main-process manager and
   * the index process open the same file at once: the check-and-alter runs in one IMMEDIATE
   * transaction, so the second opener waits (busy_timeout) and then finds everything in place.
   * Existing rows keep `chunk_counted = 0` and are filled by {@link backfillCounters}.
   */
  private migrateChunkCounters(): void {
    const present = () =>
      (this.db.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>).map(
        (column) => column.name,
      )
    const triggers = () =>
      (
        this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{
          name: string
        }>
      ).map((row) => row.name)
    const complete = (): boolean => {
      const columns = present()
      const names = triggers()
      return (
        ['chunk_total', 'chunk_done', 'chunk_counted'].every((name) => columns.includes(name)) &&
        COUNTER_TRIGGER_NAMES.every((name) => names.includes(name)) &&
        this.ftsAutomergeDisabled()
      )
    }
    if (complete()) return
    this.transaction(() => {
      const columns = present()
      for (const name of ['chunk_total', 'chunk_done', 'chunk_counted'])
        if (!columns.includes(name))
          this.db.exec(`ALTER TABLE documents ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`)
      this.db.exec(COUNTER_TRIGGERS)
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS documents_uncounted ON documents(id) WHERE chunk_counted = 0',
      )
      if (!this.ftsAutomergeDisabled())
        this.db.exec("INSERT INTO chunk_fts(chunk_fts, rank) VALUES('automerge', 0)")
    })
  }

  private ftsAutomergeDisabled(): boolean {
    const row = this.db.prepare("SELECT v FROM chunk_fts_config WHERE k = 'automerge'").get() as
      { v: unknown } | undefined
    return row !== undefined && Number(row.v) === 0
  }

  /**
   * One bounded step of FTS5 segment merging (about `pages` pages of output, ~1 ms). Returns true
   * while more merging may remain, so callers loop with a yield between steps. Safe to call at
   * any time outside a write transaction; a no-op when the index is already compact.
   */
  mergeFtsStep(pages = FTS_MERGE_PAGES): boolean {
    const changes = () => (this.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    const before = changes()
    this.db.exec(`INSERT INTO chunk_fts(chunk_fts, rank) VALUES('merge', ${Math.trunc(pages)})`)
    return changes() - before > 1
  }

  /**
   * Fill the counters of documents written before they existed, one short transaction per call.
   * Counts come from covering indexes only (`chunks_document_id`, and the partial
   * `chunks_vector_lookup`), so no vector BLOB is read. Returns whether documents remain.
   */
  backfillCounters(maxDocuments = COUNTER_BACKFILL_SLICE): boolean {
    this.transaction(() => {
      const ids = (
        this.db
          .prepare('SELECT id FROM documents WHERE chunk_counted = 0 ORDER BY id LIMIT ?')
          .all(maxDocuments) as Array<{ id: number }>
      ).map((row) => row.id)
      if (!ids.length) return
      const first = ids[0]!
      const last = ids[ids.length - 1]!
      const totals = new Map<number, number>()
      for (const row of this.db
        .prepare(
          'SELECT document_id, count(*) AS n FROM chunks WHERE document_id BETWEEN ? AND ? GROUP BY document_id',
        )
        .all(first, last) as Array<{ document_id: number; n: number }>)
        totals.set(row.document_id, row.n)
      // The partial index (vector_dim, document_id) holds exactly the vectored chunks, so the
      // count never touches a BLOB. Walk the (normally single) distinct dimension by index seek;
      // the planner would otherwise prefer chunks_document_id and read every row.
      const done = new Map<number, number>()
      const nextDimension = this.db.prepare(
        `SELECT vector_dim FROM chunks INDEXED BY chunks_vector_lookup
        WHERE vector IS NOT NULL AND vector_dim > ? ORDER BY vector_dim LIMIT 1`,
      )
      const countDone = this.db.prepare(
        `SELECT document_id, count(*) AS n FROM chunks INDEXED BY chunks_vector_lookup
        WHERE vector IS NOT NULL AND vector_dim = ? AND document_id BETWEEN ? AND ?
        GROUP BY document_id`,
      )
      for (let dimension = 0; ;) {
        const next = nextDimension.get(dimension) as { vector_dim: number } | undefined
        if (!next) break
        dimension = next.vector_dim
        for (const hit of countDone.all(dimension, first, last) as Array<{
          document_id: number
          n: number
        }>)
          done.set(hit.document_id, (done.get(hit.document_id) ?? 0) + hit.n)
      }
      const update = this.db.prepare(
        'UPDATE documents SET chunk_total = ?, chunk_done = ?, chunk_counted = 1 WHERE id = ?',
      )
      for (const id of ids) update.run(totals.get(id) ?? 0, done.get(id) ?? 0, id)
    })
    return this.hasUncountedDocuments()
  }

  /** True while some document still lacks exact counters (a backfill is outstanding). */
  hasUncountedDocuments(): boolean {
    return !!this.db.prepare('SELECT 1 FROM documents WHERE chunk_counted = 0 LIMIT 1').get()
  }

  remember(path: string): void {
    const normalizedPath = resolve(path)
    const openedAt = Date.now()
    this.db
      .prepare(
        `INSERT INTO documents(path, name, status, last_opened_at, priority_at, chunk_counted) VALUES (?, ?, 'pending', ?, ?, 1)
      ON CONFLICT(path) DO UPDATE SET name = excluded.name,
        last_opened_at = CASE WHEN documents.excluded = 0 THEN excluded.last_opened_at ELSE documents.last_opened_at END,
        priority_at = CASE WHEN documents.excluded = 0 THEN max(excluded.priority_at, coalesce(documents.mtime_ms, 0)) ELSE documents.priority_at END`,
      )
      .run(normalizedPath, basename(normalizedPath), openedAt, openedAt)
  }

  /** Enroll a file found by a folder scan without making it look recently opened. */
  enrollDiscovered(path: string, mtimeMs: number, sizeBytes: number): boolean {
    const normalizedPath = resolve(path)
    this.db
      .prepare(
        `INSERT INTO documents(path, name, status, last_opened_at, priority_at, chunk_counted)
         VALUES (?, ?, 'pending', 0, ?, 1)
         ON CONFLICT(path) DO NOTHING`,
      )
      .run(normalizedPath, basename(normalizedPath), mtimeMs)
    const document = this.documentByPath(normalizedPath)
    if (!document || document.status === 'excluded') return false
    // Existing rows keep their original opened time and indexed metadata. Only a new
    // row or a file whose source metadata changed needs work from the extractor.
    return (
      document.mtimeMs === null ||
      document.mtimeMs !== mtimeMs ||
      document.sizeBytes !== sizeBytes ||
      document.status === 'pending'
    )
  }

  private ensureDocument(path: string): void {
    this.db
      .prepare(
        `INSERT INTO documents(path, name, status, chunk_counted) VALUES (?, ?, 'pending', 1) ON CONFLICT(path) DO NOTHING`,
      )
      .run(path, basename(path))
  }

  listDocuments(): StoredDocument[] {
    return (
      this.db
        .prepare(
          `SELECT id, path, name, status, mtime_ms, size_bytes, hash, error, truncated
      FROM documents ORDER BY priority_at DESC, id DESC`,
        )
        .all() as unknown as DocRow[]
    ).map(toDocument)
  }

  recentDocuments(limit = 20): StoredDocument[] {
    return (
      this.db
        .prepare(
          `SELECT id, path, name, status, mtime_ms, size_bytes, hash, error, truncated
      FROM documents WHERE excluded = 0 ORDER BY priority_at DESC, id DESC LIMIT ?`,
        )
        .all(limit) as unknown as DocRow[]
    ).map(toDocument)
  }

  documentByPath(path: string): StoredDocument | null {
    const row = this.db
      .prepare(
        `SELECT id, path, name, status, mtime_ms, size_bytes, hash, error, truncated
      FROM documents WHERE path = ?`,
      )
      .get(resolve(path)) as DocRow | undefined
    return row ? toDocument(row) : null
  }

  documentById(id: number): StoredDocument | null {
    const row = this.db
      .prepare(
        `SELECT id, path, name, status, mtime_ms, size_bytes, hash, error, truncated
      FROM documents WHERE id = ?`,
      )
      .get(id) as DocRow | undefined
    return row ? toDocument(row) : null
  }

  /** Read one document's persisted vector counts from its counters (no chunk or vector reads). */
  chunkProgress(path: string): DocumentChunkProgress {
    const row = this.db
      .prepare(
        `SELECT d.id, d.path, d.name, d.status, d.mtime_ms, d.size_bytes, d.hash, d.error, d.truncated,
          CASE WHEN d.chunk_counted = 1 THEN d.chunk_total
            ELSE (SELECT count(*) FROM chunks c WHERE c.document_id = d.id) END AS total_chunks,
          CASE WHEN d.chunk_counted = 1 THEN d.chunk_done
            ELSE (SELECT count(*) FROM chunks c WHERE c.document_id = d.id AND c.vector IS NOT NULL) END
            AS completed_chunks
        FROM documents d WHERE d.path = ?`,
      )
      .get(resolve(path)) as
      (DocRow & { total_chunks: number; completed_chunks: number | null }) | undefined
    return {
      document: row ? toDocument(row) : null,
      completedChunks: row?.completed_chunks ?? 0,
      totalChunks: row?.total_chunks ?? 0,
    }
  }

  /**
   * Aggregate enrolled documents below a selected root from the per-document counters: one pass
   * over the documents table, no chunk or vector access. Documents whose counters are not
   * backfilled yet are counted from the covering indexes instead, so the figures are always exact.
   */
  /** Move the waiting files below `root` to the front of the indexing order. */
  boostFolder(root: string, at: number): void {
    const prefix = root.endsWith(sep) ? root : root + sep
    this.db
      .prepare(
        "UPDATE documents SET priority_at = ? WHERE excluded = 0 AND status = 'pending' AND substr(path, 1, ?) = ?",
      )
      .run(at, prefix.length, prefix)
  }

  folderChunkProgress(root: string): FolderChunkProgress {
    const normalized = resolve(root)
    const prefix =
      normalized.endsWith('/') || normalized.endsWith('\\')
        ? normalized
        : `${normalized}${normalized.includes('\\') ? '\\' : '/'}`
    const counts = this.countSource()
    const row = this.db
      .prepare(
        `${counts.with}
        SELECT count(*) AS total_files,
          sum(CASE WHEN status IN ('ready', 'empty') THEN 1 ELSE 0 END) AS ready_files,
          sum(CASE WHEN status IN ('pending', 'text-only') THEN 1 ELSE 0 END) AS pending_files,
          sum(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_files,
          sum(CASE WHEN status = 'empty' THEN 1 ELSE 0 END) AS empty_files,
          coalesce(sum(truncated), 0) AS truncated_files,
          coalesce(sum(done_chunks), 0) AS completed_chunks,
          coalesce(sum(total_chunks), 0) AS total_chunks,
          coalesce(sum(CASE WHEN status IN ('ready','empty') THEN 1.0
            WHEN status = 'text-only' AND total_chunks > 0
              THEN (done_chunks * 1.0 / total_chunks)
            ELSE 0.0 END), 0.0) AS partial_file_progress
        FROM (SELECT d.status, d.truncated, ${counts.total} AS total_chunks, ${counts.done} AS done_chunks
          FROM documents d
          WHERE d.excluded = 0 AND (d.path = ? OR substr(d.path, 1, length(?)) = ?))`,
      )
      .get(normalized, prefix, prefix) as
      | {
          total_files: number
          ready_files: number
          pending_files: number
          error_files: number
          empty_files: number
          truncated_files: number
          completed_chunks: number
          total_chunks: number
          partial_file_progress: number
        }
      | undefined
    return {
      totalFiles: row?.total_files ?? 0,
      readyFiles: row?.ready_files ?? 0,
      pendingFiles: row?.pending_files ?? 0,
      errorFiles: row?.error_files ?? 0,
      emptyFiles: row?.empty_files ?? 0,
      completedChunks: row?.completed_chunks ?? 0,
      totalChunks: row?.total_chunks ?? 0,
      partialFileProgress: row?.partial_file_progress ?? 0,
      truncatedFiles: row?.truncated_files ?? 0,
    }
  }

  indexIssues(root: string, offset = 0): { total: number; items: IndexIssue[] } {
    const normalized = resolve(root)
    const prefix = normalized + (normalized.includes('\\') ? '\\' : '/')
    const where =
      "excluded = 0 AND status IN ('error', 'empty') AND (path = ? OR substr(path, 1, length(?)) = ?)"
    const total = (
      this.db
        .prepare(`SELECT count(*) n FROM documents WHERE ${where}`)
        .get(normalized, prefix, prefix) as { n: number }
    ).n
    const rows = this.db
      .prepare(
        `SELECT id, path, name, status, error FROM documents WHERE ${where}
      ORDER BY status ASC, priority_at DESC, id DESC LIMIT 10 OFFSET ?`,
      )
      .all(normalized, prefix, prefix, offset) as Array<{
      id: number
      path: string
      name: string
      status: string
      error: string | null
    }>
    return {
      total,
      items: rows.map(({ status, error, ...row }) => ({
        ...row,
        reason: issueReason(error, status),
        ...(error ? { error } : {}),
      })),
    }
  }

  /**
   * Files that failed only because their type could not be read at the time (legacy .xls) go
   * back to the queue once the reader exists. A file that fails again for another reason keeps
   * that reason, so this is safe to run at every start.
   */
  requeueNowReadable(): number {
    const result = this.db
      .prepare(
        "UPDATE documents SET status = 'pending', error = NULL WHERE status = 'error' AND excluded = 0 AND error = 'Unsupported file type: .xls'",
      )
      .run()
    return Number(result.changes)
  }

  retryDocument(id: number): string | null {
    const document = this.documentById(id)
    if (!document || document.status === 'excluded') return null
    if (document.status === 'error' || document.status === 'empty')
      this.db
        .prepare(
          "UPDATE documents SET status = 'pending', error = NULL WHERE id = ? AND excluded = 0",
        )
        .run(id)
    return document.path
  }

  documentPriority(path: string): number {
    const row = this.db
      .prepare('SELECT priority_at FROM documents WHERE path = ?')
      .get(resolve(path)) as { priority_at: number } | undefined
    return row?.priority_at ?? 0
  }

  listPaths(): string[] {
    return (
      this.db
        .prepare(
          `SELECT path FROM documents WHERE excluded = 0
          ORDER BY priority_at DESC, id DESC`,
        )
        .all() as Array<{ path: string }>
    ).map((r) => r.path)
  }

  replaceDocument(path: string, replacement: ReplacementDocument): void {
    const normalizedPath = resolve(path)
    validateReplacement(replacement)
    this.transaction(() => {
      const row = this.lockDocumentForReplace(normalizedPath)
      this.deleteChunks(row.id)
      this.updateReplacedDocument(row.id, normalizedPath, replacement)
      const insert = this.chunkInserter(row.id)
      replacement.chunks.forEach((chunk, ordinal) => insert(chunk, ordinal))
    })
  }

  /**
   * Same result as {@link replaceDocument}, but written in short transactions so a document with
   * hundreds of chunks never blocks the event loop for more than about one slice. A document
   * that fits one slice is still replaced atomically. Between slices the row is marked
   * `pending` (no hash), so an interrupted replacement is simply extracted again on resume.
   * Returns false when the write was abandoned (document excluded/removed or `shouldContinue`).
   */
  async replaceDocumentSliced(
    path: string,
    replacement: ReplacementDocument,
    options: SliceOptions = {},
  ): Promise<boolean> {
    const normalizedPath = resolve(path)
    validateReplacement(replacement)
    let phase: 'delete' | 'insert' = 'delete'
    let next = 0
    let first = true
    let documentId = 0
    let insert: ReturnType<DocumentMemoryStore['chunkInserter']> | null = null
    return this.runSliced(
      options,
      (outOfBudget) => {
        if (first) {
          documentId = this.lockDocumentForReplace(normalizedPath).id
          first = false
        } else {
          const row = this.db
            .prepare('SELECT excluded FROM documents WHERE id = ?')
            .get(documentId) as { excluded: number } | undefined
          if (!row || row.excluded) return 'abort'
        }
        if (phase === 'delete') {
          if (!this.deleteChunksBudgeted(documentId, outOfBudget)) return 'more'
          phase = 'insert'
        }
        insert ??= this.chunkInserter(documentId)
        while (next < replacement.chunks.length) {
          insert(replacement.chunks[next]!, next)
          next++
          if (next < replacement.chunks.length && outOfBudget()) return 'more'
        }
        this.updateReplacedDocument(documentId, normalizedPath, replacement)
        return 'done'
      },
      () => this.markPending(documentId),
    )
  }

  private lockDocumentForReplace(normalizedPath: string): { id: number } {
    this.ensureDocument(normalizedPath)
    const row = this.db
      .prepare('SELECT id, excluded FROM documents WHERE path = ?')
      .get(normalizedPath) as { id: number; excluded: number }
    if (row.excluded) throw new Error('Excluded document cannot be indexed')
    return row
  }

  private updateReplacedDocument(
    id: number,
    normalizedPath: string,
    replacement: ReplacementDocument,
  ): void {
    this.db
      .prepare(
        `UPDATE documents SET name = ?, status = ?, mtime_ms = ?, priority_at = max(last_opened_at, ?), size_bytes = ?, hash = ?,
        embedding_model = ?, error = ?, truncated = ?, excluded = 0, updated_at = unixepoch() WHERE id = ?`,
      )
      .run(
        basename(normalizedPath),
        replacement.status,
        replacement.mtimeMs,
        replacement.mtimeMs,
        replacement.sizeBytes,
        replacement.hash,
        replacement.embeddingModel,
        replacement.error ?? null,
        replacement.truncated ? 1 : 0,
        id,
      )
  }

  private chunkInserter(
    documentId: number,
  ): (chunk: ReplacementDocument['chunks'][number], ordinal: number) => void {
    const addChunk = this.db
      .prepare(`INSERT INTO chunks(document_id, ordinal, text, normalized, location, vector, vector_dim)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
    const addFts = this.db.prepare('INSERT INTO chunk_fts(rowid, text) VALUES (?, ?)')
    return (chunk, ordinal) => {
      const fields = documentIndexFields(chunk.text)
      const result = addChunk.run(
        documentId,
        ordinal,
        chunk.text,
        fields.normalized,
        chunk.location,
        chunk.vector ? floatBlob(chunk.vector) : null,
        chunk.vector?.length ?? null,
      )
      addFts.run(result.lastInsertRowid, fields.searchText)
    }
  }

  /**
   * Queue every document whose vectors came from a different model to be read again. Their old
   * chunks stay searchable (full text) until the new extraction replaces them.
   */
  requeueForEmbeddingModel(current: string): number {
    const result = this.db
      .prepare(
        `UPDATE documents SET status = 'pending', hash = NULL, embedding_model = NULL, error = NULL
        WHERE excluded = 0 AND embedding_model IS NOT NULL AND embedding_model <> ?`,
      )
      .run(current)
    return Number(result.changes)
  }

  /**
   * PDFs that were read only in part are read again (a higher page limit was chosen); their old
   * passages stay searchable until the new ones replace them.
   */
  requeueTruncatedPdfs(): number {
    const result = this.db
      .prepare(
        `UPDATE documents SET status = 'pending', hash = NULL, embedding_model = NULL, error = NULL
        WHERE excluded = 0 AND truncated = 1 AND lower(path) LIKE '%.pdf'`,
      )
      .run()
    return Number(result.changes)
  }

  /** Between slices a half-written document must not look finished. */
  private markPending(documentId: number): void {
    this.db
      .prepare(
        `UPDATE documents SET status = 'pending', hash = NULL, embedding_model = NULL, error = NULL
        WHERE id = ?`,
      )
      .run(documentId)
  }

  markError(
    path: string,
    error: string,
    metadata?: { mtimeMs: number; sizeBytes: number } | null,
  ): void {
    const p = resolve(path)
    this.transaction(() => {
      this.ensureDocument(p)
      const row = this.db.prepare('SELECT id, excluded FROM documents WHERE path = ?').get(p) as {
        id: number
        excluded: number
      }
      if (row.excluded) return
      this.deleteChunks(row.id)
      this.applyError(row.id, error, metadata)
    })
  }

  /** {@link markError} written in short transactions (dropping a large document's chunks is slow). */
  async markErrorSliced(
    path: string,
    error: string,
    metadata?: { mtimeMs: number; sizeBytes: number } | null,
    options: SliceOptions = {},
  ): Promise<boolean> {
    const p = resolve(path)
    let documentId = 0
    let first = true
    return this.runSliced(
      options,
      (outOfBudget) => {
        if (first) {
          this.ensureDocument(p)
          first = false
        }
        const row = (
          documentId
            ? this.db.prepare('SELECT id, excluded FROM documents WHERE id = ?').get(documentId)
            : this.db.prepare('SELECT id, excluded FROM documents WHERE path = ?').get(p)
        ) as { id: number; excluded: number } | undefined
        if (!row || row.excluded) return 'abort'
        documentId = row.id
        if (!this.deleteChunksBudgeted(documentId, outOfBudget)) return 'more'
        this.applyError(documentId, error, metadata)
        return 'done'
      },
      () => this.markPending(documentId),
    )
  }

  private applyError(
    id: number,
    error: string,
    metadata?: { mtimeMs: number; sizeBytes: number } | null,
  ): void {
    this.db
      .prepare(
        `UPDATE documents SET status = 'error', error = ?, hash = NULL, embedding_model = NULL, truncated = 0,
        mtime_ms = CASE WHEN ? = 0 THEN mtime_ms ELSE ? END,
        size_bytes = CASE WHEN ? = 0 THEN size_bytes ELSE ? END,
        updated_at = unixepoch() WHERE id = ?`,
      )
      .run(
        error,
        metadata === undefined ? 0 : 1,
        metadata?.mtimeMs ?? null,
        metadata === undefined ? 0 : 1,
        metadata?.sizeBytes ?? null,
        id,
      )
  }

  /** Add one embedding batch without replacing chunks or invalidating their IDs. */
  setChunkVectors(
    path: string,
    hash: string,
    offset: number,
    vectors: number[][],
    embeddingModel: string,
    complete: boolean,
  ): void {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid vector offset')
    if (!embeddingModel) throw new Error('Embedding model is required')
    const dimensions = new Set(vectors.map((vector) => vector.length))
    if (
      dimensions.size > 1 ||
      vectors.some((vector) => !vector.length || vector.some((v) => !Number.isFinite(v)))
    )
      throw new Error('Vectors must have a consistent nonzero dimension and finite values')
    const normalizedPath = resolve(path)
    this.transaction(() => {
      const document = this.db
        .prepare('SELECT id, hash, excluded FROM documents WHERE path = ?')
        .get(normalizedPath) as { id: number; hash: string | null; excluded: number } | undefined
      if (!document || document.excluded || document.hash !== hash)
        throw new Error('Document changed before vectors were stored')
      const existing = this.db
        .prepare(
          'SELECT vector_dim FROM chunks WHERE document_id = ? AND vector IS NOT NULL LIMIT 1',
        )
        .get(document.id) as { vector_dim: number } | undefined
      const dimension = vectors[0]?.length ?? existing?.vector_dim
      if (dimension !== undefined && existing && existing.vector_dim !== dimension)
        throw new Error('Vector dimension does not match stored vectors')
      const update = this.db.prepare(
        'UPDATE chunks SET vector = ?, vector_dim = ? WHERE document_id = ? AND ordinal = ?',
      )
      vectors.forEach((vector, index) => {
        const result = update.run(floatBlob(vector), vector.length, document.id, offset + index)
        if (Number(result.changes) !== 1)
          throw new Error('Vector batch does not match indexed chunks')
      })
      const count = this.db
        .prepare(
          'SELECT count(*) AS total, count(vector) AS vectors FROM chunks WHERE document_id = ?',
        )
        .get(document.id) as { total: number; vectors: number }
      if (complete && count.total !== count.vectors)
        throw new Error('Document vector batches are incomplete')
      this.db
        .prepare(
          `UPDATE documents SET embedding_model = ?, status = ?, error = NULL, updated_at = unixepoch()
        WHERE id = ?`,
        )
        .run(embeddingModel, complete ? 'ready' : 'text-only', document.id)
    })
  }

  /** Find a committed embedding checkpoint, retaining chunk IDs and completed vectors. */
  resumeVectorOffset(path: string, hash: string, model: string): number | null {
    const doc = this.db
      .prepare('SELECT id, hash, embedding_model, excluded FROM documents WHERE path = ?')
      .get(resolve(path)) as
      | { id: number; hash: string | null; embedding_model: string | null; excluded: number }
      | undefined
    if (
      !doc ||
      doc.excluded ||
      doc.hash !== hash ||
      (doc.embedding_model && doc.embedding_model !== model)
    )
      return null
    const row = this.db
      .prepare(
        'SELECT min(CASE WHEN vector IS NULL THEN ordinal END) AS missing, count(*) AS total FROM chunks WHERE document_id = ?',
      )
      .get(doc.id) as { missing: number | null; total: number }
    return row.missing ?? row.total
  }

  move(oldPath: string, newPath: string): void {
    const oldResolved = resolve(oldPath)
    const nextResolved = resolve(newPath)
    this.transaction(() => {
      const row = this.db.prepare('SELECT id FROM documents WHERE path = ?').get(oldResolved) as
        { id: number } | undefined
      if (!row) return
      this.db
        .prepare('UPDATE documents SET path = ?, name = ?, updated_at = unixepoch() WHERE id = ?')
        .run(nextResolved, basename(nextResolved), row.id)
      this.ocr.rename(oldResolved, nextResolved)
    })
  }

  /**
   * Forget a document whose file is gone: delete its chunks, FTS rows and vectors and the
   * row itself. An `excluded` row is the user's choice and is never touched.
   */
  tombstone(path: string): boolean {
    const p = resolve(path)
    let removed = false
    this.transaction(() => {
      const row = this.db.prepare('SELECT id, excluded FROM documents WHERE path = ?').get(p) as
        { id: number; excluded: number } | undefined
      if (!row || row.excluded) return
      this.deleteChunks(row.id)
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(row.id)
      this.ocr.remove(p)
      removed = true
    })
    return removed
  }

  /** {@link tombstone} written in short transactions; resolves true when the row was removed. */
  async tombstoneSliced(path: string, options: SliceOptions = {}): Promise<boolean> {
    const p = resolve(path)
    let removed = false
    await this.runSliced(options, (outOfBudget) => {
      const row = this.db.prepare('SELECT id, excluded FROM documents WHERE path = ?').get(p) as
        { id: number; excluded: number } | undefined
      if (!row || row.excluded) return 'done'
      if (!this.deleteChunksBudgeted(row.id, outOfBudget)) return 'more'
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(row.id)
      this.ocr.remove(p)
      removed = true
      return 'done'
    })
    return removed
  }

  /**
   * Drop scan-discovered rows (never opened by the user) whose file name is a lock or temp
   * artifact, such as Word's `~$name.doc`. Earlier scans enrolled them before the filter existed.
   */
  purgeDiscoveredByName(isIgnored: (name: string) => boolean): number {
    let removed = 0
    this.transaction(() => {
      const rows = this.db
        .prepare('SELECT id, name FROM documents WHERE last_opened_at = 0')
        .all() as Array<{ id: number; name: string }>
      for (const row of rows) {
        if (!isIgnored(row.name)) continue
        this.deleteChunks(row.id)
        this.db.prepare('DELETE FROM documents WHERE id = ?').run(row.id)
        removed++
      }
    })
    return removed
  }

  /** Record fresh source metadata after a file was moved, without re-extracting it. */
  touchMetadata(path: string, mtimeMs: number, sizeBytes: number): void {
    this.db
      .prepare('UPDATE documents SET mtime_ms = ?, size_bytes = ? WHERE path = ? AND excluded = 0')
      .run(mtimeMs, sizeBytes, resolve(path))
  }

  /** Non-excluded documents at or below a folder (SQL only; no filesystem access). */
  documentsUnder(root: string): StoredDocument[] {
    const normalized = resolve(root)
    const prefix = normalized + (normalized.includes('\\') ? '\\' : '/')
    return (
      this.db
        .prepare(
          `SELECT id, path, name, status, mtime_ms, size_bytes, hash, error, truncated
          FROM documents WHERE excluded = 0 AND (path = ? OR substr(path, 1, length(?)) = ?)`,
        )
        .all(normalized, prefix, prefix) as unknown as DocRow[]
    ).map(toDocument)
  }

  /** Paths whose extraction or embedding was interrupted and should resume on launch. */
  incompletePaths(): string[] {
    return (
      this.db
        .prepare(
          `SELECT path FROM documents WHERE excluded = 0 AND status IN ('pending', 'text-only')
          ORDER BY priority_at DESC, id DESC`,
        )
        .all() as Array<{ path: string }>
    ).map((r) => r.path)
  }

  /** One id-ordered page of {@link documentsUnder}, so a large folder can be read in slices. */
  documentsUnderPage(root: string, afterId: number, limit: number): StoredDocument[] {
    const normalized = resolve(root)
    const prefix = normalized + (normalized.includes('\\') ? '\\' : '/')
    return (
      this.db
        .prepare(
          `SELECT id, path, name, status, mtime_ms, size_bytes, hash, error, truncated
          FROM documents WHERE excluded = 0 AND id > ? AND (path = ? OR substr(path, 1, length(?)) = ?)
          ORDER BY id LIMIT ?`,
        )
        .all(afterId, normalized, prefix, prefix, limit) as unknown as DocRow[]
    ).map(toDocument)
  }

  /** The most recently user-opened documents, for the cheap safety poll. */
  openedPaths(limit: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT path FROM documents WHERE excluded = 0 AND last_opened_at > 0
          ORDER BY last_opened_at DESC LIMIT ?`,
        )
        .all(limit) as Array<{ path: string }>
    ).map((r) => r.path)
  }

  exclude(path: string): void {
    const p = resolve(path)
    this.transaction(() => {
      const row = this.db.prepare('SELECT id FROM documents WHERE path = ?').get(p) as
        { id: number } | undefined
      if (!row) return
      this.deleteChunks(row.id)
      this.ocr.remove(p)
      this.db
        .prepare(
          `UPDATE documents SET excluded = 1, status = 'excluded', hash = NULL, embedding_model = NULL,
        error = NULL, updated_at = unixepoch() WHERE id = ?`,
        )
        .run(row.id)
    })
  }

  clear(): void {
    this.transaction(() => {
      // Row triggers would update a counter once per chunk; the deletes below zero them anyway.
      for (const name of COUNTER_TRIGGER_NAMES) this.db.exec(`DROP TRIGGER IF EXISTS ${name}`)
      this.db.prepare('DELETE FROM chunk_fts').run()
      this.db.prepare('DELETE FROM chunks').run()
      this.db.prepare('DELETE FROM documents WHERE excluded = 0').run()
      this.ocr.clearAll()
      this.db.exec(
        'UPDATE documents SET chunk_total = 0, chunk_done = 0 WHERE chunk_total <> 0 OR chunk_done <> 0',
      )
      this.db.exec(COUNTER_TRIGGERS)
    })
  }

  /**
   * Files whose NAME (or its folders) fits the question, whether or not their content was ever
   * read. A scanned PDF has no passages, so passage search can never find it; its name can.
   */
  searchNames(query: string, limit = 5): DocumentMemoryHit[] {
    const words = nameWords(query)
    if (words.length === 0) return []
    // one very short word ("le") fits far too many names to be worth showing
    if (words.length === 1 && words[0]!.length < 3) return []
    const need = words.length <= 2 ? words.length : Math.max(2, Math.ceil(words.length * 0.4))
    const rows = this.db
      .prepare(
        `SELECT id, path, name, status, hash, mtime_ms, size_bytes, updated_at, truncated
        FROM documents WHERE excluded = 0`,
      )
      .all() as unknown as Array<{
      id: number
      path: string
      name: string
      status: string
      hash: string | null
      mtime_ms: number | null
      size_bytes: number | null
      updated_at: number
      truncated: number
    }>
    const scored: Array<{ row: (typeof rows)[number]; matched: number }> = []
    for (const row of rows) {
      const folders = row.path.split(/[\\/]/).slice(-3, -1).join(' ')
      const folded = normalizeDocumentText(`${row.name} ${folders}`)
      const joined = folded.replace(/ /g, '')
      let matched = matchedNameWords(words, `${row.name} ${folders}`)
      // a name written in one piece ("MyLe") still counts when the words come in that order
      if (words.length >= 2 && joined.includes(words.join(''))) matched = words.length
      if (words.length >= 2 && folded.includes(words.join(' '))) matched += 0.5
      if (matched >= need) scored.push({ row, matched })
    }
    scored.sort(
      (a, b) =>
        b.matched - a.matched ||
        Number(a.row.status === 'ready') - Number(b.row.status === 'ready') ||
        b.row.updated_at - a.row.updated_at,
    )
    return scored.slice(0, limit).map(({ row, matched }) => {
      const unread = row.status !== 'ready' && row.status !== 'text-only'
      return {
        documentId: row.id,
        path: row.path,
        name: row.name,
        chunkId: 0,
        text: unread
          ? 'The file name matches. Its content has not been read yet (a scanned PDF waiting for OCR, or unreadable), so what it says is unknown.'
          : 'The file name matches.',
        location: 'file name',
        score: matched / words.length,
        hash: row.hash,
        mtimeMs: row.mtime_ms,
        sizeBytes: row.size_bytes,
        indexedAt: row.updated_at * 1000,
        truncated: row.truncated === 1,
        ...(unread ? { contentUnread: true } : {}),
      }
    })
  }

  search(
    query: string,
    vector: number[] | null,
    limit = 8,
    embeddingModel?: string,
  ): DocumentMemoryHit[] {
    if (vector && vector.some((v) => !Number.isFinite(v)))
      throw new Error('Query vector must contain only finite numbers')
    const tokens = queryTokens(query)
    const lexical = new Map<number, number>()
    if (tokens.length) {
      const match = tokens.map(quoteFtsToken).join(' OR ')
      const rows = this.db
        .prepare(
          `SELECT f.rowid AS chunk_id, bm25(chunk_fts) AS rank
        FROM chunk_fts f JOIN chunks c ON c.id = f.rowid JOIN documents d ON d.id = c.document_id
        WHERE chunk_fts MATCH ? AND d.excluded = 0 ORDER BY rank LIMIT 200`,
        )
        .all(match) as Array<{ chunk_id: number; rank: number }>
      let rank = 0
      let previousRank: number | undefined
      rows.forEach((row, index) => {
        if (previousRank !== row.rank) rank = index + 1
        lexical.set(row.chunk_id, rank)
        previousRank = row.rank
      })
    }

    const semantic = new Map<number, number>()
    if (vector?.length) {
      const docsQuery = this.db.prepare(
        `SELECT d.id, d.priority_at FROM documents d WHERE d.excluded = 0 AND EXISTS (
          SELECT 1 FROM chunks c WHERE c.document_id = d.id AND c.vector IS NOT NULL AND c.vector_dim = ?
        ) AND (? IS NULL OR d.embedding_model = ?)
        ORDER BY d.priority_at DESC, d.id DESC LIMIT ?`,
      )
      const chunksQuery = this.db.prepare(`SELECT c.id, c.vector, c.vector_dim FROM chunks c
        WHERE c.document_id = ? AND c.vector IS NOT NULL AND c.vector_dim = ?`)
      const vectorCount = (
        this.db
          .prepare(
            `SELECT count(*) AS count FROM chunks c JOIN documents d ON d.id = c.document_id
            WHERE d.excluded = 0 AND c.vector IS NOT NULL AND c.vector_dim = ?
              AND (? IS NULL OR d.embedding_model = ?)`,
          )
          .get(vector.length, embeddingModel ?? null, embeddingModel ?? null) as { count: number }
      ).count
      const vectorDocumentCount = (
        this.db
          .prepare(
            `SELECT count(DISTINCT d.id) AS count FROM chunks c JOIN documents d ON d.id = c.document_id
            WHERE d.excluded = 0 AND c.vector IS NOT NULL AND c.vector_dim = ?
              AND (? IS NULL OR d.embedding_model = ?)`,
          )
          .get(vector.length, embeddingModel ?? null, embeddingModel ?? null) as { count: number }
      ).count
      const scanLimit =
        vectorCount <= this.searchOptions.semanticFullScanThreshold
          ? vectorCount
          : this.searchOptions.semanticRecentScan
      let queryNorm = 0
      for (const value of vector) queryNorm += value * value
      const scan = (maxRows: number, maxDocuments: number) => {
        function* scoredRows() {
          let scanned = 0
          let documentRank = 0
          const docs = docsQuery.iterate(
            vector!.length,
            embeddingModel ?? null,
            embeddingModel ?? null,
            maxDocuments,
          ) as Iterable<{ id: number; priority_at: number }>
          for (const doc of docs) {
            documentRank++
            const rows = chunksQuery.iterate(doc.id, vector!.length) as Iterable<{
              id: number
              vector: Uint8Array
              vector_dim: number
            }>
            for (const row of rows) {
              const score = cosine(vector!, blobVector(row.vector, row.vector_dim), queryNorm)
              // Preserve equal semantic scores in the top-200 heap by recent document order.
              yield { id: row.id, score: score + 1e-8 / documentRank, cosineScore: score }
              if (++scanned >= maxRows) return
            }
          }
        }
        return topVectors(scoredRows(), 200)
      }
      let best = scan(
        scanLimit,
        vectorCount <= this.searchOptions.semanticFullScanThreshold
          ? Number.MAX_SAFE_INTEGER
          : this.searchOptions.semanticRecentDocuments,
      )
      let semanticRelevance = best[0] ? best[0].cosineScore : Number.NEGATIVE_INFINITY
      const informativeTokens = tokens.filter((token) => token.length >= 4 || /^\d+$/.test(token))
      const strongLexical =
        informativeTokens.length > 0
          ? !!this.db
              .prepare(
                `SELECT 1 FROM chunk_fts f JOIN chunks c ON c.id = f.rowid
          JOIN documents d ON d.id = c.document_id
          WHERE chunk_fts MATCH ? AND d.excluded = 0 LIMIT 1`,
              )
              .get(informativeTokens.map(quoteFtsToken).join(' AND '))
          : false
      const margin =
        best.length > 1 ? semanticRelevance - best[1]!.cosineScore : Number.NEGATIVE_INFINITY
      const enoughEvidence =
        strongLexical ||
        (semanticRelevance >= this.searchOptions.semanticRelevanceThreshold &&
          margin >= SEMANTIC_RELEVANCE_MARGIN)
      if (vectorCount > this.searchOptions.semanticFullScanThreshold && !enoughEvidence) {
        best = scan(
          Math.min(vectorCount, this.searchOptions.semanticWideScan),
          this.searchOptions.semanticWideDocuments,
        )
        semanticRelevance = best[0] ? best[0].cosineScore : Number.NEGATIVE_INFINITY
        const wideMargin =
          best.length > 1 ? semanticRelevance - best[1]!.cosineScore : Number.NEGATIVE_INFINITY
        if (
          !strongLexical &&
          (semanticRelevance < this.searchOptions.semanticRelevanceThreshold ||
            wideMargin < SEMANTIC_RELEVANCE_MARGIN) &&
          (vectorCount > this.searchOptions.semanticWideScan ||
            vectorDocumentCount > this.searchOptions.semanticWideDocuments)
        )
          best = scan(vectorCount, Number.MAX_SAFE_INTEGER)
      }
      let semanticRank = 0
      let previousScore: number | undefined
      best.forEach((row, index) => {
        const score = row.cosineScore
        if (previousScore !== score) semanticRank = index + 1
        semantic.set(row.id, semanticRank)
        previousScore = score
      })
    }

    const scores = new Map<number, number>()
    for (const [id, rank] of lexical) scores.set(id, (scores.get(id) ?? 0) + 2 / (60 + rank))
    for (const [id, rank] of semantic) scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + rank))
    const recency = new Map<number, number>()
    if (scores.size) {
      const placeholders = [...scores.keys()].map(() => '?').join(',')
      const rows = this.db
        .prepare(
          `SELECT c.id, max(d.last_opened_at, coalesce(d.mtime_ms, 0)) AS recent
          FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id IN (${placeholders})`,
        )
        .all(...scores.keys()) as Array<{ id: number; recent: number }>
      const now = Date.now()
      for (const row of rows) {
        const age = Math.max(0, now - row.recent)
        // At most 0.00002: enough to settle near-ties, never enough to eclipse a strong match.
        recency.set(row.id, Math.max(0, 1 - age / (90 * 24 * 60 * 60 * 1000)) * 0.00002)
      }
    }
    const ids = [...scores]
      .sort((a, b) => b[1] + (recency.get(b[0]) ?? 0) - (a[1] + (recency.get(a[0]) ?? 0)))
      .slice(0, Math.max(0, limit))
      .map(([id]) => id)
    if (!ids.length) return []
    const get = this.db
      .prepare(`SELECT d.id AS document_id, d.path, d.name, d.hash, d.mtime_ms, d.size_bytes, d.updated_at, d.truncated, c.id AS chunk_id, c.text, c.location
      FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.id = ? AND d.excluded = 0`)
    return ids.flatMap((id) => {
      const row = get.get(id) as HitRow | undefined
      return row
        ? [
            {
              documentId: row.document_id,
              path: row.path,
              name: row.name,
              chunkId: row.chunk_id,
              text: row.text,
              location: row.location,
              score: scores.get(id)! + (recency.get(id) ?? 0),
              hash: row.hash,
              mtimeMs: row.mtime_ms,
              sizeBytes: row.size_bytes,
              indexedAt: indexedAt(row.updated_at),
              truncated: !!row.truncated,
              ...(isOcrLocation(row.location) ? { ocr: true } : {}),
            },
          ]
        : []
    })
  }

  readChunk(chunkId: number): DocumentMemoryHit | null {
    const row = this.db
      .prepare(
        `SELECT d.id AS document_id, d.path, d.name, d.hash, d.mtime_ms, d.size_bytes, d.updated_at, d.truncated, c.id AS chunk_id, c.text, c.location
      FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.id = ? AND d.excluded = 0`,
      )
      .get(chunkId) as HitRow | undefined
    return row
      ? {
          documentId: row.document_id,
          path: row.path,
          name: row.name,
          chunkId: row.chunk_id,
          text: row.text,
          location: row.location,
          score: 0,
          hash: row.hash,
          mtimeMs: row.mtime_ms,
          sizeBytes: row.size_bytes,
          indexedAt: indexedAt(row.updated_at),
          truncated: !!row.truncated,
          ...(isOcrLocation(row.location) ? { ocr: true } : {}),
        }
      : null
  }

  /** Library totals from the per-document counters (one pass over the documents table). */
  stats(): DocumentMemoryStats {
    const counts = this.countSource()
    return this.db
      .prepare(
        `${counts.with}
        SELECT count(*) AS docs,
          coalesce(sum(${counts.total}), 0) AS chunks,
          coalesce(sum(${counts.done}), 0) AS vectors,
          coalesce(sum(CASE WHEN d.status = 'error' THEN 1 ELSE 0 END), 0) AS errors
        FROM documents d WHERE d.excluded = 0`,
      )
      .get() as unknown as DocumentMemoryStats
  }

  /**
   * SQL fragments giving every document's chunk and vector counts (alias `d`). Normally these are
   * the stored counters. While a backfill is outstanding, documents without counters are counted
   * from the covering indexes (still no BLOB reads) so aggregates stay exact in the meantime.
   */
  private countSource(): { with: string; total: string; done: string } {
    if (!this.hasUncountedDocuments())
      return { with: '', total: 'd.chunk_total', done: 'd.chunk_done' }
    return {
      with: `WITH tot AS MATERIALIZED (SELECT document_id, count(*) AS n FROM chunks GROUP BY document_id),
        dn AS MATERIALIZED (SELECT document_id, count(*) AS n FROM chunks INDEXED BY chunks_vector_lookup
          WHERE vector IS NOT NULL AND vector_dim > 0 GROUP BY document_id)`,
      total: `CASE WHEN d.chunk_counted = 1 THEN d.chunk_total
        ELSE coalesce((SELECT n FROM tot WHERE tot.document_id = d.id), 0) END`,
      done: `CASE WHEN d.chunk_counted = 1 THEN d.chunk_done
        ELSE coalesce((SELECT n FROM dn WHERE dn.document_id = d.id), 0) END`,
    }
  }

  /** Cheap count of documents in the error state (no chunk scan; safe for progress polling). */
  errorCount(): number {
    return (
      this.db
        .prepare("SELECT count(*) AS n FROM documents WHERE excluded = 0 AND status = 'error'")
        .get() as { n: number }
    ).n
  }

  close(): void {
    this.db.close()
  }

  private deleteChunks(documentId: number): void {
    const ids = this.db
      .prepare('SELECT id FROM chunks WHERE document_id = ?')
      .all(documentId) as Array<{ id: number }>
    const delFts = this.db.prepare('DELETE FROM chunk_fts WHERE rowid = ?')
    for (const { id } of ids) delFts.run(id)
    this.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId)
  }

  /** Delete a document's chunks until `outOfBudget()`; true when none remain. */
  private deleteChunksBudgeted(documentId: number, outOfBudget: () => boolean): boolean {
    const delFts = this.db.prepare('DELETE FROM chunk_fts WHERE rowid = ?')
    const delChunk = this.db.prepare('DELETE FROM chunks WHERE id = ?')
    const list = this.db.prepare('SELECT id FROM chunks WHERE document_id = ? LIMIT 64')
    for (;;) {
      const ids = list.all(documentId) as Array<{ id: number }>
      if (!ids.length) return true
      for (const { id } of ids) {
        delFts.run(id)
        delChunk.run(id)
        if (outOfBudget()) return false
      }
    }
  }

  /**
   * Run `step` in repeated short transactions until it reports `done` or `abort`. A step that
   * returns `more` has already done as much as fits the budget; `onMore` runs inside the same
   * transaction to leave the data in a consistent (resumable) state before it commits.
   */
  private async runSliced(
    options: SliceOptions,
    step: (outOfBudget: () => boolean) => 'done' | 'more' | 'abort',
    onMore?: () => void,
  ): Promise<boolean> {
    const budget = options.budgetMs ?? WRITE_SLICE_MS
    for (;;) {
      const started = performance.now()
      let outcome = 'done' as 'done' | 'more' | 'abort'
      this.transaction(() => {
        outcome = step(() => performance.now() - started >= budget)
        if (outcome === 'more') onMore?.()
      })
      if (outcome !== 'more') return outcome === 'done'
      await (options.yield ?? yieldToEventLoop)()
      if (options.shouldContinue && !options.shouldContinue()) return false
    }
  }

  private transaction(work: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      work()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

interface DocRow {
  id: number
  path: string
  name: string
  status: DocumentStatus
  mtime_ms: number | null
  size_bytes: number | null
  hash: string | null
  error: string | null
  truncated: number
}
interface HitRow {
  document_id: number
  path: string
  name: string
  hash: string | null
  mtime_ms: number | null
  size_bytes: number | null
  updated_at: number | null
  truncated: number
  chunk_id: number
  text: string
  location: string
}
function toDocument(row: DocRow): StoredDocument {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    status: row.status,
    mtimeMs: row.mtime_ms,
    sizeBytes: row.size_bytes,
    hash: row.hash,
    error: row.error,
    truncated: !!row.truncated,
  }
}
function quoteFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`
}
function floatBlob(vector: number[]): Uint8Array {
  const copy = new Float32Array(vector)
  return new Uint8Array(copy.buffer)
}
/** View a stored BLOB as float32 without per-element copies (copy once only if misaligned). */
function blobVector(blob: Uint8Array, dim: number): Float32Array {
  if (blob.byteLength !== dim * Float32Array.BYTES_PER_ELEMENT) return new Float32Array(0)
  if (blob.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0)
    return new Float32Array(blob.buffer, blob.byteOffset, dim)
  const copy = blob.slice()
  return new Float32Array(copy.buffer, copy.byteOffset, dim)
}
function indexedAt(updatedAtSeconds: number | null): number | null {
  return typeof updatedAtSeconds === 'number' ? updatedAtSeconds * 1000 : null
}
function cosine(a: ArrayLike<number>, b: ArrayLike<number>, aa: number): number {
  if (a.length !== b.length || !a.length) return Number.NaN
  let dot = 0,
    bb = 0
  for (let i = 0; i < a.length; i++) {
    const y = b[i]!
    if (!Number.isFinite(y)) return Number.NaN
    dot += a[i]! * y
    bb += y * y
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0
}
function validateReplacement(replacement: ReplacementDocument): void {
  if (
    !Number.isFinite(replacement.mtimeMs) ||
    !Number.isFinite(replacement.sizeBytes) ||
    replacement.sizeBytes < 0
  )
    throw new Error('Invalid document metadata')
  if (!replacement.hash) throw new Error('Document hash is required')
  if (replacement.chunks.some((chunk) => !chunk.text.trim() || !chunk.location.trim()))
    throw new Error('Document chunks must contain text and a location')
  if (replacement.chunks.some((chunk) => !!chunk.vector && chunk.vector.length === 0))
    throw new Error('Document vectors cannot be empty')
  if (replacement.chunks.some((chunk) => !!chunk.vector && !replacement.embeddingModel))
    throw new Error('An embedding model is required when vectors are stored')
  const vectors = replacement.chunks.map((chunk) => chunk.vector)
  const dimensions = new Set(vectors.filter((v): v is number[] => !!v).map((v) => v.length))
  if (dimensions.size > 1) throw new Error('Document vectors must have a consistent dimension')
  if (vectors.some((v) => v && v.some((n) => !Number.isFinite(n))))
    throw new Error('Document vectors must contain only finite numbers')
}
