import { statSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { compactAfterRetentionBatch } from './retention-compaction'

/**
 * Bounded, resumable, cancellable FTS5 segment optimisation for the document-memory database.
 *
 * Background: the schema sets `chunk_fts` automerge to 0 (see schema-v3.ts), so every indexing batch adds a new
 * level-0 segment and nothing folds them together except the scheduler's `mergeFtsStep` (8 pages per tick).
 * This module composes with that step instead of replacing it: pass `mergeStep` to reuse
 * `store.mergeFtsStep` for chunk_fts, or leave it out and the identical `'merge'` command is issued here.
 *
 * Nothing in here is wired into the scheduler yet; see the integration note in the final report.
 */

export const FTS_TABLES = ['chunk_fts', 'document_name_fts'] as const
export type FtsTable = (typeof FTS_TABLES)[number]
export type FtsLayout = 'regular' | 'external-content' | 'contentless' | 'contentless-delete' | 'missing'

export const FTS_OPTIMIZE_DEFAULT_STEP_PAGES = 16
export const FTS_OPTIMIZE_DEFAULT_MAX_PAGES = 2048

const SHADOWS = ['data', 'idx', 'content', 'docsize', 'config'] as const

export interface FtsStorageBreakdown {
  table: FtsTable
  layout: FtsLayout
  /** Bytes of b-tree pages per shadow table (dbstat); null when dbstat is not compiled in. */
  dataBytes: number | null
  idxBytes: number | null
  contentBytes: number | null
  docsizeBytes: number | null
  configBytes: number | null
  totalBytes: number | null
}

export interface FtsOptimizeTableResult {
  table: FtsTable
  steps: number
  pagesBudgetUsed: number
  /** true when the merge command reported no remaining work */
  converged: boolean
  bytesBefore: number | null
  bytesAfter: number | null
  integrity?: 'ok' | 'rebuilt' | 'failed' | 'needs-reindex'
}

export type FtsOptimizeStopReason =
  | 'converged'
  | 'page-budget'
  | 'time-budget'
  | 'cancelled'
  | 'busy'
  | 'error'

export interface FtsOptimizeResult {
  stoppedReason: FtsOptimizeStopReason
  tables: FtsOptimizeTableResult[]
  /** Tables that still have merge work; pass them as `tables` to resume (state lives inside the FTS index). */
  pending: FtsTable[]
  steps: number
  elapsedMs: number
  /** b-tree bytes of the optimised FTS tables (dbstat) before/after; falls back to used-page delta. */
  ftsBytesBefore: number
  ftsBytesAfter: number
  /** Pages moved to the freelist by this call (file does not shrink until vacuum + checkpoint). */
  freelistPagesGained: number
  /** Physical db+wal+shm bytes before/after (after includes `reclaim` when requested). */
  physicalBytesBefore: number
  physicalBytesAfter: number
  error?: string
}

export interface OptimizeFtsOptions {
  tables?: readonly FtsTable[]
  /** Total merge pages the call may spend across all tables (default 2048 = 8 MiB of 4 KiB pages). */
  maxPages?: number
  /** Wall-clock budget; checked between steps, so overshoot is at most one step. */
  budgetMs?: number
  /** Pages per merge command (default 16). Each step is its own short write transaction. */
  stepPages?: number
  yield?: () => Promise<void>
  shouldContinue?: () => boolean
  /** Reuse an existing step implementation, e.g. `(t, p) => t === 'chunk_fts' ? store.mergeFtsStep(p) : undefined`. */
  mergeStep?: (table: FtsTable, pages: number) => boolean | undefined
  /** Temporarily lowers busy_timeout so a main-thread caller does not stall behind the indexing worker. */
  busyTimeoutMs?: number
  /** Run FTS5 integrity-check on tables that converged (O(index size)). */
  integrityCheck?: boolean
  /** On integrity failure rebuild from the FTS content table (regular/external layouts only; unbounded). */
  allowRebuild?: boolean
  /** After merging, vacuum the freed pages and truncate the WAL (compactAfterRetentionBatch). */
  reclaim?: boolean
  now?: () => number
}

function assertFtsTable(table: string): asserts table is FtsTable {
  if (!(FTS_TABLES as readonly string[]).includes(table)) throw new Error(`Unsupported FTS table: ${table}`)
}

function tableSql(db: DatabaseSync, table: string): string | null {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
    | { sql?: string }
    | undefined
  return row?.sql ?? null
}

export function detectFtsLayout(db: DatabaseSync, table: FtsTable): FtsLayout {
  const sql = tableSql(db, table)
  if (!sql) return 'missing'
  if (/content\s*=\s*''/i.test(sql)) return /contentless_delete\s*=\s*1/i.test(sql) ? 'contentless-delete' : 'contentless'
  if (/content\s*=\s*['"]?\w+/i.test(sql)) return 'external-content'
  return 'regular'
}

function shadowBytes(db: DatabaseSync, name: string): number | null {
  try {
    const row = db.prepare('SELECT coalesce(sum(pgsize), 0) AS b FROM dbstat WHERE name = ?').get(name) as { b: number }
    return Number(row.b)
  } catch {
    return null
  }
}

export function inspectFtsStorage(db: DatabaseSync, table: FtsTable): FtsStorageBreakdown {
  assertFtsTable(table)
  const layout = detectFtsLayout(db, table)
  const parts = SHADOWS.map((s) => (layout === 'missing' ? null : shadowBytes(db, `${table}_${s}`)))
  const known = parts.every((p) => p !== null)
  return {
    table,
    layout,
    dataBytes: parts[0]!,
    idxBytes: parts[1]!,
    contentBytes: parts[2]!,
    docsizeBytes: parts[3]!,
    configBytes: parts[4]!,
    totalBytes: known ? parts.reduce<number>((a, b) => a + (b ?? 0), 0) : null,
  }
}

/**
 * One FTS5 incremental merge command. Returns true while more work likely remains (the command wrote more
 * than its bookkeeping row), the same heuristic `MaintenanceRepository.mergeFtsStep` uses for chunk_fts.
 */
export function ftsMergeStep(db: DatabaseSync, table: FtsTable, pages: number): boolean {
  assertFtsTable(table)
  const changes = (): number => Number((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n)
  const before = changes()
  db.exec(`INSERT INTO ${table}(${table}, rank) VALUES('merge', ${Math.max(1, Math.trunc(pages))})`)
  return changes() - before > 1
}

/** FTS5 integrity-check; throws nothing and returns false on SQLITE_CORRUPT_VTAB. */
export function ftsIntegrityOk(db: DatabaseSync, table: FtsTable): boolean {
  assertFtsTable(table)
  try {
    db.exec(`INSERT INTO ${table}(${table}) VALUES('integrity-check')`)
    return true
  } catch {
    return false
  }
}

function dbFiles(db: DatabaseSync): string | null {
  try {
    const rows = db.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>
    return rows.find((r) => r.name === 'main')?.file || null
  } catch {
    return null
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

export function physicalDbBytes(db: DatabaseSync): number {
  const file = dbFiles(db)
  if (!file) return 0
  return fileSize(file) + fileSize(`${file}-wal`) + fileSize(`${file}-shm`)
}

function pragmaNum(db: DatabaseSync, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, number>
  return Number(Object.values(row)[0] ?? 0)
}

function isBusyError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err)
  return /database is locked|SQLITE_BUSY|database table is locked/i.test(msg)
}

function ftsBytes(db: DatabaseSync, tables: readonly FtsTable[]): number {
  let total = 0
  for (const t of tables) {
    const b = inspectFtsStorage(db, t).totalBytes
    if (b === null) {
      // dbstat unavailable: fall back to used pages of the whole file (still monotonic for before/after deltas)
      return (pragmaNum(db, 'page_count') - pragmaNum(db, 'freelist_count')) * pragmaNum(db, 'page_size')
    }
    total += b
  }
  return total
}

/**
 * Merge FTS5 segments of chunk_fts / document_name_fts within a page, time and cancellation budget.
 *
 * - Bounded: at most `maxPages` merge pages and `budgetMs` (checked between steps); each step is one short
 *   autocommit write, so the writer lock is never held across `yield`.
 * - Resumable: segment structure is persisted by FTS5; call again with `pending` to continue.
 * - Query-neutral: merging rewrites the index only; rows, rowids and bm25 inputs are unchanged.
 * - Never throws for operational failures (busy/cancel/budget); `stoppedReason: 'error'` carries `error`.
 */
export async function optimizeFts(db: DatabaseSync, options: OptimizeFtsOptions = {}): Promise<FtsOptimizeResult> {
  const now = options.now ?? Date.now
  const startedAt = now()
  const stepPages = Math.max(1, Math.min(512, Math.trunc(options.stepPages ?? FTS_OPTIMIZE_DEFAULT_STEP_PAGES)))
  const maxPages = Math.max(0, Math.trunc(options.maxPages ?? FTS_OPTIMIZE_DEFAULT_MAX_PAGES))
  const budgetMs = options.budgetMs ?? Number.POSITIVE_INFINITY
  const requested = (options.tables ?? FTS_TABLES).filter((t, i, a) => a.indexOf(t) === i)
  requested.forEach(assertFtsTable)
  const tables = requested.filter((t) => detectFtsLayout(db, t) !== 'missing')

  const physicalBefore = physicalDbBytes(db)
  const freelistBefore = pragmaNum(db, 'freelist_count')
  const ftsBefore = ftsBytes(db, tables)

  const results: FtsOptimizeTableResult[] = tables.map((table) => {
    const b = inspectFtsStorage(db, table).totalBytes
    return { table, steps: 0, pagesBudgetUsed: 0, converged: false, bytesBefore: b, bytesAfter: b }
  })

  let stopped: FtsOptimizeStopReason = 'converged'
  let error: string | undefined
  let pagesUsed = 0
  let totalSteps = 0
  let priorBusyTimeout: number | undefined
  if (options.busyTimeoutMs !== undefined) {
    try {
      priorBusyTimeout = pragmaNum(db, 'busy_timeout')
      db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs))}`)
    } catch {
      priorBusyTimeout = undefined
    }
  }

  try {
    outer: for (const res of results) {
      for (;;) {
        if (options.shouldContinue && !options.shouldContinue()) {
          stopped = 'cancelled'
          break outer
        }
        if (pagesUsed + stepPages > maxPages) {
          stopped = 'page-budget'
          break outer
        }
        if (now() - startedAt >= budgetMs) {
          stopped = 'time-budget'
          break outer
        }
        let more: boolean
        try {
          const delegated = options.mergeStep?.(res.table, stepPages)
          more = delegated === undefined ? ftsMergeStep(db, res.table, stepPages) : delegated
        } catch (err) {
          stopped = isBusyError(err) ? 'busy' : 'error'
          if (stopped === 'error') error = String((err as Error)?.message ?? err)
          break outer
        }
        pagesUsed += stepPages
        totalSteps++
        res.steps++
        res.pagesBudgetUsed += stepPages
        if (!more) {
          res.converged = true
          break
        }
        if (options.yield) await options.yield()
      }
    }
  } finally {
    if (priorBusyTimeout !== undefined) {
      try {
        db.exec(`PRAGMA busy_timeout = ${priorBusyTimeout}`)
      } catch {
        // connection already closed
      }
    }
  }

  if (options.integrityCheck) {
    for (const res of results) {
      if (!res.converged) continue
      if (ftsIntegrityOk(db, res.table)) {
        res.integrity = 'ok'
        continue
      }
      const layout = detectFtsLayout(db, res.table)
      if (!options.allowRebuild || layout === 'contentless' || layout === 'contentless-delete') {
        res.integrity = layout.startsWith('contentless') ? 'needs-reindex' : 'failed'
        continue
      }
      try {
        db.exec('BEGIN IMMEDIATE')
        db.exec(`INSERT INTO ${res.table}(${res.table}) VALUES('rebuild')`)
        db.exec('COMMIT')
        res.integrity = ftsIntegrityOk(db, res.table) ? 'rebuilt' : 'failed'
      } catch (err) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // no open transaction
        }
        res.integrity = 'failed'
        error = String((err as Error)?.message ?? err)
      }
    }
  }

  const freelistGained = Math.max(0, pragmaNum(db, 'freelist_count') - freelistBefore)

  if (options.reclaim) {
    try {
      compactAfterRetentionBatch(db)
    } catch {
      // reclaim is best effort; the merge result stands on its own
    }
  }

  for (const res of results) res.bytesAfter = inspectFtsStorage(db, res.table).totalBytes
  const pending = results.filter((r) => !r.converged).map((r) => r.table)
  if (stopped === 'converged' && pending.length > 0) stopped = 'page-budget'

  return {
    stoppedReason: stopped,
    tables: results,
    pending,
    steps: totalSteps,
    elapsedMs: now() - startedAt,
    ftsBytesBefore: ftsBefore,
    ftsBytesAfter: ftsBytes(db, tables),
    freelistPagesGained: freelistGained,
    physicalBytesBefore: physicalBefore,
    physicalBytesAfter: physicalDbBytes(db),
    ...(error ? { error } : {}),
  }
}
