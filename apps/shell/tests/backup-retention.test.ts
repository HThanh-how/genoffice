import { chmodSync, existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkBackupStatus,
  enforceBackupRetentionPolicy,
  isBackupVerified,
} from '../src/main/document-memory/storage/migration/backup-retention'
import {
  initV3RetentionState,
  readV3RetentionState,
  writeV3RetentionState,
  recordV3VerifiedLaunch,
  V3_RETENTION_FILENAME,
  CANONICAL_V3_RETENTION_FILENAME,
} from '../src/main/document-memory/storage/migration/v3-retention-state'
import { verifyDatabaseIntegrity } from '../src/main/document-memory/storage/migration/logical-verifier'
import { ensureDocumentMemoryStorageReady } from '../src/main/document-memory/storage-bootstrap'
import { DocumentMemoryStore } from '../src/main/document-memory/store'

/**
 * Creates a fully valid SQLite V3 database matching enterprise Canonical Schema V3.
 */
function createValidV3Database(dbPath: string): void {
  const store = new DocumentMemoryStore(dbPath)
  store.close()
}

/**
 * Creates a valid SQLite V2 backup database and sets its file modification timestamp.
 */
function createValidV2Backup(backupPath: string, ageHoursAgo: number): void {
  const db = new DatabaseSync(backupPath)
  db.exec('CREATE TABLE test_backup (id INTEGER PRIMARY KEY, note TEXT);')
  db.exec("INSERT INTO test_backup VALUES (1, 'backup data payload');")
  db.close()

  const targetMtimeMs = Date.now() - ageHoursAgo * 3600 * 1000
  const sec = Math.floor(targetMtimeMs / 1000)
  utimesSync(backupPath, sec, sec)
}

/**
 * Creates a corrupted, non-SQLite binary/text file.
 */
function createCorruptedDatabase(path: string, ageHoursAgo = 0): void {
  writeFileSync(path, 'CORRUPTED_NON_SQLITE_HEADER_PAYLOAD_TEST_DATA_XYZ', 'utf8')
  if (ageHoursAgo > 0) {
    const targetMtimeMs = Date.now() - ageHoursAgo * 3600 * 1000
    const sec = Math.floor(targetMtimeMs / 1000)
    utimesSync(path, sec, sec)
  }
}

