import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * How long the V2 rollback backup left by the V2->V3 cutover is kept before the automatic retention policy may retire it
 * (it also needs the verified V3 launches and a passing integrity check, see enforceBackupRetentionPolicy). The backup is
 * not charged to the index quota, so keeping it costs the index nothing; the user can still delete it at any time from
 * Settings. Stored next to the database as a tiny JSON file; a missing, corrupt or out-of-range value means the default.
 */
export const BACKUP_RETENTION_SETTINGS_FILENAME = 'document-memory-backup-retention.json'
export const DEFAULT_BACKUP_RETENTION_DAYS = 14
export const MIN_BACKUP_RETENTION_DAYS = 1
export const MAX_BACKUP_RETENTION_DAYS = 365

export function normalizeBackupRetentionDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_BACKUP_RETENTION_DAYS
  const days = Math.floor(value)
  return days >= MIN_BACKUP_RETENTION_DAYS && days <= MAX_BACKUP_RETENTION_DAYS
    ? days
    : DEFAULT_BACKUP_RETENTION_DAYS
}

export function readBackupRetentionDays(dir: string): number {
  try {
    const parsed = JSON.parse(
      readFileSync(join(dir, BACKUP_RETENTION_SETTINGS_FILENAME), 'utf8'),
    ) as { retentionDays?: unknown } | null
    return normalizeBackupRetentionDays(parsed?.retentionDays)
  } catch {
    return DEFAULT_BACKUP_RETENTION_DAYS
  }
}

export function writeBackupRetentionDays(dir: string, days: number): number {
  const retentionDays = normalizeBackupRetentionDays(days)
  const target = join(dir, BACKUP_RETENTION_SETTINGS_FILENAME)
  const temp = `${target}.${process.pid}.${Date.now()}.part`
  writeFileSync(temp, JSON.stringify({ retentionDays }, null, 2), 'utf8')
  renameSync(temp, target)
  return retentionDays
}
