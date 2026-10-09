import { lstatSync, opendirSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { extractBackupTimestamp } from './v3-retention-state'

/**
 * The V2 rollback backups a V2->V3 cutover leaves next to the live database, and the ONE place that decides which
 * files are such backups. Backups are NOT part of the search index: the user's documents are the source of truth, the
 * live V3 database is derived data, and the backup is only the previous derived copy kept for rollback. The storage
 * quota therefore never charges them (see collectStorageAccounting), and they are only ever removed by
 *  - the automatic retention policy (backup-retention.ts: age + verified launches), or
 *  - the explicit "Delete old index backup" action, which goes through deleteV2Backups below.
 *
 * Names produced by the migration (generateCollisionSafeBackupPath / getCanonicalBackupPath):
 *   <db>.v2.backup.db                         canonical (older releases)
 *   <db>.v2.<epoch-ms>.<8..12 hex>.backup.db  collision-safe
 * plus the SQLite companions of such a file: -wal, -shm, -journal. Nothing else qualifies: not file-index.db, not model
 * caches, not "*.tmp" scratch, not a name that merely ends in ".backup.db".
 */

export const V2_BACKUP_COMPANION_SUFFIXES: readonly string[] = ['-wal', '-shm', '-journal']

export interface BackupNameOptions {
  /** NTFS / default APFS compare names case-insensitively. Default: true on win32 and darwin, false elsewhere. */
  caseInsensitive?: boolean
}

function defaultCaseInsensitive(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
}

/** Windows paths compare case-insensitively (drive letter / folder case can differ between two realpath calls). */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Returns the main backup file name a directory entry belongs to (itself, or the owner of a -wal/-shm/-journal), else null. */
export function matchV2BackupFileName(
  name: string,
  dbBase = 'document-memory.db',
  options: BackupNameOptions = {},
): { main: string; companion: boolean } | null {
  const ci = options.caseInsensitive ?? defaultCaseInsensitive()
  const stem = dbBase.replace(/\.db$/i, '')
  const owners = stem === dbBase ? [dbBase] : [dbBase, stem]
  const prefix = owners.map(escapeRegExp).join('|')
  const re = new RegExp(
    `^(?:${prefix})\\.v2\\.(?:\\d{10,16}\\.[0-9a-f]{8,12}\\.)?backup\\.db((?:-wal|-shm|-journal)?)$`,
    ci ? 'i' : '',
  )
  const m = re.exec(name)
  if (!m) return null
  const companion = m[1] !== ''
  return { main: companion ? name.slice(0, name.length - m[1].length) : name, companion }
}

export interface V2BackupEntry {
  /** Absolute path of the main backup file. */
  path: string
  name: string
  /** Main file + every existing companion. */
  sizeBytes: number
  mainBytes: number
  companionPaths: string[]
  /** Creation time from the file name (epoch ms), mtime for the canonical un-timestamped name. */
  createdAt: number
}

export interface V2BackupInventory {
  dir: string
  backups: V2BackupEntry[]
  totalBytes: number
  errors: Array<{ path: string; error: string; code?: string }>
}

const MAX_SCANNED_ENTRIES = 50_000

/**
 * Lists the backups of `dbPath`'s folder (one level, never recursive). A directory entry counts only when it is a REAL
 * regular file directly inside the folder: symlinks / junctions are never followed or sized, and its realpath must be
 * `<realpath(folder)>/<name>`. Read-only; safe to call from the main process and from workers.
 */
export function inventoryV2Backups(
  dbPath: string,
  options: BackupNameOptions = {},
): V2BackupInventory {
  const dir = dirname(dbPath)
  const dbBase = basename(dbPath)
  const errors: V2BackupInventory['errors'] = []
  const empty: V2BackupInventory = { dir, backups: [], totalBytes: 0, errors }

  let realDir: string
  try {
    realDir = realpathSync(dir)
  } catch (err: any) {
    if (err?.code !== 'ENOENT')
      errors.push({ path: dir, error: err?.message ?? String(err), code: err?.code })
    return empty
  }

  let stream: import('node:fs').Dir
  try {
    stream = opendirSync(realDir)
  } catch (err: any) {
    if (err?.code !== 'ENOENT')
      errors.push({ path: realDir, error: err?.message ?? String(err), code: err?.code })
    return empty
  }

  const mains = new Map<string, { size: number }>()
  const companions = new Map<string, Array<{ path: string; size: number }>>()
  const ci = options.caseInsensitive ?? defaultCaseInsensitive()
  const key = (name: string): string => (ci ? name.toLowerCase() : name)
  try {
    let seen = 0
    let entry: import('node:fs').Dirent | null
    while ((entry = stream.readSync()) !== null) {
      if (++seen > MAX_SCANNED_ENTRIES) {
        errors.push({
          path: realDir,
          error: `Backup scan stopped after ${MAX_SCANNED_ENTRIES} entries`,
          code: 'EQUOTA',
        })
        break
      }
      const match = matchV2BackupFileName(entry.name, dbBase, options)
      if (!match) continue
      const full = join(realDir, entry.name)
      try {
        const st = lstatSync(full)
        if (!st.isFile()) continue // symlink, junction, directory: not ours to size or follow
        if (!samePath(realpathSync(full), full)) continue // a path component is a link; the file lives elsewhere
        if (match.companion) {
          const list = companions.get(key(match.main)) ?? []
          list.push({ path: full, size: st.size })
          companions.set(key(match.main), list)
        } else {
          mains.set(full, { size: st.size })
        }
      } catch (err: any) {
        if (err?.code !== 'ENOENT')
          errors.push({ path: full, error: err?.message ?? String(err), code: err?.code })
      }
    }
  } finally {
    try {
      stream.closeSync()
    } catch {
      // ignore close errors
    }
  }

  const backups: V2BackupEntry[] = []
  for (const [path, { size }] of mains) {
    const name = basename(path)
    const owned = companions.get(key(name)) ?? []
    backups.push({
      path,
      name,
      mainBytes: size,
      sizeBytes: size + owned.reduce((sum, c) => sum + c.size, 0),
      companionPaths: owned.map((c) => c.path),
      createdAt: extractBackupTimestamp(path),
    })
  }
  backups.sort((a, b) => b.createdAt - a.createdAt)
  return {
    dir: realDir,
    backups,
    totalBytes: backups.reduce((sum, b) => sum + b.sizeBytes, 0),
    errors,
  }
}

/** True when a cutover / migration is mid-flight: the "backup" is then the only complete copy of the index. */
export function isMigrationInFlight(dbPath: string): boolean {
  const dir = dirname(dbPath)
  try {
    const manifest = JSON.parse(
      readFileSync(join(dir, 'document-memory.migration-state.json'), 'utf8'),
    ) as { phase?: unknown }
    if (manifest?.phase !== 'completed') return true
  } catch (err: any) {
    if (err?.code !== 'ENOENT') return true // unreadable / torn manifest: assume in flight
  }
  for (const suffix of ['.migrating', '.v3.tmp', '.v3.tmp.db']) {
    try {
      lstatSync(`${dbPath}${suffix}`)
      return true
    } catch {
      // absent
    }
  }
  return false
}

/** Cheap structural check (no quick_check): the live file is a readable V3 database with its core tables. */
export function isLiveV3Database(dbPath: string): boolean {
  let db: DatabaseSync | null = null
  try {
    const st = lstatSync(dbPath)
    if (!st.isFile() || st.size < 4096) return false
    db = new DatabaseSync(dbPath, { readOnly: true })
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string
        }>
      ).map((r) => r.name),
    )
    if (
      !['documents', 'chunks', 'chunk_embeddings', 'document_embedding_counts'].every((t) =>
        tables.has(t),
      )
    )
      return false
    const chunkColumns = (
      db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>
    ).map((c) => c.name)
    return !chunkColumns.includes('vector') && !chunkColumns.includes('vector_dim')
  } catch {
    return false
  } finally {
    try {
      db?.close()
    } catch {
      // ignore
    }
  }
}

