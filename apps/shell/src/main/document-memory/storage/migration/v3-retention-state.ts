import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

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
 */
export function findAllV2Backups(
  dir: string,
  dbBase = 'document-memory.db',
  state?: V3RetentionState | null,
): Array<{ path: string; mtimeMs: number }> {
  if (!existsSync(dir)) return []
  try {
    const files = readdirSync(dir)
    const candidates: Array<{ path: string; mtimeMs: number }> = []
    const prefix = dbBase.replace(/\.db$/, '')
    const activeState = state !== undefined ? state : readV3RetentionState(dir)

    for (const f of files) {
      if (f.startsWith(prefix) && f.includes('.v2.') && f.endsWith('.backup.db')) {
        const full = join(dir, f)
        try {
          const mtimeMs = getBackupCreationTime(full, activeState)
          candidates.push({ path: full, mtimeMs })
        } catch {
          // ignore unreadable
        }
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return candidates
  } catch {
    return []
  }
}

/**
 * Locates the most recent V2 rollback backup in the given directory.
 */
export function findMostRecentV2Backup(
  dir: string,
  dbBase = 'document-memory.db',
  state?: V3RetentionState | null,
): { path: string; mtimeMs: number } | null {
  const all = findAllV2Backups(dir, dbBase, state)
  return all.length > 0 ? all[0] : null
}

/**
 * Reads and parses the persistent V3 retention state from disk.
 * Returns null if not present or corrupt.
 */
export function readV3RetentionState(dbPathOrDir: string): V3RetentionState | null {
  const dir = resolveRetentionDir(dbPathOrDir)
  const candidates = [join(dir, V3_RETENTION_FILENAME), join(dir, CANONICAL_V3_RETENTION_FILENAME)]

  for (const candidatePath of candidates) {
    if (existsSync(candidatePath)) {
      try {
        const raw = readFileSync(candidatePath, 'utf8')
        const parsed = JSON.parse(raw) as Partial<V3RetentionState>
        if (
          typeof parsed.backupPath === 'string' &&
          typeof parsed.createdAt === 'number' &&
          typeof parsed.verifiedLaunches === 'number'
        ) {
          return {
            backupPath: parsed.backupPath,
            createdAt: parsed.createdAt,
            verifiedLaunches: parsed.verifiedLaunches,
          }
        }
      } catch {
        // try next candidate
      }
    }
  }

  return null
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
