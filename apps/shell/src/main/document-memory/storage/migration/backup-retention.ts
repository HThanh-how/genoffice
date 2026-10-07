import { existsSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { verifyDatabaseIntegrity } from './logical-verifier'
import {
  type V3RetentionState,
  readV3RetentionState,
  writeV3RetentionState,
  initV3RetentionState,
  recordV3VerifiedLaunch,
  clearV3RetentionState,
  getV3RetentionStatePath,
  findAllV2Backups,
  findMostRecentV2Backup,
} from './v3-retention-state'

export {
  type V3RetentionState,
  readV3RetentionState,
  writeV3RetentionState,
  initV3RetentionState,
  recordV3VerifiedLaunch,
  clearV3RetentionState,
  getV3RetentionStatePath,
  findAllV2Backups,
  findMostRecentV2Backup,
}

export function getCanonicalBackupPath(dbPath: string): string {
  return `${dbPath}.v2.backup.db`
}

export function generateCollisionSafeBackupPath(dbPath: string): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const ts = Date.now()
    const suffix = randomUUID().slice(0, 8)
    const candidate = `${dbPath}.v2.${ts}.${suffix}.backup.db`
    if (!existsSync(candidate)) {
      return candidate
    }
  }
  return `${dbPath}.v2.${Date.now()}.${randomUUID().replace(/-/g, '').slice(0, 12)}.backup.db`
}

export function isBackupVerified(backupPath: string): boolean {
  if (!existsSync(backupPath)) return false
  try {
    const st = statSync(backupPath)
    if (st.size < 100) return false
    const check = verifyDatabaseIntegrity(backupPath)
    return check.ok === true
  } catch {
    return false
  }
}

export function checkBackupStatus(backupPath: string): {
  exists: boolean
  sizeBytes: number | null
  mtimeMs: number | null
  verified: boolean
} {
  if (!existsSync(backupPath)) {
    return { exists: false, sizeBytes: null, mtimeMs: null, verified: false }
  }
  try {
    const st = statSync(backupPath)
    const verified = isBackupVerified(backupPath)
    return { exists: true, sizeBytes: st.size, mtimeMs: st.mtimeMs, verified }
  } catch {
    return { exists: false, sizeBytes: null, mtimeMs: null, verified: false }
  }
}

export interface BackupCandidate {
  path: string
  mtimeMs: number
  verified: boolean
}

export interface BackupRetentionOptions {
  minVerifiedLaunches?: number
  minAgeHours?: number
}

/**
 * Enforces enterprise backup retention policy (Pair 5 / BLOCKER 5):
 * - Retains V2 rollback backup until V3 has successfully launched and verified at least 3 times.
 * - AND backup has existed for >= 24 hours.
 * - AND backup integrity verification PASS.
 * - AND current V3 database integrity verification PASS.
 * 
 * Safely purges V2 rollback backup ONLY when all 4 conditions are met.
 */
export function enforceBackupRetentionPolicy(
  dbPath: string,
  minVerifiedLaunchesOrOptions?: number | BackupRetentionOptions,
  maybeMinAgeHours?: number,
): number {
  const dir = dirname(dbPath)
  if (!existsSync(dir)) return 0

  let minVerifiedLaunches = 3
  let minAgeHours = 24

  if (typeof minVerifiedLaunchesOrOptions === 'number') {
    minVerifiedLaunches = minVerifiedLaunchesOrOptions
    if (typeof maybeMinAgeHours === 'number') {
      minAgeHours = maybeMinAgeHours
    }
  } else if (minVerifiedLaunchesOrOptions && typeof minVerifiedLaunchesOrOptions === 'object') {
    if (typeof minVerifiedLaunchesOrOptions.minVerifiedLaunches === 'number') {
      minVerifiedLaunches = minVerifiedLaunchesOrOptions.minVerifiedLaunches
    }
    if (typeof minVerifiedLaunchesOrOptions.minAgeHours === 'number') {
      minAgeHours = minVerifiedLaunchesOrOptions.minAgeHours
    }
  }

  // Condition 4: Current V3 integrity PASS
  // Database must exist and pass physical SQLite integrity & FK constraints
  if (!existsSync(dbPath)) {
    return 0
  }
  const v3Integrity = verifyDatabaseIntegrity(dbPath)
  if (!v3Integrity.ok) {
    return 0
  }

  const dbBase = basename(dbPath)
  const candidateFiles = findAllV2Backups(dir, dbBase)
  let state = readV3RetentionState(dbPath)

  if (!state) {
    if (candidateFiles.length > 0) {
      // Discover existing candidate backup on disk and initialize state with 0 verified launches
      state = initV3RetentionState(dbPath, candidateFiles[0].path, candidateFiles[0].mtimeMs)
    } else {
      return 0
    }
  }

  if (!existsSync(state.backupPath)) {
    clearV3RetentionState(dbPath)
    return 0
  }

  // Condition 3: Backup integrity PASS
  const backupHealthy = isBackupVerified(state.backupPath)
  if (!backupHealthy) {
    return 0
  }

  // Condition 2: V3 verified launches >= 3
  const launchesPass = state.verifiedLaunches >= minVerifiedLaunches
  if (!launchesPass) {
    return 0
  }

  // Condition 1: Age >= 24h
  const now = Date.now()
  let backupMtimeMs: number
  try {
    backupMtimeMs = statSync(state.backupPath).mtimeMs
  } catch {
    return 0
  }
  const effectiveCreatedAt = Math.min(state.createdAt ?? backupMtimeMs, backupMtimeMs)
  const ageMs = now - effectiveCreatedAt
  const minAgeMs = minAgeHours * 60 * 60 * 1000
  const agePass = ageMs >= minAgeMs
  if (!agePass) {
    return 0
  }

  // All 4 conditions met: Purge V2 backup and reclaim storage
  let purgedCount = 0
  try {
    unlinkSync(state.backupPath)
    purgedCount++
    clearV3RetentionState(dbPath)
  } catch {
    // Safe: failure during unlink never throws or corrupts state
  }

  // Also clean up any other orphan V2 backup files older than minAgeHours
  for (const item of candidateFiles) {
    if (item.path === state.backupPath) continue
    const ageItemMs = now - item.mtimeMs
    if (ageItemMs >= minAgeMs) {
      try {
        unlinkSync(item.path)
        purgedCount++
      } catch {
        // ignore
      }
    }
  }

  return purgedCount
}

export function cleanupObsoleteBackup(backupPath: string, maxAgeDays = 14): boolean {
  if (!existsSync(backupPath)) return false
  try {
    const st = statSync(backupPath)
    const ageMs = Date.now() - st.mtimeMs
    if (ageMs > maxAgeDays * 24 * 60 * 60 * 1000) {
      unlinkSync(backupPath)
      return true
    }
  } catch {
    // ignore
  }
  return false
}
