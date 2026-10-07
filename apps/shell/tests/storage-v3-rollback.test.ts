import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  migrateStorageV2ToV3,
  verifyDatabaseIntegrity,
} from '../src/main/document-memory/storage-migration'

describe('Storage V3 Migration Safe Rollback Suite', () => {
  let directory: string
  let dbPath: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genoffice-rollback-'))
    dbPath = join(directory, 'document-memory.db')
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('safely rolls back to original V2 database when verification fails post-cutover', () => {
    // 1. Create a V2 source database
    const v2Db = new DatabaseSync(dbPath)
    v2Db.exec(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        status TEXT NOT NULL
      );
      INSERT INTO documents (id, path, name, status) VALUES (1, 'D:/pre-cutover.docx', 'pre-cutover.docx', 'ready');
    `)
    v2Db.close()

    const backupPath = `${dbPath}.v2.backup.db`

    // 2. Trigger migration with verification-failed injection
    expect(() => {
      migrateStorageV2ToV3(dbPath, {
        activeSpaceId: 'test-space',
        activeDimensions: 384,
        testFailureInjectionPoint: 'verification-failed',
      })
    }).toThrow(/safely rolled back/)

    // 3. Verify rollback restoration
    // Source DB MUST exist and contain original V2 data!
    expect(existsSync(dbPath)).toBe(true)
    expect(existsSync(backupPath)).toBe(false) // Backup was restored back to dbPath

    const restoredDb = new DatabaseSync(dbPath)
    try {
      const doc = restoredDb.prepare('SELECT id, name FROM documents WHERE id = 1').get() as {
        id: number
        name: string
      }
      expect(doc).not.toBeNull()
      expect(doc.name).toBe('pre-cutover.docx')
    } finally {
      restoredDb.close()
    }
  })

  it('safely cleans up and preserves source when error occurs before cutover', () => {
    const v2Db = new DatabaseSync(dbPath)
    v2Db.exec(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        status TEXT NOT NULL
      );
      INSERT INTO documents (id, path, name, status) VALUES (99, 'D:/intact.docx', 'intact.docx', 'ready');
    `)
    v2Db.close()

    const tempPath = `${dbPath}.v3.tmp`

    expect(() => {
      migrateStorageV2ToV3(dbPath, {
        activeSpaceId: 'test-space',
        activeDimensions: 384,
        testFailureInjectionPoint: 'before-cutover',
        tempDbPath: tempPath,
      })
    }).toThrow(/Test injected failure before cutover/)

    // Source DB MUST remain untouched
    expect(existsSync(dbPath)).toBe(true)
    const checkSource = new DatabaseSync(dbPath)
    try {
      const row = checkSource.prepare('SELECT id FROM documents WHERE id = 99').get() as {
        id: number
      }
      expect(row.id).toBe(99)
    } finally {
      checkSource.close()
    }

    const integrity = verifyDatabaseIntegrity(dbPath)
    expect(integrity.ok).toBe(true)
  })
})