export type BackupDeleteRefusal =
  'live-index-missing' | 'live-index-not-v3' | 'migration-in-flight' | 'nothing-to-delete'

export interface BackupDeleteResult {
  ok: boolean
  deleted: string[]
  freedBytes: number
  /** Why nothing was (fully) deleted. */
  refused?: BackupDeleteRefusal
  error?: string
}

export interface DeleteBackupsOptions extends BackupNameOptions {
  /** Test seam: replaces the async unlink. */
  unlinkFile?: (path: string) => Promise<void>
}

/**
 * User-initiated removal of the V2 rollback backups. Refuses unless the live database is a healthy-looking V3 index
 * and no migration is in flight (then the backup may be the only complete copy). Only files returned by
 * inventoryV2Backups are touched, and each is re-checked right before unlink: still the same real path inside the real
 * folder, still a regular file, never the live database itself. The user's documents are never in scope.
 */
export async function deleteV2Backups(
  dbPath: string,
  options: DeleteBackupsOptions = {},
): Promise<BackupDeleteResult> {
  const fail = (refused: BackupDeleteRefusal): BackupDeleteResult => ({
    ok: false,
    deleted: [],
    freedBytes: 0,
    refused,
  })
  if (isMigrationInFlight(dbPath)) return fail('migration-in-flight')
  try {
    if (!lstatSync(dbPath).isFile()) return fail('live-index-missing')
  } catch {
    return fail('live-index-missing')
  }
  if (!isLiveV3Database(dbPath)) return fail('live-index-not-v3')

  const inventory = inventoryV2Backups(dbPath, options)
  if (inventory.backups.length === 0) return fail('nothing-to-delete')

  const liveReal = realpathSync(dbPath)
  const remove = options.unlinkFile ?? ((p: string) => unlink(p))
  const deleted: string[] = []
  let freedBytes = 0
  const errors: string[] = []
  for (const backup of inventory.backups) {
    for (const path of [backup.path, ...backup.companionPaths]) {
      try {
        const st = lstatSync(path)
        if (
          !st.isFile() ||
          !samePath(realpathSync(path), path) ||
          samePath(path, liveReal) ||
          !samePath(dirname(path), inventory.dir)
        )
          continue
        await remove(path)
        deleted.push(path)
        freedBytes += st.size
      } catch (err: any) {
        if (err?.code !== 'ENOENT')
          errors.push(`${basename(path)}: ${err?.code ?? err?.message ?? 'unlink failed'}`)
      }
    }
  }
  return {
    ok: errors.length === 0,
    deleted,
    freedBytes,
    ...(errors.length ? { error: errors.join('; ') } : {}),
  }
}

/** Best-effort removal of a backup's -wal / -shm / -journal after its main file was deleted by the retention policy. */
export function removeBackupCompanions(backupPath: string): void {
  for (const suffix of V2_BACKUP_COMPANION_SUFFIXES) {
    try {
      const companion = `${backupPath}${suffix}`
      if (lstatSync(companion).isFile()) unlinkSync(companion)
    } catch {
      // absent or busy: leftovers are reported and can be removed from Settings
    }
  }
}
