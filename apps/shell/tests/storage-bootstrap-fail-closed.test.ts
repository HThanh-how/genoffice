import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
})
