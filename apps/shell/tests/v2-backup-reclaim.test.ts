import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runRetentionWorkerTask } from '../src/main/document-memory/runtime/backup-retention-worker'
import { collectStorageAccounting } from '../src/main/document-memory/runtime/storage-accounting'
import {
  DEFAULT_BACKUP_RETENTION_DAYS,
  readBackupRetentionDays,
  writeBackupRetentionDays,
} from '../src/main/document-memory/storage/migration/backup-retention-settings'
import {
  readV3RetentionState,
  writeV3RetentionState,
} from '../src/main/document-memory/storage/migration/v3-retention-state'
import {
  deleteV2Backups,
  inventoryV2Backups,
  matchV2BackupFileName,
} from '../src/main/document-memory/storage/migration/v2-backup-files'
import { DocumentMemoryStore } from '../src/main/document-memory/store'

const DAY_MS = 24 * 3600 * 1000
const NAME = 'document-memory.db.v2.1791535907060.e37993d1.backup.db'

function validBackup(path: string, createdAt: number): void {
  rmSync(path, { force: true })
  const db = new DatabaseSync(path)
  db.exec(
    "CREATE TABLE legacy (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO legacy VALUES (1, 'old index');",
  )
  db.close()
  const sec = Math.floor(createdAt / 1000)
  utimesSync(path, sec, sec)
}

describe('V2 backup file pattern', () => {
  const m = (name: string, ci = false) =>
    matchV2BackupFileName(name, 'document-memory.db', { caseInsensitive: ci })

  it('matches exactly the names the migration writes, plus their SQLite companions', () => {
    expect(m(NAME)).toEqual({ main: NAME, companion: false })
    expect(m('document-memory.db.v2.backup.db')).toEqual({
      main: 'document-memory.db.v2.backup.db',
      companion: false,
    })
    expect(m('document-memory.v2.backup.db')).not.toBeNull() // older <stem>.v2 spelling
    expect(m(`${NAME}-wal`)).toEqual({ main: NAME, companion: true })
    expect(m(`${NAME}-shm`)).toEqual({ main: NAME, companion: true })
    expect(m(`${NAME}-journal`)).toEqual({ main: NAME, companion: true })
    expect(m('document-memory.db.v2.1791535907060.0123456789ab.backup.db')).not.toBeNull() // 12 hex fallback id
  })

  it('rejects everything else: other databases, scratch files, lookalike suffixes, other apps', () => {
    for (const name of [
      'document-memory.db',
      'document-memory.db-wal',
      'file-index.db',
      'document-memory.db.v2.1791535907060.e37993d1.backup.db.old',
      'document-memory.db.v2.1791535907060.e37993d1.backup.db.tmp',
      `${NAME}-x`,
      'my.v2.backup.db',
      'other.db.v2.1791535907060.e37993d1.backup.db',
      'document-memory.db.v2.17.zz.backup.db',
      'document-memory.db.v2.1791535907060.e37993d1.backup.sqlite',
      'document-memory.db.compact-prev.1791535907060.bak',
      'document-memory.db.v3.tmp',
      'document-memory.db.migrating',
      '../document-memory.db.v2.backup.db',
    ]) {
      expect(m(name), name).toBeNull()
    }
  })

  it('is case-insensitive only where the file system is (Windows), exact elsewhere', () => {
    const shouting = NAME.toUpperCase()
    expect(m(shouting, false)).toBeNull()
    expect(m(shouting, true)).not.toBeNull()
    expect(m(`${shouting}-WAL`, true)).toEqual({ main: shouting, companion: true })
  })
})

