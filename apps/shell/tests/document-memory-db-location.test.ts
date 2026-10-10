import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyPendingDbMove,
  cancelDbMove,
  CorruptRelocationJournalError,
  dbLocationState,
  isDbDirAccessible,
  planDbMove,
  resolveDbDir,
  verifyDatabaseIntegrity,
  verifyDatabaseSchema,
} from '../src/main/document-memory/db-location'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'

let root: string
let userData: string
let target: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genoffice-dbloc-'))
  userData = join(root, 'userData')
  target = join(root, 'bigdrive', 'index')
  mkdirSync(userData, { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function seedRealDatabase(dir: string, docCount = 3): void {
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'document-memory.db')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, path TEXT, title TEXT);')
  db.exec('CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, doc_id TEXT, text TEXT);')
  for (let i = 0; i < docCount; i++) {
    db.prepare('INSERT OR REPLACE INTO documents (id, path, title) VALUES (?, ?, ?);').run(
      `doc-${i}`,
      `/data/file-${i}.docx`,
      `Document Title ${i}`,
    )
    db.prepare('INSERT OR REPLACE INTO chunks (id, doc_id, text) VALUES (?, ?, ?);').run(
      `chunk-${i}`,
      `doc-${i}`,
      `Snippet text for doc ${i}`,
    )
  }
  db.close()
}

function getDatabaseDocCount(dir: string): number {
  const dbPath = join(dir, 'document-memory.db')
  if (!existsSync(dbPath)) return 0
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const row = db.prepare('SELECT count(*) as c FROM documents;').get() as
      { c: number } | undefined
    return row?.c ?? 0
  } finally {
    db.close()
  }
}

describe('moving the index to another folder (basic lifecycle)', () => {
  it('starts in the data folder and reports its size', () => {
    seedRealDatabase(userData, 5)
    expect(dbLocationState(userData)).toMatchObject({ dir: userData, isDefault: true })
    expect(dbLocationState(userData).sizeBytes).toBeGreaterThan(0)
  })

  it('refuses a folder that is not a usable place and says why', () => {
    seedRealDatabase(userData)
    expect(planDbMove(userData, 'relative/dir')).toEqual({ ok: false, error: 'invalid' })
    expect(planDbMove(userData, userData)).toEqual({ ok: false, error: 'same' })
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'document-memory.db'), 'someone else')
    expect(planDbMove(userData, target)).toEqual({ ok: false, error: 'exists' })
    const file = join(root, 'a-file')
    writeFileSync(file, '')
    expect(planDbMove(userData, join(file, 'sub'))).toEqual({ ok: false, error: 'unwritable' })
    expect(dbLocationState(userData).pending).toBeUndefined()
  })

  it('schedules a move, does nothing yet, and carries it out at the next start', async () => {
    seedRealDatabase(userData, 4)
    expect(planDbMove(userData, target)).toMatchObject({ ok: true })
    expect(dbLocationState(userData).pending).toBe(target)
    expect(existsSync(join(target, 'document-memory.db'))).toBe(false)

    expect(await applyPendingDbMove(userData)).toEqual({ moved: true })

    expect(existsSync(join(target, 'document-memory.db'))).toBe(true)
    expect(getDatabaseDocCount(target)).toBe(4)
    expect(existsSync(join(userData, 'document-memory.db'))).toBe(false)
    expect(resolveDbDir(userData)).toBe(target)
    expect(dbLocationState(userData)).toMatchObject({ dir: target, isDefault: false })
    expect(dbLocationState(userData).pending).toBeUndefined()
  })

  it('can be undone: the index moves back to the data folder', async () => {
    seedRealDatabase(userData, 3)
    planDbMove(userData, target)
    await applyPendingDbMove(userData)

    expect(planDbMove(userData, userData)).toMatchObject({ ok: true })
    await applyPendingDbMove(userData)

    expect(existsSync(join(userData, 'document-memory.db'))).toBe(true)
    expect(getDatabaseDocCount(userData)).toBe(3)
    expect(resolveDbDir(userData)).toBe(userData)
    expect(dbLocationState(userData).isDefault).toBe(true)
  })

  it('leaves the index where it was, and says why, when the move fails', async () => {
    seedRealDatabase(userData, 2)
    expect(planDbMove(userData, target)).toMatchObject({ ok: true })
    rmSync(join(root, 'bigdrive'), { recursive: true, force: true })
    writeFileSync(join(root, 'bigdrive'), 'now a file')

    const result = await applyPendingDbMove(userData)

    expect(result.moved).toBe(false)
    expect(result.error).toBeTruthy()
    expect(existsSync(join(userData, 'document-memory.db'))).toBe(true)
    expect(resolveDbDir(userData)).toBe(userData)
    expect(dbLocationState(userData)).toMatchObject({ lastError: result.error })
    expect(dbLocationState(userData).pending).toBeUndefined()
  })

  it('reports unavailable and does not silently fall back to userData when chosen folder goes away', async () => {
    seedRealDatabase(userData, 2)
    planDbMove(userData, target)
    await applyPendingDbMove(userData)

    expect(resolveDbDir(userData)).toBe(target)
    rmSync(join(root, 'bigdrive'), { recursive: true, force: true })

    // Must NOT silently claim userData as current location (which would initialize an empty database)
    expect(resolveDbDir(userData)).toBe(target)
    expect(isDbDirAccessible(resolveDbDir(userData))).toBe(false)
    const state = dbLocationState(userData)
    expect(state.unavailable).toBe(true)
    expect(state.dir).toBe(target)
  })

  it('forgets a move that was scheduled and then cancelled', () => {
    seedRealDatabase(userData)
    planDbMove(userData, target)
    cancelDbMove(userData)
    expect(dbLocationState(userData).pending).toBeUndefined()
  })

  it('opens the index in the chosen folder', () => {
    const manager = new DocumentMemoryManager(userData, {
      dbDir: target,
      pollIntervalMs: 3_600_000,
    })
    try {
      expect(manager.dbPath).toBe(join(target, 'document-memory.db'))
      expect(existsSync(join(target, 'document-memory.db'))).toBe(true)
      expect(existsSync(join(userData, 'document-memory.db'))).toBe(false)
    } finally {
      manager.close()
    }
  })
})

