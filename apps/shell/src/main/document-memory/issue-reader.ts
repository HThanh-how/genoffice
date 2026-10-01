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

  /** One page of problem files, optionally limited to one reason. */
  page(
    root: string,
    offset = 0,
    reason?: IndexIssueReason,
    pageSize = ISSUE_PAGE_SIZE,
  ): { total: number; items: IndexIssue[] } {
    const issues = this.rows(root).map((row) => this.toIssue(row))
    const matching = reason ? issues.filter((issue) => issue.reason === reason) : issues
    return { total: matching.length, items: matching.slice(offset, offset + pageSize) }
  }

  /** Ids of every problem file (optionally of one reason), for "Retry all". */
  ids(root: string, reason?: IndexIssueReason): number[] {
    return this.rows(root)
      .filter((row) => !reason || issueReason(row.error, row.status) === reason)
      .map((row) => row.id)
  }
}