describe('V2 backup inventory and user-initiated delete', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dm-backup-reclaim-'))
    dbPath = join(dir, 'document-memory.db')
    new DocumentMemoryStore(dbPath).close()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const put = (name: string, bytes = 1000) => writeFileSync(join(dir, name), Buffer.alloc(bytes, 1))

  it('sums each backup with its companions and ignores everything that is not a backup', () => {
    put(NAME, 5000)
    put(`${NAME}-wal`, 700)
    put(`${NAME}-shm`, 32)
    put('file-index.db', 9999)
    put('document-memory.db.v2.1791535907060.e37993d1.backup.db.old', 9999)
    const inv = inventoryV2Backups(dbPath, { caseInsensitive: false })
    expect(inv.backups).toHaveLength(1)
    expect(inv.backups[0].name).toBe(NAME)
    expect(inv.backups[0].sizeBytes).toBe(5732)
    expect(inv.backups[0].createdAt).toBe(1791535907060)
    expect(inv.totalBytes).toBe(5732)
  })

  it('does not follow or size a symlinked backup', () => {
    const outside = mkdtempSync(join(tmpdir(), 'dm-backup-outside-'))
    try {
      writeFileSync(join(outside, 'x.backup.db'), Buffer.alloc(4000))
      symlinkSync(join(outside, 'x.backup.db'), join(dir, NAME))
      expect(inventoryV2Backups(dbPath).backups).toHaveLength(0)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('deletes only the backup files, frees their bytes and leaves the live index, other databases and documents alone', async () => {
    put(NAME, 5000)
    put(`${NAME}-wal`, 700)
    put('file-index.db', 321)
    mkdirSync(join(dir, 'document-memory-models'))
    put('document-memory-models/model.onnx', 55)
    writeFileSync(join(dir, 'my-document.docx'), 'user data')

    const result = await deleteV2Backups(dbPath, { caseInsensitive: false })

    expect(result).toMatchObject({ ok: true, freedBytes: 5700 })
    expect(result.deleted.map((p) => p.split(/[\\/]/).pop()).sort()).toEqual(
      [NAME, `${NAME}-wal`].sort(),
    )
    expect(existsSync(join(dir, NAME))).toBe(false)
    for (const kept of [
      'document-memory.db',
      'file-index.db',
      'my-document.docx',
      'document-memory-models/model.onnx',
    ]) {
      expect(existsSync(join(dir, kept)), kept).toBe(true)
    }
    expect((await deleteV2Backups(dbPath)).refused).toBe('nothing-to-delete')
  })

  it('refuses while a cutover is unfinished: the backup may then be the only complete copy of the index', async () => {
    put(NAME, 5000)
    writeFileSync(
      join(dir, 'document-memory.migration-state.json'),
      JSON.stringify({ phase: 'source-backed-up', backupPath: join(dir, NAME) }),
    )
    expect((await deleteV2Backups(dbPath)).refused).toBe('migration-in-flight')
    rmSync(join(dir, 'document-memory.migration-state.json'))
    writeFileSync(`${dbPath}.migrating`, '{}')
    expect((await deleteV2Backups(dbPath)).refused).toBe('migration-in-flight')
    expect(existsSync(join(dir, NAME))).toBe(true)
  })

  it('refuses when the live index is missing or is not a V3 database', async () => {
    put(NAME, 5000)
    rmSync(dbPath)
    expect((await deleteV2Backups(dbPath)).refused).toBe('live-index-missing')
    const v2 = new DatabaseSync(dbPath)
    v2.exec(
      'CREATE TABLE documents (id INTEGER PRIMARY KEY); CREATE TABLE chunks (id INTEGER PRIMARY KEY, vector BLOB);',
    )
    for (let i = 0; i < 200; i++) v2.exec(`INSERT INTO documents VALUES (${i})`)
    v2.close()
    expect((await deleteV2Backups(dbPath)).refused).toBe('live-index-not-v3')
    expect(existsSync(join(dir, NAME))).toBe(true)
  })

  it('reports a file that cannot be removed instead of throwing, and keeps going', async () => {
    put(NAME, 5000)
    put('document-memory.db.v2.1700000000000.abcd1234.backup.db', 100)
    const result = await deleteV2Backups(dbPath, {
      caseInsensitive: false,
      unlinkFile: async (p) => {
        if (p.endsWith(NAME)) throw Object.assign(new Error('locked'), { code: 'EBUSY' })
        rmSync(p)
      },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('EBUSY')
    expect(result.freedBytes).toBe(100)
    expect(existsSync(join(dir, NAME))).toBe(true)
  })
})

describe('automatic retention of the V2 backup', () => {
  let dir: string
  let dbPath: string
  let backup: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dm-backup-retention-'))
    dbPath = join(dir, 'document-memory.db')
    backup = join(dir, NAME)
    new DocumentMemoryStore(dbPath).close()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function track(ageDays: number, launches: number): void {
    const createdAt = Date.now() - ageDays * DAY_MS
    validBackup(backup, createdAt)
    writeV3RetentionState(dir, { backupPath: backup, createdAt, verifiedLaunches: launches })
  }

  it('keeps the default period at 14 days and clamps the configured one', () => {
    expect(DEFAULT_BACKUP_RETENTION_DAYS).toBe(14)
    expect(readBackupRetentionDays(dir)).toBe(14)
    expect(writeBackupRetentionDays(dir, 30)).toBe(30)
    expect(readBackupRetentionDays(dir)).toBe(30)
    expect(writeBackupRetentionDays(dir, 0)).toBe(14)
    expect(writeBackupRetentionDays(dir, 9999)).toBe(14)
    writeFileSync(join(dir, 'document-memory-backup-retention.json'), '{broken')
    expect(readBackupRetentionDays(dir)).toBe(14)
  })

  it('keeps a verified backup younger than the period even after enough launches', () => {
    track(5, 5)
    expect(runRetentionWorkerTask(dbPath)).toEqual({ purgedCount: 0 })
    expect(existsSync(backup)).toBe(true)
  })

  it('keeps an old backup until the new index has opened successfully 3 times', () => {
    track(20, 2)
    expect(runRetentionWorkerTask(dbPath)).toEqual({ purgedCount: 0 })
    expect(existsSync(backup)).toBe(true)
  })

  it('retires the backup (and its -wal/-shm) once it is older than the period AND the index opened 3 times', () => {
    track(20, 3)
    writeFileSync(`${backup}-wal`, Buffer.alloc(64))
    writeFileSync(`${backup}-shm`, Buffer.alloc(64))
    expect(runRetentionWorkerTask(dbPath)).toEqual({ purgedCount: 1 })
    expect(existsSync(backup)).toBe(false)
    expect(existsSync(`${backup}-wal`)).toBe(false)
    expect(existsSync(`${backup}-shm`)).toBe(false)
    expect(readV3RetentionState(dir)).toBeNull()
    expect(existsSync(dbPath)).toBe(true)
  })

  it('honours a configured period', () => {
    track(20, 3)
    writeBackupRetentionDays(dir, 30)
    expect(runRetentionWorkerTask(dbPath)).toEqual({ purgedCount: 0 })
    writeBackupRetentionDays(dir, 7)
    expect(runRetentionWorkerTask(dbPath)).toEqual({ purgedCount: 1 })
  })

  it('never retires a backup whose own integrity check fails, however old', () => {
    const createdAt = Date.now() - 40 * DAY_MS
    writeFileSync(backup, 'not a database at all')
    writeV3RetentionState(dir, { backupPath: backup, createdAt, verifiedLaunches: 9 })
    expect(runRetentionWorkerTask(dbPath)).toEqual({ purgedCount: 0 })
    expect(existsSync(backup)).toBe(true)
  })

  it('does not hash a multi-GB backup on every accounting pass: protection is decided from age and launches only', () => {
    track(1, 0)
    const young = collectStorageAccounting({ dbPath })
    expect(young.protectedBytes).toBe(young.backupSizeBytes)
    expect(young.backupSizeBytes).toBeGreaterThan(0)
    track(30, 5)
    const old = collectStorageAccounting({ dbPath })
    expect(old.protectedBytes).toBe(0)
    expect(old.backupSizeBytes).toBeGreaterThan(0)
  })
})
