import { isIgnoredFileName } from '../folder-scan'
import type { DocumentMemoryStore } from '../store'

const FLAG_KEY = 'junk_purge_v1'

/**
 * One-time cleanup of temp/backup/OS-junk files that were indexed before the scan policy learned to skip them.
 * Only touches rows the user never opened (purgeDiscoveredByName); source files are never touched.
 */
export function purgeJunkOnce(store: DocumentMemoryStore): number {
  const db = store.rawDb
  const done = db.prepare('SELECT 1 FROM document_memory_meta WHERE key = ?').get(FLAG_KEY)
  if (done) return 0
  const removed = store.purgeDiscoveredByName(isIgnoredFileName)
  db.prepare('INSERT OR REPLACE INTO document_memory_meta(key, value) VALUES(?, ?)').run(FLAG_KEY, String(Date.now()))
  return removed
}
