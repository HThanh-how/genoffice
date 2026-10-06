import { issueReason, type IndexIssue } from './issues'
import { topVectors } from './top-vectors'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import {
  documentIndexFields,
  queryTokens,
} from './normalization'
import { OcrSidecar, isOcrLocation } from './ocr-sidecar'
import {
  LEGACY_E5_EMBEDDING_ID,
  LEGACY_VIETNAMESE_EMBEDDING_ID,
  type EmbeddingProfile,
} from './embedding-profiles'
import { fuseHybridResults } from './hybrid-ranker'
import { activateSet, createBuildingSet, retireOldSets } from './chunk-sets'
import { USearchIndex } from './usearch-index'
import { ANN_MIN_VECTORS } from './ann-index'
import { defaultSqliteCacheKiB } from './memory-tier'
import { HotMetadataSearch } from './hot-metadata-search'

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
  semanticCoverage?: number
  activeEmbeddingSpace?: string
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
  semanticCoverage?: number
  activeEmbeddingSpace?: string
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
  active_chunk_set_id INTEGER,
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
CREATE TABLE IF NOT EXISTS embedding_spaces (
  id TEXT PRIMARY KEY,
  model_repo TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  pooling TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  quantization TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS chunk_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunker_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('building', 'active', 'retired')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_set_id INTEGER REFERENCES chunk_sets(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  normalized TEXT NOT NULL,
  location TEXT NOT NULL,
  vector BLOB,
  vector_dim INTEGER,
  CHECK ((vector IS NULL AND vector_dim IS NULL) OR (vector IS NOT NULL AND vector_dim > 0))
);
CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES embedding_spaces(id) ON DELETE CASCADE,
  vector BLOB NOT NULL,
  vector_dim INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (chunk_id, space_id)
);
CREATE INDEX IF NOT EXISTS chunk_embeddings_space ON chunk_embeddings(space_id, chunk_id);
CREATE TABLE IF NOT EXISTS embedding_migrations (
  target_space_id TEXT PRIMARY KEY,
  source_space_id TEXT,
  total_chunks INTEGER NOT NULL DEFAULT 0,
  completed_chunks INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'paused', 'complete', 'failed')),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chunk_migrations (
  version INTEGER PRIMARY KEY,
  total_documents INTEGER NOT NULL,
  completed_documents INTEGER NOT NULL,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ann_indexes (
  space_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL DEFAULT 0,
  desired_generation INTEGER NOT NULL DEFAULT 0,
  file_path TEXT,
  indexed_count INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'dirty',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(text, tokenize='unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE IF NOT EXISTS document_name_fts USING fts5(
  name,
  path,
  content='documents',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2',
  prefix='3 4'
);
CREATE TRIGGER IF NOT EXISTS documents_name_ai AFTER INSERT ON documents BEGIN
  INSERT INTO document_name_fts(rowid, name, path) VALUES(new.id, new.name, new.path);
END;
CREATE TRIGGER IF NOT EXISTS documents_name_ad AFTER DELETE ON documents BEGIN
  INSERT INTO document_name_fts(document_name_fts, rowid, name, path) VALUES('delete', old.id, old.name, old.path);
END;
CREATE TRIGGER IF NOT EXISTS documents_name_au AFTER UPDATE OF name, path ON documents BEGIN
  INSERT INTO document_name_fts(document_name_fts, rowid, name, path) VALUES('delete', old.id, old.name, old.path);
  INSERT INTO document_name_fts(rowid, name, path) VALUES(new.id, new.name, new.path);
END;
CREATE TABLE IF NOT EXISTS document_memory_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
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
  role?: 'search' | 'worker'
  cacheKiB?: number
}

/** Durable memory for explicitly opened documents. Only enrolled documents are searchable. */
export class DocumentMemoryStore {
  readonly role: 'search' | 'worker'
  private readonly db: DatabaseSync
  readonly dbPath: string
  private readonly searchOptions: Required<Omit<DocumentMemorySearchOptions, 'role' | 'cacheKiB'>>
  private ocrSidecar: OcrSidecar | null = null
  private readonly annIndexes = new Map<string, USearchIndex>()
  private readonly hotMetadataSearch: HotMetadataSearch

  /** Text transcribed by the scanned-PDF reader (see ocr-sidecar.ts). */
  get ocr(): OcrSidecar {
    return (this.ocrSidecar ??= new OcrSidecar(this.db))
  }

  get rawDb(): DatabaseSync {
    return this.db
  }

  constructor(dbPath: string, options: DocumentMemorySearchOptions = {}) {
    this.role = options.role ?? 'search'
    this.dbPath = dbPath
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
    const cacheKiB = options.cacheKiB ?? defaultSqliteCacheKiB(options.role ?? 'search')
    this.db.exec(`PRAGMA cache_size = -${cacheKiB};`)
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
    this.migrateEmbeddingSchema()
    this.migrateChunkCounters()
    this.ensureNameFtsV1()
    this.hotMetadataSearch = new HotMetadataSearch(this.db)
    // a blank Word/Excel/Markdown file used to be filed as "scanned, needs OCR": only a PDF can be
    this.db.exec(
      `UPDATE documents SET error = 'No readable text in this file; there is nothing to search'
       WHERE status = 'empty' AND error = 'No readable text; scanned documents need OCR'
         AND lower(path) NOT LIKE '%.pdf'`,
    )
    try {
      chmodSync(resolve(dbPath), 0o600)
    } catch {
      // Some filesystems and in-memory databases do not support chmod.
    }
  }

  private ensureNameFtsV1(): void {
    const row = this.db
      .prepare("SELECT value FROM document_memory_meta WHERE key = 'name_fts_version'")
      .get() as { value: string } | undefined
    if (!row || row.value !== '1') {
      try {
        this.transaction(() => {
          this.db.prepare("INSERT INTO document_name_fts(document_name_fts) VALUES('rebuild')").run()
          this.db
            .prepare(
              "INSERT OR REPLACE INTO document_memory_meta(key, value) VALUES('name_fts_version', '1')",
            )
            .run()
        })
      } catch {
        // If rebuild fails, transaction rolls back and version is not written, allowing retry next startup
      }
    }
  }

  /**
   * Migrate legacy schema to V2: ensure embedding spaces exist and copy legacy vectors
   * from chunks.vector to chunk_embeddings without recomputing.
   */
  private migrateEmbeddingSchema(): void {
    const docColumns = (
      this.db.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>
    ).map((c) => c.name)
    if (!docColumns.includes('active_chunk_set_id')) {
      this.db.exec('ALTER TABLE documents ADD COLUMN active_chunk_set_id INTEGER')
    }

    const chunkColumns = (
      this.db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>
    ).map((c) => c.name)
    if (!chunkColumns.includes('chunk_set_id')) {
      this.db.exec('ALTER TABLE chunks ADD COLUMN chunk_set_id INTEGER')
    }

    const annColumns = (
      this.db.prepare('PRAGMA table_info(ann_indexes)').all() as Array<{ name: string }>
    ).map((c) => c.name)
    if (!annColumns.includes('desired_generation')) {
      this.db.exec('ALTER TABLE ann_indexes ADD COLUMN desired_generation INTEGER NOT NULL DEFAULT 0')
    }

    const indexList = this.db.prepare("PRAGMA index_list('chunks')").all() as Array<{
      name: string
      unique: number
    }>
    const hasOldUnique = indexList.some(
      (idx) => idx.unique === 1 && idx.name.startsWith('sqlite_autoindex_chunks_'),
    )
    if (hasOldUnique) {
      this.db.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE chunks_v2_migration (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          chunk_set_id INTEGER REFERENCES chunk_sets(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL,
          text TEXT NOT NULL,
          normalized TEXT NOT NULL,
          location TEXT NOT NULL,
          vector BLOB,
          vector_dim INTEGER,
          CHECK ((vector IS NULL AND vector_dim IS NULL) OR (vector IS NOT NULL AND vector_dim > 0))
        );
        INSERT INTO chunks_v2_migration (id, document_id, chunk_set_id, ordinal, text, normalized, location, vector, vector_dim)
        SELECT id, document_id, chunk_set_id, ordinal, text, normalized, location, vector, vector_dim FROM chunks;
        DROP TABLE chunks;
        ALTER TABLE chunks_v2_migration RENAME TO chunks;
        PRAGMA foreign_keys = ON;
      `)
    }

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS chunks_set_ordinal ON chunks(chunk_set_id, ordinal) WHERE chunk_set_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS chunks_legacy_doc_ordinal ON chunks(document_id, ordinal) WHERE chunk_set_id IS NULL;
      CREATE INDEX IF NOT EXISTS chunks_chunk_set_id ON chunks(chunk_set_id);
      CREATE INDEX IF NOT EXISTS chunks_document_id ON chunks(document_id);
      CREATE INDEX IF NOT EXISTS chunks_vector_lookup ON chunks(vector_dim, document_id) WHERE vector IS NOT NULL;
    `)

    this.db.exec(`
      DROP TRIGGER IF EXISTS documents_ai_name;
      DROP TRIGGER IF EXISTS documents_ad_name;
      DROP TRIGGER IF EXISTS documents_au_name;
    `)

    // Ensure legacy spaces exist
    this.db.prepare(`
      INSERT OR IGNORE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES
        (?, 'Xenova/multilingual-e5-small', '761b726dd34fb83930e26aab4e9ac3899aa1fa78', 'mean', 384, 'q8'),
        (?, 'AITeamVN/Vietnamese_Embedding', 'dea33aa1ab339f38d66ae0a40e6c40e0a9249568', 'sentence', 1024, 'fp32')
    `).run(LEGACY_E5_EMBEDDING_ID, LEGACY_VIETNAMESE_EMBEDDING_ID)

    // Copy legacy vectors from chunks into chunk_embeddings without recomputing
    this.db.prepare(`
      INSERT OR IGNORE INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim)
      SELECT c.id, ?, c.vector, c.vector_dim
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.vector IS NOT NULL AND (d.embedding_model IS NULL OR d.embedding_model = ?)
    `).run(LEGACY_E5_EMBEDDING_ID, LEGACY_E5_EMBEDDING_ID)

    this.db.prepare(`
      INSERT OR IGNORE INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim)
      SELECT c.id, ?, c.vector, c.vector_dim
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.vector IS NOT NULL AND d.embedding_model = ?
    `).run(LEGACY_VIETNAMESE_EMBEDDING_ID, LEGACY_VIETNAMESE_EMBEDDING_ID)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunk_migrations (
        version INTEGER PRIMARY KEY,
        total_documents INTEGER NOT NULL,
        completed_documents INTEGER NOT NULL,
        state TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES ('v2_chunk_migrations', unixepoch());
    `)
  }

  ensureEmbeddingSpace(profile: EmbeddingProfile): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      profile.embeddingId,
      profile.repo,
      profile.revision,
      profile.pooling,
      profile.dimensions,
      'q8',
    )
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

  /** Count a folder, or the complete library when no folder is selected. */
  folderChunkProgress(root?: string): FolderChunkProgress {
    const normalized = root === undefined ? null : resolve(root)
    const prefix =
      normalized === null
        ? null
        : normalized.endsWith('/') || normalized.endsWith('\\')
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
          WHERE d.excluded = 0 ${normalized === null ? '' : 'AND (d.path = ? OR substr(d.path, 1, length(?)) = ?)'})`,
      )
      .get(...(normalized === null ? [] : [normalized, prefix!, prefix!])) as
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

  /** OCR changes searchable text without changing the source file; persist the need to re-read. */
  markOcrPending(path: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE documents SET status = 'pending', error = NULL, updated_at = unixepoch() WHERE path = ? AND excluded = 0",
      )
      .run(resolve(path))
    return Number(result.changes) > 0
  }

  documentPriority(path: string): number {
    const row = this.db
      .prepare('SELECT priority_at FROM documents WHERE path = ?')
      .get(resolve(path)) as { priority_at: number } | undefined
    return row?.priority_at ?? 0
  }

  /** Indexed files with one of these legacy extensions (lower-case, with the dot), newest first. */
  legacyPaths(extensions: readonly string[], limit: number): string[] {
    if (extensions.length === 0) return []
    const clauses = extensions.map(() => 'lower(path) LIKE ?').join(' OR ')
    return (
      this.db
        .prepare(
          `SELECT path FROM documents WHERE excluded = 0 AND (${clauses})
          ORDER BY priority_at DESC, id DESC LIMIT ?`,
        )
        .all(...extensions.map((e) => `%${e}`), limit) as Array<{ path: string }>
    ).map((r) => r.path)
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
      const chunkSetId = createBuildingSet(this.db, row.id, 2)
      this.updateReplacedDocument(row.id, normalizedPath, replacement)
      const insert = this.chunkInserter(row.id, replacement.embeddingModel, chunkSetId)
      replacement.chunks.forEach((chunk, ordinal) => insert(chunk, ordinal))
      activateSet(this.db, row.id, chunkSetId)
      this.deleteOldChunksForDocument(row.id, chunkSetId)
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
    let next = 0
    let first = true
    let documentId = 0
    let chunkSetId = 0
    let insert: ReturnType<DocumentMemoryStore['chunkInserter']> | null = null
    return this.runSliced(
      options,
      (outOfBudget) => {
        if (first) {
          documentId = this.lockDocumentForReplace(normalizedPath).id
          chunkSetId = createBuildingSet(this.db, documentId, 2)
          first = false
        } else {
          const row = this.db
            .prepare('SELECT excluded FROM documents WHERE id = ?')
            .get(documentId) as { excluded: number } | undefined
          if (!row || row.excluded) return 'abort'
        }
        insert ??= this.chunkInserter(documentId, replacement.embeddingModel, chunkSetId)
        while (next < replacement.chunks.length) {
          insert(replacement.chunks[next]!, next)
          next++
          if (next < replacement.chunks.length && outOfBudget()) return 'more'
        }
        this.updateReplacedDocument(documentId, normalizedPath, replacement)
        activateSet(this.db, documentId, chunkSetId)
        this.deleteOldChunksForDocument(documentId, chunkSetId)
        return 'done'
      },
      () => this.markPending(documentId),
    )
  }

  deleteOldChunksForDocument(documentId: number, activeChunkSetId: number): void {
    const oldChunkIds = this.db
      .prepare(
        'SELECT id FROM chunks WHERE document_id = ? AND (chunk_set_id IS NULL OR chunk_set_id <> ?)',
      )
      .all(documentId, activeChunkSetId) as Array<{ id: number }>
    if (!oldChunkIds.length) return
    const delFts = this.db.prepare('DELETE FROM chunk_fts WHERE rowid = ?')
    const delChunk = this.db.prepare('DELETE FROM chunks WHERE id = ?')
    for (const { id } of oldChunkIds) {
      delFts.run(id)
      delChunk.run(id)
    }
    retireOldSets(this.db, documentId)
    const chunkIds = oldChunkIds.map((c) => c.id)
    if (this.role === 'worker') {
      for (const [spaceId, ann] of this.annIndexes.entries()) {
        try {
          if (ann.isAvailable()) {
            ann.removeSync(chunkIds)
            if (!ann.isHealthy()) {
              this.markAnnDirty(spaceId)
            }
          }
        } catch {
          this.markAnnDirty(spaceId)
        }
      }
    } else {
      for (const spaceId of this.annIndexes.keys()) {
        this.markAnnDirty(spaceId)
      }
    }
  }

  /**
   * Cleans up orphaned or incomplete building chunk sets created before an interruption/crash (MIG-14).
   * Ensures dangling chunks and FTS rows are purged before resuming migration.
   */
  cleanupDanglingBuildingSets(): number {
    const danglingSets = this.db
      .prepare("SELECT id, document_id FROM chunk_sets WHERE state = 'building'")
      .all() as Array<{ id: number; document_id: number }>

    if (!danglingSets.length) return 0

    this.transaction(() => {
      const delFts = this.db.prepare('DELETE FROM chunk_fts WHERE rowid = ?')
      const delChunk = this.db.prepare('DELETE FROM chunks WHERE id = ?')
      const delSet = this.db.prepare('DELETE FROM chunk_sets WHERE id = ?')

      for (const set of danglingSets) {
        const chunks = this.db
          .prepare('SELECT id FROM chunks WHERE chunk_set_id = ?')
          .all(set.id) as Array<{ id: number }>
        for (const c of chunks) {
          delFts.run(c.id)
          delChunk.run(c.id)
        }
        delSet.run(set.id)
      }
    })

    return danglingSets.length
  }

  /**
   * Retrieves documents requiring chunk upgrade to Chunker V2, prioritized by:
   * 1. priority_at DESC (recently opened/searched documents first)
   * 2. size_bytes ASC (small documents first)
   * 3. id ASC (consistent order for rest)
   */
  getDocumentsNeedingChunkUpgrade(limit = 100): Array<{
    id: number
    path: string
    name: string
    priorityAt: number
    sizeBytes: number
  }> {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.path, d.name, d.priority_at, d.size_bytes
         FROM documents d
         LEFT JOIN chunk_sets s ON s.id = d.active_chunk_set_id
         WHERE d.excluded = 0 AND d.status = 'ready'
           AND (d.active_chunk_set_id IS NULL OR s.chunker_version < 2 OR s.state <> 'active')
           AND EXISTS (SELECT 1 FROM chunks c WHERE c.document_id = d.id)
         ORDER BY d.priority_at DESC, coalesce(d.size_bytes, 0) ASC, d.id ASC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      id: number
      path: string
      name: string
      priority_at: number
      size_bytes: number
    }>

    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      name: r.name,
      priorityAt: r.priority_at,
      sizeBytes: r.size_bytes,
    }))
  }

  /**
   * Gets current chunk migration status from chunk_migrations table.
   */
  getChunkMigrationProgress(version = 2): {
    version: number
    totalDocuments: number
    completedDocuments: number
    state: 'pending' | 'running' | 'paused' | 'complete' | 'failed'
    updatedAt: number
  } | null {
    const row = this.db
      .prepare(
        `SELECT version, total_documents, completed_documents, state, updated_at
         FROM chunk_migrations WHERE version = ?`,
      )
      .get(version) as
      | {
          version: number
          total_documents: number
          completed_documents: number
          state: 'pending' | 'running' | 'paused' | 'complete' | 'failed'
          updated_at: number
        }
      | undefined

    if (!row) return null
    return {
      version: row.version,
      totalDocuments: row.total_documents,
      completedDocuments: row.completed_documents,
      state: row.state,
      updatedAt: row.updated_at,
    }
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
        replacement.sizeBytes ?? null,
        replacement.hash ?? null,
        replacement.embeddingModel ?? null,
        replacement.error ?? null,
        replacement.truncated ? 1 : 0,
        id,
      )
  }

  private chunkInserter(
    documentId: number,
    embeddingModel?: string | null,
    chunkSetId?: number | null,
  ): (chunk: ReplacementDocument['chunks'][number], ordinal: number) => void {
    const addChunk = this.db
      .prepare(`INSERT INTO chunks(document_id, chunk_set_id, ordinal, text, normalized, location, vector, vector_dim)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    const addFts = this.db.prepare('INSERT INTO chunk_fts(rowid, text) VALUES (?, ?)')
    const addChunkEmbedding = this.db.prepare(`
      INSERT OR REPLACE INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim)
      VALUES (?, ?, ?, ?)
    `)
    const ensureSpace = this.db.prepare(`
      INSERT OR IGNORE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES (?, ?, 'pinned', 'last-token', ?, 'q8')
    `)
    return (chunk, ordinal) => {
      const fields = documentIndexFields(chunk.text)
      const result = addChunk.run(
        documentId,
        chunkSetId ?? null,
        ordinal,
        chunk.text,
        fields.normalized,
        chunk.location,
        chunk.vector ? floatBlob(chunk.vector) : null,
        chunk.vector?.length ?? null,
      )
      addFts.run(result.lastInsertRowid, fields.searchText)
      if (chunk.vector && embeddingModel) {
        ensureSpace.run(embeddingModel, embeddingModel, chunk.vector.length)
        addChunkEmbedding.run(
          result.lastInsertRowid,
          embeddingModel,
          floatBlob(chunk.vector),
          chunk.vector.length,
        )
        if (this.role === 'worker') {
          try {
            const ann = this.getAnnIndex(embeddingModel, chunk.vector.length)
            if (ann.isAvailable()) {
              ann.addSync([Number(result.lastInsertRowid)], [chunk.vector])
            }
          } catch {
            // Non-blocking ANN update
          }
        } else {
          this.markAnnDirty(embeddingModel)
        }
      }
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

  /** Add one embedding batch to chunk_embeddings without replacing chunks or invalidating their IDs. */
  setChunkEmbeddings(
    path: string,
    hash: string,
    offset: number,
    vectors: number[][],
    embeddingSpaceId: string,
    complete: boolean,
  ): void {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid vector offset')
    if (!embeddingSpaceId) throw new Error('Embedding space ID is required')
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

      const chunkRows = this.db
        .prepare(
          `SELECT c.id, c.ordinal FROM chunks c
           JOIN documents d ON d.id = c.document_id
           WHERE c.document_id = ?
             AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)
             AND c.ordinal >= ?
           ORDER BY c.ordinal ASC LIMIT ?`,
        )
        .all(document.id, offset, vectors.length) as Array<{ id: number; ordinal: number }>

      if (chunkRows.length !== vectors.length) {
        throw new Error('Vector batch does not match indexed chunks')
      }

      this.db
        .prepare(
          `INSERT OR IGNORE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
           VALUES (?, ?, 'pinned', 'last-token', ?, 'q8')`,
        )
        .run(embeddingSpaceId, embeddingSpaceId, dimensions.values().next().value ?? 384)

      const insertEmbedding = this.db.prepare(`
        INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (chunk_id, space_id)
        DO UPDATE SET
          vector = excluded.vector,
          vector_dim = excluded.vector_dim,
          created_at = unixepoch()
      `)

      const updateChunkLegacy = this.db.prepare(
        'UPDATE chunks SET vector = ?, vector_dim = ? WHERE id = ?',
      )

      vectors.forEach((vector, index) => {
        const chunk = chunkRows[index]!
        const blob = floatBlob(vector)
        insertEmbedding.run(chunk.id, embeddingSpaceId, blob, vector.length)
        updateChunkLegacy.run(blob, vector.length, chunk.id)
      })

      const count = this.db
        .prepare(
          `SELECT count(*) AS total, count(e.chunk_id) AS vectors
           FROM chunks c
           JOIN documents d ON d.id = c.document_id
           LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.space_id = ?
           WHERE c.document_id = ?
             AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)`,
        )
        .get(embeddingSpaceId, document.id) as { total: number; vectors: number }

      if (complete && count.total !== count.vectors)
        throw new Error('Document vector batches are incomplete')

      this.db
        .prepare(
          `UPDATE documents SET embedding_model = ?, status = ?, error = NULL, updated_at = unixepoch()
           WHERE id = ?`,
        )
        .run(embeddingSpaceId, complete ? 'ready' : 'text-only', document.id)
    })
    if (this.role === 'worker') {
      try {
        const ann = this.getAnnIndex(embeddingSpaceId, vectors[0]!.length)
        if (ann.isAvailable()) {
          const chunkRows = this.db
            .prepare(
              `SELECT c.id FROM chunks c
               JOIN documents d ON d.id = c.document_id
               WHERE c.document_id = (SELECT id FROM documents WHERE path = ?)
                 AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)
                 AND c.ordinal >= ?
               ORDER BY c.ordinal ASC LIMIT ?`,
            )
            .all(normalizedPath, offset, vectors.length) as Array<{ id: number }>
          if (chunkRows.length === vectors.length) {
            ann.addSync(chunkRows.map((c) => c.id), vectors)
          }
          if (!ann.isHealthy()) {
            this.markAnnDirty(embeddingSpaceId)
          } else {
            this.db
              .prepare(
                `UPDATE ann_indexes SET indexed_count = (SELECT count(*) FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id JOIN documents d ON d.id = c.document_id WHERE e.space_id = ? AND d.excluded = 0 AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)), updated_at = unixepoch() WHERE space_id = ?`,
              )
              .run(embeddingSpaceId, embeddingSpaceId)
          }
        }
      } catch {
        this.markAnnDirty(embeddingSpaceId)
      }
    } else {
      this.markAnnDirty(embeddingSpaceId)
    }
  }

  setChunkVectors(
    path: string,
    hash: string,
    offset: number,
    vectors: number[][],
    embeddingModel: string,
    complete: boolean,
  ): void {
    return this.setChunkEmbeddings(path, hash, offset, vectors, embeddingModel, complete)
  }

  recordMigrationEmbeddings(
    embeddingSpaceId: string,
    batch: Array<{ chunkId: number; vector: number[] }>,
  ): void {
    if (!batch.length) return
    this.transaction(() => {
      const insert = this.db.prepare(`
        INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (chunk_id, space_id)
        DO UPDATE SET
          vector = excluded.vector,
          vector_dim = excluded.vector_dim,
          created_at = unixepoch()
      `)
      for (const item of batch) {
        insert.run(item.chunkId, embeddingSpaceId, floatBlob(item.vector), item.vector.length)
      }
    })
    if (this.role === 'worker') {
      try {
        const ann = this.getAnnIndex(embeddingSpaceId, batch[0]!.vector.length)
        if (ann.isAvailable()) {
          ann.addSync(
            batch.map((b) => b.chunkId),
            batch.map((b) => b.vector),
          )
          if (!ann.isHealthy()) {
            this.markAnnDirty(embeddingSpaceId)
          } else {
            this.db
              .prepare(
                `UPDATE ann_indexes SET indexed_count = (SELECT count(*) FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id JOIN documents d ON d.id = c.document_id WHERE e.space_id = ? AND d.excluded = 0 AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)), updated_at = unixepoch() WHERE space_id = ?`,
              )
              .run(embeddingSpaceId, embeddingSpaceId)
          }
        }
      } catch {
        this.markAnnDirty(embeddingSpaceId)
      }
    } else {
      this.markAnnDirty(embeddingSpaceId)
    }
  }

  /** Find a committed embedding checkpoint, retaining chunk IDs and completed vectors. */
  resumeEmbeddingOffset(path: string, hash: string, embeddingSpaceId: string): number | null {
    const doc = this.db
      .prepare('SELECT id, hash, embedding_model, excluded, status FROM documents WHERE path = ?')
      .get(resolve(path)) as
      | {
          id: number
          hash: string | null
          embedding_model: string | null
          excluded: number
          status: string
        }
      | undefined
    if (
      !doc ||
      doc.excluded ||
      doc.hash !== hash ||
      // A file still waiting to be read has no complete text stored, whatever hash it carries
      // (the folder scan records one, and an interrupted write leaves part of the text):
      // resuming would skip storing the text and leave the file waiting for good.
      doc.status === 'pending'
    )
      return null

    const row = this.db
      .prepare(`
        SELECT min(c.ordinal) AS missing, count(*) AS total
        FROM chunks c
        JOIN documents d ON d.id = c.document_id
        LEFT JOIN chunk_embeddings e
          ON e.chunk_id = c.id
          AND e.space_id = ?
        WHERE c.document_id = ?
          AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)
          AND e.chunk_id IS NULL
      `)
      .get(embeddingSpaceId, doc.id) as { missing: number | null; total: number }

    return row.missing ?? row.total
  }

  resumeVectorOffset(path: string, hash: string, model: string): number | null {
    return this.resumeEmbeddingOffset(path, hash, model)
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
   * Files whose NAME (or its folders) fits the question, using SQLite document_name_fts
   * and hot metadata scoring.
   */
  searchNames(query: string, limit = 5): DocumentMemoryHit[] {
    return this.hotMetadataSearch.searchNames(query, limit)
  }

  recent(limit = 20): StoredDocument[] {
    return this.hotMetadataSearch.recent(limit)
  }

  /**
   * Batch hydrate chunk hits into DocumentMemoryHit objects in a single SQL query.
   */
  hydrateChunkHits(
    hits: Array<{ chunkId: number; rank?: number; score?: number }>,
  ): DocumentMemoryHit[] {
    if (!hits.length) return []
    const placeholders = hits.map(() => '?').join(',')
    const chunkIds = hits.map((h) => h.chunkId)
    const rows = this.db
      .prepare(
        `SELECT
           c.id, c.text, c.location, c.document_id,
           d.path, d.name, d.status, d.hash, d.mtime_ms, d.size_bytes, d.updated_at, d.truncated
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
         WHERE c.id IN (${placeholders})
           AND d.excluded = 0
           AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)`,
      )
      .all(...chunkIds) as Array<{
      id: number
      text: string
      location: string
      document_id: number
      path: string
      name: string
      status: string
      hash: string | null
      mtime_ms: number | null
      size_bytes: number | null
      updated_at: number
      truncated: number
    }>

    const rowMap = new Map<number, (typeof rows)[number]>()
    for (const row of rows) {
      rowMap.set(row.id, row)
    }

    const result: DocumentMemoryHit[] = []
    for (const hit of hits) {
      const row = rowMap.get(hit.chunkId)
      if (!row) continue
      result.push({
        documentId: row.document_id,
        path: row.path,
        name: row.name,
        chunkId: row.id,
        text: row.text,
        location: row.location,
        score: hit.score ?? 0,
        hash: row.hash,
        mtimeMs: row.mtime_ms,
        sizeBytes: row.size_bytes,
        indexedAt: row.updated_at * 1000,
        truncated: row.truncated === 1,
      })
    }
    return result
  }

  /** Standalone lexical search using FTS5 (BM25) */
  searchLexical(
    query: string,
    limit = 200,
  ): Array<{ chunkId: number; rank: number; score: number; documentId: number }> {
    const tokens = queryTokens(query)
    if (!tokens.length) return []
    const match = tokens.map(quoteFtsToken).join(' OR ')
    const rows = this.db
      .prepare(
        `SELECT f.rowid AS chunk_id, bm25(chunk_fts) AS rank, c.document_id
         FROM chunk_fts f
         JOIN chunks c ON c.id = f.rowid
         JOIN documents d ON d.id = c.document_id
         WHERE chunk_fts MATCH ? AND d.excluded = 0
           AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)
         ORDER BY rank LIMIT ?`,
      )
      .all(match, limit) as Array<{ chunk_id: number; rank: number; document_id: number }>

    const results: Array<{ chunkId: number; rank: number; score: number; documentId: number }> = []
    let rank = 0
    let previousRank: number | undefined
    rows.forEach((row, index) => {
      if (previousRank !== row.rank) rank = index + 1
      results.push({
        chunkId: row.chunk_id,
        rank,
        score: row.rank,
        documentId: row.document_id,
      })
      previousRank = row.rank
    })
    return results
  }

  /** Standalone semantic search using chunk_embeddings and cosine similarity (exact fallback) */
  searchSemantic(
    vector: number[],
    limit = 200,
    embeddingSpaceId?: string,
  ): Array<{ chunkId: number; rank: number; score: number; documentId: number }> {
    if (vector.some((v) => !Number.isFinite(v))) {
      throw new Error('Query vector must contain only finite numbers')
    }
    let queryNorm = 0
    for (const value of vector) queryNorm += value * value

    // Check if we have chunk_embeddings for this space
    const countRow = this.db
      .prepare(
        `SELECT count(*) AS count
         FROM chunk_embeddings e
         JOIN chunks c ON c.id = e.chunk_id
         JOIN documents d ON d.id = c.document_id
         WHERE d.excluded = 0 AND (? IS NULL OR e.space_id = ?)
           AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)`,
      )
      .get(embeddingSpaceId ?? null, embeddingSpaceId ?? null) as { count: number }

    const legacyCountRow =
      countRow.count === 0
        ? (this.db
            .prepare(
              `SELECT count(*) AS count FROM chunks c JOIN documents d ON d.id = c.document_id
               WHERE d.excluded = 0 AND c.vector IS NOT NULL AND c.vector_dim = ?
                 AND (? IS NULL OR d.embedding_model = ?)
                 AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)`,
            )
            .get(vector.length, embeddingSpaceId ?? null, embeddingSpaceId ?? null) as {
            count: number
          })
        : { count: 0 }

    if (countRow.count === 0 && legacyCountRow.count === 0) {
      return []
    }

    // Production ANN routing: when semantic vector count >= ANN_MIN_VECTORS (20k), query USearchIndex
    // Strict contract: ONLY trust ANN if state is 'ready', coverage matches canonical count, and index is healthy
    if (countRow.count >= ANN_MIN_VECTORS && embeddingSpaceId) {
      try {
        const annMeta = this.db
          .prepare(
            'SELECT generation, desired_generation, indexed_count, state FROM ann_indexes WHERE space_id = ?',
          )
          .get(embeddingSpaceId) as
          | { generation: number; desired_generation: number; indexed_count: number; state: string }
          | undefined

        const ann = this.getAnnIndex(embeddingSpaceId, vector.length)
        if (
          annMeta &&
          annMeta.state === 'ready' &&
          ann.isHealthy() &&
          typeof ann.getLoadedGeneration === 'function' &&
          typeof ann.reloadSync === 'function' &&
          annMeta.generation !== ann.getLoadedGeneration()
        ) {
          ann.reloadSync(annMeta.generation)
        }

        const isAnnTrusted = Boolean(
          annMeta &&
            annMeta.state === 'ready' &&
            annMeta.generation === annMeta.desired_generation &&
            annMeta.indexed_count === countRow.count &&
            ann.isHealthy() &&
            typeof ann.getLoadedGeneration === 'function' &&
            ann.getLoadedGeneration() === annMeta.generation,
        )

        if (isAnnTrusted) {
          const annHits = ann.searchSync(vector, limit * 2)
          if (!ann.isHealthy()) {
            this.markAnnDirty(embeddingSpaceId)
          } else if (annHits.length > 0) {
            const chunkIds = annHits.map((h) => h.chunkId)
            const placeholders = chunkIds.map(() => '?').join(',')
            const validRows = this.db
              .prepare(
                `SELECT c.id, c.document_id, d.priority_at
                 FROM chunks c
                 JOIN documents d ON d.id = c.document_id
                 WHERE c.id IN (${placeholders}) AND d.excluded = 0
                   AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)`,
              )
              .all(...chunkIds) as Array<{ id: number; document_id: number; priority_at: number }>

            const validMap = new Map(validRows.map((r) => [r.id, r]))
            const hits: Array<{ chunkId: number; rank: number; score: number; documentId: number }> = []
            let rank = 1
            for (const annHit of annHits) {
              const row = validMap.get(annHit.chunkId)
              if (row) {
                hits.push({
                  chunkId: annHit.chunkId,
                  rank: rank++,
                  score: Math.max(0, 1 - annHit.distance),
                  documentId: row.document_id,
                })
                if (hits.length >= limit) break
              }
            }
            if (hits.length > 0) {
              return hits
            }
          }
        } else if (annMeta && !ann.isHealthy()) {
          this.markAnnDirty(embeddingSpaceId)
        }
      } catch {
        // Fallback directly to SQLite exact scan
      }
    }

    function* scoredRows(store: DocumentMemoryStore) {
      if (countRow.count > 0) {
        const rows = store.db
          .prepare(
            `SELECT e.chunk_id AS id, e.vector, e.vector_dim, c.document_id, d.priority_at
             FROM chunk_embeddings e
             JOIN chunks c ON c.id = e.chunk_id
             JOIN documents d ON d.id = c.document_id
             WHERE d.excluded = 0 AND (? IS NULL OR e.space_id = ?)
               AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)
             ORDER BY d.priority_at DESC, d.id DESC`,
          )
          .iterate(embeddingSpaceId ?? null, embeddingSpaceId ?? null) as Iterable<{
            id: number
            vector: Uint8Array
            vector_dim: number
            document_id: number
            priority_at: number
          }>

        let documentRank = 0
        for (const row of rows) {
          if (row.vector_dim !== vector.length) continue
          documentRank++
          const score = cosine(vector, blobVector(row.vector, row.vector_dim), queryNorm)
          yield {
            id: row.id,
            score: score + 1e-8 / documentRank,
            cosineScore: score,
            documentId: row.document_id,
          }
        }
      } else {
        // Fallback to legacy chunks.vector if chunk_embeddings is empty
        const legacyRows = store.db
          .prepare(
            `SELECT c.id, c.vector, c.vector_dim, c.document_id, d.priority_at
             FROM chunks c
             JOIN documents d ON d.id = c.document_id
             WHERE d.excluded = 0 AND c.vector IS NOT NULL AND c.vector_dim = ?
               AND (? IS NULL OR d.embedding_model = ?)
               AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)
             ORDER BY d.priority_at DESC, d.id DESC`,
          )
          .iterate(vector.length, embeddingSpaceId ?? null, embeddingSpaceId ?? null) as Iterable<{
            id: number
            vector: Uint8Array
            vector_dim: number
            document_id: number
            priority_at: number
          }>

        let documentRank = 0
        for (const row of legacyRows) {
          documentRank++
          const score = cosine(vector, blobVector(row.vector, row.vector_dim), queryNorm)
          yield {
            id: row.id,
            score: score + 1e-8 / documentRank,
            cosineScore: score,
            documentId: row.document_id,
          }
        }
      }
    }

    const top = topVectors(scoredRows(this), limit)
    let rank = 0
    let previousScore: number | undefined
    return top.map((item, index) => {
      if (previousScore !== item.cosineScore) rank = index + 1
      previousScore = item.cosineScore
      return {
        chunkId: item.id,
        rank,
        score: item.cosineScore,
        documentId: item.documentId,
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

    const lexicalHits = this.searchLexical(query, 200)
    const semanticHits = vector?.length ? this.searchSemantic(vector, 200, embeddingModel) : []

    if (!lexicalHits.length && !semanticHits.length) return []

    const candidateChunkIds = new Set<number>()
    const chunkToDoc = new Map<number, number>()
    for (const item of lexicalHits) {
      candidateChunkIds.add(item.chunkId)
      chunkToDoc.set(item.chunkId, item.documentId)
    }
    for (const item of semanticHits) {
      candidateChunkIds.add(item.chunkId)
      chunkToDoc.set(item.chunkId, item.documentId)
    }

    const recencyScores = new Map<number, number>()
    if (candidateChunkIds.size > 0) {
      const placeholders = [...candidateChunkIds].map(() => '?').join(',')
      const rows = this.db
        .prepare(
          `SELECT c.id, max(d.last_opened_at, coalesce(d.mtime_ms, 0)) AS recent
           FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id IN (${placeholders})`,
        )
        .all(...candidateChunkIds) as Array<{ id: number; recent: number }>
      const now = Date.now()
      for (const row of rows) {
        const age = Math.max(0, now - row.recent)
        recencyScores.set(row.id, Math.max(0, 1 - age / (90 * 24 * 60 * 60 * 1000)) * 0.00002)
      }
    }

    const fusedHits = fuseHybridResults(
      lexicalHits.map((h) => ({ chunkId: h.chunkId, rank: h.rank, documentId: h.documentId })),
      semanticHits.map((h) => ({ chunkId: h.chunkId, rank: h.rank, documentId: h.documentId })),
      {
        limit,
        maxChunksPerDocument: 2,
        chunkToDocument: chunkToDoc,
        recencyScores,
      },
    )

    if (!fusedHits.length) return []
    const get = this.db
      .prepare(`SELECT d.id AS document_id, d.path, d.name, d.hash, d.mtime_ms, d.size_bytes, d.updated_at, d.truncated, c.id AS chunk_id, c.text, c.location
      FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.id = ? AND d.excluded = 0
        AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)`)

    return fusedHits.flatMap((hit) => {
      const row = get.get(hit.chunkId) as HitRow | undefined
      return row
        ? [
            {
              documentId: row.document_id,
              path: row.path,
              name: row.name,
              chunkId: row.chunk_id,
              text: row.text,
              location: row.location,
              score: hit.score,
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
      WHERE c.id = ? AND d.excluded = 0
        AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)`,
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
  stats(activeEmbeddingSpace?: string): DocumentMemoryStats {
    const counts = this.countSource()
    const base = this.db
      .prepare(
        `${counts.with}
        SELECT count(*) AS docs,
          coalesce(sum(${counts.total}), 0) AS chunks,
          coalesce(sum(${counts.done}), 0) AS vectors,
          coalesce(sum(CASE WHEN d.status = 'error' THEN 1 ELSE 0 END), 0) AS errors
        FROM documents d WHERE d.excluded = 0`,
      )
      .get() as unknown as DocumentMemoryStats

    let semanticCoverage: number | undefined
    if (activeEmbeddingSpace && base.chunks > 0) {
      const spaceCount = this.db
        .prepare(`
          SELECT count(DISTINCT e.chunk_id) AS done
          FROM chunk_embeddings e
          JOIN chunks c ON c.id = e.chunk_id
          JOIN documents d ON d.id = c.document_id
          WHERE e.space_id = ? AND d.excluded = 0
            AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)
        `)
        .get(activeEmbeddingSpace) as { done: number }
      semanticCoverage = Math.min(1, spaceCount.done / base.chunks)
    }

    return {
      ...base,
      ...(semanticCoverage !== undefined ? { semanticCoverage } : {}),
      ...(activeEmbeddingSpace ? { activeEmbeddingSpace } : {}),
    }
  }

  getEmbeddingSpaces(): Array<{
    id: string
    modelRepo: string
    modelRevision: string
    pooling: string
    dimensions: number
    quantization: string
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, model_repo, model_revision, pooling, dimensions, quantization
         FROM embedding_spaces ORDER BY created_at ASC`,
      )
      .all() as Array<{
        id: string
        model_repo: string
        model_revision: string
        pooling: string
        dimensions: number
        quantization: string
      }>
    return rows.map((r) => ({
      id: r.id,
      modelRepo: r.model_repo,
      modelRevision: r.model_revision,
      pooling: r.pooling,
      dimensions: r.dimensions,
      quantization: r.quantization,
    }))
  }

  getAnnIndex(spaceId: string, dimensions: number): USearchIndex {
    let idx = this.annIndexes.get(spaceId)
    if (!idx) {
      const sanitized = spaceId.replace(/[^a-zA-Z0-9_.-]/g, '_')
      const indexPath = join(dirname(this.dbPath), `ann-${sanitized}.usearch`)
      idx = new USearchIndex(dimensions, indexPath)
      this.annIndexes.set(spaceId, idx)
    }
    return idx
  }

  markAnnDirty(spaceId: string): void {
    try {
      this.db
        .prepare(
          `INSERT INTO ann_indexes (space_id, generation, desired_generation, indexed_count, state, updated_at)
           VALUES (?, 0, 1, 0, 'dirty', unixepoch())
           ON CONFLICT(space_id)
           DO UPDATE SET
             desired_generation = desired_generation + 1,
             state = 'dirty',
             updated_at = unixepoch()`,
        )
        .run(spaceId)
    } catch {
      // Non-blocking
    }
  }

  async rebuildAnnIndex(spaceId: string): Promise<{ ok: boolean; count: number }> {
    const sanitized = spaceId.replace(/[^a-zA-Z0-9_.-]/g, '_')
    const fileName = `ann-${sanitized}.usearch`
    this.db
      .prepare(
        `INSERT INTO ann_indexes (space_id, generation, desired_generation, file_path, indexed_count, state, updated_at)
         VALUES (?, 0, 1, ?, 0, 'rebuilding', unixepoch())
         ON CONFLICT (space_id) DO UPDATE SET
           file_path = excluded.file_path,
           desired_generation = CASE WHEN ann_indexes.desired_generation = 0 THEN 1 ELSE ann_indexes.desired_generation END,
           state = 'rebuilding',
           updated_at = unixepoch()`,
      )
      .run(spaceId, fileName)

    const currentMeta = this.db
      .prepare('SELECT generation, desired_generation FROM ann_indexes WHERE space_id = ?')
      .get(spaceId) as { generation?: number; desired_generation?: number } | undefined
    const targetGeneration = currentMeta?.desired_generation ?? 1

    const rows = this.db
      .prepare(
        `SELECT e.chunk_id, e.vector, e.vector_dim
         FROM chunk_embeddings e
         JOIN chunks c ON c.id = e.chunk_id
         JOIN documents d ON d.id = c.document_id
         WHERE e.space_id = ? AND d.excluded = 0
           AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)`,
      )
      .all(spaceId) as Array<{ chunk_id: number; vector: Uint8Array; vector_dim: number }>

    if (!rows.length) {
      const info = this.db
        .prepare(
          `UPDATE ann_indexes
           SET generation = ?,
               indexed_count = 0,
               state = 'ready',
               updated_at = unixepoch()
           WHERE space_id = ? AND desired_generation = ?`,
        )
        .run(targetGeneration, spaceId, targetGeneration)
      if (info.changes === 0) {
        this.db
          .prepare("UPDATE ann_indexes SET state = 'dirty', updated_at = unixepoch() WHERE space_id = ?")
          .run(spaceId)
        return { ok: false, count: 0 }
      }
      return { ok: true, count: 0 }
    }
    const dim = rows[0]!.vector_dim
    const ann = this.getAnnIndex(spaceId, dim)
    const chunkIds = rows.map((r) => r.chunk_id)
    const vectors = rows.map((r) => Array.from(blobVector(r.vector, r.vector_dim)))

    try {
      const success = await ann.rebuildAtomic(chunkIds, vectors, targetGeneration)
      if (success) {
        const info = this.db
          .prepare(
            `UPDATE ann_indexes
             SET generation = ?,
                 indexed_count = ?,
                 state = 'ready',
                 updated_at = unixepoch()
             WHERE space_id = ?
               AND desired_generation = ?`,
          )
          .run(targetGeneration, rows.length, spaceId, targetGeneration)

        if (info.changes === 0) {
          // Canonical data was mutated during rebuild!
          // DO NOT set ready. Keep state = 'dirty' and return { ok: false, count: 0 }
          this.db
            .prepare("UPDATE ann_indexes SET state = 'dirty', updated_at = unixepoch() WHERE space_id = ?")
            .run(spaceId)
          if (typeof ann.markDirty === 'function') {
            ann.markDirty()
          }
          return { ok: false, count: 0 }
        }
        return { ok: true, count: rows.length }
      } else {
        this.db
          .prepare("UPDATE ann_indexes SET state = 'dirty', updated_at = unixepoch() WHERE space_id = ?")
          .run(spaceId)
        if (typeof ann.markDirty === 'function') {
          ann.markDirty()
        }
        return { ok: false, count: 0 }
      }
    } catch {
      this.db
        .prepare("UPDATE ann_indexes SET state = 'dirty', updated_at = unixepoch() WHERE space_id = ?")
        .run(spaceId)
      if (typeof ann.markDirty === 'function') {
        ann.markDirty()
      }
      return { ok: false, count: 0 }
    }
  }

  /** Synchronizes the in-memory/on-disk ANN index for the given space (worker-side entrypoint). */
  async syncAnnIndex(spaceId: string): Promise<{ ok: boolean; count: number }> {
    return this.rebuildAnnIndex(spaceId)
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
    if (ids.length > 0) {
      const chunkIds = ids.map((c) => c.id)
      if (this.role === 'worker') {
        for (const [spaceId, ann] of this.annIndexes.entries()) {
          try {
            if (ann.isAvailable()) {
              ann.removeSync(chunkIds)
              if (!ann.isHealthy()) {
                this.markAnnDirty(spaceId)
              }
            }
          } catch {
            this.markAnnDirty(spaceId)
          }
        }
      } else {
        for (const spaceId of this.annIndexes.keys()) {
          this.markAnnDirty(spaceId)
        }
      }
    }
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
        if (this.role === 'worker') {
          for (const [spaceId, ann] of this.annIndexes.entries()) {
            try {
              if (ann.isAvailable()) {
                ann.removeSync([id])
                if (!ann.isHealthy()) {
                  this.markAnnDirty(spaceId)
                }
              }
            } catch {
              this.markAnnDirty(spaceId)
            }
          }
        } else {
          for (const spaceId of this.annIndexes.keys()) {
            this.markAnnDirty(spaceId)
          }
        }
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
