import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'

describe('legacy database: document name index', () => {
  let dir: string
  let dbPath: string
  let store: DocumentMemoryStore | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-legacy-namefts-'))
    dbPath = join(dir, 'legacy.sqlite')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, status TEXT NOT NULL,
        mtime_ms REAL, size_bytes INTEGER, hash TEXT, embedding_model TEXT, error TEXT,
        excluded INTEGER NOT NULL DEFAULT 0, truncated INTEGER NOT NULL DEFAULT 0,
        last_opened_at INTEGER NOT NULL DEFAULT 0, priority_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, text TEXT NOT NULL, location TEXT NOT NULL, vector BLOB, vector_dim INTEGER
      );
      CREATE VIRTUAL TABLE chunk_fts USING fts5(text, tokenize='unicode61 remove_diacritics 2');
    `)
    db.prepare("INSERT INTO documents(path, name, status) VALUES ('/legacy/giay ra vien.pdf', 'giay ra vien.pdf', 'ready')").run()
    db.close()
  })

  afterEach(() => {
    store?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('indexes pre-existing documents by name when the name index is first created', () => {
    store = new DocumentMemoryStore(dbPath)
    const hit = store.rawDb
      .prepare("SELECT rowid FROM document_name_fts WHERE document_name_fts MATCH 'vien'")
      .all() as Array<{ rowid: number }>
    expect(hit.map((r) => r.rowid)).toEqual([1])
    const orphan = store.rawDb
      .prepare('SELECT count(*) AS n FROM documents WHERE id NOT IN (SELECT rowid FROM document_name_fts)')
      .get() as { n: number }
    expect(orphan.n).toBe(0)
  })

  it('renames a pre-existing document without corrupting the name index', () => {
    store = new DocumentMemoryStore(dbPath)
    store.rawDb.prepare("UPDATE documents SET name = 'giay xuat vien.pdf' WHERE id = 1").run()
    const hit = store.rawDb
      .prepare("SELECT rowid FROM document_name_fts WHERE document_name_fts MATCH 'xuat'")
      .all() as Array<{ rowid: number }>
    expect(hit.map((r) => r.rowid)).toEqual([1])
    expect(store.rawDb.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
  })
})
