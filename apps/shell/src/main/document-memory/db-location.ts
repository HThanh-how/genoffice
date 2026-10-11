import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { copyFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
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
  stagingDir?: string
  files?: Array<{ name: string; size: number }>
  expectedDocCount?: number
  startedAt?: number
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
    const fd = openSync(filePath, process.platform === 'win32' ? 'r+' : 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // Non-blocking fallback if descriptor sync is unavailable
  }
}

function fsyncDir(dirPath: string): void {
  if (process.platform === 'win32') return
  try {
    const fd = openSync(dirPath, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // Directory fsync non-blocking fallback on POSIX
  }
}

export class CorruptRelocationJournalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CorruptRelocationJournalError'
  }
}

export class CorruptLocationMetadataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CorruptLocationMetadataError'
  }
}

function writeAtomic(
  filePath: string,
  content: string,
  options?: { isRecoveryRestore?: boolean },
): void {
  // Validate that content is valid JSON before writing
  try {
    JSON.parse(content)
  } catch (err) {
    throw new Error(
      `Refusing to write invalid metadata JSON to ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }

  const dir = dirname(filePath)
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  const bakPath = `${filePath}.bak`
  const bakTmpPath = `${bakPath}.${process.pid}.${Date.now()}.tmp`

  // 1. Durably write the new content to tmpPath
  const fd = openSync(tmpPath, 'w')
  try {
    writeFileSync(fd, content, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }

  // 2. Durably maintain bakPath before replacement:
  // ONLY if this is NOT a recovery restore, AND if current filePath exists and is valid JSON!
  // Never overwrite a valid backup with a corrupted or unverified primary file!
  if (!options?.isRecoveryRestore && existsSync(filePath)) {
    let currentFileValid = false
    try {
      const existing = readFileSync(filePath, 'utf8')
      JSON.parse(existing)
      currentFileValid = true
    } catch {
      // ignore parse failure
    }

    if (currentFileValid) {
      try {
        const bakFd = openSync(bakTmpPath, 'w')
        try {
          const currentContent = readFileSync(filePath)
          writeFileSync(bakFd, currentContent)
          fsyncSync(bakFd)
        } finally {
          closeSync(bakFd)
        }
        if (process.platform === 'win32') {
          let bakPromoted = false
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              renameSync(bakTmpPath, bakPath)
              bakPromoted = true
              break
            } catch {}
          }
          if (!bakPromoted && existsSync(bakPath)) {
            const bakOld = `${bakPath}.${process.pid}.${Date.now()}.old`
            try {
              renameSync(bakPath, bakOld)
              renameSync(bakTmpPath, bakPath)
              try {
                unlinkSync(bakOld)
              } catch {}
            } catch {
              try {
                if (existsSync(bakOld)) renameSync(bakOld, bakPath)
              } catch {}
            }
          }
        } else {
          renameSync(bakTmpPath, bakPath)
        }
        fsyncFile(bakPath)
        fsyncDir(dir)
      } catch {
        // Best-effort backup promotion
      } finally {
        try {
          if (existsSync(bakTmpPath)) unlinkSync(bakTmpPath)
        } catch {}
      }
    }
  }

  // 3. Atomically promote tmpPath -> filePath
  if (process.platform === 'win32') {
    let promoted = false
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        renameSync(tmpPath, filePath)
        promoted = true
        break
      } catch {
        // Brief retry for transient Windows sharing collisions
      }
    }
    if (!promoted) {
      // If direct replace failed on Windows, stage through .old with rollback restore
      const oldPath = `${filePath}.${process.pid}.${Date.now()}.old`
      try {
        if (existsSync(filePath)) {
          renameSync(filePath, oldPath)
        }
        try {
          renameSync(tmpPath, filePath)
          promoted = true
          try {
            unlinkSync(oldPath)
          } catch {}
        } catch (renameErr) {
          try {
            if (existsSync(oldPath)) {
              renameSync(oldPath, filePath)
            }
          } catch {}
          throw renameErr
        }
      } catch (err) {
        try {
          if (existsSync(tmpPath)) unlinkSync(tmpPath)
        } catch {}
        throw new Error(
          `Failed atomic file replacement for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        )
      }
    }
    fsyncFile(filePath)
  } else {
    try {
      renameSync(tmpPath, filePath)
      fsyncFile(filePath)
      fsyncDir(dir)
    } catch (err) {
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath)
      } catch {}
      throw new Error(
        `Failed atomic file replacement for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
  }
}

function findStagedOldFiles(filePath: string): string[] {
  try {
    const dir = dirname(filePath)
    const base = basename(filePath)
    if (!existsSync(dir)) return []
    const prefix = `${base}.`
    const files = readdirSync(dir)
    return files
      .filter((f) => (f.startsWith(prefix) || f === `${base}.old`) && f.endsWith('.old'))
      .map((f) => join(dir, f))
      .sort((a, b) => {
        try {
          return statSync(b).mtimeMs - statSync(a).mtimeMs
        } catch {
          return 0
        }
      })
  } catch {
    return []
  }
}

function cleanOrphanedTmpAndOldFiles(filePath: string): void {
  try {
    const dir = dirname(filePath)
    const base = basename(filePath)
    if (!existsSync(dir)) return
    const prefix = `${base}.`
    const files = readdirSync(dir)
    for (const f of files) {
      if (
        (f.startsWith(prefix) && (f.endsWith('.old') || f.endsWith('.tmp'))) ||
        f === `${base}.old`
      ) {
        try {
          unlinkSync(join(dir, f))
        } catch {}
      }
    }
  } catch {}
}

export function isSafeRelocationStagingDir(
  stagingDir: unknown,
  targetDir: string,
  sourceDir: string,
): boolean {
  if (typeof stagingDir !== 'string' || !stagingDir.trim()) return false
  if (typeof targetDir !== 'string' || !targetDir.trim()) return false
  if (typeof sourceDir !== 'string' || !sourceDir.trim()) return false
  if (!isAbsolute(stagingDir) || !isAbsolute(targetDir) || !isAbsolute(sourceDir)) return false
  if (stagingDir.includes('..') || targetDir.includes('..') || sourceDir.includes('..'))
    return false

  const resolvedStaging = resolve(stagingDir)
  const resolvedTarget = resolve(targetDir)
  const resolvedSource = resolve(sourceDir)

  if (!resolvedTarget || !resolvedSource || resolvedTarget === resolvedSource) return false
  if (resolvedStaging === resolvedTarget || resolvedStaging === resolvedSource) return false
  if (
    resolvedStaging === resolve('/') ||
    dirname(resolvedStaging) === resolvedStaging ||
    resolvedTarget === resolve('/') ||
    dirname(resolvedTarget) === resolvedTarget ||
    resolvedSource === resolve('/') ||
    dirname(resolvedSource) === resolvedSource
  ) {
    return false
  }

  // Correct parent directory: staging directory MUST be an immediate direct child of targetDir
  if (resolve(dirname(resolvedStaging)) !== resolvedTarget) return false

  // Staging naming convention: must begin with .relocation-staging- followed by valid identifier
  const base = basename(resolvedStaging)
  if (!base.startsWith('.relocation-staging-') || base.length < 22) return false
  if (!/^\.relocation-staging-[0-9a-zA-Z_-]+$/.test(base)) return false

  // Non-aliasing: ensure stagingDir is not an ancestor/prefix of target or source
  const sep = resolvedStaging.includes('\\') ? '\\' : '/'
  if (
    resolvedTarget.startsWith(resolvedStaging + sep) ||
    resolvedSource.startsWith(resolvedStaging + sep)
  ) {
    return false
  }

  // Symlink, junction, and escaping verification
  try {
    if (existsSync(resolvedStaging)) {
      const lst = lstatSync(resolvedStaging)
      if (lst.isSymbolicLink()) return false
      if (!lst.isDirectory()) return false

      if (existsSync(resolvedTarget)) {
        const realStaging = realpathSync(resolvedStaging)
        const realTarget = realpathSync(resolvedTarget)
        if (resolve(dirname(realStaging)) !== realTarget) return false
        if (realStaging === realTarget) return false
      }
      if (existsSync(resolvedSource)) {
        const realStaging = realpathSync(resolvedStaging)
        const realSource = realpathSync(resolvedSource)
        if (realStaging === realSource) return false
      }
    }
  } catch {
    return false
  }

  return true
}

function read(userData: string): LocationSettings {
  const primaryPath = join(userData, SETTINGS_FILE)
  const bakPath = join(userData, `${SETTINGS_FILE}.bak`)
  const oldFiles = findStagedOldFiles(primaryPath)
  const primaryExists = existsSync(primaryPath)
  const bakExists = existsSync(bakPath)
  const hasOldFiles = oldFiles.length > 0

  if (!primaryExists && !bakExists && !hasOldFiles) {
    return {}
  }

  const parseSettings = (filePath: string): LocationSettings | null => {
    try {
      if (!existsSync(filePath)) return null
      const content = readFileSync(filePath, 'utf8')
      const value: unknown = JSON.parse(content)
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const raw = value as Record<string, unknown>
      for (const key of Object.keys(raw)) {
        if (key !== 'dir' && key !== 'moveTo' && key !== 'lastError') return null
      }
      if (raw.dir !== undefined) {
        if (typeof raw.dir !== 'string' || !raw.dir.trim() || !isAbsolute(raw.dir)) return null
      }
      if (raw.moveTo !== undefined) {
        if (typeof raw.moveTo !== 'string' || !raw.moveTo.trim() || !isAbsolute(raw.moveTo)) {
          return null
        }
      }
      if (raw.lastError !== undefined) {
        if (typeof raw.lastError !== 'string') return null
      }
      return {
        ...(typeof raw.dir === 'string' && raw.dir ? { dir: raw.dir } : {}),
        ...(typeof raw.moveTo === 'string' && raw.moveTo ? { moveTo: raw.moveTo } : {}),
        ...(typeof raw.lastError === 'string' && raw.lastError ? { lastError: raw.lastError } : {}),
      }
    } catch {
      return null
    }
  }

  if (primaryExists) {
    const primary = parseSettings(primaryPath)
    if (primary !== null) {
      cleanOrphanedTmpAndOldFiles(primaryPath)
      return primary
    }
  }

  // Primary was missing or corrupted: check .old candidates first (most recent pre-crash primary state)
  for (const oldFile of oldFiles) {
    const oldSettings = parseSettings(oldFile)
    if (oldSettings !== null) {
      try {
        writeAtomic(primaryPath, JSON.stringify(oldSettings, null, 2), { isRecoveryRestore: true })
        cleanOrphanedTmpAndOldFiles(primaryPath)
      } catch {}
      return oldSettings
    }
  }

  // Next check .bak backup
  if (bakExists) {
    const backup = parseSettings(bakPath)
    if (backup !== null) {
      // Primary was missing or corrupted, but backup is valid.
      // Durably restore primary from valid backup WITHOUT overwriting backup!
      try {
        writeAtomic(primaryPath, JSON.stringify(backup, null, 2), { isRecoveryRestore: true })
        cleanOrphanedTmpAndOldFiles(primaryPath)
      } catch {}
      return backup
    }
  }

  // Metadata files existed on disk, but neither primary, .old, nor backup could be parsed!
  // If an existing verified database is already present in userData, preserve default location.
  const defaultDbPath = join(userData, 'document-memory.db')
  if (existsSync(defaultDbPath) && verifyDatabaseIntegrity(defaultDbPath).ok) {
    return {
      lastError: 'Settings metadata was corrupted; preserved existing database in default location',
    }
  }

  // Fail closed to prevent silent data loss (creating a fresh empty database in userData).
  throw new CorruptLocationMetadataError(
    `Corrupt location metadata in ${userData}; failing closed to prevent silent data loss`,
  )
}

function write(userData: string, settings: LocationSettings): void {
  writeAtomic(join(userData, SETTINGS_FILE), JSON.stringify(settings, null, 2))
}

function parseJournal(content: string): RelocationJournal | null {
  try {
    const parsed = JSON.parse(content) as RelocationJournal
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (parsed.version !== 1) return null
    if (!['prepare', 'staged', 'committed', 'cleanup'].includes(parsed.phase)) return null
    if (!['source', 'target'].includes(parsed.authoritative)) return null

    // Strictly validate journal phase and authority consistency
    if (
      (parsed.phase === 'prepare' || parsed.phase === 'staged') &&
      parsed.authoritative !== 'source'
    ) {
      return null
    }
    if (
      (parsed.phase === 'committed' || parsed.phase === 'cleanup') &&
      parsed.authoritative !== 'target'
    ) {
      return null
    }

    if (
      typeof parsed.sourceDir !== 'string' ||
      !parsed.sourceDir.trim() ||
      !isAbsolute(parsed.sourceDir)
    ) {
      return null
    }
    if (
      typeof parsed.targetDir !== 'string' ||
      !parsed.targetDir.trim() ||
      !isAbsolute(parsed.targetDir) ||
      resolve(parsed.sourceDir) === resolve(parsed.targetDir)
    ) {
      return null
    }
    if (parsed.stagingDir !== undefined) {
      if (!isSafeRelocationStagingDir(parsed.stagingDir, parsed.targetDir, parsed.sourceDir)) {
        return null
      }
    }
    if (parsed.files !== undefined) {
      if (!Array.isArray(parsed.files)) return null
      for (const f of parsed.files) {
        if (
          !f ||
          typeof f !== 'object' ||
          typeof f.name !== 'string' ||
          typeof f.size !== 'number' ||
          f.size < 0
        ) {
          return null
        }
      }
    }
    if (
      parsed.expectedDocCount !== undefined &&
      (typeof parsed.expectedDocCount !== 'number' ||
        !Number.isInteger(parsed.expectedDocCount) ||
        parsed.expectedDocCount < 0)
    ) {
      return null
    }
    if (
      parsed.startedAt !== undefined &&
      (typeof parsed.startedAt !== 'number' || parsed.startedAt <= 0)
    ) {
      return null
    }
    if (typeof parsed.updatedAt !== 'number' || parsed.updatedAt <= 0) return null

    return parsed
  } catch {
    return null
  }
}

function readJournal(userData: string): RelocationJournal | null {
  const journalPath = join(userData, JOURNAL_FILE)
  const bakPath = `${journalPath}.bak`
  const oldFiles = findStagedOldFiles(journalPath)
  const journalExists = existsSync(journalPath)
  const bakExists = existsSync(bakPath)
  const hasOld = oldFiles.length > 0

  if (!journalExists && !bakExists && !hasOld) return null

  if (journalExists) {
    try {
      const content = readFileSync(journalPath, 'utf8')
      const parsed = parseJournal(content)
      if (parsed) {
        cleanOrphanedTmpAndOldFiles(journalPath)
        return parsed
      }
    } catch {
      // Primary journal unreadable, try old/backup
    }
  }

  for (const oldFile of oldFiles) {
    try {
      const content = readFileSync(oldFile, 'utf8')
      const parsed = parseJournal(content)
      if (parsed) {
        try {
          writeAtomic(journalPath, JSON.stringify(parsed, null, 2), { isRecoveryRestore: true })
          cleanOrphanedTmpAndOldFiles(journalPath)
        } catch {}
        return parsed
      }
    } catch {}
  }

  if (bakExists) {
    try {
      const content = readFileSync(bakPath, 'utf8')
      const parsed = parseJournal(content)
      if (parsed) {
        try {
          writeAtomic(journalPath, JSON.stringify(parsed, null, 2), { isRecoveryRestore: true })
          cleanOrphanedTmpAndOldFiles(journalPath)
        } catch {}
        return parsed
      }
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
  const journalPath = join(userData, JOURNAL_FILE)
  try {
    unlinkSync(journalPath)
  } catch {}
  try {
    unlinkSync(join(userData, `${JOURNAL_FILE}.bak`))
  } catch {}
  cleanOrphanedTmpAndOldFiles(journalPath)
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
 * Verifies exclusive access/quiescence, inspects SQLite checkpoint result fields, and verifies truncation.
 */
export function checkpointDatabaseWal(dbPath: string): { ok: boolean; error?: string } {
  if (!existsSync(dbPath)) return { ok: true }
  try {
    const db = new DatabaseSync(dbPath)
    try {
      db.exec('PRAGMA busy_timeout = 2000;')
      // Verify quiescence and absence of active writer transactions
      db.exec('BEGIN IMMEDIATE; COMMIT;')

      const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get() as
        { busy?: number; log?: number; checkpointed?: number } | Record<string, unknown> | undefined
      const busy = row
        ? typeof row.busy === 'number'
          ? row.busy
          : Number(Object.values(row)[0] ?? 0)
        : 0
      const log = row
        ? typeof row.log === 'number'
          ? row.log
          : Number(Object.values(row)[1] ?? 0)
        : 0

      if (busy !== 0) {
        return {
          ok: false,
          error: 'SQLite wal_checkpoint returned busy (active readers or writers holding lock)',
        }
      }
      if (log > 0) {
        return {
          ok: false,
          error: `SQLite wal_checkpoint incomplete: ${log} frames remain uncheckpointed in WAL`,
        }
      }

      const walPath = `${dbPath}-wal`
      if (existsSync(walPath)) {
        try {
          if (statSync(walPath).size > 0) {
            return { ok: false, error: 'SQLite WAL file was not truncated to 0 bytes' }
          }
        } catch {}
      }
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

  if (resolve(sourceDir) === resolve(targetDir)) {
    const errorMsg = 'Critical: Relocation journal has identical source and target directories'
    write(userData, { dir: sourceDir, lastError: errorMsg })
    return { moved: false, error: errorMsg }
  }

  const safeCleanupStaging = async () => {
    if (stagingDir && isSafeRelocationStagingDir(stagingDir, targetDir, sourceDir)) {
      try {
        await rm(stagingDir, { recursive: true, force: true })
      } catch {}
    }
  }

  if (authoritative === 'target') {
    // Target was committed as authoritative before interruption
    const targetDbPath = join(targetDir, 'document-memory.db')
    const targetValid = verifyDatabaseCandidate(targetDbPath)
    if (targetValid.ok) {
      // Clean up staging directory if still around
      await safeCleanupStaging()
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
      await safeCleanupStaging()
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
    await safeCleanupStaging()
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
    await safeCleanupStaging()
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

    // 1.6 Record baseline schema, counts, and post-checkpoint source file stats
    const sourceDbStats = existsSync(sourceDbPath)
      ? { size: statSync(sourceDbPath).size, mtimeMs: statSync(sourceDbPath).mtimeMs }
      : null
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

    // 2.0 Verify source quiescence: source must not have mutated during copy
    if (sourceDbStats && existsSync(sourceDbPath)) {
      const currentSrcStat = statSync(sourceDbPath)
      if (
        currentSrcStat.size !== sourceDbStats.size ||
        currentSrcStat.mtimeMs !== sourceDbStats.mtimeMs
      ) {
        throw new Error(
          'Source database modified during staging; aborting relocation for consistency',
        )
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
