import type { DatabaseSync } from 'node:sqlite'

/**
 * Additive schema for REDUNDANCY-AWARE compaction ("smart janitor").
 *
 * Everything here is derived data: it can be dropped and rebuilt from `chunks` at any time and it never holds
 * the only copy of user content (originals on disk are never touched; compaction only shrinks the INDEX).
 *
 * chunk_fingerprints   one 53-bit hash of the normalised text (lowercase, no diacritics/digits/whitespace) per
 *                      chunk. PERSISTED (not computed on the fly) because the alternative re-reads and re-hashes
 *                      every chunk text (>50% of the DB) on every maintenance run; the table costs ~25 bytes per
 *                      chunk (<1% of a chunk's own ~3.7 KB text+FTS+vector) and lets analysis be incremental
 *                      (cursor on chunk id). Cascades away with its chunk.
 * boilerplate_fingerprints  fingerprints seen in >= K distinct documents. Survives the deletion of the very
 *                      chunks that proved it, so a later sibling is still recognised as boilerplate.
 * family_boilerplate_lines  per document family: line fingerprints (digits stripped) that are template text.
 *                      Tiny (one row per template line per family) and, like the table above, survives
 *                      compaction of the siblings.
 * document_redundancy  one compact row per document: family, family size, boilerplate ratio, exact-copy link.
 * document_skeleton    compaction state per document: stage 'vectors' (boilerplate vectors dropped, text intact)
 *                      or 'skeleton' (boilerplate text/FTS dropped, identity + skeleton lines kept). Removed by
 *                      trigger when the document is re-extracted (new active chunk set) or content-evicted, so
 *                      the existing read-now / retry / open paths re-hydrate it without any extra wiring.
 */
export const REDUNDANCY_MIGRATION_ID = '20261010_document_redundancy'

export const REDUNDANCY_DDL = `
CREATE TABLE IF NOT EXISTS chunk_fingerprints (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL,
  fp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chunk_fingerprints_fp ON chunk_fingerprints(fp, document_id);

CREATE TABLE IF NOT EXISTS boilerplate_fingerprints (
  fp INTEGER PRIMARY KEY,
  doc_count INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS family_boilerplate_lines (
  family_key TEXT NOT NULL,
  fp INTEGER NOT NULL,
  PRIMARY KEY (family_key, fp)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS document_redundancy (
  document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  family_key TEXT NOT NULL,
  family_size INTEGER NOT NULL DEFAULT 1,
  boilerplate_ratio REAL NOT NULL DEFAULT -1,
  content_fp INTEGER,
  duplicate_of INTEGER,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  text_bytes INTEGER NOT NULL DEFAULT 0,
  boilerplate_bytes INTEGER NOT NULL DEFAULT 0,
  vector_bytes INTEGER NOT NULL DEFAULT 0,
  hash TEXT,
  chunk_set_id INTEGER,
  computed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS document_redundancy_family ON document_redundancy(family_key);
CREATE INDEX IF NOT EXISTS document_redundancy_content ON document_redundancy(content_fp) WHERE content_fp IS NOT NULL;

CREATE TABLE IF NOT EXISTS document_skeleton (
  document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('vectors', 'skeleton')),
  hash TEXT,
  family_key TEXT,
  kept_chunks INTEGER NOT NULL DEFAULT 0,
  dropped_chunks INTEGER NOT NULL DEFAULT 0,
  dropped_bytes INTEGER NOT NULL DEFAULT 0,
  compacted_at INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS document_skeleton_rehydrate
AFTER UPDATE OF active_chunk_set_id ON documents
WHEN NEW.active_chunk_set_id IS NOT OLD.active_chunk_set_id
BEGIN
  DELETE FROM document_skeleton WHERE document_id = NEW.id;
END;
`

/** Separate because it references documents.content_evicted, which legacy databases gain through a migration. */
const CONTENT_EVICTED_TRIGGER_DDL = `
CREATE TRIGGER IF NOT EXISTS document_skeleton_content_evicted
AFTER UPDATE OF content_evicted ON documents
WHEN NEW.content_evicted = 1 AND OLD.content_evicted = 0
BEGIN
  DELETE FROM document_skeleton WHERE document_id = NEW.id;
END;
`

const REDUNDANCY_TABLES = [
  'chunk_fingerprints',
  'boilerplate_fingerprints',
  'family_boilerplate_lines',
  'document_redundancy',
  'document_skeleton',
] as const

const ensured = new WeakSet<DatabaseSync>()

function tableExists(db: DatabaseSync, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
  } catch {
    return false
  }
}

export function hasSkeletonTable(db: DatabaseSync): boolean {
  return tableExists(db, 'document_skeleton')
}

export function hasRedundancySchema(db: DatabaseSync): boolean {
  return REDUNDANCY_TABLES.every((t) => tableExists(db, t))
}

/** Idempotent. Needs `documents` and `chunks` (the DDL references both). Safe to call on every open. */
export function ensureRedundancySchema(db: DatabaseSync): void {
  if (ensured.has(db)) return
  const needed = db
    .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name IN ('documents', 'chunks')")
    .get() as { c: number }
  if (needed.c < 2) return
  db.exec(REDUNDANCY_DDL)
  try {
    db.exec(CONTENT_EVICTED_TRIGGER_DDL)
  } catch {
    // no content_evicted column yet: the next ensure (after that migration) creates the trigger
  }
  ensured.add(db)
}
