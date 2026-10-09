import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectStorageAccounting } from '../src/main/document-memory/runtime/storage-accounting'
import { StorageAdmissionController } from '../src/main/document-memory/runtime/storage-admission'
import {
  contentWriteCapBytes,
  createStorageBudgetSnapshot,
} from '../src/main/document-memory/storage-budget'
import { openDatabase } from '../src/main/document-memory/storage/database'
import { applyCanonicalSchemaV3 } from '../src/main/document-memory/storage/schema-v3'

/**
 * Field incident (Windows, 0.11.104): maxDatabaseBytes = 4 GiB, live V3 index 221 MB, and the V2->V3 cutover's rollback
 * backup `document-memory.db.v2.<ts>.<id>.backup.db` (5 461 098 496 bytes) beside it. The backup was summed into
 * totalManagedBytes, so the index sat permanently over its hard cap: "Storage quota exhausted: projected bytes
 * 5683724644 exceeds budget 4619606425", and compaction evicted the index to make room for a file it does not own.
 * Sizes here are the real ones; the big files are sparse (truncate) so the suite stays instant and uses no disk.
 */
const FIELD_QUOTA = 4_294_967_296
const FIELD_BACKUP_BYTES = 5_461_098_496
const BACKUP_NAME = 'document-memory.db.v2.1791535907060.e37993d1.backup.db'

