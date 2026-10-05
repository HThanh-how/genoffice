import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'

function floatBlob(vector: number[]): Uint8Array {
  const f32 = new Float32Array(vector)
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)
}

describe('Legacy Schema Migration without Data Loss', () => {
  let directory: string
  let dbPath: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genoffice-legacy-'))
    dbPath = join(directory, 'legacy-memory.sqlite')
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('migrates a V1 database to V2 schema without dropping DB or losing vectors', () => {
    // 1. Manually construct a pure V1 schema database
    const rawDb = new DatabaseSync(dbPath)
    rawDb.exec(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        mtime_ms REAL,
        size_bytes INTEGER,
        hash TEXT,
        embedding_model TEXT,
        error TEXT,
        excluded INTEGER NOT NULL DEFAULT 0,
        truncated INTEGER NOT NULL DEFAULT 0,
        last_opened_at INTEGER NOT NULL DEFAULT 0,
        priority_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        chunk_total INTEGER NOT NULL DEFAULT 0,
        chunk_done INTEGER NOT NULL DEFAULT 0,
        chunk_counted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        text TEXT NOT NULL,
        normalized TEXT NOT NULL,
        location TEXT NOT NULL,
        vector BLOB,
        vector_dim INTEGER,
        UNIQUE(document_id, ordinal)
      );
      CREATE VIRTUAL TABLE chunk_fts USING fts5(text, tokenize='unicode61 remove_diacritics 2');
    `)

    // Insert legacy document & chunk with 2D vector
    const legacyVec = [0.8, 0.6]
    const legacyBlob = floatBlob(legacyVec)

    rawDb.exec(`
      INSERT INTO documents (id, path, name, status, embedding_model, chunk_total, chunk_done, chunk_counted)
      VALUES (1, 'D:/docs/legacy.docx', 'legacy.docx', 'ready', 'legacy-v1-model', 1, 1, 1);
    `)

    rawDb
      .prepare(
        `INSERT INTO chunks (id, document_id, ordinal, text, normalized, location, vector, vector_dim)
         VALUES (1, 1, 0, 'Legacy document content for search', 'legacy document content for search', 'Chunk 1', ?, 2)`,
      )
      .run(legacyBlob)

    rawDb
      .prepare('INSERT INTO chunk_fts (rowid, text) VALUES (1, ?)')
      .run('legacy document content for search')

    rawDb.close()

    // 2. Open this legacy database with DocumentMemoryStore V2
    const store = new DocumentMemoryStore(dbPath)

    try {
      // 3. Verify V1 document is intact
      const doc = store.documentById(1)
      expect(doc).not.toBeNull()
      expect(doc?.name).toBe('legacy.docx')
      expect(doc?.status).toBe('ready')

      // 4. Verify FTS lexical search works immediately
      const lexicalHits = store.searchLexical('Legacy', 10)
      expect(lexicalHits).toHaveLength(1)
      expect(lexicalHits[0]?.chunkId).toBe(1)

      // 5. Verify semantic search works via legacy fallback or migrated chunk_embeddings
      const semanticHits = store.searchSemantic([0.8, 0.6], 10, 'legacy-v1-model')
      expect(semanticHits).toHaveLength(1)
      expect(semanticHits[0]?.chunkId).toBe(1)

      // 6. Verify new schema tables exist
      const directDb = (store as unknown as { db: DatabaseSync }).db
      const tables = directDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>
      const tableNames = tables.map((t) => t.name)

      expect(tableNames).toContain('embedding_spaces')
      expect(tableNames).toContain('chunk_sets')
      expect(tableNames).toContain('chunk_embeddings')
      expect(tableNames).toContain('embedding_migrations')
      expect(tableNames).toContain('ann_indexes')

      // 7. Verify chunk_set_id column exists on chunks table
      const chunkCols = directDb.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>
      expect(chunkCols.some((c) => c.name === 'chunk_set_id')).toBe(true)

      // 8. Verify documents.active_chunk_set_id exists
      const docCols = directDb.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>
      expect(docCols.some((c) => c.name === 'active_chunk_set_id')).toBe(true)
    } finally {
      store.close()
    }
  })
})