describe('V2 Backup Launch-Based Retention Policy Suite (QA-BACKUP Pair 5)', () => {
  let tempDir: string
  let dbPath: string
  let canonicalBackupPath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-qa-backup-ret-'))
    dbPath = join(tempDir, 'document-memory.db')
    canonicalBackupPath = join(tempDir, 'document-memory.v2.backup.db')
  })

  afterEach(() => {
    try {
      // Restore write permissions in case any files were set read-only
      const p1 = join(tempDir, V3_RETENTION_FILENAME)
      const p2 = join(tempDir, CANONICAL_V3_RETENTION_FILENAME)
      if (existsSync(p1)) chmodSync(p1, 0o666)
      if (existsSync(p2)) chmodSync(p2, 0o666)
      if (existsSync(canonicalBackupPath)) chmodSync(canonicalBackupPath, 0o666)
    } catch {}

    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it('RET-01: age 48h + launches=2 -> KEEP', () => {
    // Current V3 database is valid
    createValidV3Database(dbPath)
    expect(verifyDatabaseIntegrity(dbPath).ok).toBe(true)

    // Backup is 48 hours old and valid
    createValidV2Backup(canonicalBackupPath, 48)
    expect(isBackupVerified(canonicalBackupPath)).toBe(true)

    // Retention state recorded 2 verified launches (< 3 required)
    const createdAt48h = Date.now() - 48 * 3600 * 1000
    writeV3RetentionState(tempDir, {
      backupPath: canonicalBackupPath,
      createdAt: createdAt48h,
      verifiedLaunches: 2,
    })

    const purged = enforceBackupRetentionPolicy(dbPath)

    // Invariant: Must KEEP backup because launches (2) < minVerifiedLaunches (3)
    expect(purged).toBe(0)
    expect(existsSync(canonicalBackupPath)).toBe(true)

    const state = readV3RetentionState(tempDir)
    expect(state).not.toBeNull()
    expect(state?.verifiedLaunches).toBe(2)
  })

  it('RET-02: age 10h + launches=3 -> KEEP', () => {
    // Current V3 database is valid
    createValidV3Database(dbPath)
    expect(verifyDatabaseIntegrity(dbPath).ok).toBe(true)

    // Backup is only 10 hours old (< 24h required)
    createValidV2Backup(canonicalBackupPath, 10)
    expect(isBackupVerified(canonicalBackupPath)).toBe(true)

    // Retention state recorded 3 verified launches (meets launch count)
    const createdAt10h = Date.now() - 10 * 3600 * 1000
    writeV3RetentionState(tempDir, {
      backupPath: canonicalBackupPath,
      createdAt: createdAt10h,
      verifiedLaunches: 3,
    })

    const purged = enforceBackupRetentionPolicy(dbPath)

    // Invariant: Must KEEP backup because age (10h) < minAgeHours (24h)
    expect(purged).toBe(0)
    expect(existsSync(canonicalBackupPath)).toBe(true)

    const state = readV3RetentionState(tempDir)
    expect(state).not.toBeNull()
    expect(state?.verifiedLaunches).toBe(3)
  })

  it('RET-03: age 48h + launches=3 + current V3 valid + backup valid -> DELETE', () => {
    // Current V3 database is valid
    createValidV3Database(dbPath)
    expect(verifyDatabaseIntegrity(dbPath).ok).toBe(true)

    // Backup is 48 hours old (>= 24h) and valid
    createValidV2Backup(canonicalBackupPath, 48)
    expect(isBackupVerified(canonicalBackupPath)).toBe(true)

    // Retention state recorded 3 verified launches (>= 3)
    const createdAt48h = Date.now() - 48 * 3600 * 1000
    writeV3RetentionState(tempDir, {
      backupPath: canonicalBackupPath,
      createdAt: createdAt48h,
      verifiedLaunches: 3,
    })

    const purged = enforceBackupRetentionPolicy(dbPath)

    // Invariant: All 4 conditions met -> DELETE backup and reclaim storage
    expect(purged).toBe(1)
    expect(existsSync(canonicalBackupPath)).toBe(false)

    // State must be cleanly cleared after successful purge
    const state = readV3RetentionState(tempDir)
    expect(state).toBeNull()
  })

  it('RET-04: current V3 corrupt -> do not increment launch -> KEEP', async () => {
    // Current V3 database file is corrupted
    createCorruptedDatabase(dbPath)
    expect(verifyDatabaseIntegrity(dbPath).ok).toBe(false)

    // Backup is 48h old and valid
    createValidV2Backup(canonicalBackupPath, 48)
    expect(isBackupVerified(canonicalBackupPath)).toBe(true)

    // Initial state: 2 verified launches
    const createdAt48h = Date.now() - 48 * 3600 * 1000
    writeV3RetentionState(tempDir, {
      backupPath: canonicalBackupPath,
      createdAt: createdAt48h,
      verifiedLaunches: 2,
    })

    // Simulate startup attempt through production bootstrap path
    await ensureDocumentMemoryStorageReady(tempDir)

    // State launch count MUST NOT be incremented when V3 integrity is invalid
    const stateAfterBootstrap = readV3RetentionState(tempDir)
    expect(stateAfterBootstrap?.verifiedLaunches).toBe(2)

    // Retention policy enforcement also rejects purge when V3 is corrupt
    const purged = enforceBackupRetentionPolicy(dbPath)
    expect(purged).toBe(0)
    expect(existsSync(canonicalBackupPath)).toBe(true)
  })

  it('RET-05: backup corrupt -> do not silently call it verified', () => {
    // Current V3 database is valid
    createValidV3Database(dbPath)
    expect(verifyDatabaseIntegrity(dbPath).ok).toBe(true)

    // Backup is corrupted (not valid SQLite)
    createCorruptedDatabase(canonicalBackupPath, 48)

    // Verification check must return false and not crash
    expect(isBackupVerified(canonicalBackupPath)).toBe(false)
    const status = checkBackupStatus(canonicalBackupPath)
    expect(status.exists).toBe(true)
    expect(status.verified).toBe(false)

    // Even if age and launch criteria were satisfied, corrupt backup is not treated as verified
    const createdAt48h = Date.now() - 48 * 3600 * 1000
    writeV3RetentionState(tempDir, {
      backupPath: canonicalBackupPath,
      createdAt: createdAt48h,
      verifiedLaunches: 3,
    })

    const purged = enforceBackupRetentionPolicy(dbPath)
    expect(purged).toBe(0)
    expect(existsSync(canonicalBackupPath)).toBe(true)
  })

  it('RET-06: restart 3 times increments exactly 3, not twice per startup', async () => {
    // Initialize valid V3 database
    createValidV3Database(dbPath)
    expect(verifyDatabaseIntegrity(dbPath).ok).toBe(true)

    // Valid backup present
    createValidV2Backup(canonicalBackupPath, 1)

    // Initialize state post-migration with 0 verified launches
    initV3RetentionState(tempDir, canonicalBackupPath)
    expect(readV3RetentionState(tempDir)?.verifiedLaunches).toBe(0)

    // Startup 1
    const res1 = await ensureDocumentMemoryStorageReady(tempDir)
    expect(res1.ready).toBe(true)
    expect(res1.retentionState?.verifiedLaunches).toBe(1)
    expect(readV3RetentionState(tempDir)?.verifiedLaunches).toBe(1)

    // Startup 2
    const res2 = await ensureDocumentMemoryStorageReady(tempDir)
    expect(res2.ready).toBe(true)
    expect(res2.retentionState?.verifiedLaunches).toBe(2)
    expect(readV3RetentionState(tempDir)?.verifiedLaunches).toBe(2)

    // Startup 3
    const res3 = await ensureDocumentMemoryStorageReady(tempDir)
    expect(res3.ready).toBe(true)
    expect(res3.retentionState?.verifiedLaunches).toBe(3)
    expect(readV3RetentionState(tempDir)?.verifiedLaunches).toBe(3)

    // Backup remains because age is only 1 hour (< 24h)
    expect(existsSync(canonicalBackupPath)).toBe(true)
  })

  it('RET-07: state file write failure -> backup remains', () => {
    // Current V3 database is valid
    createValidV3Database(dbPath)
    expect(verifyDatabaseIntegrity(dbPath).ok).toBe(true)

    // Backup is 48h old and valid
    createValidV2Backup(canonicalBackupPath, 48)
    expect(isBackupVerified(canonicalBackupPath)).toBe(true)

    // Initial state with 2 launches successfully written to disk
    const createdAt48h = Date.now() - 48 * 3600 * 1000
    writeV3RetentionState(tempDir, {
      backupPath: canonicalBackupPath,
      createdAt: createdAt48h,
      verifiedLaunches: 2,
    })

    const p1 = join(tempDir, V3_RETENTION_FILENAME)
    const p2 = join(tempDir, CANONICAL_V3_RETENTION_FILENAME)

    // Lock state files to read-only simulating filesystem write failure (EPERM/EACCES)
    chmodSync(p1, 0o444)
    chmodSync(p2, 0o444)

    // Recording launch encounters write failure; does not throw unhandled error
    expect(() => {
      recordV3VerifiedLaunch(tempDir)
    }).not.toThrow()

    // State on disk could not be persisted as 3; on disk it remains at 2 launches
    const stateOnDisk = readV3RetentionState(tempDir)
    expect(stateOnDisk?.verifiedLaunches).toBe(2)

    // When policy checks disk state, condition (2 < 3) is not met -> backup remains!
    const purged = enforceBackupRetentionPolicy(dbPath)
    expect(purged).toBe(0)
    expect(existsSync(canonicalBackupPath)).toBe(true)

    // Unlock files for cleanup
    chmodSync(p1, 0o666)
    chmodSync(p2, 0o666)
  })
})
