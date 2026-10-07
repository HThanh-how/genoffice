import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  performAtomicCutover,
  recoverInterruptedCutover,
  getManifestPath,
  type CutoverStateManifest,
} from '../src/main/document-memory/storage/migration/cutover'
import { DocumentMemoryStore } from '../src/main/document-memory/store'

function createMinimalV2Db(path: string, marker: string): void {
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      CREATE TABLE documents (id INTEGER PRIMARY KEY, path TEXT, name TEXT, marker TEXT);
      INSERT INTO documents (path, name, marker) VALUES ('/test.txt', 'test.txt', '${marker}');
    `)
  } finally {
    db.close()
  }
}

function readMarker(path: string): string | null {
  if (!existsSync(path)) return null
  const db = new DatabaseSync(path)
  try {
    const row = db.prepare('SELECT marker FROM documents LIMIT 1').get() as { marker?: string } | undefined
    return row?.marker ?? null
  } catch {
    return null
  } finally {
    db.close()
  }
}

describe('Cutover State Machine & Crash Recovery Suite (QA-04)', () => {
  let tempDir: string
  let sourceDbPath: string
  let tempDbPath: string
  let backupDbPath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-cutover-test-'))
    sourceDbPath = join(tempDir, 'document-memory.db')
    tempDbPath = join(tempDir, 'document-memory.db.v3.tmp.db')
    backupDbPath = join(tempDir, 'document-memory.db.v2.backup.db')

    // Create source DB (old version) and temp DB (migrated V3 version)
    createMinimalV2Db(sourceDbPath, 'ORIGINAL_V2')
    const v3Store = new DocumentMemoryStore(tempDbPath)
    v3Store.close()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('CUTOVER-01: Manifest prepared phase is recorded and crash before backup leaves source intact', () => {
    const manifestPath = getManifestPath(sourceDbPath)
    let manifestExistedAtCrash = false

    expect(() => {
      performAtomicCutover({
        resolvedSource: sourceDbPath,
        tempPath: tempDbPath,
        backupPath: backupDbPath,
        testFailureInjectionPoint: 'crash-before-backup',
        onRollback: () => {
          manifestExistedAtCrash = existsSync(manifestPath)
        },
      })
    }).toThrow('Test injected crash before source backup')

    expect(manifestExistedAtCrash).toBe(true)

    // When performAtomicCutover throws, rollback handler cleans up manifest.
    // Now simulate an abrupt crash where manifest "prepared" was flushed to disk:
    writeFileSync(
      manifestPath,
      JSON.stringify({
        phase: 'prepared',
        sourceDbPath,
        tempPath: tempDbPath,
        backupPath: backupDbPath,
        timestamp: Date.now(),
      } satisfies CutoverStateManifest),
      'utf8',
    )

    // Crash recovery should handle "prepared" phase
    const recovered = recoverInterruptedCutover(tempDir)
    expect(recovered).toBe(true)
    expect(existsSync(sourceDbPath)).toBe(true)
    expect(readMarker(sourceDbPath)).toBe('ORIGINAL_V2')
    expect(existsSync(manifestPath)).toBe(false)
  })

  it('CUTOVER-02: Recovery when crash occurs after source moved to backup restores original database', () => {
    const manifestPath = getManifestPath(sourceDbPath)

    // Simulate crash at phase "source-backed-up"
    // Source was renamed to backup, temp is still temp
    createMinimalV2Db(backupDbPath, 'ORIGINAL_BACKUP')
    if (existsSync(sourceDbPath)) rmSync(sourceDbPath, { force: true })

    writeFileSync(
      manifestPath,
      JSON.stringify({
        phase: 'source-backed-up',
        sourceDbPath,
        tempPath: tempDbPath,
        backupPath: backupDbPath,
        timestamp: Date.now(),
      } satisfies CutoverStateManifest),
      'utf8',
    )

    const recovered = recoverInterruptedCutover(tempDir)
    expect(recovered).toBe(true)
    // Source must be restored from backup
    expect(existsSync(sourceDbPath)).toBe(true)
    expect(readMarker(sourceDbPath)).toBe('ORIGINAL_BACKUP')
    expect(existsSync(manifestPath)).toBe(false)
  })

  it('CUTOVER-03: Recovery when crash occurs after temp renamed to source validates integrity', () => {
    const manifestPath = getManifestPath(sourceDbPath)

    // Valid V3 DB in source, backup still exists
    writeFileSync(
      manifestPath,
      JSON.stringify({
        phase: 'temp-renamed-to-source',
        sourceDbPath,
        tempPath: tempDbPath,
        backupPath: backupDbPath,
        timestamp: Date.now(),
      } satisfies CutoverStateManifest),
      'utf8',
    )

    // Create valid V3 DB at source by removing minimal DB first
    rmSync(sourceDbPath, { force: true })
    const validV3 = new DocumentMemoryStore(sourceDbPath)
    validV3.close()

    const recovered = recoverInterruptedCutover(tempDir)
    expect(recovered).toBe(true)
    expect(existsSync(sourceDbPath)).toBe(true)
    expect(existsSync(manifestPath)).toBe(false)
  })

  it('CUTOVER-04: Full successful cutover promotes temp to source and cleans manifest', () => {
    const manifestPath = getManifestPath(sourceDbPath)

    performAtomicCutover({
      resolvedSource: sourceDbPath,
      tempPath: tempDbPath,
      backupPath: backupDbPath,
    })

    expect(existsSync(sourceDbPath)).toBe(true)
    expect(existsSync(tempDbPath)).toBe(false)
    expect(existsSync(manifestPath)).toBe(false)
    expect(existsSync(backupDbPath)).toBe(true)
  })

  it('CUTOVER-05: Automatic rollback on verification failure safely restores source database', () => {
    const manifestPath = getManifestPath(sourceDbPath)

    expect(() => {
      performAtomicCutover({
        resolvedSource: sourceDbPath,
        tempPath: tempDbPath,
        backupPath: backupDbPath,
        testFailureInjectionPoint: 'verification-failed',
      })
    }).toThrow('V2 to V3 migration failed and was safely rolled back')

    expect(existsSync(sourceDbPath)).toBe(true)
    expect(readMarker(sourceDbPath)).toBe('ORIGINAL_V2')
    expect(existsSync(tempDbPath)).toBe(false)
    expect(existsSync(manifestPath)).toBe(false)
  })
})
