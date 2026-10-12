/**
 * Document Search V3: Backup Collision & Retention Hardening Suite (QA-06)
 *
 * Verifies enterprise backup safety and lifecycle retention invariants:
 * - BACKUP-01: Existing old backups do not collide or get clobbered during migration
 * - BACKUP-02: Repeated migrations create distinct collision-safe backup paths
 * - BACKUP-03: 3 newest verified backups are retained until launch/age conditions are met
 * - BACKUP-04: Backups younger than 24 hours (< 24h) are strictly retained
 * - BACKUP-05: Old 4th verified backup (>= 24h) is eligible for safe reclamation
 * - BACKUP-06: Failed migration backup is rolled back and not treated as completed
 * - BACKUP-07: Recovery uses exact manifest backup path rather than guessing
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkBackupStatus,
  enforceBackupRetentionPolicy,
  generateCollisionSafeBackupPath,
  getCanonicalBackupPath,
  isBackupVerified,
} from '../src/main/document-memory/storage/migration/backup-retention'
import {
  findAllV2Backups,
  readV3RetentionState,
  writeV3RetentionState,
} from '../src/main/document-memory/storage/migration/v3-retention-state'
import {
  getManifestPath,
  recoverInterruptedCutover,
  type CutoverStateManifest,
} from '../src/main/document-memory/storage/migration/cutover'
import { verifyDatabaseIntegrity } from '../src/main/document-memory/storage/migration/logical-verifier'
import { migrateStorageV2ToV3 } from '../src/main/document-memory/storage-migration'
import { DocumentMemoryStore } from '../src/main/document-memory/store'

/**
 * Creates a fully valid V2 schema database with sample records.
 */
function createValidV2Database(path: string, markerPayload = 'v2-data'): void {
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
    CREATE TABLE v2_metadata (
      meta_key TEXT PRIMARY KEY,
      meta_value TEXT
    );
  `)
  db.prepare(
    `
    INSERT INTO documents (id, path, name, status, mtime_ms, size_bytes)
    VALUES (1, 'D:/documents/test.docx', 'test.docx', 'completed', 1700000000000, 1024)
  `,
  ).run()
  db.prepare(
    `
    INSERT INTO document_chunks (id, document_id, chunk_index, content, token_count)
    VALUES (1, 1, 0, 'sample search content', 3)
  `,
  ).run()
  db.prepare(
    `
    INSERT INTO v2_metadata (meta_key, meta_value)
    VALUES ('marker', ?)
  `,
  ).run(markerPayload)
  db.close()
}

/**
 * Creates a valid SQLite V2 backup database and adjusts mtime.
 */
function createValidV2Backup(path: string, ageHoursAgo: number, payload = 'backup-marker'): void {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE backup_test (
      id INTEGER PRIMARY KEY,
      payload TEXT
    );
  `)
  db.prepare('INSERT INTO backup_test (id, payload) VALUES (1, ?)').run(payload)
  db.close()

  const targetMtimeMs = Date.now() - ageHoursAgo * 3600 * 1000
  const sec = Math.floor(targetMtimeMs / 1000)
  utimesSync(path, sec, sec)
}

/**
 * Creates a valid SQLite Canonical Schema V3 database.
 */
function createValidV3Database(path: string): void {
  const store = new DocumentMemoryStore(path)
  store.close()
}

/**
 * Creates a corrupted non-SQLite file.
 */
function createCorruptedFile(path: string, ageHoursAgo = 0): void {
  writeFileSync(path, 'CORRUPTED_NON_SQLITE_BINARY_PAYLOAD_DATA', 'utf8')
  if (ageHoursAgo > 0) {
    const targetMtimeMs = Date.now() - ageHoursAgo * 3600 * 1000
    const sec = Math.floor(targetMtimeMs / 1000)
    utimesSync(path, sec, sec)
  }
}

