import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  migrateStorageV2ToV3,
  verifyDatabaseIntegrity,
} from '../src/main/document-memory/storage-migration'

describe('Storage V3 Atomic Cutover and Verification Suite', () => {
  let directory: string
  let dbPath: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genoffice-cutover-'))
    dbPath = join(directory, 'document-memory.db')
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('performs atomic cutover with WAL truncate, backup creation, and rigorous integrity checks', () => {
    // 1. Create a valid V2 source database
    const v2Db = new DatabaseSync(dbPath)
    v2Db.exec(`
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
        last_opened_at INTEGER NOT NULL DEFAULT 1700000000,
        priority_at INTEGER NOT NULL DEFAULT 1700000000,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        chunk_total INTEGER NOT NULL DEFAULT 1,
        chunk_done INTEGER NOT NULL DEFAULT 1,
        chunk_counted INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        text TEXT NOT NULL,
        normalized TEXT NOT NULL,
        location TEXT NOT NULL
      );
      INSERT INTO documents (id, path, name, status) VALUES (1, 'D:/test/doc.docx', 'doc.docx', 'ready');
      INSERT INTO chunks (id, document_id, ordinal, text, normalized, location)
      VALUES (10, 1, 0, 'Test cutover chunk text', 'test cutover chunk text', 'Chunk 1');
    `)
    v2Db.close()

    const backupPath = `${dbPath}.v2.backup.db`
    const tempPath = `${dbPath}.v3.tmp`

    // 2. Run cutover
    const result = migrateStorageV2ToV3(dbPath, { backupDbPath: backupPath, tempDbPath: tempPath })

    expect(result.success).toBe(true)
    expect(result.verified).toBe(true)
    expect(result.documentsCopied).toBe(1)
    expect(result.chunksCopied).toBe(1)

    // 3. Verify files on filesystem
    expect(existsSync(dbPath)).toBe(true)
    expect(existsSync(backupPath)).toBe(true) // V2 backup was safely created
    expect(existsSync(tempPath)).toBe(false) // Temp DB was cutover to target

    // 4. Verify SQLite pragmas directly on the migrated database
    const integrity = verifyDatabaseIntegrity(dbPath)
    expect(integrity.ok).toBe(true)
    expect(integrity.integrity).toBe('ok')
    expect(integrity.foreignKeyErrors).toHaveLength(0)

    // 5. Verify PRAGMAs: WAL mode and incremental auto_vacuum
    const rawDb = new DatabaseSync(dbPath)
    try {
      const journalMode = (rawDb.prepare('PRAGMA journal_mode').get() as { journal_mode: string })
        .journal_mode
      expect(journalMode.toLowerCase()).toBe('wal')

      const autoVacuum = (rawDb.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number })
        .auto_vacuum
      // In SQLite: 0 = NONE, 1 = FULL, 2 = INCREMENTAL
      expect(autoVacuum).toBe(2)
    } finally {
      rawDb.close()
    }
  })
})
