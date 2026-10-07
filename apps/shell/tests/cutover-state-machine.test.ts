import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  performAtomicCutover,
  recoverInterruptedCutover,
  getManifestPath,
} from '../src/main/document-memory/storage/migration/cutover'
import { resolveRetentionDir } from '../src/main/document-memory/storage/migration/v3-retention-state'
import { ensureDocumentMemoryStorageReady } from '../src/main/document-memory/storage-bootstrap'
import { verifyDatabaseIntegrity } from '../src/main/document-memory/storage/migration/logical-verifier'
import { DocumentMemoryStore } from '../src/main/document-memory/store'

const mockState = vi.hoisted(() => ({
  failManifestWrite: false,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      const target = String(args[0])
      if (
        mockState.failManifestWrite &&
        (target.includes('document-memory.migration-state.json') || target.endsWith('.migration-state.json.tmp'))
      ) {
        throw new Error('EACCES: permission denied, simulated manifest write failure')
      }
      return actual.writeFileSync(...args)
    },
  }
})

describe('Cutover State Machine & Manifest Durability Suite (QA-CUT)', () => {
  let tempDir: string
  let dbPath: string
  let tempPath: string
  let backupPath: string
  let manifestPath: string

  beforeEach(() => {
    mockState.failManifestWrite = false
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-cutover-sm-'))
    dbPath = join(tempDir, 'document-memory.db')
    tempPath = join(tempDir, 'document-memory.db.v3.tmp')
    backupPath = join(tempDir, 'document-memory.db.v2.backup.db')
    manifestPath = getManifestPath(tempDir)
  })

  afterEach(() => {
    mockState.failManifestWrite = false
    vi.restoreAllMocks()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  function createV2TestDb(path: string, markerValue = 42): void {
    const db = new DatabaseSync(path)
    try {
      db.exec(`
        CREATE TABLE documents (
          id INTEGER PRIMARY KEY,
          path TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          status TEXT NOT NULL
        );
        CREATE TABLE marker_v2 (
          marker_id INTEGER PRIMARY KEY,
          payload INTEGER NOT NULL
        );
        INSERT INTO documents (id, path, name, status) VALUES (1, 'D:/docs/sample.docx', 'sample.docx', 'ready');
        INSERT INTO marker_v2 (marker_id, payload) VALUES (1, ${markerValue});
      `)
    } finally {
      db.close()
    }
  }

  function createV3TestDb(path: string, markerValue = 99): void {
    const store = new DocumentMemoryStore(path)
    store.close()
    const db = new DatabaseSync(path)
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS marker_v3 (
          marker_id INTEGER PRIMARY KEY,
          payload INTEGER NOT NULL
        );
        INSERT INTO marker_v3 (marker_id, payload) VALUES (1, ${markerValue});
      `)
    } finally {
      db.close()
    }
  }

  it('CUT-01 manifest writer failure → source untouched → backup absent', () => {
    createV2TestDb(dbPath, 42)
    createV3TestDb(tempPath, 99)

    // Arm mock to fail on manifest write
    mockState.failManifestWrite = true

    expect(() => {
      performAtomicCutover({
        resolvedSource: dbPath,
        tempPath,
        backupPath,
      })
    }).toThrow(/permission denied|simulated manifest write failure/i)

    mockState.failManifestWrite = false

    // 1. source untouched
    expect(existsSync(dbPath)).toBe(true)
    const db = new DatabaseSync(dbPath)
    try {
      const row = db.prepare('SELECT payload FROM marker_v2 WHERE marker_id = 1').get() as { payload: number }
      expect(row.payload).toBe(42)
    } finally {
      db.close()
    }

    // 2. backup absent
    expect(existsSync(backupPath)).toBe(false)

    // 3. temporary and final manifest absent
    expect(existsSync(manifestPath)).toBe(false)
    expect(existsSync(`${manifestPath}.tmp`)).toBe(false)
  })

  it('CUT-02 PREPARED persisted → source rename → simulated crash → recovery restores source', () => {
    createV2TestDb(dbPath, 42)
    createV3TestDb(tempPath, 99)

    // Persist manifest with phase 'prepared'
    writeFileSync(
      manifestPath,
      JSON.stringify({
        phase: 'prepared',
        sourceDbPath: dbPath,
        tempPath,
        backupPath,
        timestamp: Date.now(),
      }),
      'utf8',
    )

    // Source was renamed to backup, then process crashed immediately before manifest was updated
    renameSync(dbPath, backupPath)
    expect(existsSync(dbPath)).toBe(false)
    expect(existsSync(backupPath)).toBe(true)

    // Recovery runs
    const recovered = recoverInterruptedCutover(tempDir)
    expect(recovered).toBe(true)

    // Invariants:
    // Source is restored
    expect(existsSync(dbPath)).toBe(true)
    const db = new DatabaseSync(dbPath)
    try {
      const row = db.prepare('SELECT payload FROM marker_v2 WHERE marker_id = 1').get() as { payload: number }
      expect(row.payload).toBe(42)
    } finally {
      db.close()
    }

    // Backup and temp are cleaned up
    expect(existsSync(backupPath)).toBe(false)
    expect(existsSync(tempPath)).toBe(false)
    expect(existsSync(manifestPath)).toBe(false)
  })

  it('CUT-03 corrupt manifest + source missing + backup exists → bootstrap ready=false → manifest preserved', async () => {
    createV2TestDb(backupPath, 42) // backup exists
    expect(existsSync(dbPath)).toBe(false) // source missing

    const corruptContent = '{ "phase": "prepared", INVALID_JSON_SYNTAX_CORRUPTED ...'
    writeFileSync(manifestPath, corruptContent, 'utf8')

    const res = await ensureDocumentMemoryStorageReady(tempDir)

    expect(res.ready).toBe(false)
    expect(res.migrated).toBe(false)
    expect(res.error).toBeDefined()
    expect(res.error).toContain('Interrupted cutover recovery failed')
    expect(res.error).toContain('Corrupted cutover manifest')

    // Manifest must be preserved for forensic analysis (fail-closed, not deleted)
    expect(existsSync(manifestPath)).toBe(true)
    expect(readFileSync(manifestPath, 'utf8')).toBe(corruptContent)

    // Source still missing, backup preserved
    expect(existsSync(dbPath)).toBe(false)
    expect(existsSync(backupPath)).toBe(true)
  })

  it('CUT-04 unknown phase → ready=false and throws on direct recovery', async () => {
    createV2TestDb(dbPath, 42)

    const unknownManifest = {
      phase: 'unknown_unrecognized_phase_state',
      sourceDbPath: dbPath,
      tempPath,
      backupPath,
      timestamp: Date.now(),
    }
    writeFileSync(manifestPath, JSON.stringify(unknownManifest), 'utf8')

    // 1. Direct recoverInterruptedCutover throws
    expect(() => recoverInterruptedCutover(tempDir)).toThrow(/unknown phase "unknown_unrecognized_phase_state"/i)

    // 2. Bootstrap fails closed with ready=false
    const res = await ensureDocumentMemoryStorageReady(tempDir)
    expect(res.ready).toBe(false)
    expect(res.migrated).toBe(false)
    expect(res.error).toContain('unknown phase')

    // Manifest preserved
    expect(existsSync(manifestPath)).toBe(true)
  })

  it('CUT-05 crash after source→backup → source restored', () => {
    createV2TestDb(backupPath, 42) // source was already renamed to backup
    expect(existsSync(dbPath)).toBe(false) // source absent
    createV3TestDb(tempPath, 99) // temp exists

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

    const recovered = recoverInterruptedCutover(tempDir)
    expect(recovered).toBe(true)

    // Source is restored
    expect(existsSync(dbPath)).toBe(true)
    const db = new DatabaseSync(dbPath)
    try {
      const row = db.prepare('SELECT payload FROM marker_v2 WHERE marker_id = 1').get() as { payload: number }
      expect(row.payload).toBe(42)
    } finally {
      db.close()
    }

    // Backup and temp removed
    expect(existsSync(backupPath)).toBe(false)
    expect(existsSync(tempPath)).toBe(false)
    expect(existsSync(manifestPath)).toBe(false)
  })

  it('CUT-06 crash after temp→source → valid V3 recovered', async () => {
    createV3TestDb(dbPath, 99) // Temp was already renamed to source, source is valid V3
    createV2TestDb(backupPath, 42) // Backup exists

    writeFileSync(
      manifestPath,
      JSON.stringify({
        phase: 'target-installed',
        sourceDbPath: dbPath,
        tempPath,
        backupPath,
        timestamp: Date.now(),
      }),
      'utf8',
    )

    const recovered = recoverInterruptedCutover(tempDir)
    expect(recovered).toBe(true)

    // Canonical V3 database preserved
    expect(existsSync(dbPath)).toBe(true)
    const integrity = verifyDatabaseIntegrity(dbPath)
    expect(integrity.ok).toBe(true)

    const db = new DatabaseSync(dbPath)
    try {
      const row = db.prepare('SELECT payload FROM marker_v3 WHERE marker_id = 1').get() as { payload: number }
      expect(row.payload).toBe(99)
    } finally {
      db.close()
    }

    // Manifest cleaned up
    expect(existsSync(manifestPath)).toBe(false)

    // Bootstrapping reports ready=true with isV3=true
    const res = await ensureDocumentMemoryStorageReady(tempDir)
    expect(res.ready).toBe(true)
    expect(res.report?.isV3).toBe(true)
  })

  it('CUT-07 manifest atomic-write: writes via temp file and purges dangling temp manifest on writer crash', () => {
    // Test dangling .tmp manifest recovery
    const tempManifest = `${manifestPath}.tmp`
    writeFileSync(tempManifest, JSON.stringify({ phase: 'prepared' }), 'utf8')
    expect(existsSync(tempManifest)).toBe(true)
    expect(existsSync(manifestPath)).toBe(false)

    // recoverInterruptedCutover purges dangling temporary manifest
    const recovered = recoverInterruptedCutover(tempDir)
    expect(recovered).toBe(false)
    expect(existsSync(tempManifest)).toBe(false)
  })

  it('PATH-01 getManifestPath(db.sqlite) → manifest nằm cạnh DB', () => {
    const sqlitePath = join(tempDir, 'document-memory.sqlite')
    const manifest = getManifestPath(sqlitePath)
    expect(manifest).toBe(join(tempDir, 'document-memory.migration-state.json'))
  })

  it('PATH-02 resolveRetentionDir(db.sqlite3) → dirname(DB)', () => {
    const sqlite3Path = join(tempDir, 'document-memory.sqlite3')
    const dir = resolveRetentionDir(sqlite3Path)
    expect(dir).toBe(tempDir)
  })
})
