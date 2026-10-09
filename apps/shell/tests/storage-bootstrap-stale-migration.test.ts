import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureDocumentMemoryStorageReady } from '../src/main/document-memory/storage-bootstrap'
import { recoverStaleMigrationArtifacts } from '../src/main/document-memory/storage/migration/stale-artifacts'
import { BOOTSTRAP_LOG_FILE } from '../src/main/document-memory/bootstrap-log'

/** Smallest legacy V2 layout the migration accepts (inline chunk vectors, no chunk_sets). */
function buildLegacyV2(dbPath: string, docs = 5): void {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec(`
    CREATE TABLE documents (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, status TEXT NOT NULL, mtime_ms REAL, size_bytes INTEGER, hash TEXT, embedding_model TEXT, error TEXT, excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)), truncated INTEGER NOT NULL DEFAULT 0, truncated_reason TEXT, last_opened_at INTEGER NOT NULL DEFAULT 0, priority_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT (unixepoch()), chunk_total INTEGER NOT NULL DEFAULT 0, chunk_done INTEGER NOT NULL DEFAULT 0, chunk_counted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, text TEXT NOT NULL, normalized TEXT NOT NULL, location TEXT NOT NULL, vector BLOB, vector_dim INTEGER);
    CREATE VIRTUAL TABLE chunk_fts USING fts5(text);
    CREATE TABLE ocr_pages (path TEXT NOT NULL, page INTEGER NOT NULL, hash TEXT NOT NULL, mtime_ms REAL NOT NULL, size_bytes INTEGER NOT NULL, total_pages INTEGER NOT NULL, text TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (path, page)) WITHOUT ROWID;
    CREATE TABLE pdf_scan_info (path TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, size_bytes INTEGER NOT NULL, total_pages INTEGER NOT NULL, scanned TEXT NOT NULL) WITHOUT ROWID;`)
  const insDoc = db.prepare(`INSERT INTO documents (id, path, name, status, mtime_ms, size_bytes, hash, chunk_total) VALUES (?, ?, ?, 'ready', 1, 1, ?, 2)`)
  const insChunk = db.prepare('INSERT INTO chunks (document_id, ordinal, text, normalized, location) VALUES (?, ?, ?, ?, ?)')
  db.exec('BEGIN')
  for (let d = 1; d <= docs; d++) {
    insDoc.run(d, `/data/doc-${d}.txt`, `doc-${d}.txt`, `h${d}`)
    for (let i = 0; i < 2; i++) insChunk.run(d, i, `hop dong ${d} doan ${i}`, `hop dong ${d} doan ${i}`, `{"p":${i}}`)
  }
  db.exec('COMMIT')
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.close()
}

/** A pid that cannot belong to a running process on this machine. */
const DEAD_PID = 2 ** 22 + 12345

describe('interrupted V2->V3 migration leftovers (killed launch)', () => {
  let dir: string
  let dbPath: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-boot-stale-'))
    dbPath = join(dir, 'document-memory.db')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const leave = (pid: number, startedAt = Date.now()) => {
    writeFileSync(`${dbPath}.migrating`, JSON.stringify({ pid, startedAt }))
    writeFileSync(`${dbPath}.v3.tmp`, 'half-written v3 database')
    writeFileSync(`${dbPath}.v3.tmp-wal`, 'wal')
    writeFileSync(`${dbPath}.v3.tmp-shm`, 'shm')
  }

  it('removes the dead process leftovers, migrates, and records both in document-memory.log', async () => {
    buildLegacyV2(dbPath)
    leave(DEAD_PID)

    const res = await ensureDocumentMemoryStorageReady(dir, { settingsDir: dir })

    expect(res.error).toBeUndefined()
    expect(res.ready).toBe(true)
    expect(res.migrated).toBe(true)
    for (const suffix of ['.migrating', '.v3.tmp', '.v3.tmp-wal', '.v3.tmp-shm']) expect(existsSync(`${dbPath}${suffix}`)).toBe(false)
    const log = readFileSync(join(dir, 'logs', BOOTSTRAP_LOG_FILE), 'utf8')
    expect(log).toContain('Removed leftovers of an interrupted V2->V3 migration')
    expect(log).toContain('V2->V3 migration completed')
  })

  it('treats an unreadable (torn) guard and a guard written by this very process as stale', async () => {
    buildLegacyV2(dbPath)
    leave(DEAD_PID)
    writeFileSync(`${dbPath}.migrating`, '{"pid": 12')
    expect(recoverStaleMigrationArtifacts(dir).removed).toHaveLength(4)
    leave(process.pid)
    expect(recoverStaleMigrationArtifacts(dir).removed).toHaveLength(4)
  })

  it('does not touch the files of a migration another live process is still running', async () => {
    buildLegacyV2(dbPath)
    leave(process.ppid)

    const res = await ensureDocumentMemoryStorageReady(dir, { settingsDir: dir })

    expect(res.ready).toBe(false)
    expect(res.error).toContain(`pid ${process.ppid}`)
    expect(res.error).toContain('retried on the next start')
    expect(existsSync(`${dbPath}.v3.tmp`)).toBe(true)
    expect(readFileSync(join(dir, 'logs', BOOTSTRAP_LOG_FILE), 'utf8')).toContain('Document memory is unavailable')
  })

  it('ignores a live pid whose guard is older than the stale limit (pid reuse)', () => {
    buildLegacyV2(dbPath)
    leave(process.ppid, Date.now() - 7 * 60 * 60 * 1000)
    expect(recoverStaleMigrationArtifacts(dir).removed).toHaveLength(4)
  })

  it('stays fail-closed (and removes nothing) when a cutover manifest exists or the live database is missing', () => {
    leave(DEAD_PID)
    expect(recoverStaleMigrationArtifacts(dir).removed).toEqual([]) // no live database: ambiguous
    buildLegacyV2(dbPath)
    writeFileSync(join(dir, 'document-memory.migration-state.json'), '{}')
    expect(recoverStaleMigrationArtifacts(dir).removed).toEqual([]) // cutover recovery owns this state
    expect(existsSync(`${dbPath}.v3.tmp`)).toBe(true)
  })

  it('writes the real failure reason to the log when the database cannot be used', async () => {
    writeFileSync(dbPath, 'this is not a sqlite database at all, just garbage bytes'.repeat(20))

    const res = await ensureDocumentMemoryStorageReady(dir, { settingsDir: dir })

    expect(res.ready).toBe(false)
    const log = readFileSync(join(dir, 'logs', BOOTSTRAP_LOG_FILE), 'utf8')
    expect(log).toContain('[error]')
    expect(log).toContain(res.error!)
  })
})
