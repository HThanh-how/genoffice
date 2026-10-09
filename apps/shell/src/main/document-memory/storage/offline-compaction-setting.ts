import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Opt-in switch of the OFFLINE full compaction (`VACUUM INTO` + verified swap, runtime/offline-compaction.ts) that
 * storage-bootstrap runs before any database connection exists. OFF by default and deliberately not exposed in the UI:
 * the file `<settingsDir>/document-memory-compaction.json` must contain `{ "offlineCompaction": true }`.
 * The online path (incremental vacuum + WAL truncate after every retention batch) is always active and sufficient for
 * databases that are already auto_vacuum=INCREMENTAL; the offline step is for legacy files and one-off clean-ups.
 */
export const COMPACTION_SETTINGS_FILENAME = 'document-memory-compaction.json'

export function readOfflineCompactionSetting(settingsDir: string | undefined): boolean {
  if (!settingsDir) return false
  const path = join(settingsDir, COMPACTION_SETTINGS_FILENAME)
  try {
    if (!existsSync(path)) return false
    return JSON.parse(readFileSync(path, 'utf8'))?.offlineCompaction === true
  } catch {
    return false
  }
}
