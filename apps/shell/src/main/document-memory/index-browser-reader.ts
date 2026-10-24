import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { resolve } from 'node:path'
import { releasedDocumentSql } from './storage/repositories/progress-repository'
import { issueReason, ISSUE_REASON_ORDER } from './issues'
import {
  INDEX_BROWSER_PAGE_SIZE,
  INDEX_BROWSER_SORTS,
  type IndexBrowserPage,
  type IndexBrowserQuery,
} from '../../shared/fork/index-browser'

const fold = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')

/** Validate at the IPC boundary as well as in the reader; SQL identifiers never come from input. */
export function validateBrowserQuery(value: unknown): IndexBrowserQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid file view')
  const q = value as IndexBrowserQuery
  for (const bound of [q.afterId, q.throughId])
    if (bound !== undefined && (!Number.isSafeInteger(bound) || bound < 0))
      throw new Error('Invalid file cursor')
  if (
    (q.root !== undefined && (typeof q.root !== 'string' || q.root.length > 32768)) ||
    (q.query !== undefined && (typeof q.query !== 'string' || q.query.length > 200)) ||
    (q.status !== undefined &&
      !['ready', 'pending', 'empty', 'error', 'released'].includes(q.status)) ||
    (q.type !== undefined && !/^[a-z0-9]{1,12}$/i.test(q.type)) ||
    (q.sort !== undefined && !INDEX_BROWSER_SORTS.includes(q.sort)) ||
    (q.descending !== undefined && typeof q.descending !== 'boolean') ||
    (q.offset !== undefined && (!Number.isSafeInteger(q.offset) || q.offset < 0)) ||
    (q.reasons !== undefined &&
      (!Array.isArray(q.reasons) ||
        q.reasons.length > ISSUE_REASON_ORDER.length ||
        q.reasons.some((r) => !ISSUE_REASON_ORDER.includes(r))))
  )
    throw new Error('Invalid file view')
  return q
}

/** Runs only in the existing status reader thread. Returns one bounded metadata page, never bodies. */
export function readIndexBrowser(db: DatabaseSync, input: IndexBrowserQuery): IndexBrowserPage {
  const q = validateBrowserQuery(input)
  db.function('index_fold', { deterministic: true }, (value) => fold(String(value ?? '')))
  db.function('index_reason', { deterministic: true }, (error, status) =>
    status === 'text-only'
      ? 'waiting'
      : issueReason(error === null ? null : String(error), String(status)),
  )
  db.function(
    'index_type',
    { deterministic: true },
    (value) => String(value).split('.').pop()?.toLowerCase() ?? '',
  )
  const where = ['excluded = 0']
  const args: SQLInputValue[] = []
  const released = releasedDocumentSql(db, 'documents')
  if (q.afterId !== undefined) {
    where.push('id > ?')
    args.push(q.afterId)
  }
  if (q.throughId !== undefined) {
    where.push('id <= ?')
    args.push(q.throughId)
  }
  if (q.root && q.root !== '*') {
    const root = resolve(q.root)
    const prefix = root.replace(/[\\/]$/, '') + (root.includes('\\') ? '\\' : '/')
    where.push('(path = ? COLLATE NOCASE OR substr(path, 1, length(?)) = ? COLLATE NOCASE)')
    args.push(root, prefix, prefix)
  }
  for (const word of fold(q.query ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)) {
    where.push("instr(index_fold(name || ' ' || path), ?) > 0")
    args.push(word)
  }
  if (q.reasons?.length) {
    where.push(
      `status IN ('pending', 'text-only', 'error', 'empty') AND NOT (${released}) AND index_reason(error, status) IN (${q.reasons.map(() => '?').join(',')})`,
    )
    args.push(...q.reasons)
  }
  if (q.status) {
    if (q.status === 'released') where.push(`(${released})`)
    else if (q.status === 'pending')
      where.push(`status IN ('pending', 'text-only') AND NOT (${released})`)
    else {
      where.push('status = ?')
      args.push(q.status)
    }
  }
  if (q.type) {
    where.push('index_type(name) = ?')
    args.push(q.type.toLowerCase())
  }
  const clause = where.join(' AND ')
  const totals = db
    .prepare(
      `SELECT count(*) AS total, coalesce(sum(size_bytes), 0) AS sizeBytes, coalesce(max(id), 0) AS maxId FROM documents WHERE ${clause}`,
    )
    .get(...args) as { total: number; sizeBytes: number }
  const order = {
    queue: 'priority_at',
    name: 'name COLLATE NOCASE',
    folder: 'path COLLATE NOCASE',
    type: 'index_type(name)',
    progress: 'CAST(chunk_done AS REAL) / max(chunk_total, 1)',
    status: 'status',
    connection: "(index_reason(error, status) = 'unavailable')",
    size: 'size_bytes',
    recent: 'updated_at',
  }[q.sort ?? 'queue']
  const direction =
    q.afterId !== undefined
      ? 'ASC'
      : (q.sort ?? 'queue') === 'queue'
        ? q.descending
          ? 'ASC'
          : 'DESC'
        : q.descending
          ? 'DESC'
          : 'ASC'
  const rows = db
    .prepare(
      `SELECT id, path, name, CASE WHEN ${released} THEN 'released' WHEN status = 'text-only' THEN 'pending' ELSE status END AS status, error, size_bytes AS sizeBytes, updated_at * 1000 AS updatedAt, chunk_done AS chunkDone, chunk_total AS chunkTotal FROM documents WHERE ${clause} ORDER BY ${q.afterId !== undefined ? 'id' : order} ${direction}, id ${direction} LIMIT ? OFFSET ?`,
    )
    .all(...args, INDEX_BROWSER_PAGE_SIZE, q.offset ?? 0) as unknown as Array<
    IndexBrowserPage['items'][number] & {
      error: string | null
      chunkDone: number
      chunkTotal: number
    }
  >
  return {
    ...totals,
    items: rows.map(({ chunkDone, chunkTotal, ...row }) => ({
      ...row,
      ...(chunkTotal > 0
        ? { progress: { kind: 'chunks' as const, done: chunkDone, total: chunkTotal } }
        : {}),
      ...(row.status === 'error' ||
      row.status === 'empty' ||
      row.status === 'pending' ||
      row.status === 'text-only'
        ? { reason: row.status === 'text-only' ? 'waiting' : issueReason(row.error, row.status) }
        : {}),
      error: row.error ?? undefined,
    })),
  }
}