describe('Document Search V3: Backup Collision & Retention Hardening Suite (QA-06)', () => {
  let tempDir: string
  let dbPath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-qa06-backup-'))
    dbPath = join(tempDir, 'document-memory.db')
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  // BACKUP-01: existing old backup doesn't collide
  it("BACKUP-01 existing old backup doesn't collide", () => {
    createValidV2Database(dbPath, 'original-v2-marker')

    // Scenario 1: Pre-existing canonical backup file on disk
    const canonicalBackup = getCanonicalBackupPath(dbPath)
    writeFileSync(canonicalBackup, 'PRE_EXISTING_CANONICAL_BACKUP_PAYLOAD', 'utf8')

    // Scenario 2: Pre-existing timestamped collision candidate
    const existingCollisionPath = generateCollisionSafeBackupPath(dbPath)
    writeFileSync(existingCollisionPath, 'PRE_EXISTING_TIMESTAMPED_BACKUP_PAYLOAD', 'utf8')

    // Execute migration
    const result = migrateStorageV2ToV3(dbPath, {
      activeSpaceId: 'test-space',
      activeDimensions: 384,
    })

    expect(result.success).toBe(true)
    expect(existsSync(result.backupDbPath)).toBe(true)

    // The newly created backup does NOT collide with either pre-existing backup
    expect(result.backupDbPath).not.toBe(canonicalBackup)
    expect(result.backupDbPath).not.toBe(existingCollisionPath)

    // Pre-existing backup contents are completely intact and untouched
    expect(readFileSync(canonicalBackup, 'utf8')).toBe('PRE_EXISTING_CANONICAL_BACKUP_PAYLOAD')
    expect(readFileSync(existingCollisionPath, 'utf8')).toBe(
      'PRE_EXISTING_TIMESTAMPED_BACKUP_PAYLOAD',
    )

    // Newly generated backup is valid SQLite containing original V2 data
    expect(isBackupVerified(result.backupDbPath)).toBe(true)
    const backupDb = new DatabaseSync(result.backupDbPath)
    try {
      const row = backupDb
        .prepare('SELECT meta_value FROM v2_metadata WHERE meta_key = ?')
        .get('marker') as { meta_value: string }
      expect(row.meta_value).toBe('original-v2-marker')
    } finally {
      backupDb.close()
    }
  })

  // BACKUP-02: second migration creates different backup
  it('BACKUP-02 second migration creates different backup', () => {
    // Migration 1
    createValidV2Database(dbPath, 'migration-1-data')
    const result1 = migrateStorageV2ToV3(dbPath, {
      activeSpaceId: 'test-space',
      activeDimensions: 384,
    })
    expect(result1.success).toBe(true)
    const backupPath1 = result1.backupDbPath
    expect(existsSync(backupPath1)).toBe(true)

    // Simulate second migration: remove V3 db, place new V2 database at dbPath and migrate again
    if (existsSync(dbPath)) {
      rmSync(dbPath)
    }
    createValidV2Database(dbPath, 'migration-2-data')
    const result2 = migrateStorageV2ToV3(dbPath, {
      activeSpaceId: 'test-space',
      activeDimensions: 384,
    })
    expect(result2.success).toBe(true)
    const backupPath2 = result2.backupDbPath
    expect(existsSync(backupPath2)).toBe(true)

    // Second migration creates a completely distinct backup path
    expect(backupPath2).not.toBe(backupPath1)

    // Both distinct backup files exist simultaneously on disk without clobbering each other
    expect(existsSync(backupPath1)).toBe(true)
    expect(existsSync(backupPath2)).toBe(true)

    // Verify independent contents of both backups
    const db1 = new DatabaseSync(backupPath1)
    const db2 = new DatabaseSync(backupPath2)
    try {
      const row1 = db1
        .prepare('SELECT meta_value FROM v2_metadata WHERE meta_key = ?')
        .get('marker') as { meta_value: string }
      const row2 = db2
        .prepare('SELECT meta_value FROM v2_metadata WHERE meta_key = ?')
        .get('marker') as { meta_value: string }
      expect(row1.meta_value).toBe('migration-1-data')
      expect(row2.meta_value).toBe('migration-2-data')
    } finally {
      db1.close()
      db2.close()
    }

    // Direct path generator also produces unique paths on repeated calls
    const pathA = generateCollisionSafeBackupPath(dbPath)
    const pathB = generateCollisionSafeBackupPath(dbPath)
    expect(pathA).not.toBe(pathB)
  })

  // BACKUP-03: 3 newest verified backups retained
  it('BACKUP-03 3 newest verified backups retained', () => {
    createValidV3Database(dbPath)
    expect(verifyDatabaseIntegrity(dbPath).ok).toBe(true)

    const now = Date.now()
    const p1 = `${dbPath}.v2.${now - 30 * 3600 * 1000}.1.backup.db`
    const p2 = `${dbPath}.v2.${now - 40 * 3600 * 1000}.2.backup.db`
    const p3 = `${dbPath}.v2.${now - 50 * 3600 * 1000}.3.backup.db`

    // Create 3 verified backups (all older than 24h)
    createValidV2Backup(p1, 30, 'backup-1')
    createValidV2Backup(p2, 40, 'backup-2')
    createValidV2Backup(p3, 50, 'backup-3')

    expect(isBackupVerified(p1)).toBe(true)
    expect(isBackupVerified(p2)).toBe(true)
    expect(isBackupVerified(p3)).toBe(true)

    // Retention state records launches < 3 (only 2 verified launches)
    writeV3RetentionState(tempDir, {
      backupPath: p1,
      createdAt: now - 30 * 3600 * 1000,
      verifiedLaunches: 2,
    })

    // Enforce policy: because verified launches < 3, NONE of the 3 verified backups are purged
    const purged = enforceBackupRetentionPolicy(dbPath)
    expect(purged).toBe(0)

    // All 3 newest verified backups are retained on disk
    expect(existsSync(p1)).toBe(true)
    expect(existsSync(p2)).toBe(true)
    expect(existsSync(p3)).toBe(true)

    // findAllV2Backups discovers all 3 candidates sorted descending by mtime
    const candidates = findAllV2Backups(tempDir, basename(dbPath))
    expect(candidates.length).toBe(3)
    expect(candidates[0].path).toBe(p1)
    expect(candidates[1].path).toBe(p2)
    expect(candidates[2].path).toBe(p3)
  })

  // BACKUP-04: <24h retained
  it('BACKUP-04 <24h retained', () => {
    createValidV3Database(dbPath)
    expect(verifyDatabaseIntegrity(dbPath).ok).toBe(true)

    const now = Date.now()
    const p1 = `${dbPath}.v2.${now - 1 * 3600 * 1000}.recent1.backup.db`
    const p2 = `${dbPath}.v2.${now - 3 * 3600 * 1000}.recent2.backup.db`
    const p3 = `${dbPath}.v2.${now - 8 * 3600 * 1000}.recent3.backup.db`
    const p4 = `${dbPath}.v2.${now - 16 * 3600 * 1000}.recent4.backup.db`
    const p5 = `${dbPath}.v2.${now - 22 * 3600 * 1000}.recent5.backup.db`

    // Create 5 valid backups, all younger than 24 hours (< 24h)
    createValidV2Backup(p1, 1)
    createValidV2Backup(p2, 3)
    createValidV2Backup(p3, 8)
    createValidV2Backup(p4, 16)
    createValidV2Backup(p5, 22)

    // Even if verified launches requirement (>= 3) is already satisfied
    writeV3RetentionState(tempDir, {
      backupPath: p1,
      createdAt: now - 1 * 3600 * 1000,
      verifiedLaunches: 5,
    })

    const purged = enforceBackupRetentionPolicy(dbPath)

    // Invariant: Zero backups are purged because all backups are < 24h old
    expect(purged).toBe(0)
    expect(existsSync(p1)).toBe(true)
    expect(existsSync(p2)).toBe(true)
    expect(existsSync(p3)).toBe(true)
    expect(existsSync(p4)).toBe(true)
    expect(existsSync(p5)).toBe(true)
  })

  // BACKUP-05: old 4th verified backup eligible
  it('BACKUP-05 old 4th verified backup eligible', () => {
    createValidV3Database(dbPath)
    expect(verifyDatabaseIntegrity(dbPath).ok).toBe(true)

    const now = Date.now()
    // 3 newest backups are < 24h
    const p1 = `${dbPath}.v2.${now - 2 * 3600 * 1000}.new1.backup.db`
    const p2 = `${dbPath}.v2.${now - 4 * 3600 * 1000}.new2.backup.db`
    const p3 = `${dbPath}.v2.${now - 6 * 3600 * 1000}.new3.backup.db`
    // 4th backup is old (48h old, well beyond 24h)
    const p4 = `${dbPath}.v2.${now - 48 * 3600 * 1000}.old4.backup.db`

    createValidV2Backup(p1, 2, 'newest-1')
    createValidV2Backup(p2, 4, 'newest-2')
    createValidV2Backup(p3, 6, 'newest-3')
    createValidV2Backup(p4, 48, 'oldest-4')

    expect(isBackupVerified(p1)).toBe(true)
    expect(isBackupVerified(p2)).toBe(true)
    expect(isBackupVerified(p3)).toBe(true)
    expect(isBackupVerified(p4)).toBe(true)

    // Retention state is tracking the 4th backup with 3 verified launches
    writeV3RetentionState(tempDir, {
      backupPath: p4,
      createdAt: now - 48 * 3600 * 1000,
      verifiedLaunches: 3,
    })

    const purged = enforceBackupRetentionPolicy(dbPath)

    // The old 4th backup is eligible and purged
    expect(purged).toBe(1)
    expect(existsSync(p4)).toBe(false)

    // The 3 newest verified backups (< 24h) are strictly retained
    expect(existsSync(p1)).toBe(true)
    expect(existsSync(p2)).toBe(true)
    expect(existsSync(p3)).toBe(true)
  })

  // BACKUP-06: failed migration backup not treated completed
  it('BACKUP-06 failed migration backup not treated completed', () => {
    createValidV2Database(dbPath, 'v2-data-before-failure')

    // 1. Injected failure during cutover causes automatic rollback
    expect(() => {
      migrateStorageV2ToV3(dbPath, {
        activeSpaceId: 'test-space',
        activeDimensions: 384,
        testFailureInjectionPoint: 'verification-failed',
      })
    }).toThrow(/V2 to V3 migration failed and was safely rolled back/i)

    // Source database is preserved intact after failed migration
    expect(existsSync(dbPath)).toBe(true)
    const restoredDb = new DatabaseSync(dbPath)
    try {
      const row = restoredDb
        .prepare('SELECT meta_value FROM v2_metadata WHERE meta_key = ?')
        .get('marker') as { meta_value: string }
      expect(row.meta_value).toBe('v2-data-before-failure')
    } finally {
      restoredDb.close()
    }

    // Retention state is NOT created with verified launches
    const state = readV3RetentionState(tempDir)
    expect(state).toBeNull()

    // 2. Corrupted / non-SQLite backup file is never treated as verified completed
    const corruptedBackupPath = `${dbPath}.v2.${Date.now()}.corrupt.backup.db`
    createCorruptedFile(corruptedBackupPath, 48)

    expect(isBackupVerified(corruptedBackupPath)).toBe(false)
    const status = checkBackupStatus(corruptedBackupPath)
    expect(status.exists).toBe(true)
    expect(status.verified).toBe(false)

    // Even if assigned to state, policy refuses to purge or treat it as verified
    writeV3RetentionState(tempDir, {
      backupPath: corruptedBackupPath,
      createdAt: Date.now() - 48 * 3600 * 1000,
      verifiedLaunches: 3,
    })
    createValidV3Database(dbPath)

    const purged = enforceBackupRetentionPolicy(dbPath)
    expect(purged).toBe(0)
    expect(existsSync(corruptedBackupPath)).toBe(true)
  })

  // BACKUP-07: recovery uses manifest backup path, not guessed path
  it('BACKUP-07 recovery uses manifest backup path, not guessed path', () => {
    createValidV2Database(dbPath, 'target-location')

    // Generate a collision-safe timestamped backup path (NOT the canonical path)
    const manifestBackupPath = generateCollisionSafeBackupPath(dbPath)
    writeFileSync(manifestBackupPath, 'PAYLOAD_FROM_MANIFEST_RECORDED_BACKUP', 'utf8')

    // Pre-create the canonical backup with different content to test that recovery does NOT guess
    const canonicalGuessedPath = getCanonicalBackupPath(dbPath)
    writeFileSync(canonicalGuessedPath, 'PAYLOAD_FROM_GUESSED_CANONICAL_PATH', 'utf8')

    // Write durable cutover manifest explicitly referencing manifestBackupPath
    const manifestPath = getManifestPath(dbPath)
    const manifest: CutoverStateManifest = {
      phase: 'source-backed-up',
      sourceDbPath: dbPath,
      tempPath: `${dbPath}.v3.tmp.db`,
      backupPath: manifestBackupPath,
      timestamp: Date.now(),
    }
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8')

    // Simulate crash after source was moved to backup: remove source db
    if (existsSync(dbPath)) {
      rmSync(dbPath)
    }
    expect(existsSync(dbPath)).toBe(false)

    // Execute crash recovery
    const recovered = recoverInterruptedCutover(dbPath)
    expect(recovered).toBe(true)

    // Database is restored
    expect(existsSync(dbPath)).toBe(true)

    // Recovery restored the exact file referenced in manifest, NOT the guessed canonical path!
    expect(readFileSync(dbPath, 'utf8')).toBe('PAYLOAD_FROM_MANIFEST_RECORDED_BACKUP')

    // Guessed canonical path was untouched and preserved
    expect(existsSync(canonicalGuessedPath)).toBe(true)
    expect(readFileSync(canonicalGuessedPath, 'utf8')).toBe('PAYLOAD_FROM_GUESSED_CANONICAL_PATH')
  })
})
