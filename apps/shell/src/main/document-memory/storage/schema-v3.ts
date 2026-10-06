import type { DatabaseSync } from 'node:sqlite'

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
export const CANONICAL_SCHEMA_V3 = `
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
  chunk_set_id INTEGER,
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

CREATE TRIGGER IF NOT EXISTS chunks_counter_insert AFTER INSERT ON chunks BEGIN
  UPDATE documents SET chunk_total = chunk_total + 1 WHERE id = new.document_id;
END;

CREATE TRIGGER IF NOT EXISTS chunks_counter_delete AFTER DELETE ON chunks BEGIN
  UPDATE documents SET chunk_total = chunk_total - 1 WHERE id = old.document_id;
END;

CREATE TABLE IF NOT EXISTS document_memory_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS chunks_document_id ON chunks(document_id);
CREATE INDEX IF NOT EXISTS documents_excluded_status ON documents(excluded, status);
CREATE INDEX IF NOT EXISTS documents_priority ON documents(excluded, priority_at DESC);
`

/**
 * Applies the canonical V3 schema to the database.
 */
export function applyCanonicalSchemaV3(db: DatabaseSync): void {
  try { db.exec('ALTER TABLE documents ADD COLUMN priority_at INTEGER NOT NULL DEFAULT 0;') } catch { /* ignore */ }
  try { db.exec('ALTER TABLE documents ADD COLUMN last_opened_at INTEGER NOT NULL DEFAULT 0;') } catch { /* ignore */ }
  try { db.exec('ALTER TABLE documents ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0;') } catch { /* ignore */ }
  try { db.exec('ALTER TABLE documents ADD COLUMN truncated_reason TEXT;') } catch { /* ignore */ }
  try { db.exec('ALTER TABLE documents ADD COLUMN active_chunk_set_id INTEGER;') } catch { /* ignore */ }
  try { db.exec('ALTER TABLE documents ADD COLUMN chunk_total INTEGER NOT NULL DEFAULT 0;') } catch { /* ignore */ }
  try { db.exec('ALTER TABLE documents ADD COLUMN chunk_done INTEGER NOT NULL DEFAULT 0;') } catch { /* ignore */ }
  try { db.exec('ALTER TABLE documents ADD COLUMN chunk_counted INTEGER NOT NULL DEFAULT 0;') } catch { /* ignore */ }
  db.exec(CANONICAL_SCHEMA_V3)
  try { db.exec('ALTER TABLE chunks ADD COLUMN chunk_set_id INTEGER;') } catch { /* ignore */ }
  try {
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
  } catch { /* chunks.vector might not exist */ }
}
