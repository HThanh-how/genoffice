import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  generateCollisionSafeBackupPath,
  getCanonicalBackupPath,
} from '../src/main/document-memory/storage/migration/backup-retention'
import { migrateStorageV2ToV3 } from '../src/main/document-memory/storage-migration'
import {
  recoverInterruptedCutover,
  getManifestPath,
  type CutoverStateManifest,
} from '../src/main/document-memory/storage/migration/cutover'

function createMinimalV2Db(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY,
      path TEXT UNIQUE,
      name TEXT,
      status TEXT,
      mtime_ms INTEGER,
      size_bytes INTEGER,
      hash TEXT,
      embedding_model TEXT,
      active_chunk_set_id INTEGER,
      error TEXT,
      excluded INTEGER,
      truncated INTEGER,
      truncated_reason TEXT,
      last_opened_at INTEGER,
      priority_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE document_chunks (
      id INTEGER PRIMARY KEY,
      document_id INTEGER,
      chunk_index INTEGER,
      content TEXT,
      token_count INTEGER,
      tsv TEXT
    );
    CREATE TABLE document_embeddings (
      id INTEGER PRIMARY KEY,
      document_id INTEGER,
      chunk_id INTEGER,
      model TEXT,
      dimensions INTEGER,
      embedding BLOB,
      created_at INTEGER
    );
  `)
  db.prepare(`
    INSERT INTO documents (id, path, status) VALUES (1, 'doc1.txt', 'completed')
  `).run()
  db.prepare(`
    INSERT INTO document_chunks (id, document_id, chunk_index, content) VALUES (1, 1, 0, 'sample content')
  `).run()
  db.close()
}

describe('Collision-Safe Backup Naming Suite (QA-06)', () => {
  let tempDir: string
  let dbPath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-backup-col-'))
    dbPath = join(tempDir, 'document-memory.db')
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it('BACKUPCOL-01: no previous backup -> migration successfully produces a collision-safe backup file', () => {
    createMinimalV2Db(dbPath)

    const result = migrateStorageV2ToV3(dbPath, {
      activeSpaceId: 'test-space',
      activeDimensions: 384,
    })

    expect(result.success).toBe(true)
    expect(existsSync(result.backupDbPath)).toBe(true)
    expect(result.backupDbPath).toMatch(/\.v2\.\d+\.[a-zA-Z0-9_-]+\.backup\.db$/)
  })

  it('BACKUPCOL-02: existing backup file on disk -> generates different distinct path', () => {
    createMinimalV2Db(dbPath)

    const path1 = generateCollisionSafeBackupPath(dbPath)
    writeFileSync(path1, 'dummy backup 1', 'utf8')

    const path2 = generateCollisionSafeBackupPath(dbPath)
    expect(path1).not.toBe(path2)
    expect(existsSync(path2)).toBe(false)
  })

  it('BACKUPCOL-03: multiple backup generations produce unique paths', () => {
    createMinimalV2Db(dbPath)

    const pathA = generateCollisionSafeBackupPath(dbPath)
    writeFileSync(pathA, 'data A', 'utf8')

    const pathB = generateCollisionSafeBackupPath(dbPath)
    writeFileSync(pathB, 'data B', 'utf8')

    const pathC = generateCollisionSafeBackupPath(dbPath)
    writeFileSync(pathC, 'data C', 'utf8')

    const uniqueSet = new Set([pathA, pathB, pathC])
    expect(uniqueSet.size).toBe(3)
  })

  it('BACKUPCOL-04: recovery uses exact manifest backup path', () => {
    createMinimalV2Db(dbPath)
    const customBackupPath = generateCollisionSafeBackupPath(dbPath)
    writeFileSync(customBackupPath, 'content of custom backup', 'utf8')

    const manifestPath = getManifestPath(dbPath)
    const manifest: CutoverStateManifest = {
      phase: 'source-backed-up',
      sourceDbPath: dbPath,
      tempPath: `${dbPath}.v3.tmp.db`,
      backupPath: customBackupPath,
      timestamp: Date.now(),
    }
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8')

    // Source db currently moved
    if (existsSync(dbPath)) {
      rmSync(dbPath)
    }

    const recovered = recoverInterruptedCutover(dbPath)
    expect(recovered).toBe(true)
    expect(existsSync(dbPath)).toBe(true)
    expect(readFileSync(dbPath, 'utf8')).toBe('content of custom backup')
  })

  it('BACKUPCOL-05: Windows existing destination or canonical backup does not collide or break migration', () => {
    createMinimalV2Db(dbPath)

    // Pre-create canonical legacy backup name to simulate legacy collision
    const canonicalBackup = getCanonicalBackupPath(dbPath)
    writeFileSync(canonicalBackup, 'pre-existing old backup', 'utf8')

    const result = migrateStorageV2ToV3(dbPath, {
      activeSpaceId: 'test-space',
      activeDimensions: 384,
    })

    expect(result.success).toBe(true)
    expect(result.backupDbPath).not.toBe(canonicalBackup)
    expect(existsSync(result.backupDbPath)).toBe(true)
    // Legacy canonical backup remains untouched
    expect(readFileSync(canonicalBackup, 'utf8')).toBe('pre-existing old backup')
  })
})
