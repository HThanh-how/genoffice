import type { DatabaseSync } from 'node:sqlite'
import { migrateDocumentImportance } from './migration/document-importance'
import { migrateCacheRetentionSchema } from './migration/cache-retention'
import { migrateNameSearchProjection } from './migration/name-search-projection'
import { ensureDocumentMediaSchema } from './migration/document-media'

/**
 * CANONICAL SCHEMA V3 (Single Source of Truth - Invariant INV-08)
 * 
 * Strict physical schema rules:
 * - Table `chunks` contains ONLY: id, document_id, chunk_set_id, ordinal, text, location.
 * - Table `chunk_embeddings` is the SOLE canonical vector store.
 * - Table `document_embedding_counts` tracks per-document, per-space completed chunk counts.
 * - Table `documents` includes `truncated_reason` check constraint.
 * - Invariant INV-03: chunks table MUST NOT have `vector`, `vector_dim`, or `normalized`.
 */
export const CANONICAL_BASE_TABLES_SQL = `
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
  truncated_reason TEXT CHECK (truncated_reason IN ('chunk-limit', 'content-limit', 'pdf-page-limit', 'tabular-sampling') OR truncated_reason IS NULL),
  last_opened_at INTEGER NOT NULL DEFAULT 0,
  priority_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  chunk_total INTEGER NOT NULL DEFAULT 0,
  chunk_done INTEGER NOT NULL DEFAULT 0,
  chunk_counted INTEGER NOT NULL DEFAULT 0,
  content_evicted INTEGER NOT NULL DEFAULT 0 CHECK (content_evicted IN (0, 1)),
  importance_override TEXT NOT NULL DEFAULT 'auto' CHECK (importance_override IN ('auto', 'important', 'low')),
  importance_suggestion TEXT NOT NULL DEFAULT 'unknown' CHECK (importance_suggestion IN ('unknown', 'normal', 'important')),
  importance_reason TEXT,
  importance_updated_at INTEGER NOT NULL DEFAULT 0
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
  location TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_embedding_counts (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES embedding_spaces(id) ON DELETE CASCADE,
  completed_chunks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(document_id, space_id)
);

CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES embedding_spaces(id) ON DELETE CASCADE,
  vector BLOB NOT NULL,
  vector_dim INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (chunk_id, space_id)
);

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

CREATE TABLE IF NOT EXISTS document_memory_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export const CANONICAL_DEPENDENT_SCHEMA_SQL = `
CREATE INDEX IF NOT EXISTS chunk_embeddings_space ON chunk_embeddings(space_id, chunk_id);
CREATE INDEX IF NOT EXISTS chunks_document_id ON chunks(document_id);
CREATE INDEX IF NOT EXISTS documents_excluded_status ON documents(excluded, status);
CREATE INDEX IF NOT EXISTS documents_priority ON documents(excluded, priority_at DESC);
-- Foreign-key children: without an index SQLite scans the whole child table for every parent row it deletes
-- (chunk_sets for a document, chunks for a chunk set), which made deleting one document cost milliseconds per
-- 100k rows and a purge of thousands of them minutes.
CREATE INDEX IF NOT EXISTS chunk_sets_document_id ON chunk_sets(document_id);
CREATE INDEX IF NOT EXISTS chunks_chunk_set_id ON chunks(chunk_set_id);
-- Rename detection looks up other documents of the same size before it hashes a new file.
CREATE INDEX IF NOT EXISTS documents_size_bytes ON documents(size_bytes);

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(text, tokenize='unicode61 remove_diacritics 2');

