import { existsSync, statSync, unlinkSync } from 'node:fs'

export function getCanonicalBackupPath(dbPath: string): string {
  return `${dbPath}.v2.backup.db`
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
