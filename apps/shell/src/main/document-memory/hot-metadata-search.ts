import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { matchedNameWords, nameWords, normalizeDocumentText } from './normalization'
import type { DocumentMemoryHit, StoredDocument } from './store'

interface CandidateRow {
  id: number
  path: string
  name: string
  status: string
  hash: string | null
  mtime_ms: number | null
  size_bytes: number | null
  updated_at: number
  truncated: number
  priority_at: number
  last_opened_at: number
  name_rank: number
}

interface RecentRow {
  id: number
  path: string
  name: string
  status: string
  mtime_ms: number | null
  size_bytes: number | null
  hash: string | null
  error: string | null
  truncated: number
}

export class HotMetadataSearch {
  private readonly searchNameStatement: StatementSync
  private readonly recentStatement: StatementSync

  constructor(private readonly db: DatabaseSync) {
    this.searchNameStatement = this.db.prepare(`
      SELECT
        d.id,
        d.path,
        d.name,
        d.status,
        d.hash,
        d.mtime_ms,
        d.size_bytes,
        d.updated_at,
        d.truncated,
        d.priority_at,
        d.last_opened_at,
        bm25(document_name_fts, 5.0, 1.0) AS name_rank
      FROM document_name_fts
      JOIN documents d ON d.id = document_name_fts.rowid
      WHERE document_name_fts MATCH ? AND d.excluded = 0
      ORDER BY name_rank
      LIMIT ?;
    `)

    this.recentStatement = this.db.prepare(`
      SELECT
        id, path, name, status, mtime_ms, size_bytes, hash, error, truncated
      FROM documents
      WHERE excluded = 0
      ORDER BY priority_at DESC
      LIMIT ?;
    `)
  }

  searchNames(query: string, limit = 5, candidateLimit = 64): DocumentMemoryHit[] {
    const words = nameWords(query)
    if (words.length === 0) return []
    if (words.length === 1 && words[0]!.length < 3) return []
    const need = words.length <= 2 ? words.length : Math.max(2, Math.ceil(words.length * 0.4))

    let rows: CandidateRow[] = []
    try {
      const ftsTokens = words.map((w) => `"${w.replace(/"/g, '""')}"*`)
      const ftsQuery = ftsTokens.join(' OR ')
      rows = this.searchNameStatement.all(ftsQuery, candidateLimit) as unknown as CandidateRow[]
    } catch {
      // Fallback if FTS parsing or match syntax fails
      try {
        rows = this.db
          .prepare(
            `SELECT id, path, name, status, hash, mtime_ms, size_bytes, updated_at, truncated, priority_at, last_opened_at, 0 as name_rank
             FROM documents WHERE excluded = 0
             ORDER BY priority_at DESC
             LIMIT ?`,
          )
          .all(candidateLimit) as unknown as CandidateRow[]
      } catch {
        return []
      }
    }

    const now = Date.now()
    const queryNorm = normalizeDocumentText(words.join(' '))
    const scored: Array<{ row: CandidateRow; score: number }> = []

    for (const row of rows) {
      const folders = row.path.split(/[\\/]/).slice(-3, -1).join(' ')
      const folded = normalizeDocumentText(`${row.name} ${folders}`)
      const joined = folded.replace(/ /g, '')
      let matched = matchedNameWords(words, `${row.name} ${folders}`)
      if (words.length >= 2 && joined.includes(words.join(''))) matched = words.length
      if (words.length >= 2 && folded.includes(words.join(' '))) matched += 0.5
      if (matched < need) continue

      const matchRatio = matched / words.length

      // Exact stem & prefix bonuses
      let exactBonus = 0
      let prefixBonus = 0
      const stemName = row.name.replace(/\.[^/.]+$/, '')
      const nameNorm = normalizeDocumentText(stemName)
      if (nameNorm === queryNorm) {
        exactBonus = 0.25
      } else if (nameNorm.startsWith(queryNorm)) {
        prefixBonus = 0.15
      }

      // Recency decay bonus
      const recentAt = Math.max(row.last_opened_at ?? 0, row.mtime_ms ?? 0, row.priority_at ?? 0)
      const ageDays = (now - recentAt) / (1000 * 3600 * 24)
      let recentBonus = 0
      if (ageDays < 1) recentBonus = 0.12
      else if (ageDays < 7) recentBonus = 0.08
      else if (ageDays < 30) recentBonus = 0.04
      else if (ageDays < 90) recentBonus = 0.01

      const nameScore = matchRatio * 0.7 + exactBonus + prefixBonus + recentBonus
      scored.push({ row, score: nameScore })
    }

    scored.sort(
      (a, b) =>
        b.score - a.score ||
        Number(a.row.status === 'ready') - Number(b.row.status === 'ready') ||
        b.row.updated_at - a.row.updated_at,
    )

    return scored.slice(0, limit).map(({ row, score }) => {
      const unread = row.status !== 'ready' && row.status !== 'text-only'
      return {
        documentId: row.id,
        path: row.path,
        name: row.name,
        chunkId: 0,
        text: unread
          ? 'The file name matches. Its content has not been read yet (a scanned PDF waiting for OCR, or unreadable), so what it says is unknown.'
          : 'The file name matches.',
        location: 'file name',
        score,
        hash: row.hash,
        mtimeMs: row.mtime_ms,
        sizeBytes: row.size_bytes,
        indexedAt: row.updated_at * 1000,
        truncated: row.truncated === 1,
        ...(unread ? { contentUnread: true } : {}),
      }
    })
  }

  recent(limit = 20): StoredDocument[] {
    const rows = this.recentStatement.all(limit) as unknown as RecentRow[]
    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      name: r.name,
      status: r.status as StoredDocument['status'],
      mtimeMs: r.mtime_ms,
      sizeBytes: r.size_bytes,
      hash: r.hash,
      error: r.error,
      truncated: r.truncated === 1,
    }))
  }
}
