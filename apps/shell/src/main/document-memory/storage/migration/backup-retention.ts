import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { verifyDatabaseIntegrity } from './logical-verifier'
import { MIN_VERIFIED_BACKUPS, MIN_BACKUP_AGE_HOURS } from './retention-policy'
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

    // Condition A: If an active/interrupted cutover manifest exists for this backup, it is incomplete/failed!
    const dir = dirname(backupPath)
    const manifestPath = join(dir, 'document-memory.migration-state.json')
    if (existsSync(manifestPath)) {
      try {
        const raw = readFileSync(manifestPath, 'utf8')
        const manifest = JSON.parse(raw)
        if (manifest && typeof manifest === 'object' && manifest.phase !== 'completed') {
          if (manifest.backupPath && resolve(manifest.backupPath) === resolve(backupPath)) {
            return false
          }
        }
      } catch {
        // ignore parse error
      }
    }

    const check = verifyDatabaseIntegrity(backupPath)
    if (check.ok !== true) return false

    // Condition B: Ensure database is readable SQLite with schema tables (not an empty/incomplete artifact)
    const db = new DatabaseSync(backupPath, { readOnly: true })
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
      if (tables.length === 0) return false
    } finally {
      db.close()
    }

    return true
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
  minRetainedBackups?: number
  minAgeHours?: number
}

/**
 * Enforces enterprise backup retention policy (PAIR 06 / BEH-17 / BLOCKER 5):
 * - Keeps at least 3 verified backups (>= 3 verified copies).
 * - Keeps all backups created within the last 24 hours (>= 24h retention).
 * - Backups younger than 24h or within the 3 newest verified backups are NEVER deleted.
 * - Failed/incomplete migration backups are never treated as verified.
 * - Safely purges only backups older than 24h beyond the 3 newest verified backups,
 *   or a verified migration rollback backup once V3 has completed >= 3 verified launches.
 */
