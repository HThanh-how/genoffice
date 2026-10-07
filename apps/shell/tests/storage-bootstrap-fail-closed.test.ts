import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureDocumentMemoryStorageReady } from '../src/main/document-memory/storage-bootstrap'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import * as cutoverModule from '../src/main/document-memory/storage/migration/cutover'

describe('Storage Bootstrap Recovery Fail-Closed Suite (QA-05)', () => {
  let tempDir: string
  let dbPath: string
  let manifestPath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-boot-fail-closed-'))
    dbPath = join(tempDir, 'document-memory.db')
    manifestPath = join(tempDir, 'document-memory.migration-state.json')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it('BOOTFAIL-01: Bootstrap fails closed with ready=false when cutover recovery throws an error', async () => {
    // Simulate cutover recovery throwing an unexpected fatal I/O or permission error
    vi.spyOn(cutoverModule, 'recoverInterruptedCutover').mockImplementationOnce(() => {
      throw new Error('EIO: unrecoverable disk error during cutover recovery')
    })

    const res = await ensureDocumentMemoryStorageReady(tempDir)
    expect(res.ready).toBe(false)
    expect(res.migrated).toBe(false)
    expect(res.error).toContain('Interrupted cutover recovery failed')
  })

  it('BOOTFAIL-02: Bootstrap fails closed if migration manifest still present after cutover recovery', async () => {
    // Simulate recovery failing to eliminate the manifest (e.g. unhandled phase or lock)
    writeFileSync(manifestPath, JSON.stringify({ phase: 'in-flight' }), 'utf8')
    vi.spyOn(cutoverModule, 'recoverInterruptedCutover').mockImplementationOnce(() => false)

    const res = await ensureDocumentMemoryStorageReady(tempDir)
    expect(res.ready).toBe(false)
    expect(res.migrated).toBe(false)
    expect(res.error).toBe('Critical: migration manifest still present after cutover recovery')
  })

  it('BOOTFAIL-03: Bootstrap successfully recovers valid interrupted state and completes ready=true', async () => {
    const backupPath = `${dbPath}.v2.backup.db`
    const tempPath = `${dbPath}.v3.tmp.db`

    // Create backup DB (V3 store for simplicity)
    const backupStore = new DocumentMemoryStore(backupPath)
    backupStore.close()

    // Simulate crash after source was backed up
    writeFileSync(
      manifestPath,
      JSON.stringify({
        phase: 'source-backed-up',
        sourceDbPath: dbPath,
        tempPath,
        backupPath,
        timestamp: Date.now(),
      }),
      'utf8',
    )

    const res = await ensureDocumentMemoryStorageReady(tempDir)
    expect(res.ready).toBe(true)
    expect(existsSync(dbPath)).toBe(true)
    expect(existsSync(manifestPath)).toBe(false)
  })

  it('BOOTFAIL-04: Non-existent database directory returns ready=true without error', async () => {
    const res = await ensureDocumentMemoryStorageReady(tempDir)
    expect(res.ready).toBe(true)
    expect(res.migrated).toBe(false)
    expect(res.error).toBeUndefined()
  })

  it('BOOTFAIL-05: Already verified V3 database returns ready=true and report.isV3=true', async () => {
    const v3Store = new DocumentMemoryStore(dbPath)
    v3Store.close()

    const res = await ensureDocumentMemoryStorageReady(tempDir)
    expect(res.ready).toBe(true)
    expect(res.migrated).toBe(false)
    expect(res.report?.isV3).toBe(true)
  })

  it('BOOTFAIL-06 canonical physical V3 + foreign-key violation → ready=false', async () => {
    const store = new DocumentMemoryStore(dbPath)
    store.close()
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA foreign_keys = OFF;')
    /*
     * Insert an orphan relationship that
     * PRAGMA foreign_key_check can see.
     */
    db.prepare(
      'INSERT INTO chunks (id, document_id, ordinal, text, location) VALUES (?, ?, ?, ?, ?)',
    ).run(999, 99999, 0, 'orphan chunk violation', 'orphan:location:0')
    db.close()

    const result = await ensureDocumentMemoryStorageReady(tempDir)
    expect(result.ready).toBe(false)
  })

  it('BOOTFAIL-07 existing non-empty/unknown DB → ready=false', async () => {
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE custom_unknown_table (id INTEGER PRIMARY KEY, info TEXT);')
    db.exec("INSERT INTO custom_unknown_table (info) VALUES ('unrecognized payload');")
    db.close()

    const result = await ensureDocumentMemoryStorageReady(tempDir)
    expect(result.ready).toBe(false)
  })

  it('BOOTFAIL-08 source DB missing + timestamped V2 backup exists → ready=false', async () => {
    const timestampedBackupPath = join(tempDir, `document-memory.${Date.now()}.v2.backup.db`)
    writeFileSync(timestampedBackupPath, 'mock-v2-backup-content', 'utf8')

    const result = await ensureDocumentMemoryStorageReady(tempDir)
    expect(result.ready).toBe(false)
  })

  it('BOOTFAIL-09 source DB missing + document-memory.db.v3.tmp exists → ready=false', async () => {
    const v3TmpPath = join(tempDir, 'document-memory.db.v3.tmp')
    writeFileSync(v3TmpPath, 'mock-v3-temp-content', 'utf8')

    const result = await ensureDocumentMemoryStorageReady(tempDir)
    expect(result.ready).toBe(false)
  })

  it('BOOTFAIL-10 genuine fresh install: no DB no backup no temp no retention state → ready=true', async () => {
    const result = await ensureDocumentMemoryStorageReady(tempDir)
    expect(result.ready).toBe(true)
  })
})