describe('storage accounting: migration backups are not part of the index quota', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dm-backup-exclusion-'))
    dbPath = join(dir, 'document-memory.db')
    const db = openDatabase(dbPath)
    applyCanonicalSchemaV3(db)
    db.close()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function sparse(path: string, size: number): void {
    writeFileSync(path, '')
    truncateSync(path, size)
  }

  it('field repro: a 5.2 GB V2 backup next to a small live DB does not push a 4 GB quota over its cap', () => {
    sparse(join(dir, BACKUP_NAME), FIELD_BACKUP_BYTES)
    writeFileSync(
      join(dir, 'document-memory.v3-retention.json'),
      JSON.stringify({
        backupPath: join(dir, BACKUP_NAME),
        createdAt: 1791535907060,
        verifiedLaunches: 2,
      }),
    )

    const report = collectStorageAccounting({ dbPath })

    // The backup is still discovered and reported, just not charged to the index.
    expect(report.backupSizeBytes).toBe(FIELD_BACKUP_BYTES)
    expect(report.backupFiles.map((p) => p.endsWith(BACKUP_NAME))).toContain(true)
    expect(report.totalManagedBytes).toBeLessThan(10 * 1024 * 1024)
    expect(report.totalManagedBytes).toBe(report.totalTrackedBytes)
    expect(report.isDegraded).toBe(false)

    const budget = { maxDatabaseBytes: FIELD_QUOTA }
    const snapshot = createStorageBudgetSnapshot({
      activeDbSizeBytes: report.dbSizeBytes,
      walSizeBytes: report.walSizeBytes,
      budgetBytes: FIELD_QUOTA,
      backupBytes: report.backupSizeBytes,
      totalManagedBytes: report.totalManagedBytes,
      breakdown: report.breakdown,
    })
    expect(snapshot.limitState).toBe('ok')
    expect(snapshot.overQuotaBytes).toBe(0)
    expect(snapshot.backupBytes).toBe(FIELD_BACKUP_BYTES)

    // The exact admission that failed in the field now passes (OCR persistence is a content writer).
    const controller = new StorageAdmissionController()
    const decision = controller.canAdmit(
      'ocr',
      1_618_276,
      report.totalManagedBytes,
      contentWriteCapBytes(budget),
    )
    expect(decision.admitted).toBe(true)
    expect(decision.reason).toBe('ok')
  })

  it('the breakdown fallback of createStorageBudgetSnapshot does not charge backups either', () => {
    const snapshot = createStorageBudgetSnapshot({
      activeDbSizeBytes: 1000,
      budgetBytes: 10_000,
      breakdown: {
        activeDbBytes: 1000,
        walBytes: 0,
        shmBytes: 0,
        annBytes: 200,
        ocrExternalBytes: 0,
        tempBytes: 0,
        backupBytes: 50_000_000,
        protectedBackupBytes: 50_000_000,
        reusableFreelistBytes: 0,
        modelWeightsBytes: 0,
      },
    })
    expect(snapshot.totalManagedBytes).toBe(1200)
    expect(snapshot.limitState).toBe('ok')
  })

  it('backup companions (-wal / -shm / -journal) are reported as backup bytes and never as index bytes', () => {
    sparse(join(dir, BACKUP_NAME), 3_000_000)
    sparse(join(dir, `${BACKUP_NAME}-wal`), 400_000)
    sparse(join(dir, `${BACKUP_NAME}-shm`), 32_768)
    sparse(join(dir, `${BACKUP_NAME}-journal`), 1000)

    const report = collectStorageAccounting({ dbPath })

    expect(report.backupSizeBytes).toBe(3_000_000 + 400_000 + 32_768 + 1000)
    expect(report.totalManagedBytes).toBe(report.databaseBytes)
  })

  it('canonical and legacy backup names are both outside the quota', () => {
    sparse(join(dir, 'document-memory.db.v2.backup.db'), 2_000_000)
    sparse(join(dir, 'document-memory.db.v2.1700000000000.abcd1234.backup.db'), 3_000_000)

    const report = collectStorageAccounting({ dbPath })

    expect(report.backupSizeBytes).toBe(5_000_000)
    expect(report.totalManagedBytes).toBe(report.databaseBytes)
  })

  it('what the index owns is still counted: live DB + WAL/SHM, ANN files, OCR cache, sidecars, in-flight temp files', () => {
    writeFileSync(`${dbPath}-wal`, Buffer.alloc(20_000))
    writeFileSync(`${dbPath}-shm`, Buffer.alloc(4_000))
    writeFileSync(join(dir, 'ann-standard.usearch'), Buffer.alloc(50_000))
    mkdirSync(join(dir, 'ocr'))
    writeFileSync(join(dir, 'ocr', 'page1.png'), Buffer.alloc(30_000))
    writeFileSync(join(dir, 'document-memory.sidecar.db'), Buffer.alloc(7_000))
    writeFileSync(join(dir, 'ann-standard.usearch.tmp.123'), Buffer.alloc(9_000))
    sparse(join(dir, BACKUP_NAME), 8_000_000)

    const report = collectStorageAccounting({ dbPath })

    expect(report.annSizeBytes).toBe(50_000)
    expect(report.ocrSizeBytes).toBe(30_000)
    expect(report.sidecarSizeBytes).toBe(7_000)
    expect(report.tempSizeBytes).toBe(9_000)
    expect(report.totalManagedBytes).toBe(
      report.dbSizeBytes + 20_000 + 4_000 + 50_000 + 30_000 + 7_000 + 9_000,
    )
    expect(report.backupSizeBytes).toBe(8_000_000)
  })

  it('files that merely look similar are neither backups nor index bytes', () => {
    sparse(join(dir, 'file-index.db'), 4_000_000)
    sparse(join(dir, 'document-memory.db.v2.1700000000000.abcd1234.backup.db.old'), 1_000_000)
    sparse(join(dir, 'my.v2.backup.db'), 1_000_000)
    mkdirSync(join(dir, 'document-memory-models'))
    sparse(join(dir, 'document-memory-models', 'model.onnx'), 5_000_000)

    const report = collectStorageAccounting({ dbPath })

    expect(report.backupSizeBytes).toBe(0)
    expect(report.totalManagedBytes).toBe(report.databaseBytes)
  })

  it('a corrupt retention-state file cannot make the quota unmeasurable now that backups are not charged', () => {
    writeFileSync(join(dir, 'document-memory.v3-retention.json'), '{not json')
    sparse(join(dir, BACKUP_NAME), 1_000_000)

    const report = collectStorageAccounting({ dbPath })

    expect(report.isDegraded).toBe(false)
    expect(report.backupSizeBytes).toBe(1_000_000)
    expect(report.backupScanErrors?.some((e) => e.code === 'ECORRUPT')).toBe(true)
  })

  it('a backup reached through a symlink out of the data folder is not followed', () => {
    const outside = mkdtempSync(join(tmpdir(), 'dm-backup-outside-'))
    try {
      sparse(join(outside, 'secret.backup.db'), 9_000_000)
      symlinkSync(
        join(outside, 'secret.backup.db'),
        join(dir, 'document-memory.db.v2.1700000000000.deadbeef.backup.db'),
      )
      const report = collectStorageAccounting({ dbPath })
      expect(report.backupSizeBytes).toBe(0)
      expect(report.totalManagedBytes).toBe(report.databaseBytes)
      expect(existsSync(join(outside, 'secret.backup.db'))).toBe(true)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