export function enforceBackupRetentionPolicy(
  dbPath: string,
  minVerifiedOrOptions?: number | BackupRetentionOptions,
  maybeMinAgeHours?: number,
): number {
  const dir = dirname(dbPath)
  if (!existsSync(dir)) return 0

  let minRetainedBackups = MIN_VERIFIED_BACKUPS
  let minVerifiedLaunches = 3
  let minAgeHours = MIN_BACKUP_AGE_HOURS

  if (typeof minVerifiedOrOptions === 'number') {
    minRetainedBackups = minVerifiedOrOptions
    minVerifiedLaunches = minVerifiedOrOptions
    if (typeof maybeMinAgeHours === 'number') {
      minAgeHours = maybeMinAgeHours
    }
  } else if (minVerifiedOrOptions && typeof minVerifiedOrOptions === 'object') {
    if (typeof minVerifiedOrOptions.minRetainedBackups === 'number') {
      minRetainedBackups = minVerifiedOrOptions.minRetainedBackups
    }
    if (typeof minVerifiedOrOptions.minVerifiedLaunches === 'number') {
      minVerifiedLaunches = minVerifiedOrOptions.minVerifiedLaunches
    }
    if (typeof minVerifiedOrOptions.minAgeHours === 'number') {
      minAgeHours = minVerifiedOrOptions.minAgeHours
    }
  }

  const dbBase = basename(dbPath)
  const candidateFiles = findAllV2Backups(dir, dbBase)
  let state = readV3RetentionState(dbPath)

  if (state && !existsSync(state.backupPath)) {
    clearV3RetentionState(dbPath)
    state = null
  }

  if (candidateFiles.length === 0) {
    return 0
  }

  const now = Date.now()
  const minAgeMs = minAgeHours * 60 * 60 * 1000

  const protectedPaths = new Set<string>()

  // Job R1: Cheap-checks trước:
  // 1. backup < 24h -> chắc chắn protect -> không integrity scan
  for (const item of candidateFiles) {
    const ageMs = now - item.mtimeMs
    if (ageMs < minAgeMs) {
      protectedPaths.add(resolve(item.path))
    }
  }

  // 2. verified launches chưa đủ -> tracked rollback backup protect -> không cần verify để delete
  if (state && existsSync(state.backupPath)) {
    if (state.verifiedLaunches < minVerifiedLaunches) {
      protectedPaths.add(resolve(state.backupPath))
    }
  }

  // 3. không có candidate nào có khả năng delete -> return 0 ngay (cheap return)
  const hasPotentialDeletable = candidateFiles.some((item) => {
    const resolvedPath = resolve(item.path)
    const isProtected = protectedPaths.has(resolvedPath)
    const isOld = now - item.mtimeMs >= minAgeMs
    return !isProtected && isOld
  })

  if (!hasPotentialDeletable) {
    return 0
  }

  // Database must pass physical SQLite integrity & FK constraints if present
  if (existsSync(dbPath)) {
    const v3Integrity = verifyDatabaseIntegrity(dbPath)
    if (!v3Integrity.ok) {
      return 0
    }
  }

  // Job R2: Memoization cache within a single retention run
  const verificationCache = new Map<string, boolean>()
  const checkVerifiedMemo = (targetPath: string): boolean => {
    const resolvedKey = resolve(targetPath)
    if (verificationCache.has(resolvedKey)) {
      return verificationCache.get(resolvedKey)!
    }
    const result = isBackupVerified(targetPath)
    verificationCache.set(resolvedKey, result)
    return result
  }

  // Check launch-based single rollback backup eligibility (Pair 5 compatibility)
  let stateRollbackEligible = false
  if (state && existsSync(state.backupPath)) {
    const launchesPass = state.verifiedLaunches >= minVerifiedLaunches
    let backupMtimeMs = 0
    try {
      backupMtimeMs = statSync(state.backupPath).mtimeMs
    } catch {
      backupMtimeMs = 0
    }
    const effectiveCreatedAt = Math.min(state.createdAt ?? backupMtimeMs, backupMtimeMs)
    const agePass = now - effectiveCreatedAt >= minAgeMs

    // Only if launches and age pass do we check physical backup verification
    if (launchesPass && agePass) {
      const backupHealthy = checkVerifiedMemo(state.backupPath)
      if (backupHealthy) {
        stateRollbackEligible = true
      }
    }
  }

  // If state tracks a rollback backup that is not eligible for retirement, protect it
  if (state && !stateRollbackEligible && existsSync(state.backupPath)) {
    protectedPaths.add(resolve(state.backupPath))
  }

  // Audit candidates with memoized verification and evaluate retention quota
  const auditedCandidates: BackupCandidate[] = []
  let verifiedCount = 0

  for (const item of candidateFiles) {
    const resolvedPath = resolve(item.path)
    const ageMs = now - item.mtimeMs
    const isRecent = ageMs < minAgeMs

    // If stateRollbackEligible is true and this is the only candidate backup on disk (single migration rollback),
    // it has satisfied its launch duty and is eligible for retirement by Pair 5 launch policy.
    const isSingleRetiringRollback =
      state?.backupPath &&
      resolve(item.path) === resolve(state.backupPath) &&
      stateRollbackEligible &&
      candidateFiles.length === 1

    if (isSingleRetiringRollback) {
      auditedCandidates.push({
        path: item.path,
        mtimeMs: item.mtimeMs,
        verified: true,
      })
      continue
    }

    if (isRecent) {
      // backup < 24h -> chắc chắn protect -> không integrity scan
      protectedPaths.add(resolvedPath)
      auditedCandidates.push({
        path: item.path,
        mtimeMs: item.mtimeMs,
        verified: false,
      })
      continue
    }

    // Backup older than 24h (>= 24h):
    // Only verify if needed for minRetainedBackups quota or if already in cache
    let verified = false
    if (verifiedCount < minRetainedBackups) {
      verified = checkVerifiedMemo(item.path)
      if (verified) {
        protectedPaths.add(resolvedPath)
        verifiedCount++
      }
    } else if (verificationCache.has(resolvedPath)) {
      verified = verificationCache.get(resolvedPath)!
    }

    auditedCandidates.push({
      path: item.path,
      mtimeMs: item.mtimeMs,
      verified,
    })
  }

  let purgedCount = 0

  // Purge eligible unprotected candidates (older than minAgeHours AND outside top verified backups)
  for (const item of auditedCandidates) {
    const resolvedPath = resolve(item.path)
    if (protectedPaths.has(resolvedPath)) {
      continue
    }

    const ageMs = now - item.mtimeMs
    if (ageMs >= minAgeMs) {
      try {
        unlinkSync(item.path)
        purgedCount++
        if (state && resolve(item.path) === resolve(state.backupPath)) {
          clearV3RetentionState(dbPath)
        }
      } catch {
        // Safe: failure during unlink never throws or corrupts state
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