CREATE VIRTUAL TABLE IF NOT EXISTS document_name_fts USING fts5(
  name,
  path,
  content='documents',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2',
  prefix='3'
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

CREATE TRIGGER IF NOT EXISTS chunks_counter_insert AFTER INSERT ON chunks BEGIN
  UPDATE documents SET chunk_total = chunk_total + 1 WHERE id = new.document_id;
END;

CREATE TRIGGER IF NOT EXISTS chunks_counter_delete AFTER DELETE ON chunks BEGIN
  UPDATE documents SET chunk_total = chunk_total - 1 WHERE id = old.document_id;
END;
`

export const CANONICAL_SCHEMA_V3 = `${CANONICAL_BASE_TABLES_SQL}
${CANONICAL_DEPENDENT_SCHEMA_SQL}
`

function getTableColumnNames(db: DatabaseSync, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return new Set(rows.map((r) => r.name))
}

/**
 * Applies the canonical V3 schema to the database.
 * Strict dependency ordering:
 * 1. Base tables created first so documents, chunks, and metadata exist.
 * 2. Additive columns ensured on existing databases with pre-existing tables.
 * 3. Additive migrations run with errors explicitly propagated to caller.
 * 4. Dependent indexes, virtual tables, and triggers created.
 * 5. Metadata and configuration initialized.
 */
export function applyCanonicalSchemaV3(db: DatabaseSync): void {
  // 1. Create base tables first so documents and meta tables exist
  db.exec(CANONICAL_BASE_TABLES_SQL)

  // 2. Additive column migrations for existing databases
  const docCols = getTableColumnNames(db, 'documents')
  if (!docCols.has('priority_at')) {
    db.exec('ALTER TABLE documents ADD COLUMN priority_at INTEGER NOT NULL DEFAULT 0;')
  }
  if (!docCols.has('last_opened_at')) {
    db.exec('ALTER TABLE documents ADD COLUMN last_opened_at INTEGER NOT NULL DEFAULT 0;')
  }
  if (!docCols.has('truncated')) {
    db.exec('ALTER TABLE documents ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0;')
  }
  if (!docCols.has('truncated_reason')) {
    db.exec('ALTER TABLE documents ADD COLUMN truncated_reason TEXT;')
  }
  if (!docCols.has('active_chunk_set_id')) {
    db.exec('ALTER TABLE documents ADD COLUMN active_chunk_set_id INTEGER;')
  }
  if (!docCols.has('chunk_total')) {
    db.exec('ALTER TABLE documents ADD COLUMN chunk_total INTEGER NOT NULL DEFAULT 0;')
  }
  if (!docCols.has('chunk_done')) {
    db.exec('ALTER TABLE documents ADD COLUMN chunk_done INTEGER NOT NULL DEFAULT 0;')
  }
  if (!docCols.has('chunk_counted')) {
    db.exec('ALTER TABLE documents ADD COLUMN chunk_counted INTEGER NOT NULL DEFAULT 0;')
  }

  const chunkCols = getTableColumnNames(db, 'chunks')
  if (!chunkCols.has('chunk_set_id')) {
    db.exec('ALTER TABLE chunks ADD COLUMN chunk_set_id INTEGER;')
  }

  // 3. Additive migrations with strict error checking (Requirement 3)
  migrateDocumentImportance(db)

  const cacheRetentionResult = migrateCacheRetentionSchema(db)
  if (cacheRetentionResult.error) {
    throw new Error(`Cache retention migration failed: ${cacheRetentionResult.error}`)
  }

  const nameProjResult = migrateNameSearchProjection(db)
  if (nameProjResult.error) {
    throw new Error(`Name search projection migration failed: ${nameProjResult.error}`)
  }

  ensureDocumentMediaSchema(db)

  // 4. Create dependent indexes, virtual tables, and triggers (Requirement 1 & 2)
  const hadNameFts = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'document_name_fts'").get(),
  )
  db.exec(CANONICAL_DEPENDENT_SCHEMA_SQL)
  if (!hadNameFts) {
    // The external-content name index was just created empty: index the rows that already exist,
    // otherwise legacy documents are unsearchable by name and the 'delete' half of
    // documents_name_au hits rows the index never saw (SQLITE_CORRUPT on rename).
    db.exec("INSERT INTO document_name_fts(document_name_fts) VALUES('rebuild')")
  }

  // 5. Schema version marker initialization
  db.prepare(`
    INSERT INTO document_memory_meta (key, value)
    VALUES ('schema_version', '3'), ('name_fts_version', '1')
    ON CONFLICT(key) DO NOTHING;
  `).run()

  // 6. Legacy vector migration if legacy vector column exists in chunks
  if (chunkCols.has('vector')) {
    db.exec(`
      INSERT OR IGNORE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      SELECT DISTINCT coalesce(d.embedding_model, 'legacy'), coalesce(d.embedding_model, 'legacy'), 'pinned', 'mean', coalesce(c.vector_dim, 384), 'fp32'
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.vector IS NOT NULL;

      INSERT OR IGNORE INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim, created_at)
      SELECT c.id, coalesce(d.embedding_model, 'legacy'), c.vector, coalesce(c.vector_dim, length(c.vector) / 4), unixepoch()
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.vector IS NOT NULL;

      INSERT OR REPLACE INTO document_embedding_counts (document_id, space_id, completed_chunks)
      SELECT c.document_id, e.space_id, count(e.chunk_id)
      FROM chunks c
      JOIN chunk_embeddings e ON e.chunk_id = c.id
      GROUP BY c.document_id, e.space_id;
    `)
  }

  // 7. Configure chunk_fts automerge
  try {
    const hasFtsConfig = Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunk_fts_config'").get(),
    )
    if (hasFtsConfig) {
      const autoMerge = db.prepare("SELECT v FROM chunk_fts_config WHERE k = 'automerge'").get()
      if (!autoMerge) {
        db.exec("INSERT INTO chunk_fts(chunk_fts, rank) VALUES('automerge', 0);")
      }
    } else {
      db.exec("INSERT INTO chunk_fts(chunk_fts, rank) VALUES('automerge', 0);")
    }
  } catch (err: unknown) {
    console.debug('[schema-v3] automerge config skipped or already configured:', err)
  }
}
