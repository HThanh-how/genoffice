import {
  accessSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { copyFile, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SETTINGS_FILE = 'document-memory-location.json'
const JOURNAL_FILE = 'document-memory-relocation-journal.json'

/** All database files SQLite and GenOffice keep beside the primary database file. */
export const ALL_POTENTIAL_DB_FILES = [
  'document-memory.db',
  'document-memory.db-wal',
  'document-memory.db-shm',
  'document-memory.db.v2.backup.db',
]

/** Standard primary and wal files. */
export const DB_FILES = ['document-memory.db', 'document-memory.db-wal']

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
  unavailable?: boolean
  /** a move waiting for the next start */
  pending?: string
  lastError?: string
}

export interface RelocationJournal {
  version: 1
  phase: 'prepare' | 'staged' | 'committed' | 'cleanup'
  authoritative: 'source' | 'target'
  sourceDir: string
  targetDir: string
  stagingDir: string
  files: Array<{ name: string; size: number }>
  expectedDocCount?: number
  startedAt: number
  updatedAt: number
  error?: string
}

export interface RelocationFaultHooks {
  onBeforeSnapshot?: () => void
  onDuringSnapshot?: () => void
  onAfterStageBeforeVerify?: () => void
  onDuringVerify?: () => void
  onAfterPromotionBeforeCommit?: () => void
  onBeforeCommit?: () => void
  onImmediatelyAfterCommit?: () => void
  onDuringCleanup?: () => void
}

function fsyncFile(filePath: string): void {
  try {
    const fd = openSync(filePath, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // Non-blocking fallback if descriptor sync is unavailable
  }
}

export class CorruptRelocationJournalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CorruptRelocationJournalError'
  }
}

function writeAtomic(filePath: string, content: string): void {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  const bakPath = `${filePath}.bak`
  writeFileSync(tmpPath, content, 'utf8')
  fsyncFile(tmpPath)
  if (existsSync(filePath)) {
    try {
      copyFileSync(filePath, bakPath)
      fsyncFile(bakPath)
    } catch {
      // Best-effort backup
    }
  }
  if (process.platform === 'win32') {
    try {
      try {
        unlinkSync(filePath)
      } catch {}
      renameSync(tmpPath, filePath)
      fsyncFile(filePath)
    } catch {
      writeFileSync(filePath, content, 'utf8')
      fsyncFile(filePath)
      try {
        unlinkSync(tmpPath)
      } catch {}
    }
  } else {
    try {
      renameSync(tmpPath, filePath)
      fsyncFile(filePath)
    } catch {
      writeFileSync(filePath, content, 'utf8')
      fsyncFile(filePath)
      try {
        unlinkSync(tmpPath)
      } catch {}
    }
  }
}

function read(userData: string): LocationSettings {
  const parseSettings = (filePath: string): LocationSettings | null => {
    try {
      if (!existsSync(filePath)) return null
      const content = readFileSync(filePath, 'utf8')
      const value: unknown = JSON.parse(content)
      if (!value || typeof value !== 'object') return null
      const { dir, moveTo, lastError } = value as LocationSettings
      return {
        ...(typeof dir === 'string' && dir ? { dir } : {}),
        ...(typeof moveTo === 'string' && moveTo ? { moveTo } : {}),
        ...(typeof lastError === 'string' && lastError ? { lastError } : {}),
      }
    } catch {
      return null
    }
  }

  const primary = parseSettings(join(userData, SETTINGS_FILE))
  if (primary !== null) return primary

  const backup = parseSettings(join(userData, `${SETTINGS_FILE}.bak`))
  if (backup !== null) return backup

  return {}
}

function write(userData: string, settings: LocationSettings): void {
  writeAtomic(join(userData, SETTINGS_FILE), JSON.stringify(settings, null, 2))
}

