import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { verifyDatabaseIntegrity } from './logical-verifier'

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

/**
 * Enforces enterprise backup retention policy (BEH-17 / Pair 07):
 * - Keeps at least 3 verified backups (>= 3 verified copies)
 * - Keeps all backups created within the last 24 hours (>= 24h retention)
 * - Backup chưa verified: do not count as safe verified launch
 * - Safely purges only backups that are older than 24h AND beyond the 3 most recent verified backups
 */
export function enforceBackupRetentionPolicy(
  dbPath: string,
  minRetainedBackups = 3,
  minAgeHours = 24,
): number {
  const dir = dirname(dbPath)
  if (!existsSync(dir)) return 0

  const dbBase = basename(dbPath)
  const candidateFiles: BackupCandidate[] = []

  try {
    const files = readdirSync(dir)
    for (const f of files) {
      if (f.startsWith(dbBase) && f.includes('.v2.') && f.endsWith('.backup.db')) {
        const full = join(dir, f)
        try {
          const st = statSync(full)
          const verified = isBackupVerified(full)
          candidateFiles.push({ path: full, mtimeMs: st.mtimeMs, verified })
        } catch {
          // ignore unreadable files
        }
      }
    }
  } catch {
    return 0
  }

  // Sort descending by mtimeMs (most recent first)
  candidateFiles.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const now = Date.now()
  const minAgeMs = minAgeHours * 60 * 60 * 1000

  let verifiedCount = 0
  const protectedPaths = new Set<string>()

  for (const item of candidateFiles) {
    const ageMs = now - item.mtimeMs
    // Invariant: Never delete any backup younger than 24 hours
    if (ageMs < minAgeMs) {
      protectedPaths.add(item.path)
    }

    // Invariant: Keep at least minRetainedBackups (>= 3) verified backups
    if (item.verified && verifiedCount < minRetainedBackups) {
      protectedPaths.add(item.path)
      verifiedCount++
    }
  }

  let purgedCount = 0

  // Purge eligible unprotected candidates
  for (const item of candidateFiles) {
    if (protectedPaths.has(item.path)) {
      continue
    }

    const ageMs = now - item.mtimeMs
    // Only purge if older than minAgeMs
    if (ageMs >= minAgeMs) {
      try {
        unlinkSync(item.path)
        purgedCount++
      } catch {
        // Safe: failure during unlink never affects other files or throws
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