describe('crash-safety & fault-injection relocation protocol (P0-01)', () => {
  it('Scenario 1: Interruption before snapshot leaves source intact and rolls back', async () => {
    seedRealDatabase(userData, 5)
    planDbMove(userData, target)

    let faultInjected = false
    await expect(
      applyPendingDbMove(userData, {
        onBeforeSnapshot: () => {
          faultInjected = true
          throw new Error('SIMULATED CRASH: before snapshot')
        },
      }),
    ).resolves.toEqual({ moved: false, error: 'SIMULATED CRASH: before snapshot' })

    expect(faultInjected).toBe(true)
    expect(getDatabaseDocCount(userData)).toBe(5)
    expect(resolveDbDir(userData)).toBe(userData)
  })

  it('Scenario 2: Interruption during snapshot/WAL checkpoint rolls back safely', async () => {
    seedRealDatabase(userData, 3)
    planDbMove(userData, target)

    let faultInjected = false
    await expect(
      applyPendingDbMove(userData, {
        onDuringSnapshot: () => {
          faultInjected = true
          throw new Error('SIMULATED CRASH: during WAL snapshot')
        },
      }),
    ).resolves.toEqual({ moved: false, error: 'SIMULATED CRASH: during WAL snapshot' })

    expect(faultInjected).toBe(true)
    expect(getDatabaseDocCount(userData)).toBe(3)
    expect(resolveDbDir(userData)).toBe(userData)
  })

  it('Scenario 3: Interruption after staging but before verification rolls back to source', async () => {
    seedRealDatabase(userData, 4)
    planDbMove(userData, target)

    // Simulate process crash (unhandled rejection / sudden kill)
    await expect(
      applyPendingDbMove(userData, {
        onAfterStageBeforeVerify: () => {
          throw new Error('SIMULATED CRASH: process died after staging')
        },
      }),
    ).resolves.toMatchObject({ moved: false })

    // Simulate next application start: journal recovery rolls back partial move
    const recovery = await applyPendingDbMove(userData)
    expect(recovery.moved).toBe(false)
    expect(getDatabaseDocCount(userData)).toBe(4)
    expect(resolveDbDir(userData)).toBe(userData)
  })

  it('Scenario 4: Interruption during verification rolls back to source', async () => {
    seedRealDatabase(userData, 4)
    planDbMove(userData, target)

    await expect(
      applyPendingDbMove(userData, {
        onDuringVerify: () => {
          throw new Error('SIMULATED CRASH: corrupted verification')
        },
      }),
    ).resolves.toMatchObject({ moved: false })

    const recovery = await applyPendingDbMove(userData)
    expect(recovery.moved).toBe(false)
    expect(getDatabaseDocCount(userData)).toBe(4)
    expect(resolveDbDir(userData)).toBe(userData)
  })

  it('Scenario 5: Interruption after destination promotion rolls back to source', async () => {
    seedRealDatabase(userData, 5)
    planDbMove(userData, target)

    // Interrupted before metadata commit (journal authoritative is still 'source')
    await expect(
      applyPendingDbMove(userData, {
        onAfterPromotionBeforeCommit: () => {
          throw new Error('SIMULATED CRASH: after promotion before commit')
        },
      }),
    ).resolves.toMatchObject({ moved: false })

    // Restart: since authoritative was source, recovery preserves source and cleans target
    const recovery = await applyPendingDbMove(userData)
    expect(recovery.moved).toBe(false)
    expect(getDatabaseDocCount(userData)).toBe(5)
    expect(resolveDbDir(userData)).toBe(userData)
  })

  it('Scenario 6: Interruption before metadata commit rolls back to source', async () => {
    seedRealDatabase(userData, 3)
    planDbMove(userData, target)

    await expect(
      applyPendingDbMove(userData, {
        onBeforeCommit: () => {
          throw new Error('SIMULATED CRASH: right before metadata commit')
        },
      }),
    ).resolves.toMatchObject({ moved: false })

    const recovery = await applyPendingDbMove(userData)
    expect(recovery.moved).toBe(false)
    expect(getDatabaseDocCount(userData)).toBe(3)
    expect(resolveDbDir(userData)).toBe(userData)
  })

  it('Scenario 7: Interruption immediately after metadata commit finalizes destination', async () => {
    seedRealDatabase(userData, 6)
    planDbMove(userData, target)

    // Commit has occurred; destination is now authoritative! Crash happens before cleanup.
    await expect(
      applyPendingDbMove(userData, {
        onImmediatelyAfterCommit: () => {
          throw new Error('SIMULATED CRASH: right after commit before cleanup')
        },
      }),
    ).resolves.toMatchObject({ moved: false })

    // Restart: recovery detects target is authoritative and intact -> promotes and cleans leftover source
    const recovery = await applyPendingDbMove(userData)
    expect(recovery.moved).toBe(true)
    expect(resolveDbDir(userData)).toBe(target)
    expect(getDatabaseDocCount(target)).toBe(6)
    expect(existsSync(join(userData, 'document-memory.db'))).toBe(false)
  })

  it('Scenario 8: Interruption during source cleanup finalizes destination on restart', async () => {
    seedRealDatabase(userData, 4)
    planDbMove(userData, target)

    await expect(
      applyPendingDbMove(userData, {
        onDuringCleanup: () => {
          throw new Error('SIMULATED CRASH: midway through cleanup')
        },
      }),
    ).resolves.toMatchObject({ moved: false })

    // Restart: target authoritative -> cleans remaining source files
    const recovery = await applyPendingDbMove(userData)
    expect(recovery.moved).toBe(true)
    expect(resolveDbDir(userData)).toBe(target)
    expect(getDatabaseDocCount(target)).toBe(4)
    expect(existsSync(join(userData, 'document-memory.db'))).toBe(false)
  })

  it('Scenario 9: Interruption after one source sidecar was removed recovers destination', async () => {
    seedRealDatabase(userData, 2)
    writeFileSync(join(userData, 'document-memory.db.v2.backup.db'), 'backup-copy')
    planDbMove(userData, target)

    await expect(
      applyPendingDbMove(userData, {
        onDuringCleanup: () => {
          // Manually remove primary db to simulate partial deletion
          rmSync(join(userData, 'document-memory.db'), { force: true })
          throw new Error('SIMULATED CRASH: partial sidecar deletion')
        },
      }),
    ).resolves.toMatchObject({ moved: false })

    const recovery = await applyPendingDbMove(userData)
    expect(recovery.moved).toBe(true)
    expect(resolveDbDir(userData)).toBe(target)
    expect(getDatabaseDocCount(target)).toBe(2)
  })

  it('Scenario 10: Target volume unavailable during relocation fails closed without data loss', async () => {
    seedRealDatabase(userData, 3)
    // Directory is unwritable because volume/parent does not exist
    const nonExistent =
      process.platform === 'win32'
        ? 'Z:\\non-existent-drive-root-xyz\\sub'
        : join('/non-existent-drive-root-xyz', 'sub')
    const plan = planDbMove(userData, nonExistent)
    expect(plan.ok).toBe(false)
    expect(getDatabaseDocCount(userData)).toBe(3)
  })

  it('Scenario 11: Source directory unavailable during relocation fails cleanly', async () => {
    const customSource = join(root, 'custom-source')
    seedRealDatabase(customSource, 2)
    writeFileSync(
      join(userData, 'document-memory-location.json'),
      JSON.stringify({ dir: customSource, moveTo: target }),
    )

    // Wipe source directory before moving
    rmSync(customSource, { recursive: true, force: true })

    const result = await applyPendingDbMove(userData)
    expect(result.moved).toBe(false)
    expect(result.error).toMatch(/source directory does not exist/)
  })

  it('Scenario 12: Target database already existing is rejected before any destructive action', async () => {
    seedRealDatabase(userData, 2)
    seedRealDatabase(target, 5)

    const plan = planDbMove(userData, target)
    expect(plan).toEqual({ ok: false, error: 'exists' })

    // Data in both locations preserved
    expect(getDatabaseDocCount(userData)).toBe(2)
    expect(getDatabaseDocCount(target)).toBe(5)
  })

  it('Scenario 13: Malformed settings metadata JSON does not crash and defaults safely', () => {
    seedRealDatabase(userData, 2)
    writeFileSync(join(userData, 'document-memory-location.json'), '{ invalid json ...')

    expect(resolveDbDir(userData)).toBe(userData)
    expect(dbLocationState(userData)).toMatchObject({ dir: userData, isDefault: true })
  })

  it('Scenario 14: Uncheckpointed committed WAL transactions are flushed and verified', async () => {
    seedRealDatabase(userData, 1)
    const dbPath = join(userData, 'document-memory.db')

    // Write directly into WAL with autocheckpoint disabled
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA wal_autocheckpoint = 0;')
    db.prepare('INSERT INTO documents (id, path, title) VALUES (?, ?, ?);').run(
      'doc-wal-uncheckpointed',
      '/wal/path.docx',
      'WAL Title',
    )
    db.close()

    // Plan and execute move
    expect(planDbMove(userData, target)).toMatchObject({ ok: true })
    const result = await applyPendingDbMove(userData)
    expect(result.moved).toBe(true)

    // Verify all records (including previously uncheckpointed WAL row) made it to target
    expect(getDatabaseDocCount(target)).toBe(2)
    expect(verifyDatabaseIntegrity(join(target, 'document-memory.db'))).toEqual({ ok: true })
    expect(verifyDatabaseSchema(join(target, 'document-memory.db'), 2)).toMatchObject({
      ok: true,
      docCount: 2,
    })
  })

  it('Scenario 15: Corrupted relocation journal without backup fails closed without empty DB creation', async () => {
    writeFileSync(join(userData, 'document-memory-relocation-journal.json'), '{ corrupted json ...')

    expect(() => resolveDbDir(userData)).toThrow(CorruptRelocationJournalError)
    const state = dbLocationState(userData)
    expect(state.unavailable).toBe(true)
    expect(state.lastError).toMatch(/Corrupt relocation journal/)

    const moveResult = await applyPendingDbMove(userData)
    expect(moveResult.moved).toBe(false)
    expect(moveResult.error).toMatch(/Corrupt relocation journal/)
  })

  it('Scenario 16: Interrupted relocation with corrupt primary journal safely recovers from .bak journal', async () => {
    seedRealDatabase(target, 4)
    const validJournal = {
      version: 1,
      sourceDir: userData,
      targetDir: target,
      phase: 'committed',
      authoritative: 'target',
      updatedAt: Date.now(),
    }
    writeFileSync(
      join(userData, 'document-memory-relocation-journal.json.bak'),
      JSON.stringify(validJournal, null, 2),
    )
    writeFileSync(
      join(userData, 'document-memory-relocation-journal.json'),
      'half-written-truncated-json-###',
    )

    expect(resolveDbDir(userData)).toBe(target)
    const moveResult = await applyPendingDbMove(userData)
    expect(moveResult.moved).toBe(true)
    expect(getDatabaseDocCount(target)).toBe(4)
    expect(resolveDbDir(userData)).toBe(target)
  })

  it('Scenario 17: Interrupted relocation NEVER deletes target artifacts solely because source DB is missing', async () => {
    seedRealDatabase(target, 5)
    // Source DB does NOT exist in userData!
    expect(existsSync(join(userData, 'document-memory.db'))).toBe(false)

    // Crash simulated right before commit: journal marked authoritative === 'source'
    const uncommittedJournal = {
      version: 1,
      sourceDir: userData,
      targetDir: target,
      phase: 'staged',
      authoritative: 'source',
      updatedAt: Date.now(),
    }
    writeFileSync(
      join(userData, 'document-memory-relocation-journal.json'),
      JSON.stringify(uncommittedJournal, null, 2),
    )

    // In vulnerable implementation, !existsSync(sourceDbPath) caused unlink of all target files!
    // In corrected implementation, the surviving target copy must be preserved and promoted!
    const result = await applyPendingDbMove(userData)
    expect(result.moved).toBe(true)
    expect(existsSync(join(target, 'document-memory.db'))).toBe(true)
    expect(getDatabaseDocCount(target)).toBe(5)
    expect(resolveDbDir(userData)).toBe(target)
  })
})