function parseJournal(content: string): RelocationJournal | null {
  try {
    const parsed = JSON.parse(content) as RelocationJournal
    if (
      parsed &&
      parsed.version === 1 &&
      typeof parsed.sourceDir === 'string' &&
      typeof parsed.targetDir === 'string'
    ) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

function readJournal(userData: string): RelocationJournal | null {
  const journalPath = join(userData, JOURNAL_FILE)
  const bakPath = `${journalPath}.bak`
  const journalExists = existsSync(journalPath)
  const bakExists = existsSync(bakPath)

  if (!journalExists && !bakExists) return null

  if (journalExists) {
    try {
      const content = readFileSync(journalPath, 'utf8')
      const parsed = parseJournal(content)
      if (parsed) return parsed
    } catch {
      // Primary journal unreadable, try backup
    }
  }

  if (bakExists) {
    try {
      const content = readFileSync(bakPath, 'utf8')
      const parsed = parseJournal(content)
      if (parsed) return parsed
    } catch {
      // Backup also unreadable
    }
  }

  throw new CorruptRelocationJournalError(
    `Corrupt relocation journal in ${userData}; failing closed to prevent silent data loss`,
  )
}

function writeJournal(userData: string, journal: RelocationJournal): void {
  journal.updatedAt = Date.now()
  writeAtomic(join(userData, JOURNAL_FILE), JSON.stringify(journal, null, 2))
}

function removeJournal(userData: string): void {
  try {
    unlinkSync(join(userData, JOURNAL_FILE))
  } catch {}
  try {
    unlinkSync(join(userData, `${JOURNAL_FILE}.bak`))
  } catch {}
}

/** Check if database directory is mounted, exists, and is readable & writable. */
export function isDbDirAccessible(dir: string): boolean {
  if (!dir) return false
  try {
    accessSync(dir, constants.R_OK | constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The folder that holds the index. Returns the configured directory, or userData if none.
 * Never silently falls back to userData when configured storage is unplugged/unavailable,
 * preventing silent creation of empty databases.
 */
export function resolveDbDir(userData: string): string {
  const journal = readJournal(userData)
  if (journal) {
    if (journal.authoritative === 'target') {
      return journal.targetDir
    }
    return journal.sourceDir
  }
  const { dir } = read(userData)
  if (!dir) return userData
  return dir
}

export function sizeOfDb(dir: string): number {
  let total = 0
  for (const name of ALL_POTENTIAL_DB_FILES) {
    try {
      total += statSync(join(dir, name)).size
    } catch {
      /* not there */
    }
  }
  return total
}

export function dbLocationState(userData: string): DbLocationState {
  try {
    const dir = resolveDbDir(userData)
    const accessible = isDbDirAccessible(dir)
    const { moveTo, lastError } = read(userData)
    return {
      dir,
      isDefault: resolve(dir) === resolve(userData),
      sizeBytes: accessible ? sizeOfDb(dir) : 0,
      unavailable: !accessible,
      ...(moveTo ? { pending: moveTo } : {}),
      ...(!accessible
        ? { lastError: lastError ?? 'Configured storage directory is unavailable or unmounted' }
        : lastError
          ? { lastError }
          : {}),
    }
  } catch (err) {
    const lastError = err instanceof Error ? err.message : String(err)
    return {
      dir: userData,
      isDefault: true,
      sizeBytes: 0,
      unavailable: true,
      lastError,
    }
  }
}

/**
 * Executes SQLite WAL checkpoint (TRUNCATE) to flush committed transactions from WAL into main DB file.
 */
export function checkpointDatabaseWal(dbPath: string): { ok: boolean; error?: string } {
  if (!existsSync(dbPath)) return { ok: true }
  try {
    const db = new DatabaseSync(dbPath)
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
      return { ok: true }
    } finally {
      db.close()
    }
  } catch (err) {
    return {
      ok: false,
      error: `WAL checkpoint failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Performs SQLite PRAGMA quick_check to verify physical B-tree and database integrity.
 */
export function verifyDatabaseIntegrity(dbPath: string): { ok: boolean; error?: string } {
  if (!existsSync(dbPath)) return { ok: false, error: 'Database file does not exist' }
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const checkResult = db.prepare('PRAGMA quick_check;').all() as Array<Record<string, unknown>>
      const firstRow = checkResult[0]
      const status = firstRow ? Object.values(firstRow)[0] : undefined
      if (status !== 'ok') {
        return { ok: false, error: `SQLite quick_check failed: ${String(status)}` }
      }
      return { ok: true }
    } finally {
      db.close()
    }
  } catch (err) {
    return {
      ok: false,
      error: `Failed to open or verify SQLite database: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Verifies schema and record counts on an SQLite database.
 */
export function verifyDatabaseSchema(
  dbPath: string,
  expectedDocCount?: number,
): { ok: boolean; docCount?: number; chunkCount?: number; error?: string } {
  if (!existsSync(dbPath)) return { ok: false, error: 'Database file does not exist' }
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table';")
        .all() as Array<{ name: string }>
      const tableNames = new Set(tables.map((t) => t.name))
      if (!tableNames.has('documents')) {
        return { ok: false, error: 'Required table "documents" is missing' }
      }
      const docRow = db.prepare('SELECT count(*) as c FROM documents;').get() as
        { c: number } | undefined
      const chunkRow = tableNames.has('chunks')
        ? (db.prepare('SELECT count(*) as c FROM chunks;').get() as { c: number } | undefined)
        : { c: 0 }
      const docCount = docRow?.c ?? 0
      const chunkCount = chunkRow?.c ?? 0
      if (expectedDocCount !== undefined && docCount !== expectedDocCount) {
        return {
          ok: false,
          error: `Document count mismatch: expected ${expectedDocCount}, found ${docCount}`,
        }
      }
      return { ok: true, docCount, chunkCount }
    } finally {
      db.close()
    }
  } catch (err) {
    return {
      ok: false,
      error: `Schema check failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Verifies both SQLite physical integrity and application schema for candidate databases.
 */
export function verifyDatabaseCandidate(
  dbPath: string,
  expectedDocCount?: number,
): { ok: boolean; error?: string } {
  const integrity = verifyDatabaseIntegrity(dbPath)
  if (!integrity.ok) return integrity
  const schema = verifyDatabaseSchema(dbPath, expectedDocCount)
  if (!schema.ok) return { ok: false, error: schema.error }
  return { ok: true }
}

/**
 * Check a new folder and, when valid, schedule the move for the next start.
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
    unlinkSync(probe)
  } catch {
    return { ok: false, error: 'unwritable' }
  }
  if (ALL_POTENTIAL_DB_FILES.some((name) => existsSync(join(next, name)))) {
    return { ok: false, error: 'exists' }
  }
  const sizeBytes = sizeOfDb(current)
  try {
    const space = statfsSync(next)
    if (Number(space.bavail) * Number(space.bsize) < sizeBytes * SPACE_MARGIN) {
      return { ok: false, error: 'space' }
    }
  } catch {
    /* free space check non-blocking if statfs is unavailable */
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

/**
 * Recovers an interrupted relocation using the persistent relocation journal.
 */
async function recoverInterruptedRelocation(
  userData: string,
  journal: RelocationJournal,
): Promise<{ moved: boolean; error?: string }> {
  const { sourceDir, targetDir, stagingDir, authoritative } = journal

  if (authoritative === 'target') {
    // Target was committed as authoritative before interruption
    const targetDbPath = join(targetDir, 'document-memory.db')
    const targetValid = verifyDatabaseCandidate(targetDbPath)
    if (targetValid.ok) {
      // Clean up staging directory if still around
      try {
        await rm(stagingDir, { recursive: true, force: true })
      } catch {}
      // Clean up source directory files
      for (const name of ALL_POTENTIAL_DB_FILES) {
        try {
          unlinkSync(join(sourceDir, name))
        } catch {}
      }
      const isDefault = resolve(targetDir) === resolve(userData)
      write(userData, { ...(isDefault ? {} : { dir: targetDir }), lastError: undefined })
      removeJournal(userData)
      return { moved: true }
    }

    // Target database corrupted: check if source is still valid
    const sourceDbPath = join(sourceDir, 'document-memory.db')
    const sourceValid = verifyDatabaseCandidate(sourceDbPath)
    if (sourceValid.ok) {
      // Roll back to source
      for (const name of ALL_POTENTIAL_DB_FILES) {
        try {
          unlinkSync(join(targetDir, name))
        } catch {}
      }
      try {
        await rm(stagingDir, { recursive: true, force: true })
      } catch {}
      const isDefault = resolve(sourceDir) === resolve(userData)
      write(userData, {
        ...(isDefault ? {} : { dir: sourceDir }),
        lastError: 'Target corrupted after commit; rolled back to verified source',
      })
      removeJournal(userData)
      return {
        moved: false,
        error: 'Target corrupted after commit; rolled back to verified source',
      }
    }

    // Neither is valid: fail closed, do not delete anything
    const errorMsg =
      'Critical: Relocation interrupted and neither source nor target passed integrity verification'
    write(userData, { dir: sourceDir, lastError: errorMsg })
    return { moved: false, error: errorMsg }
  }

  // Authoritative === 'source': move had not committed
  const sourceDbPath = join(sourceDir, 'document-memory.db')
  const targetDbPath = join(targetDir, 'document-memory.db')
  const sourceValid = verifyDatabaseCandidate(sourceDbPath)
  const targetValid = verifyDatabaseCandidate(targetDbPath)

  if (sourceValid.ok) {
    // Source is intact and verified. Safe to clean up target artifacts and roll back.
    try {
      await rm(stagingDir, { recursive: true, force: true })
    } catch {}
    for (const name of ALL_POTENTIAL_DB_FILES) {
      try {
        unlinkSync(join(targetDir, name))
      } catch {}
    }
    const isDefault = resolve(sourceDir) === resolve(userData)
    write(userData, {
      ...(isDefault ? {} : { dir: sourceDir }),
      lastError: 'Interrupted move rolled back to source',
    })
    removeJournal(userData)
    return { moved: false, error: 'Interrupted move rolled back to source' }
  }

  // Source is missing or corrupted: NEVER delete target solely because source DB is missing.
  // Check if target has a verified surviving copy.
  if (targetValid.ok) {
    try {
      await rm(stagingDir, { recursive: true, force: true })
    } catch {}
    const isDefault = resolve(targetDir) === resolve(userData)
    write(userData, { ...(isDefault ? {} : { dir: targetDir }), lastError: undefined })
    removeJournal(userData)
    return { moved: true }
  }

  // Neither candidate is valid: fail closed, NEVER delete any database files
  const errorMsg = 'Critical: Cannot verify database integrity during relocation crash recovery'
  write(userData, { dir: sourceDir, lastError: errorMsg })
  return { moved: false, error: errorMsg }
}

/**
 * Carry out a scheduled database relocation.
 * Implements a crash-safe, four-phase protocol (PREPARE, STAGE, COMMIT, CLEANUP)
 * with SQLite integrity verification and durable persistent journal.
 */
export async function applyPendingDbMove(
  userData: string,
  faultHooks?: RelocationFaultHooks,
): Promise<{ moved: boolean; error?: string }> {
  // Step 0: Check for any interrupted prior relocation
  let pendingJournal: RelocationJournal | null
  try {
    pendingJournal = readJournal(userData)
  } catch (err) {
    return { moved: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (pendingJournal) {
    return await recoverInterruptedRelocation(userData, pendingJournal)
  }

  const settings = read(userData)
  const { moveTo } = settings
  if (!moveTo) return { moved: false }

  const from = resolveDbDir(userData)
  const target = resolve(moveTo)

  if (resolve(from) === target) {
    cancelDbMove(userData)
    return { moved: false, error: 'Target is identical to source directory' }
  }

  const stagingDir = join(target, `.relocation-staging-${process.pid}-${Date.now()}`)
  const copiedFiles: string[] = []

  try {
    // ========================================================
    // PHASE 1: PREPARE
    // ========================================================
    faultHooks?.onBeforeSnapshot?.()

    // 1.1 Verify destination writability
    mkdirSync(target, { recursive: true })
    const probe = join(target, `.genoffice-probe-${process.pid}-${Date.now()}`)
    writeFileSync(probe, '')
    unlinkSync(probe)

    // 1.2 Reject if destination already contains a database
    if (ALL_POTENTIAL_DB_FILES.some((name) => existsSync(join(target, name)))) {
      throw new Error('target has an index')
    }

    // 1.3 Verify source existence
    if (!existsSync(from)) {
      throw new Error('source directory does not exist')
    }

    const sourceDbPath = join(from, 'document-memory.db')
    if (existsSync(sourceDbPath)) {
      // 1.4 Flush and truncate WAL into primary database
      faultHooks?.onDuringSnapshot?.()
      const cp = checkpointDatabaseWal(sourceDbPath)
      if (!cp.ok) {
        throw new Error(cp.error)
      }

      // 1.5 Verify source SQLite physical integrity
      const srcIntegrity = verifyDatabaseIntegrity(sourceDbPath)
      if (!srcIntegrity.ok) {
        throw new Error(`Source database integrity check failed: ${srcIntegrity.error}`)
      }
    }

    // 1.6 Record baseline schema and counts
    const srcSchema = existsSync(sourceDbPath)
      ? verifyDatabaseSchema(sourceDbPath)
      : { docCount: 0 }

    // 1.7 Check disk space
    const sizeBytes = sizeOfDb(from)
    try {
      const space = statfsSync(target)
      if (Number(space.bavail) * Number(space.bsize) < sizeBytes * SPACE_MARGIN) {
        throw new Error('insufficient disk space on target volume')
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('insufficient')) throw err
    }

    // 1.8 Create staging directory and persist initial journal
    mkdirSync(stagingDir, { recursive: true })

    const presentFiles = ALL_POTENTIAL_DB_FILES.filter(
      (name) => existsSync(join(from, name)) && name !== 'document-memory.db-shm',
    )

    const journal: RelocationJournal = {
      version: 1,
      phase: 'prepare',
      authoritative: 'source',
      sourceDir: from,
      targetDir: target,
      stagingDir,
      files: presentFiles.map((name) => ({ name, size: statSync(join(from, name)).size })),
      expectedDocCount: srcSchema.docCount,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }
    writeJournal(userData, journal)

    // ========================================================
    // PHASE 2: STAGE
    // ========================================================
    for (const name of presentFiles) {
      const srcFile = join(from, name)
      const stagedFile = join(stagingDir, name)
      copiedFiles.push(stagedFile)
      await copyFile(srcFile, stagedFile)
      fsyncFile(stagedFile)
      if ((await stat(srcFile)).size !== (await stat(stagedFile)).size) {
        throw new Error(`${name} copied short`)
      }
    }

    faultHooks?.onAfterStageBeforeVerify?.()

    // 2.1 Verify staged database SQLite integrity
    faultHooks?.onDuringVerify?.()
    const stagedDbPath = join(stagingDir, 'document-memory.db')
    if (existsSync(stagedDbPath)) {
      const stagedIntegrity = verifyDatabaseIntegrity(stagedDbPath)
      if (!stagedIntegrity.ok) {
        throw new Error(`Staged database integrity verification failed: ${stagedIntegrity.error}`)
      }
      const stagedSchema = verifyDatabaseSchema(stagedDbPath, srcSchema.docCount)
      if (!stagedSchema.ok) {
        throw new Error(`Staged database schema verification failed: ${stagedSchema.error}`)
      }
    }

    journal.phase = 'staged'
    writeJournal(userData, journal)

    // ========================================================
    // PHASE 3: COMMIT
    // ========================================================
    for (const name of presentFiles) {
      await rename(join(stagingDir, name), join(target, name))
      fsyncFile(join(target, name))
    }
    try {
      await rm(stagingDir, { recursive: true, force: true })
    } catch {}

    faultHooks?.onAfterPromotionBeforeCommit?.()

    // 3.1 Verify promoted database at destination
    const targetDbPath = join(target, 'document-memory.db')
    if (existsSync(targetDbPath)) {
      const targetIntegrity = verifyDatabaseIntegrity(targetDbPath)
      if (!targetIntegrity.ok) {
        throw new Error(`Target database integrity verification failed: ${targetIntegrity.error}`)
      }
    }

    faultHooks?.onBeforeCommit?.()

    // 3.2 Update journal: target is now authoritatively committed!
    journal.phase = 'committed'
    journal.authoritative = 'target'
    writeJournal(userData, journal)

    // 3.3 Update location settings
    const isDefault = resolve(target) === resolve(userData)
    write(userData, {
      ...(isDefault ? {} : { dir: target }),
      lastError: undefined,
    })

    faultHooks?.onImmediatelyAfterCommit?.()

    // ========================================================
    // PHASE 4: CLEANUP
    // ========================================================
    journal.phase = 'cleanup'
    writeJournal(userData, journal)

    faultHooks?.onDuringCleanup?.()

    let leftoverError: string | undefined
    for (const name of ALL_POTENTIAL_DB_FILES) {
      const srcFile = join(from, name)
      if (existsSync(srcFile)) {
        try {
          unlinkSync(srcFile)
        } catch (error) {
          leftoverError = `the old copy of ${name} could not be removed: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    }

    removeJournal(userData)

    if (leftoverError) {
      write(userData, {
        ...(isDefault ? {} : { dir: target }),
        lastError: leftoverError,
      })
      return { moved: true, error: leftoverError }
    }

    return { moved: true }
  } catch (error) {
    // Rollback staging files
    try {
      await rm(stagingDir, { recursive: true, force: true })
    } catch {}
    for (const file of copiedFiles) {
      try {
        unlinkSync(file)
      } catch {}
    }

    const message = error instanceof Error ? error.message : String(error)
    let journal: RelocationJournal | null = null
    try {
      journal = readJournal(userData)
    } catch {}
    if (journal && journal.authoritative === 'source') {
      removeJournal(userData)
    }

    write(userData, { ...(settings.dir ? { dir: settings.dir } : {}), lastError: message })
    return { moved: false, error: message }
  }
}
