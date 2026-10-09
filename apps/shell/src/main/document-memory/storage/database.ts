import { DatabaseSync } from 'node:sqlite'
import { chmodSync } from 'node:fs'
import { resolve } from 'node:path'
import { defaultSqliteCacheKiB } from '../memory-tier'
import { applyCanonicalSchemaV3 } from './schema-v3'
import { OcrSidecar } from '../ocr-sidecar'

export interface DatabaseOpenOptions {
  role?: 'search' | 'worker'
  cacheKiB?: number
}

/**
 * Opens and initializes a SQLite DatabaseSync handle configured according to V3 standards.
 */
export function openDatabase(dbPath: string, options: DatabaseOpenOptions = {}): DatabaseSync {
  const db = new DatabaseSync(dbPath)
  db.exec(
    'PRAGMA busy_timeout = 5000; PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;',
  )
  const cacheKiB = options.cacheKiB ?? defaultSqliteCacheKiB(options.role ?? 'search')
  db.exec(`PRAGMA cache_size = -${cacheKiB};`)
  
  applyCanonicalSchemaV3(db)
  OcrSidecar.ensureSchema(db)

  try {
    chmodSync(resolve(dbPath), 0o600)
  } catch (err: unknown) {
    // Some filesystems or test environments do not support chmod.
    console.debug('[database] chmod not supported on filesystem:', err)
  }

  return db
}

/**
 * Runs a function within an IMMEDIATE transaction.
 */
export function runTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch (rollbackErr: unknown) {
      // Ignore rollback failure if already terminated.
      console.debug('[database] rollback terminated or superseded:', rollbackErr)
    }
    throw err
  }
}
