import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

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

export function checkBackupStatus(backupPath: string): {
  exists: boolean
  sizeBytes: number | null
  mtimeMs: number | null
} {
  if (!existsSync(backupPath)) {
    return { exists: false, sizeBytes: null, mtimeMs: null }
  }
  try {
    const st = statSync(backupPath)
    return { exists: true, sizeBytes: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return { exists: false, sizeBytes: null, mtimeMs: null }
  }
}

/**
 * Enforces enterprise backup retention policy (BEH-17):
 * - Keeps at least 3 most recent backups (>= 3 launches/snapshots)
 * - Keeps all backups created within the last 24 hours (>= 24h retention)
 * - Safely purges only backups that are both beyond the 3 most recent AND older than 24h
 */
export function enforceBackupRetentionPolicy(
  dbPath: string,
  minRetainedBackups = 3,
  minAgeHours = 24,
): number {
  const dir = dirname(dbPath)
  if (!existsSync(dir)) return 0

  const dbBase = basename(dbPath)
  const backupFiles: Array<{ path: string; mtimeMs: number }> = []

  try {
    const files = readdirSync(dir)
    for (const f of files) {
      if (f.startsWith(dbBase) && f.includes('.v2.') && f.endsWith('.backup.db')) {
        const full = join(dir, f)
        try {
          const st = statSync(full)
          backupFiles.push({ path: full, mtimeMs: st.mtimeMs })
        } catch {
          // ignore
        }
      }
    }
  } catch {
    return 0
  }

  // Sort descending by mtimeMs (most recent first)
  backupFiles.sort((a, b) => b.mtimeMs - a.mtimeMs)

  let purgedCount = 0
  const now = Date.now()
  const minAgeMs = minAgeHours * 60 * 60 * 1000

  // Keep first `minRetainedBackups` entries unconditionally
  for (let i = minRetainedBackups; i < backupFiles.length; i++) {
    const item = backupFiles[i]
    const ageMs = now - item.mtimeMs
    if (ageMs >= minAgeMs) {
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
