import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyPendingDbMove,
  cancelDbMove,
  dbLocationState,
  planDbMove,
  resolveDbDir,
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

const seed = (dir: string): void => {
  writeFileSync(join(dir, 'document-memory.db'), 'main-db-contents')
  writeFileSync(join(dir, 'document-memory.db-wal'), 'wal-contents')
}

describe('moving the index to another folder', () => {
  it('starts in the data folder and reports its size', () => {
    seed(userData)
    expect(dbLocationState(userData)).toMatchObject({ dir: userData, isDefault: true })
    expect(dbLocationState(userData).sizeBytes).toBe(
      'main-db-contents'.length + 'wal-contents'.length,
    )
  })

  it('refuses a folder that is not a usable place and says why', () => {
    seed(userData)
    expect(planDbMove(userData, 'relative/dir')).toEqual({ ok: false, error: 'invalid' })
    expect(planDbMove(userData, userData)).toEqual({ ok: false, error: 'same' })
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'document-memory.db'), 'someone else')
    expect(planDbMove(userData, target)).toEqual({ ok: false, error: 'exists' })
    // a plain file where a folder is needed cannot be written into
    const file = join(root, 'a-file')
    writeFileSync(file, '')
    expect(planDbMove(userData, join(file, 'sub'))).toEqual({ ok: false, error: 'unwritable' })
    expect(dbLocationState(userData).pending).toBeUndefined()
  })

  it('schedules a move, does nothing yet, and carries it out at the next start', async () => {
    seed(userData)
    expect(planDbMove(userData, target)).toMatchObject({ ok: true })
    expect(dbLocationState(userData).pending).toBe(target)
    expect(existsSync(join(target, 'document-memory.db'))).toBe(false)

    expect(await applyPendingDbMove(userData)).toEqual({ moved: true })

    expect(readFileSync(join(target, 'document-memory.db'), 'utf8')).toBe('main-db-contents')
    expect(readFileSync(join(target, 'document-memory.db-wal'), 'utf8')).toBe('wal-contents')
    expect(existsSync(join(userData, 'document-memory.db'))).toBe(false)
    expect(existsSync(join(userData, 'document-memory.db-wal'))).toBe(false)
    expect(resolveDbDir(userData)).toBe(target)
    expect(dbLocationState(userData)).toMatchObject({ dir: target, isDefault: false })
    expect(dbLocationState(userData).pending).toBeUndefined()
  })

  it('can be undone: the index moves back to the data folder', async () => {
    seed(userData)
    planDbMove(userData, target)
    await applyPendingDbMove(userData)

    expect(planDbMove(userData, userData)).toMatchObject({ ok: true })
    await applyPendingDbMove(userData)

    expect(readFileSync(join(userData, 'document-memory.db'), 'utf8')).toBe('main-db-contents')
    expect(resolveDbDir(userData)).toBe(userData)
    expect(dbLocationState(userData).isDefault).toBe(true)
  })

  it('leaves the index where it was, and says why, when the move fails', async () => {
    seed(userData)
    // planned while the folder was fine, then something took its place
    expect(planDbMove(userData, target)).toMatchObject({ ok: true })
    rmSync(join(root, 'bigdrive'), { recursive: true, force: true })
    writeFileSync(join(root, 'bigdrive'), 'now a file')

    const result = await applyPendingDbMove(userData)

    expect(result.moved).toBe(false)
    expect(result.error).toBeTruthy()
    expect(readFileSync(join(userData, 'document-memory.db'), 'utf8')).toBe('main-db-contents')
    expect(resolveDbDir(userData)).toBe(userData)
    expect(dbLocationState(userData)).toMatchObject({ lastError: result.error })
    expect(dbLocationState(userData).pending).toBeUndefined()
  })

  it('falls back to the data folder when the chosen folder has gone away', async () => {
    seed(userData)
    planDbMove(userData, target)
    await applyPendingDbMove(userData)
    rmSync(join(root, 'bigdrive'), { recursive: true, force: true })
    expect(resolveDbDir(userData)).toBe(userData)
  })

  it('forgets a move that was scheduled and then cancelled', () => {
    seed(userData)
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
