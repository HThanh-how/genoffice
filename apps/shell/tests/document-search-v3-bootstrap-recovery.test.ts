import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureDocumentMemoryStorageReady,
  type BootstrapResult,
} from '../src/main/document-memory/storage-bootstrap'
import * as cutoverModule from '../src/main/document-memory/storage/migration/cutover'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'

describe('Pair 05: Document Search V3 Bootstrap Fail-Closed Recovery Suite (QA-05)', () => {
  let tempDir: string
  let dbPath: string
  let manifestPath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-qa05-boot-recovery-'))
    dbPath = join(tempDir, 'document-memory.db')
    manifestPath = cutoverModule.getManifestPath(tempDir)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  /**
   * Helper function representing the production shell initialization sequence
   * from apps/shell/src/main/index.ts lines 6828-6839:
   *
   *   const bootstrap = await ensureDocumentMemoryStorageReady(indexDbDir, { settingsDir })
   *   if (!bootstrap.ready) {
   *     documentMemory = null
   *   } else {
   *     documentMemory = new DocumentMemoryManager(...)
   *   }
   */
  async function initializeDocumentMemoryLifecycle(
    userDataDir: string,
    indexDbDir: string,
    managerFactory: (dir: string, opts: any) => any,
  ): Promise<{ bootstrap: BootstrapResult; manager: any | null }> {
    const bootstrap = await ensureDocumentMemoryStorageReady(indexDbDir, {
      settingsDir: userDataDir,
    })
    if (!bootstrap.ready) {
      return { bootstrap, manager: null }
    }
    return {
      bootstrap,
      manager: managerFactory(userDataDir, { dbDir: indexDbDir }),
    }
  }

  it('BOOT-01 recovery throws → ready false', async () => {
    // Simulate cutover recovery throwing a fatal filesystem/I/O exception
    vi.spyOn(cutoverModule, 'recoverInterruptedCutover').mockImplementationOnce(() => {
      throw new Error('EIO: unrecoverable hardware I/O failure during cutover recovery')
    })

    const result = await ensureDocumentMemoryStorageReady(tempDir)

    expect(result.ready).toBe(false)
    expect(result.migrated).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.error).toContain('Interrupted cutover recovery failed: EIO: unrecoverable hardware I/O failure')
  })

  it('BOOT-02 source missing + backup exists → not fresh install', async () => {
    // Ensure primary database file does NOT exist
    expect(existsSync(dbPath)).toBe(false)

    // Simulate an interrupted migration where the primary database was renamed
    // or removed, but a timestamped V2 backup artifact exists in the directory
    const timestampedBackupPath = join(tempDir, `document-memory.${Date.now()}.v2.backup.db`)
    writeFileSync(timestampedBackupPath, 'legacy-v2-database-backup-payload', 'utf8')

    const result = await ensureDocumentMemoryStorageReady(tempDir)

    expect(result.ready).toBe(false)
    expect(result.migrated).toBe(false)
    expect(result.error).toBe(
      'Document-memory database is missing while migration or rollback artifacts still exist.',
    )
  })

  it('BOOT-03 source missing + temp exists → not fresh install', async () => {
    // Ensure primary database file does NOT exist
    expect(existsSync(dbPath)).toBe(false)

    // Simulate an incomplete migration where the .v3.tmp staging database remains
    const v3TempPath = `${dbPath}.v3.tmp`
    writeFileSync(v3TempPath, 'staged-v3-temporary-database-payload', 'utf8')

    const result = await ensureDocumentMemoryStorageReady(tempDir)

    expect(result.ready).toBe(false)
    expect(result.migrated).toBe(false)
    expect(result.error).toBeDefined()
    expect(
      result.error!.includes('unexpected temporary migration artifacts') ||
      result.error!.includes('Document-memory database is missing while migration or rollback artifacts still exist.'),
    ).toBe(true)
  })

  it('BOOT-04 corrupt manifest → ready false', async () => {
    // Scenario A: Truncated / malformed JSON content
    writeFileSync(
      manifestPath,
      '{"phase": "prepared", "sourceDbPath": "truncated...',
      'utf8',
    )

    // Execute WITHOUT mocking recoverInterruptedCutover to test real manifest parsing failure
    const malformedResult = await ensureDocumentMemoryStorageReady(tempDir)

    expect(malformedResult.ready).toBe(false)
    expect(malformedResult.migrated).toBe(false)
    expect(malformedResult.error).toBeDefined()
    expect(malformedResult.error).toContain('Interrupted cutover recovery failed: Corrupted cutover manifest')
    expect(malformedResult.error).toContain('invalid JSON')

    // Scenario B: Valid JSON syntax but invalid phase
    writeFileSync(
      manifestPath,
      JSON.stringify({
        phase: 'corrupted-nonexistent-phase',
        sourceDbPath: dbPath,
        tempPath: `${dbPath}.v3.tmp`,
        backupPath: `${dbPath}.v2.backup.db`,
        timestamp: Date.now(),
      }),
      'utf8',
    )

    const invalidPhaseResult = await ensureDocumentMemoryStorageReady(tempDir)

    expect(invalidPhaseResult.ready).toBe(false)
    expect(invalidPhaseResult.migrated).toBe(false)
    expect(invalidPhaseResult.error).toBeDefined()
    expect(invalidPhaseResult.error).toContain('unknown phase "corrupted-nonexistent-phase"')
  })

  it('BOOT-05 true fresh install → ready true', async () => {
    // Entire directory is clean: no db, no backups, no temp files, no manifest, no retention
    expect(existsSync(dbPath)).toBe(false)
    expect(existsSync(manifestPath)).toBe(false)

    const result = await ensureDocumentMemoryStorageReady(tempDir)

    expect(result.ready).toBe(true)
    expect(result.migrated).toBe(false)
    expect(result.error).toBeUndefined()
  })

  it('BOOT-06 manager constructor not called on bootstrap failure', async () => {
    const managerFactorySpy = vi.fn().mockImplementation((dir, opts) => {
      return { dir, opts, fakeManagerInstance: true }
    })

    // Failure Case 1: Interrupted cutover recovery throws
    vi.spyOn(cutoverModule, 'recoverInterruptedCutover').mockImplementationOnce(() => {
      throw new Error('Fatal failure during cutover crash recovery')
    })

    const failedLaunch1 = await initializeDocumentMemoryLifecycle(tempDir, tempDir, managerFactorySpy)

    expect(failedLaunch1.bootstrap.ready).toBe(false)
    expect(failedLaunch1.manager).toBeNull()
    expect(managerFactorySpy).not.toHaveBeenCalled()

    // Failure Case 2: Corrupted cutover manifest
    writeFileSync(manifestPath, '{ "invalidJson": true, ', 'utf8')

    const failedLaunch2 = await initializeDocumentMemoryLifecycle(tempDir, tempDir, managerFactorySpy)

    expect(failedLaunch2.bootstrap.ready).toBe(false)
    expect(failedLaunch2.manager).toBeNull()
    expect(managerFactorySpy).not.toHaveBeenCalled()

    // Failure Case 3: Source missing but backup exists (not fresh install)
    rmSync(manifestPath, { force: true })
    const backupPath = join(tempDir, `document-memory.${Date.now()}.v2.backup.db`)
    writeFileSync(backupPath, 'backup-bytes', 'utf8')

    const failedLaunch3 = await initializeDocumentMemoryLifecycle(tempDir, tempDir, managerFactorySpy)

    expect(failedLaunch3.bootstrap.ready).toBe(false)
    expect(failedLaunch3.manager).toBeNull()
    expect(managerFactorySpy).not.toHaveBeenCalled()

    // Contrast with Success Case: True fresh install
    rmSync(backupPath, { force: true })
    const successLaunch = await initializeDocumentMemoryLifecycle(tempDir, tempDir, managerFactorySpy)

    expect(successLaunch.bootstrap.ready).toBe(true)
    expect(successLaunch.manager).not.toBeNull()
    expect(managerFactorySpy).toHaveBeenCalledTimes(1)
  })
})
