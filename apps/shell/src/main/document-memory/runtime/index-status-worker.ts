/**
 * Worker-thread entry of the read-only status reader. The aggregates the index dashboard shows (document / chunk /
 * vector counts, per-folder counts, problem-file groups) are full passes over the `documents` table: on an index of
 * 100k+ documents each takes 100-300 ms of synchronous SQLite work. They run here, on their own connection and event
 * loop, so Electron's main thread only ever receives the finished numbers.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { ProgressRepository } from '../storage/repositories/progress-repository'
import { IndexIssueReader } from '../issue-reader'
import type { StatusRequest } from './index-status-types'

let db: DatabaseSync | null = null
let progress: ProgressRepository | null = null
let issues: IndexIssueReader | null = null

function open(): { progress: ProgressRepository; issues: IndexIssueReader; db: DatabaseSync } {
  const dbPath = (workerData as { dbPath: string }).dbPath
  if (!db) {
    db = new DatabaseSync(dbPath, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 5000')
    progress = new ProgressRepository(db)
    issues = new IndexIssueReader(dbPath)
  }
  return { db, progress: progress!, issues: issues! }
}

function handle(request: StatusRequest): unknown {
  const reader = open()
  switch (request.op) {
    case 'stats':
      return reader.progress.stats(request.space)
    case 'folder':
      return reader.progress.folderChunkProgress(request.root, request.space)
    case 'issues':
      return reader.issues.summary(request.root)
    case 'search':
      return reader.issues.search(request.query)
    case 'legacy': {
      if (request.extensions.length === 0) return []
      const clauses = request.extensions.map(() => 'lower(path) LIKE ?').join(' OR ')
      const rows = reader.db
        .prepare(
          `SELECT path FROM documents WHERE excluded = 0 AND (${clauses}) ORDER BY priority_at DESC, id DESC LIMIT ?`,
        )
        .all(...request.extensions.map((e) => `%${e}`), request.limit) as Array<{ path: string }>
      return rows.map((r) => r.path)
    }
  }
}

parentPort?.on('message', (message: StatusRequest & { id: number }) => {
  try {
    parentPort?.postMessage({ id: message.id, result: handle(message) })
  } catch (error) {
    parentPort?.postMessage({
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
