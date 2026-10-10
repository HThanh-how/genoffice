import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import type { IndexFileDetail, IndexedFileHit } from '../../shared/fork/document-index-api'
import {
  groupIssueCounts,
  issueReason,
  type IndexIssue,
  type IndexIssueReason,
  type IssueGroupCount,
} from './issues'
import {
  computeEffectiveImportance,
  type FileImportanceOverride,
  type FileImportanceSuggestion,
  type FileImportanceInfo,
} from './document-importance'
import {
  hasNameProjection,
  getMetaValue,
  NAME_PROJECTION_STATUS_KEY,
} from './name-search-projection'

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
/** Scope value meaning every folder in the index. */
export const ALL_FOLDERS = '*'

/** Lower case with accents removed, so "benh vien" finds "BỆNH VIỆN". */
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim()
}

export class IndexIssueReader {
  private db: DatabaseSync | null = null

  constructor(private readonly dbPath: string) {}

  private connection(): DatabaseSync {
    if (!this.db) {
      this.db = new DatabaseSync(this.dbPath, { readOnly: true })
      try {
        this.db.exec(
          'PRAGMA busy_timeout = 5000; PRAGMA cache_size = -16384; PRAGMA mmap_size = 67108864;',
        )
      } catch {}
    }
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

  private scope(root: string): { where: string; args: string[] } {
    // '*' = every indexed folder, so the list never depends on which folder was scanned last
    if (root === ALL_FOLDERS)
      return { where: "excluded = 0 AND status IN ('error', 'empty', 'pending')", args: [] }
    const normalized = resolve(root)
    const prefix = normalized + (normalized.includes('\\') ? '\\' : '/')
    return {
      where:
        "excluded = 0 AND status IN ('error', 'empty', 'pending') AND (path = ? OR substr(path, 1, length(?)) = ?)",
      args: [normalized, prefix, prefix],
    }
  }

  /** Files whose name or path contains every typed word, accents and case ignored. */
  search(query: string, limit = 40): IndexedFileHit[] {
    const words = fold(query).split(' ').filter(Boolean)
    if (words.length === 0) return []

    const hits: IssueRow[] = []
    const seenIds = new Set<number>()

    const testAndAddRow = (row: IssueRow): boolean => {
      if (seenIds.has(row.id)) return false
      seenIds.add(row.id)
      const haystack = fold(`${row.name} ${row.path}`)
      if (words.every((word) => haystack.includes(word))) {
        hits.push(row)
        return true
      }
      return false
    }

    const candidateLimit = Math.max(limit * 4, 100)
    const db = this.connection()

    // 1. Primary candidate retrieval: Dedicated normalized projection FTS
    if (hasNameProjection(db)) {
      const clauses = words
        .map((w) => {
          const clean = w.replace(/["*()^]/g, '')
          if (!clean) return null
          const parts = clean.split(/[_/\\-]+/).filter(Boolean)
          if (parts.length > 1) {
            const joined = parts.join('')
            const spaced = parts.join(' ')
            return `("${spaced}" OR "${joined}"*)`
          }
          if (clean.length === 3) {
            return `("${clean}"* OR compact_ngrams: "${clean}")`
          }
          return `"${clean}"*`
        })
        .filter(Boolean)

      if (clauses.length > 0) {
        const matchQuery = clauses.join(' AND ')
        try {
          const rows = db
            .prepare(
              `
              SELECT d.id, d.path, d.name, d.status, d.error
              FROM document_name_projection_fts f
              JOIN documents d ON d.id = f.rowid
              WHERE document_name_projection_fts MATCH ? AND d.excluded = 0
              ORDER BY (d.status = 'ready') ASC, d.id ASC
              LIMIT ?
            `,
            )
            .all(matchQuery, candidateLimit) as unknown as IssueRow[]
          for (const row of rows) testAndAddRow(row)
        } catch {
          // ignore FTS syntax errors and proceed to fallback
        }
      }
    }

    // 2. Secondary candidate retrieval: document_name_fts with Vietnamese d/đ variants (if primary found nothing or no projection)
    if (hits.length === 0 || !hasNameProjection(db)) {
      try {
        const ftsTokens = words.flatMap((w) => {
          const clean = w.replace(/["*()^]/g, '')
          if (!clean) return []
          const variants = [clean]
          if (clean.includes('d')) variants.push(clean.replace(/d/g, 'đ'))
          return variants.map((v) => `"${v}"*`)
        })
        if (ftsTokens.length > 0) {
          const matchQuery = ftsTokens.join(' OR ')
          const rows = db
            .prepare(
              `
              SELECT d.id, d.path, d.name, d.status, d.error
              FROM document_name_fts f
              JOIN documents d ON d.id = f.rowid
              WHERE document_name_fts MATCH ? AND d.excluded = 0
              ORDER BY (d.status = 'ready') ASC, d.id ASC
              LIMIT ?
            `,
            )
            .all(matchQuery, candidateLimit) as unknown as IssueRow[]
          for (const row of rows) testAndAddRow(row)
        }
      } catch {
        // ignore FTS error and proceed
      }
    }

    // 3. Unprojected documents check (only if 0 hits, projection table exists, and backfill not yet completed)
    if (
      hits.length === 0 &&
      hasNameProjection(db) &&
      getMetaValue(db, NAME_PROJECTION_STATUS_KEY) !== 'completed'
    ) {
      try {
        const unprojected = db
          .prepare(
            `
            SELECT d.id, d.path, d.name, d.status, d.error
            FROM documents d
            LEFT JOIN document_name_projection p ON p.document_id = d.id
            WHERE d.excluded = 0 AND p.document_id IS NULL
            ORDER BY (d.status = 'ready') ASC, d.id ASC
            LIMIT 100
          `,
          )
          .all() as unknown as IssueRow[]
        for (const row of unprojected) testAndAddRow(row)
      } catch {
        // ignore
      }
    }

    // 4. Bounded parameterized LIKE query fallback (only if 0 hits, no projection, or sub-trigram tokens < 3 chars)
    const needsLikeFallback =
      hits.length < limit &&
      (hits.length === 0 || !hasNameProjection(db) || words.some((w) => w.length < 3))

    if (needsLikeFallback) {
      try {
        if (hasNameProjection(db)) {
          const likeClauses = words
            .map(() => '(p.name_norm LIKE ? OR p.path_norm LIKE ?)')
            .join(' AND ')
          const likeParams = words.flatMap((w) => [`%${w}%`, `%${w}%`])
          const rows = db
            .prepare(
              `
              SELECT d.id, d.path, d.name, d.status, d.error
              FROM document_name_projection p
              JOIN documents d ON d.id = p.document_id
              WHERE d.excluded = 0 AND ${likeClauses}
              ORDER BY (d.status = 'ready') ASC, d.id ASC
              LIMIT ?
            `,
            )
            .all(...likeParams, candidateLimit) as unknown as IssueRow[]
          for (const row of rows) testAndAddRow(row)
        } else {
          const likeClauses = words.map(() => '(d.name LIKE ? OR d.path LIKE ?)').join(' AND ')
          const likeParams = words.flatMap((w) => [`%${w}%`, `%${w}%`])
          const rows = db
            .prepare(
              `
              SELECT d.id, d.path, d.name, d.status, d.error
              FROM documents d
              WHERE d.excluded = 0 AND ${likeClauses}
              ORDER BY (d.status = 'ready') ASC, d.id ASC
              LIMIT ?
            `,
            )
            .all(...likeParams, candidateLimit) as unknown as IssueRow[]
          for (const row of rows) testAndAddRow(row)
        }
      } catch {
        // ignore
      }
    }

    // Problem files first, then ready, with deterministic id ordering
    hits.sort((a, b) => Number(a.status === 'ready') - Number(b.status === 'ready') || a.id - b.id)

    return hits.slice(0, limit).map((row) => {
      const problem = row.status === 'error' || row.status === 'empty' || row.status === 'pending'
      const base = this.toIssue(row)
      const withProgress = this.withProgress(base)
      return {
        id: row.id,
        path: row.path,
        name: row.name,
        status: row.status,
        ...(problem ? { reason: base.reason } : {}),
        ...(row.error ? { error: row.error } : {}),
        ...(withProgress.progress ? { progress: withProgress.progress } : {}),
      }
    })
  }

  /** Everything the file's detail view shows, read in a few cheap queries by document id. */
  detail(id: number): Omit<IndexFileDetail, 'exists'> | null {
    const db = this.connection()
    const row = db
      .prepare(
        `SELECT id, path, name, status, error, size_bytes, mtime_ms, updated_at, embedding_model,
          truncated, chunk_total, chunk_done,
          importance_override, importance_suggestion, importance_reason, importance_updated_at
         FROM documents WHERE id = ?`,
      )
      .get(id) as
      | {
          id: number
          path: string
          name: string
          status: string
          error: string | null
          size_bytes: number | null
          mtime_ms: number | null
          updated_at: number
          embedding_model: string | null
          truncated: number
          chunk_total: number
          chunk_done: number
          importance_override?: string | null
          importance_suggestion?: string | null
          importance_reason?: string | null
          importance_updated_at?: number | null
        }
      | undefined
    if (!row) return null
    const override = (row.importance_override ?? 'auto') as FileImportanceOverride
    const suggestion = (row.importance_suggestion ?? 'unknown') as FileImportanceSuggestion
    const effective = computeEffectiveImportance(override, suggestion)
    const importance: FileImportanceInfo = {
      override,
      suggestion,
      reason: row.importance_reason ?? null,
      effective,
      updatedAt: (row.importance_updated_at ?? 0) * 1000,
    }
    const detail: Omit<IndexFileDetail, 'exists'> = {
      id: row.id,
      path: row.path,
      name: row.name,
      status: row.status,
      ...(row.error ? { error: row.error } : {}),
      ...(row.size_bytes === null ? {} : { sizeBytes: row.size_bytes }),
      ...(row.mtime_ms === null ? {} : { mtimeMs: row.mtime_ms }),
      updatedAt: row.updated_at * 1000,
      ...(row.embedding_model ? { embeddingModel: row.embedding_model } : {}),
      truncated: row.truncated === 1,
      chunkTotal: row.chunk_total,
      chunkDone: row.chunk_done,
      importance,
    }
    if (/\.pdf$/i.test(row.path)) {
      const scan = db
        .prepare('SELECT total_pages, scanned FROM pdf_scan_info WHERE path = ?')
        .get(row.path) as { total_pages: number; scanned: string } | undefined
      const ocr = db
        .prepare(
          'SELECT count(*) AS pages, coalesce(sum(length(text)), 0) AS chars, max(model) AS model, max(total_pages) AS total FROM ocr_pages WHERE path = ?',
        )
        .get(row.path) as {
        pages: number
        chars: number
        model: string | null
        total: number | null
      }
      let scanned = 0
      try {
        const list: unknown = scan ? JSON.parse(scan.scanned) : []
        if (Array.isArray(list)) scanned = list.length
      } catch {
        // an unreadable list counts as no scanned pages
      }
      const totalPages = scan?.total_pages ?? ocr.total ?? 0
      if (totalPages > 0 || ocr.pages > 0)
        detail.pdf = {
          totalPages,
          scannedPages: scanned,
          ocrPages: ocr.pages,
          ocrChars: ocr.chars,
          ...(ocr.model ? { ocrModel: ocr.model } : {}),
        }
    }
    return detail
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
    return { total, items: rows.map((row) => this.withProgress(this.toIssue(row))) }
  }

  /** Adds the file's own progress (OCR pages or embedded passages) when there is any. */
  private withProgress(issue: IndexIssue): IndexIssue {
    try {
      const detail = this.detail(issue.id)
      if (!detail) return issue
      if (detail.pdf && detail.pdf.totalPages > 0 && issue.reason === 'no-text')
        return {
          ...issue,
          progress: {
            kind: 'ocr',
            done: detail.pdf.ocrPages,
            total: detail.pdf.scannedPages || detail.pdf.totalPages,
          },
        }
      if (detail.chunkTotal > 0)
        return {
          ...issue,
          progress: { kind: 'chunks', done: detail.chunkDone, total: detail.chunkTotal },
        }
    } catch {
      // a row without progress still renders
    }
    return issue
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
