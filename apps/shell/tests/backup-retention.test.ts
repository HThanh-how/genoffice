import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  enforceBackupRetentionPolicy,
  isBackupVerified,
} from '../src/main/document-memory/storage/migration/backup-retention'

function createValidSqliteBackup(path: string, mtimeMs: number): void {
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE test_backup (id INTEGER PRIMARY KEY);')
  db.close()
  const sec = Math.floor(mtimeMs / 1000)
  utimesSync(path, sec, sec)
}

function createCorruptedBackup(path: string, mtimeMs: number): void {
  writeFileSync(path, 'not a valid sqlite database corrupt binary payload', 'utf8')
  const sec = Math.floor(mtimeMs / 1000)
  utimesSync(path, sec, sec)
}

describe('Verified Backup Retention Policy Suite (QA-07)', () => {
  let tempDir: string
  let dbPath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-backup-ret-'))
    dbPath = join(tempDir, 'document-memory.db')
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it('RET-01: newest 3 verified backups are retained even when older than 24h', () => {
    const now = Date.now()
    const p1 = `${dbPath}.v2.${now - 40 * 3600 * 1000}.1.backup.db`
    const p2 = `${dbPath}.v2.${now - 50 * 3600 * 1000}.2.backup.db`
    const p3 = `${dbPath}.v2.${now - 60 * 3600 * 1000}.3.backup.db`
    const p4 = `${dbPath}.v2.${now - 70 * 3600 * 1000}.4.backup.db`

    createValidSqliteBackup(p1, now - 40 * 3600 * 1000)
    createValidSqliteBackup(p2, now - 50 * 3600 * 1000)
    createValidSqliteBackup(p3, now - 60 * 3600 * 1000)
    createValidSqliteBackup(p4, now - 70 * 3600 * 1000)

    const purged = enforceBackupRetentionPolicy(dbPath, 3, 24)
    expect(purged).toBe(1)
    expect(existsSync(p1)).toBe(true)
    expect(existsSync(p2)).toBe(true)
    expect(existsSync(p3)).toBe(true)
    expect(existsSync(p4)).toBe(false)
  })

  it('RET-02: backups younger than 24h are retained regardless of count', () => {
    const now = Date.now()
    const paths: string[] = []

    for (let i = 1; i <= 6; i++) {
      const p = `${dbPath}.v2.${now - i * 3600 * 1000}.${i}.backup.db`
      paths.push(p)
      createValidSqliteBackup(p, now - i * 3600 * 1000)
    }

    const purged = enforceBackupRetentionPolicy(dbPath, 3, 24)
    expect(purged).toBe(0)
    for (const p of paths) {
      expect(existsSync(p)).toBe(true)
    }
  })

  it('RET-03: old 4th backup older than 24h may be safely purged when 3 newer verified exist', () => {
    const now = Date.now()
    const p1 = `${dbPath}.v2.${now - 2 * 3600 * 1000}.1.backup.db`
    const p2 = `${dbPath}.v2.${now - 4 * 3600 * 1000}.2.backup.db`
    const p3 = `${dbPath}.v2.${now - 6 * 3600 * 1000}.3.backup.db`
    const p4 = `${dbPath}.v2.${now - 48 * 3600 * 1000}.4.backup.db`

    createValidSqliteBackup(p1, now - 2 * 3600 * 1000)
    createValidSqliteBackup(p2, now - 4 * 3600 * 1000)
    createValidSqliteBackup(p3, now - 6 * 3600 * 1000)
    createValidSqliteBackup(p4, now - 48 * 3600 * 1000)

    const purged = enforceBackupRetentionPolicy(dbPath, 3, 24)
    expect(purged).toBe(1)
    expect(existsSync(p1)).toBe(true)
    expect(existsSync(p2)).toBe(true)
    expect(existsSync(p3)).toBe(true)
    expect(existsSync(p4)).toBe(false)
  })

  it('RET-04: unverified/corrupted backups are not counted toward the 3 verified copies', () => {
    const now = Date.now()
    // 2 valid verified backups (> 24h)
    const valid1 = `${dbPath}.v2.${now - 40 * 3600 * 1000}.v1.backup.db`
    const valid2 = `${dbPath}.v2.${now - 50 * 3600 * 1000}.v2.backup.db`
    // 2 corrupted backups (> 24h)
    const corrupt1 = `${dbPath}.v2.${now - 30 * 3600 * 1000}.c1.backup.db`
    const corrupt2 = `${dbPath}.v2.${now - 35 * 3600 * 1000}.c2.backup.db`

    createValidSqliteBackup(valid1, now - 40 * 3600 * 1000)
    createValidSqliteBackup(valid2, now - 50 * 3600 * 1000)
    createCorruptedBackup(corrupt1, now - 30 * 3600 * 1000)
    createCorruptedBackup(corrupt2, now - 35 * 3600 * 1000)

    expect(isBackupVerified(valid1)).toBe(true)
    expect(isBackupVerified(valid2)).toBe(true)
    expect(isBackupVerified(corrupt1)).toBe(false)
    expect(isBackupVerified(corrupt2)).toBe(false)

    enforceBackupRetentionPolicy(dbPath, 3, 24)

    // Crucial invariant: The 2 valid backups MUST NOT be deleted because verified count is only 2 (< 3)
    expect(existsSync(valid1)).toBe(true)
    expect(existsSync(valid2)).toBe(true)
  })

  it('RET-05: failure during cleanup never deletes protected backups', () => {
    const now = Date.now()
    const p1 = `${dbPath}.v2.${now - 1000}.1.backup.db`
    const p2 = `${dbPath}.v2.${now - 2000}.2.backup.db`
    const p3 = `${dbPath}.v2.${now - 3000}.3.backup.db`

    createValidSqliteBackup(p1, now - 1000)
    createValidSqliteBackup(p2, now - 2000)
    createValidSqliteBackup(p3, now - 3000)

    // Even if non-existent or error-prone files are around
    expect(() => enforceBackupRetentionPolicy(dbPath, 3, 24)).not.toThrow()
    expect(existsSync(p1)).toBe(true)
    expect(existsSync(p2)).toBe(true)
    expect(existsSync(p3)).toBe(true)
  })
})
