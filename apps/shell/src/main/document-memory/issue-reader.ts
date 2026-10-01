import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import {
  groupIssueCounts,
  issueReason,
  type IndexIssue,
  type IndexIssueReason,
  type IssueGroupCount,
} from './issues'

export const ISSUE_PAGE_SIZE = 10
/** Above this many distinct (status, error) pairs a reason filter is applied in memory. */
const MAX_REASON_PAIRS = 5_000

export interface IndexIssueSummary {
  /** files with a problem (status error or empty) below the selected folder */
  total: number
  groups: IssueGroupCount[]
}

interface IssueRow {
  id: number
  path: string
  name: string
  status: string
  error: string | null
}

/**
 * Read-only view over the document-memory database used by the "Document index" popup.
 *
 * It opens its own read-only connection (WAL allows concurrent readers) so the popup's
 * queries never touch the indexing manager or its write connection. All queries are
 * scoped to enrolled, non-excluded rows with status error/empty and are only run on user
 * action, never from the progress poll.
 */
export class IndexIssueReader {
  private db: DatabaseSync | null = null

  constructor(private readonly dbPath: string) {}

  private connection(): DatabaseSync {
    this.db ??= new DatabaseSync(this.dbPath, { readOnly: true })
    return this.db
  }

  close(): void {
    try {
      this.db?.close()
    } catch {
      // already closed
    }
    this.db = null
  }

  private scope(root: string): { where: string; args: [string, string, string] } {
    const normalized = resolve(root)
    const prefix = normalized + (normalized.includes('\\') ? '\\' : '/')
    return {
      where:
        "excluded = 0 AND status IN ('error', 'empty') AND (path = ? OR substr(path, 1, length(?)) = ?)",
      args: [normalized, prefix, prefix],
    }
  }

  summary(root: string): IndexIssueSummary {
    const { where, args } = this.scope(root)
    const rows = this.connection()
      .prepare(
        `SELECT status, error, count(*) AS count FROM documents WHERE ${where} GROUP BY status, error`,
      )
      .all(...args) as unknown as Array<{ status: string; error: string | null; count: number }>
    const groups = groupIssueCounts(rows)
    return { total: groups.reduce((sum, group) => sum + group.count, 0), groups }
  }

  private rows(root: string): IssueRow[] {
    const { where, args } = this.scope(root)
    return this.connection()
      .prepare(
        `SELECT id, path, name, status, error FROM documents WHERE ${where}
        ORDER BY status ASC, priority_at DESC, id DESC`,
      )
      .all(...args) as unknown as IssueRow[]
  }

  private toIssue(row: IssueRow): IndexIssue {
    return {
      id: row.id,
      path: row.path,
      name: row.name,
      reason: issueReason(row.error, row.status),
      ...(row.error ? { error: row.error } : {}),
    }
  }

  /**
   * One page of problem files, optionally limited to one reason. The page and the total come
   * from SQL (LIMIT/OFFSET and a count) rather than loading every problem row: a reason is a
   * pure function of (status, error), so it is turned into a filter over the few distinct pairs.
   */
  page(
    root: string,
    offset = 0,
    reason?: IndexIssueReason,
    pageSize = ISSUE_PAGE_SIZE,
  ): { total: number; items: IndexIssue[] } {
    const { where, args } = this.scope(root)
    let filter = ''
    let filterArgs: Array<string | null> = []
    if (reason) {
      const pairs = (
        this.connection()
          .prepare(`SELECT status, error FROM documents WHERE ${where} GROUP BY status, error`)
          .all(...args) as unknown as Array<{ status: string; error: string | null }>
      ).filter((pair) => issueReason(pair.error, pair.status) === reason)
      if (!pairs.length) return { total: 0, items: [] }
      if (pairs.length > MAX_REASON_PAIRS) return this.pageInMemory(root, offset, reason, pageSize)
      filter = ` AND (${pairs.map(() => '(status = ? AND error IS ?)').join(' OR ')})`
      filterArgs = pairs.flatMap((pair) => [pair.status, pair.error])
    }
    const total = (
      this.connection()
        .prepare(`SELECT count(*) AS n FROM documents WHERE ${where}${filter}`)
        .get(...args, ...filterArgs) as { n: number }
    ).n
    const rows = this.connection()
      .prepare(
        `SELECT id, path, name, status, error FROM documents WHERE ${where}${filter}
        ORDER BY status ASC, priority_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, ...filterArgs, pageSize, offset) as unknown as IssueRow[]
    return { total, items: rows.map((row) => this.toIssue(row)) }
  }

  private pageInMemory(
    root: string,
    offset: number,
    reason: IndexIssueReason,
    pageSize: number,
  ): { total: number; items: IndexIssue[] } {
    const matching = this.rows(root)
      .map((row) => this.toIssue(row))
      .filter((issue) => issue.reason === reason)
    return { total: matching.length, items: matching.slice(offset, offset + pageSize) }
  }

  /** Ids of every problem file (optionally of one reason), for "Retry all". */
  ids(root: string, reason?: IndexIssueReason): number[] {
    const { where, args } = this.scope(root)
    return (
      this.connection()
        .prepare(
          `SELECT id, status, error FROM documents WHERE ${where}
          ORDER BY status ASC, priority_at DESC, id DESC`,
        )
        .all(...args) as unknown as Array<{ id: number; status: string; error: string | null }>
    )
      .filter((row) => !reason || issueReason(row.error, row.status) === reason)
      .map((row) => row.id)
  }
}
