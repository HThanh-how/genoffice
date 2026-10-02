import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs'
import { copyFile, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

const SETTINGS_FILE = 'document-memory-location.json'
/** The database and the two files SQLite keeps beside it while it is open. */
const DB_FILES = ['document-memory.db', 'document-memory.db-wal', 'document-memory.db-shm']
/** Free space wanted on the new drive, relative to the database: room to copy it and a little growth. */
const SPACE_MARGIN = 1.25

interface LocationSettings {
  /** where the index lives; absent means the app's own data folder */
  dir?: string
  /** a move that is carried out at the next start, before anything opens the database */
  moveTo?: string
  /** why the last move did not happen */
  lastError?: string
}

export type DbMoveError = 'invalid' | 'same' | 'unwritable' | 'space' | 'exists'

export interface DbLocationState {
  dir: string
  isDefault: boolean
  sizeBytes: number
  /** a move waiting for the next start */
  pending?: string
  lastError?: string
}

function read(userData: string): LocationSettings {
  try {
    const value: unknown = JSON.parse(readFileSync(join(userData, SETTINGS_FILE), 'utf8'))
    if (!value || typeof value !== 'object') return {}
    const { dir, moveTo, lastError } = value as LocationSettings
    return {
      ...(typeof dir === 'string' && dir ? { dir } : {}),
      ...(typeof moveTo === 'string' && moveTo ? { moveTo } : {}),
      ...(typeof lastError === 'string' && lastError ? { lastError } : {}),
    }
  } catch {
    return {}
  }
}

function write(userData: string, settings: LocationSettings): void {
  writeFileSync(join(userData, SETTINGS_FILE), JSON.stringify(settings), 'utf8')
}

/**
 * The folder that holds the index. A folder that has gone away (an unplugged drive) falls back to
 * the data folder rather than silently starting an empty index somewhere that is not there.
 */
export function resolveDbDir(userData: string): string {
  const { dir } = read(userData)
  if (!dir) return userData
  try {
    accessSync(dir, constants.R_OK | constants.W_OK)
    return dir
  } catch {
    return userData
  }
}

function sizeOfDb(dir: string): number {
  let total = 0
  for (const name of DB_FILES) {
    try {
      total += statSync(join(dir, name)).size
    } catch {
      /* not there */
    }
  }
  return total
}

export function dbLocationState(userData: string): DbLocationState {
  const dir = resolveDbDir(userData)
  const { moveTo, lastError } = read(userData)
  return {
    dir,
    isDefault: resolve(dir) === resolve(userData),
    sizeBytes: sizeOfDb(dir),
    ...(moveTo ? { pending: moveTo } : {}),
    ...(lastError ? { lastError } : {}),
  }
}

/**
 * Check a new folder and, when it will do, schedule the move for the next start. Nothing is
 * moved here: the database is open now, and copying it live could tear it.
 */
export function planDbMove(
  userData: string,
  target: string,
): { ok: true; sizeBytes: number } | { ok: false; error: DbMoveError } {
  if (!target || !isAbsolute(target)) return { ok: false, error: 'invalid' }
  const next = resolve(target)
  const current = resolveDbDir(userData)
  if (resolve(current) === next) return { ok: false, error: 'same' }
  try {
    mkdirSync(next, { recursive: true })
    const probe = join(next, `.genoffice-write-test-${process.pid}`)
    writeFileSync(probe, '')
    void rm(probe, { force: true })
  } catch {
    return { ok: false, error: 'unwritable' }
  }
  if (DB_FILES.some((name) => existsSync(join(next, name)))) return { ok: false, error: 'exists' }
  const sizeBytes = sizeOfDb(current)
  try {
    const space = statfsSync(next)
    if (Number(space.bavail) * Number(space.bsize) < sizeBytes * SPACE_MARGIN) {
      return { ok: false, error: 'space' }
    }
  } catch {
    /* free space cannot be read on this volume: go ahead, the copy will fail cleanly if it must */
  }
  write(userData, { ...read(userData), moveTo: next, lastError: undefined })
  return { ok: true, sizeBytes }
}

/** Forget a move that has been scheduled but not yet carried out. */
export function cancelDbMove(userData: string): void {
  const settings = read(userData)
  delete settings.moveTo
  write(userData, settings)
}

async function sameSize(a: string, b: string): Promise<boolean> {
  return (await stat(a)).size === (await stat(b)).size
}

/**
 * Carry out a scheduled move. Called once at start-up, before the database is opened. Every file
 * is copied beside its destination first and renamed into place only when all of them are there
 * with the right size, and the old copies are removed last: a failure at any point leaves the
 * index where it was, and the reason is kept for the settings page.
 */
export async function applyPendingDbMove(
  userData: string,
): Promise<{ moved: boolean; error?: string }> {
  const settings = read(userData)
  const { moveTo } = settings
  if (!moveTo) return { moved: false }
  const from = resolveDbDir(userData)
  const copied: string[] = []
  try {
    if (resolve(from) === resolve(moveTo)) throw new Error('already there')
    mkdirSync(moveTo, { recursive: true })
    if (DB_FILES.some((name) => existsSync(join(moveTo, name))))
      throw new Error('target has an index')
    const present = DB_FILES.filter((name) => existsSync(join(from, name)))
    for (const name of present) {
      const partial = join(moveTo, `${name}.moving`)
      copied.push(partial)
      await copyFile(join(from, name), partial)
      if (!(await sameSize(join(from, name), partial))) throw new Error(`${name} copied short`)
    }
    for (const name of present) await rename(join(moveTo, `${name}.moving`), join(moveTo, name))
    // From here the index is complete in its new place, so the move counts even if an old copy
    // cannot be removed (something still holds it open): it is reported, not undone.
    let leftover: string | undefined
    for (const name of present) {
      try {
        await rm(join(from, name), { force: true })
      } catch (error) {
        leftover = `the old copy of ${name} could not be removed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    const isDefault = resolve(moveTo) === resolve(userData)
    write(userData, {
      ...(isDefault ? {} : { dir: moveTo }),
      ...(leftover ? { lastError: leftover } : {}),
    })
    return { moved: true, ...(leftover ? { error: leftover } : {}) }
  } catch (error) {
    await Promise.all(copied.map((file) => rm(file, { force: true }).catch(() => undefined)))
    const message = error instanceof Error ? error.message : String(error)
    write(userData, { ...(settings.dir ? { dir: settings.dir } : {}), lastError: message })
    return { moved: false, error: message }
  }
}
