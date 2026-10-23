import { stat } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { rootAvailability, pathUnderRoot } from '../../root-availability'
import { classifyOcrSourceError } from '../../ocr-source-errors'

export interface SourceRecoveryPage {
  afterId: number
  done: boolean
  paths: string[]
  cloudPaths: string[]
  roots?: Array<{ root: string; online: boolean }>
}

/** Stat only, in the indexing process. A failed stat never clears a failure. */
export async function recoverOcrSourcesPage(
  db: DatabaseSync,
  afterId: number,
  options: {
    root?: string
    roots?: string[]
    rootStates?: Array<{ root: string; online: boolean }>
    manual?: boolean
    probe?: (root: string) => Promise<boolean>
    statFile?: typeof stat
  } = {},
): Promise<SourceRecoveryPage> {
  for (const root of options.roots ?? []) rootAvailability.register(root)
  const rows = db
    .prepare(
      `SELECT d.id, f.path, f.code, f.detail, f.updated_at
    FROM ocr_local_failures f JOIN documents d ON d.path = f.path
    WHERE d.id > ? AND (f.code IN ('missing', 'offline')
      OR (? = 1 AND f.code IN ('source-busy', 'source-permission')))
    ORDER BY d.id LIMIT 128`,
    )
    .all(afterId, options.manual ? 1 : 0) as Array<{
    id: number
    path: string
    code: string
    detail: string | null
    updated_at: number
  }>
  const roots = new Map<string, Promise<boolean>>()
  const known = new Map(options.rootStates?.map((state) => [state.root, state.online]))
  const probe = (root: string) => {
    let pending = roots.get(root)
    if (!pending) {
      pending = options.probe
        ? options.probe(root)
        : known.has(root)
          ? Promise.resolve(known.get(root)!)
          : rootAvailability.check(root)
      roots.set(root, pending)
    }
    return pending
  }
  const paths: string[] = []
  for (const row of rows) {
    if (options.root) {
      if (!pathUnderRoot(options.root, row.path)) continue
    }
    const root = rootAvailability.rootOf(row.path)
    if (!(await probe(root))) continue
    let timer: NodeJS.Timeout | undefined
    try {
      const info = await Promise.race([
        (options.statFile ?? stat)(row.path),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Object.assign(new Error('Source stat timed out'), { code: 'ETIMEDOUT' })),
            1000,
          )
          timer.unref?.()
        }),
      ])
      if (!info.isFile()) continue
      db.exec('BEGIN IMMEDIATE')
      try {
        const removed = db
          .prepare('DELETE FROM ocr_local_failures WHERE path = ? AND code = ? AND updated_at = ?')
          .run(row.path, row.code, row.updated_at)
        if (Number(removed.changes)) {
          // Durable handoff: a restart between the SQLite commit and JSON save replays this path.
          db.prepare('INSERT OR IGNORE INTO ocr_source_recoveries(path) VALUES (?)').run(row.path)
          db.prepare(
            "UPDATE documents SET status = 'pending', error = NULL WHERE path = ? AND excluded = 0 AND status IN ('empty', 'error')",
          ).run(row.path)
          paths.push(row.path)
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    } catch (error) {
      // A disconnect during the batch invalidates the root observation for all
      // following rows; never queue 128 native stats against a dead share.
      roots.delete(root)
      const failure = await classifyOcrSourceError(
        row.path,
        error,
        options.probe ?? ((root) => rootAvailability.checkAfterError(root)),
      )
      if (failure.code === 'offline') {
        roots.set(root, Promise.resolve(false))
        continue
      }
      db.prepare(
        'UPDATE ocr_local_failures SET code = ?, detail = ?, attempts = ? WHERE path = ? AND code = ? AND updated_at = ?',
      ).run(failure.code, failure.detail, 0, row.path, row.code, row.updated_at)
    } finally {
      if (timer) clearTimeout(timer)
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  const cloudPaths = (
    db.prepare('SELECT path FROM ocr_source_recoveries ORDER BY path LIMIT 128').all() as Array<{
      path: string
    }>
  ).map((row) => row.path)
  const observations = await Promise.all(
    [...roots].map(async ([root, online]) => ({ root, online: await online })),
  )
  return {
    paths,
    cloudPaths,
    roots: observations,
    afterId: rows.at(-1)?.id ?? afterId,
    done: rows.length < 128,
  }
}

export function acknowledgeSourceRecovery(db: DatabaseSync, paths: string[]): void {
  const remove = db.prepare('DELETE FROM ocr_source_recoveries WHERE path = ?')
  for (const path of paths.slice(0, 128)) remove.run(path)
}
