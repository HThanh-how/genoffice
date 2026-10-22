import type { DatabaseSync, StatementSync } from 'node:sqlite'

/**
 * `node:sqlite` has no statement cache: every `db.prepare(sql)` parses and plans the SQL again. On the
 * per-file hot paths (a folder reconcile touches hundreds of thousands of files, the 60 s poll offers every
 * incomplete path) that was the single largest self-time on Electron's main thread (`prepare` ~ 3x the cost
 * of the lookup itself). One prepared statement per (connection, SQL text) is reused instead; SQLite itself
 * re-prepares a statement after a schema change, and a closed connection takes its statements with it.
 *
 * Only for statements that run to completion with `get`/`all`/`run` (never held open with `iterate`).
 */
const MAX_STATEMENTS_PER_DB = 128
const caches = new WeakMap<DatabaseSync, Map<string, StatementSync>>()

export function cachedStatement(db: DatabaseSync, sql: string): StatementSync {
  let perDb = caches.get(db)
  if (!perDb) {
    perDb = new Map()
    caches.set(db, perDb)
  }
  let stmt = perDb.get(sql)
  if (!stmt) {
    // Dynamic SQL must not grow this without bound.
    if (perDb.size >= MAX_STATEMENTS_PER_DB) perDb.clear()
    stmt = db.prepare(sql)
    perDb.set(sql, stmt)
  }
  return stmt
}

/** Remembers a schema probe that came back positive (a column/table is never taken away at runtime). */
export function memoizePositive(
  cache: WeakMap<DatabaseSync, true>,
  db: DatabaseSync,
  probe: () => boolean,
): boolean {
  if (cache.get(db)) return true
  const found = probe()
  if (found) cache.set(db, true)
  return found
}
