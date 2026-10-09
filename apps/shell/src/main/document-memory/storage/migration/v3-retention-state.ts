import { existsSync, opendirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export interface BackupDiagnosticError {
  path: string
  error: string
  code?: string
}

export interface BackupScanOptions {
  errorCollector?: BackupDiagnosticError[]
  maxEntries?: number
}

export interface V3RetentionState {
  backupPath: string
  createdAt: number
  verifiedLaunches: number
}

export const V3_RETENTION_FILENAME = 'v3-retention-state.json'
export const CANONICAL_V3_RETENTION_FILENAME = 'document-memory.v3-retention.json'

/**
 * Resolves authoritative creation timestamp for a backup candidate:
 * 1. If candidate is tracked rollback backup in retention state (resolve(candidate.path) === resolve(state.backupPath)):
 *    state.createdAt is the authoritative single source of truth (NEVER file mtime or guessed timestamp).
 * 2. If untracked timestamped backup: timestamp extracted from filename (extractBackupTimestamp).
 * 3. Fallback: file mtimeMs (only for legacy untracked backups without state or timestamp in name).
 */
export function getBackupCreationTime(
  backupPath: string,
  state?: V3RetentionState | null,
): number {
  if (
    state &&
    typeof state.backupPath === 'string' &&
    resolve(backupPath) === resolve(state.backupPath) &&
    typeof state.createdAt === 'number' &&
    Number.isFinite(state.createdAt) &&
    state.createdAt > 0
  ) {
    return state.createdAt
  }
  return extractBackupTimestamp(backupPath)
}

/**
 * Extracts creation timestamp from backup filename (e.g. *.v2.<timestamp>.*).
 * Falls back to statSync(backupPath).mtimeMs or Date.now() if not found.
 */
export function extractBackupTimestamp(backupPath: string): number {
  const fileName = basename(backupPath)
  const match = fileName.match(/\.v2\.(\d+)\./)
  if (match) {
    const parsed = Number(match[1])
    if (parsed > 0) {
      return parsed
    }
  }
  if (existsSync(backupPath)) {
    try {
      return statSync(backupPath).mtimeMs
    } catch {
      return Date.now()
    }
  }
  return Date.now()
}

/**
 * Resolves the target directory where the database and retention state reside.
 */
export function resolveRetentionDir(dbPathOrDir: string): string {
  if (existsSync(dbPathOrDir)) {
    try {
      if (statSync(dbPathOrDir).isDirectory()) {
        return dbPathOrDir
      }
      return dirname(dbPathOrDir)
    } catch {
      // ignore
    }
  }
  const isFile =
    dbPathOrDir.endsWith('.db') ||
    dbPathOrDir.endsWith('.sqlite') ||
    dbPathOrDir.endsWith('.sqlite3')
  return isFile ? dirname(dbPathOrDir) : dbPathOrDir
}

/**
 * Resolves the primary file path of the V3 retention state JSON.
 */
export function getV3RetentionStatePath(dbPathOrDir: string): string {
  const dir = resolveRetentionDir(dbPathOrDir)
  const candidate1 = join(dir, V3_RETENTION_FILENAME)
  const candidate2 = join(dir, CANONICAL_V3_RETENTION_FILENAME)

  if (existsSync(candidate1)) return candidate1
  if (existsSync(candidate2)) return candidate2
  return candidate1
}

/**
 * Finds all candidate V2 rollback backup files in the database directory,
 * sorted descending by creation time (newest first).
 * Tracked rollback backup uses state.createdAt as the authoritative creation timestamp.
 * Streams bounded directory entries using opendirSync.
 * Propagates EACCES/EIO/EPERM and scan limits to errorCollector instead of swallowing.
 */
export function findAllV2Backups(
  dir: string,
  dbBase = 'document-memory.db',
  state?: V3RetentionState | null,
  optionsOrErrors?: BackupScanOptions | BackupDiagnosticError[],
): Array<{ path: string; mtimeMs: number }> {
  const detailed = findAllV2BackupsDetailed(dir, dbBase, state, optionsOrErrors)
  return detailed.backups
}

/**
 * Detailed diagnostic API for discovering V2 rollback backups.
 * Streams bounded entries, checks root boundaries, and records non-ENOENT errors.
 */
export function findAllV2BackupsDetailed(
  dir: string,
  dbBase = 'document-memory.db',
  state?: V3RetentionState | null,
  optionsOrErrors?: BackupScanOptions | BackupDiagnosticError[],
): {
  backups: Array<{ path: string; mtimeMs: number }>
  errors: BackupDiagnosticError[]
  isIncomplete: boolean
} {
  const errors: BackupDiagnosticError[] = []
  const collector = Array.isArray(optionsOrErrors)
    ? optionsOrErrors
    : optionsOrErrors?.errorCollector
  const maxEntries = Array.isArray(optionsOrErrors) ? 10_000 : (optionsOrErrors?.maxEntries ?? 10_000)

  const recordError = (errObj: BackupDiagnosticError): void => {
    errors.push(errObj)
    collector?.push(errObj)
  }

  const resolvedDir = resolve(dir)

  try {
    const st = statSync(resolvedDir)
    if (!st.isDirectory()) {
      return { backups: [], errors, isIncomplete: false }
    }
  } catch (err: any) {
    if (err && err.code === 'ENOENT') {
      return { backups: [], errors, isIncomplete: false }
    }
    recordError({
      path: resolvedDir,
      error: `Failed to stat backup directory: ${err?.message || String(err)}`,
      code: err?.code || 'EACCES',
    })
    return { backups: [], errors, isIncomplete: true }
  }

  let dirStream: import('node:fs').Dir
  try {
    dirStream = opendirSync(resolvedDir)
  } catch (err: any) {
    if (err && err.code === 'ENOENT') {
      return { backups: [], errors, isIncomplete: false }
    }
    recordError({
      path: resolvedDir,
      error: `Failed to open backup directory stream: ${err?.message || String(err)}`,
      code: err?.code || 'EACCES',
    })
    return { backups: [], errors, isIncomplete: true }
  }

  const candidates: Array<{ path: string; mtimeMs: number }> = []
  const prefix = dbBase.replace(/\.db$/, '')
  const activeState = state !== undefined ? state : readV3RetentionState(resolvedDir, collector)
  let totalEntries = 0
  let isIncomplete = false

  try {
    let entry: import('node:fs').Dirent | null
    while ((entry = dirStream.readSync()) !== null) {
      totalEntries++
      if (totalEntries > maxEntries) {
        recordError({
          path: resolvedDir,
          error: `Backup directory scan exceeded maximum entry cap (${maxEntries})`,
          code: 'EQUOTA',
        })
        isIncomplete = true
        break
      }

      const f = entry.name
      if (f.startsWith(prefix) && f.includes('.v2.') && f.endsWith('.backup.db') && !f.includes('.tmp')) {
        const full = join(resolvedDir, f)
        // Ensure path remains strictly within resolvedDir boundary
        if (!full.startsWith(resolvedDir)) {
          recordError({
            path: full,
            error: `Backup candidate escapes root managed directory: ${full}`,
            code: 'EESCAPE',
          })
          continue
        }

        try {
          const mtimeMs = getBackupCreationTime(full, activeState)
          candidates.push({ path: full, mtimeMs })
        } catch (err: any) {
          recordError({
            path: full,
            error: `Failed to resolve creation time for backup: ${err?.message || String(err)}`,
            code: err?.code,
          })
        }
      }
    }
  } catch (err: any) {
    if (err && err.code !== 'ENOENT') {
      recordError({
        path: resolvedDir,
        error: `Error while streaming backup directory entries: ${err?.message || String(err)}`,
        code: err?.code,
      })
      isIncomplete = true
    }
  } finally {
    try {
      dirStream.closeSync()
    } catch {
      // ignore close errors
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { backups: candidates, errors, isIncomplete }
}

/**
 * Locates the most recent V2 rollback backup in the given directory.
 */
export function findMostRecentV2Backup(
  dir: string,
  dbBase = 'document-memory.db',
  state?: V3RetentionState | null,
  optionsOrErrors?: BackupScanOptions | BackupDiagnosticError[],
): { path: string; mtimeMs: number } | null {
  const all = findAllV2Backups(dir, dbBase, state, optionsOrErrors)
  return all.length > 0 ? all[0] : null
}

/**
 * Reads and parses the persistent V3 retention state from disk.
 * Propagates EACCES/EIO and corrupted JSON to optional errorCollector.
 * Only ENOENT is legitimately absent (returns null without error).
 */
export function readV3RetentionState(
  dbPathOrDir: string,
  errorCollector?: BackupDiagnosticError[],
): V3RetentionState | null {
  const detailed = readV3RetentionStateDetailed(dbPathOrDir)
  if (detailed.errors.length > 0 && errorCollector) {
    errorCollector.push(...detailed.errors)
  }
  return detailed.state
}

/**
 * Typed diagnostic API to read V3 retention state and collect any I/O or corruption errors.
 */
export function readV3RetentionStateDetailed(
  dbPathOrDir: string,
): { state: V3RetentionState | null; errors: BackupDiagnosticError[] } {
  const errors: BackupDiagnosticError[] = []
  const dir = resolveRetentionDir(dbPathOrDir)
  const candidates = [join(dir, V3_RETENTION_FILENAME), join(dir, CANONICAL_V3_RETENTION_FILENAME)]

  for (const candidatePath of candidates) {
    let exists: boolean
    try {
      const st = statSync(candidatePath)
      exists = st.isFile()
    } catch (err: any) {
      if (err && err.code === 'ENOENT') {
        continue // legitimate absent
      }
      errors.push({
        path: candidatePath,
        error: `Failed to stat retention state file: ${err?.message || String(err)}`,
        code: err?.code || 'EACCES',
      })
      continue
    }

    if (exists) {
      let raw: string
      try {
        raw = readFileSync(candidatePath, 'utf8')
      } catch (err: any) {
        if (err && err.code === 'ENOENT') continue
        errors.push({
          path: candidatePath,
          error: `Failed to read retention state file: ${err?.message || String(err)}`,
          code: err?.code || 'EACCES',
        })
        continue
      }

      let parsed: any
      try {
        parsed = JSON.parse(raw)
      } catch (err: any) {
        errors.push({
          path: candidatePath,
          error: `Corrupted retention state JSON at ${candidatePath}: ${err?.message || String(err)}`,
          code: 'ECORRUPT',
        })
        continue
      }

      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        typeof parsed.backupPath === 'string' &&
        parsed.backupPath.trim() !== '' &&
        Number.isSafeInteger(parsed.createdAt) &&
        parsed.createdAt > 0 &&
        Number.isSafeInteger(parsed.verifiedLaunches) &&
        parsed.verifiedLaunches >= 0
      ) {
        return {
          state: {
            backupPath: parsed.backupPath,
            createdAt: parsed.createdAt,
            verifiedLaunches: parsed.verifiedLaunches,
          },
          errors,
        }
      } else {
        errors.push({
          path: candidatePath,
          error: `Invalid retention state schema at ${candidatePath}`,
          code: 'ECORRUPT',
        })
      }
    }
  }

  return { state: null, errors }
}

/**
 * Durably persists the V3 retention state to disk.
 * Synchronizes both standard and canonical filenames for maximum caller compatibility.
 */
export function writeV3RetentionState(dbPathOrDir: string, state: V3RetentionState): void {
  const dir = resolveRetentionDir(dbPathOrDir)
  const data = JSON.stringify(state, null, 2)
  const p1 = join(dir, V3_RETENTION_FILENAME)
  const p2 = join(dir, CANONICAL_V3_RETENTION_FILENAME)

  try {
    writeFileSync(p1, data, { encoding: 'utf8', flush: true })
  } catch (err) {
    console.warn('[v3-retention-state] Failed to persist primary state:', err)
  }

  try {
    writeFileSync(p2, data, { encoding: 'utf8', flush: true })
  } catch (err) {
    console.warn('[v3-retention-state] Failed to persist canonical state:', err)
  }
}

/**
 * Initializes the V3 retention state following a successful migration.
 * By requirement, verifiedLaunches starts at 0 immediately post-migration.
 */
export function initV3RetentionState(
  dbPathOrDir: string,
  backupPath: string,
  createdAt?: number,
): V3RetentionState {
  let created: number
  if (typeof createdAt === 'number' && Number.isFinite(createdAt) && createdAt > 0) {
    created = createdAt
  } else {
    const existing = readV3RetentionState(dbPathOrDir)
    if (
      existing &&
      resolve(existing.backupPath) === resolve(backupPath) &&
      typeof existing.createdAt === 'number' &&
      Number.isFinite(existing.createdAt) &&
      existing.createdAt > 0
    ) {
      created = existing.createdAt
    } else {
      created = extractBackupTimestamp(backupPath)
    }
  }

  const state: V3RetentionState = {
    backupPath,
    createdAt: created,
    verifiedLaunches: 0,
  }

  writeV3RetentionState(dbPathOrDir, state)
  return state
}

/**
 * Records a successful, verified V3 application launch.
 * Increments verifiedLaunches by 1 and persists updated state.
 */
export function recordV3VerifiedLaunch(dbPathOrDir: string): V3RetentionState | null {
  let state = readV3RetentionState(dbPathOrDir)

  if (!state) {
    const dir = resolveRetentionDir(dbPathOrDir)
    const backupCandidate = findMostRecentV2Backup(dir)
    if (backupCandidate) {
      state = {
        backupPath: backupCandidate.path,
        createdAt: backupCandidate.mtimeMs,
        verifiedLaunches: 0,
      }
    } else {
      return null
    }
  }

  // If the recorded backup no longer exists on disk, state is obsolete
  if (!existsSync(state.backupPath)) {
    clearV3RetentionState(dbPathOrDir)
    return null
  }

  state.verifiedLaunches += 1
  writeV3RetentionState(dbPathOrDir, state)
  return state
}

/**
 * Removes persistent V3 retention state files from disk.
 */
export function clearV3RetentionState(dbPathOrDir: string): void {
  const dir = resolveRetentionDir(dbPathOrDir)
  const p1 = join(dir, V3_RETENTION_FILENAME)
  const p2 = join(dir, CANONICAL_V3_RETENTION_FILENAME)

  try {
    if (existsSync(p1)) unlinkSync(p1)
  } catch {
    // ignore
  }

  try {
    if (existsSync(p2)) unlinkSync(p2)
  } catch {
    // ignore
  }
}
