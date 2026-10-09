import type { DatabaseSync, StatementSync } from 'node:sqlite'
import {
  hasDiacritics,
  identifierVariants,
  matchedNameWords,
  nameWords,
  nameWordsKeepingFillers,
  normalizeDocumentText,
} from './normalization'
import {
  extractMeaningfulPathSegments,
  hasNameProjection,
  buildProjectionCandidateFtsQuery,
} from './name-search-projection'
import type { DocumentMemoryHit, StoredDocument } from './store'
import { mergeMediaHits } from './media/media-search'

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
  content_evicted?: number
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
  content_evicted?: number
}

const readyRank = (status: string, contentEvicted?: number): number =>
  (status === 'ready' || status === 'text-only') && contentEvicted !== 1 ? 1 : 0

export class HotMetadataSearch {
  private readonly searchNameStatement: StatementSync
  private readonly recentStatement: StatementSync
  private searchProjectionStatement: StatementSync | null = null

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
        d.content_evicted,
        bm25(document_name_fts, 5.0, 1.0) AS name_rank
      FROM document_name_fts
      JOIN documents d ON d.id = document_name_fts.rowid
      WHERE document_name_fts MATCH ? AND d.excluded = 0
      ORDER BY name_rank
      LIMIT ?;
    `)

    this.recentStatement = this.db.prepare(`
      SELECT
        id, path, name, status, mtime_ms, size_bytes, hash, error, truncated, content_evicted
      FROM documents
      WHERE excluded = 0
      ORDER BY priority_at DESC
      LIMIT ?;
    `)
  }

  private getProjectionStatement(): StatementSync | null {
    if (!this.searchProjectionStatement) {
      if (hasNameProjection(this.db)) {
        try {
          this.searchProjectionStatement = this.db.prepare(`
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
              d.content_evicted,
              bm25(document_name_projection_fts, 5.0, 2.0, 1.0) AS name_rank
            FROM document_name_projection_fts
            JOIN documents d ON d.id = document_name_projection_fts.rowid
            WHERE document_name_projection_fts MATCH ? AND d.excluded = 0
            ORDER BY name_rank
            LIMIT ?;
          `)
        } catch (err: unknown) {
          void err
          this.searchProjectionStatement = null
        }
      }
    }
    return this.searchProjectionStatement
  }

  /** File-name search over documents and media; images/videos are described and type/date queries add media rows. */
  searchNames(query: string, limit = 5, candidateLimit = 64): DocumentMemoryHit[] {
    return mergeMediaHits(this.db, query, this.searchNamesBase(query, limit, candidateLimit), limit)
  }

  private searchNamesBase(query: string, limit: number, candidateLimit: number): DocumentMemoryHit[] {
    let words = nameWords(query)
    // Dropping filler words must not erase the query: "cái bè" (a place) would shrink to the
    // single word "be". Retry with the typed words when nothing usable is left.
    if (words.length === 0 || (words.length === 1 && words[0]!.length < 3)) {
      const typed = nameWordsKeepingFillers(query)
      if (typed.length > words.length) words = typed
    }
    if (words.length === 0) return []
    // A lone two-letter word is too ambiguous unless it is visibly Vietnamese ("bè", "đỏ").
    if (words.length === 1 && words[0]!.length < 3 && !hasDiacritics(query)) return []
    const need =
      words.length <= 2
        ? words.length
        : words.length === 3
          ? 2
          : Math.max(3, Math.ceil(words.length * 0.65))

    const rows: CandidateRow[] = []
    const seenIds = new Set<number>()

    // 1. Primary candidate retrieval: Dedicated normalized projection FTS
    const projQuery = buildProjectionCandidateFtsQuery(words)
    const projStmt = this.getProjectionStatement()
    if (projStmt && projQuery) {
      try {
        const projRows = projStmt.all(projQuery, candidateLimit) as unknown as CandidateRow[]
        for (const r of projRows) {
          if (!seenIds.has(r.id)) {
            seenIds.add(r.id)
            rows.push(r)
          }
        }
      } catch (err: unknown) {
        void err
      }
    }

    // 2. Secondary candidate retrieval / backfill fallback: standard document_name_fts
    if (rows.length < candidateLimit) {
      try {
        const ftsTokens = words.flatMap((w) =>
          identifierVariants(w.replace(/["*]/g, '')).map((variant) => `"${variant}"*`),
        )
        const ftsQuery = ftsTokens.join(' OR ')
        const ftsRows = this.searchNameStatement.all(
          ftsQuery,
          candidateLimit - rows.length,
        ) as unknown as CandidateRow[]
        for (const r of ftsRows) {
          if (!seenIds.has(r.id)) {
            seenIds.add(r.id)
            rows.push(r)
          }
        }
      } catch (err: unknown) {
        void err
      }
    }

    if (rows.length === 0) return []

    const now = Date.now()
    const queryNorm = normalizeDocumentText(words.join(' '))
    const queryJoined = queryNorm.replace(/ /g, '')
    const scored: Array<{ row: CandidateRow; score: number }> = []

    for (const row of rows) {
      const meaningfulSegments = extractMeaningfulPathSegments(row.path, 6)
      const folders = meaningfulSegments.join(' ')
      const fullText = `${row.name} ${folders}`
      const folded = normalizeDocumentText(fullText)
      const joined = folded.replace(/ /g, '')

      const stemName = row.name.replace(/\.[^/.]+$/, '')
      const stemFolded = normalizeDocumentText(stemName)
      const stemJoined = stemFolded.replace(/ /g, '')

      let matched = matchedNameWords(words, fullText)

      // Direction A: Separated query -> concatenated source
      if (words.length >= 2) {
        if (stemJoined.includes(queryJoined) || joined.includes(queryJoined)) {
          matched = Math.max(matched, words.length)
        }
      }

      // Direction B: Concatenated query -> separated source
      if (words.length === 1 && words[0]!.length >= 4) {
        const singleQuery = words[0]!
        if (stemJoined.includes(singleQuery) || singleQuery.includes(stemJoined) || joined.includes(singleQuery)) {
          matched = Math.max(matched, 1)
        }
      }

      // Exact substring / phrase bonus
      if (words.length >= 2 && (folded.includes(words.join(' ')) || joined.includes(queryJoined))) {
        matched += 0.5
      }

      // Word / person match signals on filename vs directory path
      const nameMatched = matchedNameWords(words, stemName)
      const pathMatched = matchedNameWords(words, folders)

      // False positive rejection: if all matched words came ONLY from parent folders
      // while filename has zero query match and query contains distinguishing terms not in folder
      if (nameMatched === 0 && pathMatched < words.length && words.length > 2) {
        continue
      }

      // Verification / false positive rejection: candidate MUST satisfy need threshold
      if (matched < need) continue

      const matchRatio = Math.min(1.0, matched / words.length)

      // Exact stem & folder bonuses
      let exactBonus = 0
      let prefixBonus = 0
      const components = [
        { text: stemFolded, joined: stemJoined },
        ...meaningfulSegments.map((s) => {
          const norm = normalizeDocumentText(s)
          return { text: norm, joined: norm.replace(/ /g, '') }
        }),
      ]

      for (const comp of components) {
        if (comp.text === queryNorm || (queryJoined.length >= 3 && comp.joined === queryJoined)) {
          exactBonus = Math.max(exactBonus, 0.25)
        } else if (
          comp.text.startsWith(queryNorm) ||
          (queryJoined.length >= 3 && (comp.joined.startsWith(queryJoined) || comp.joined.endsWith(queryJoined)))
        ) {
          prefixBonus = Math.max(prefixBonus, 0.15)
        }
      }

      // Cross-segment bonus: query matches across both filename and directory components
      let crossSegmentBonus = 0
      if (nameMatched > 0 && pathMatched > 0) {
        crossSegmentBonus = 0.15
      }

      // Recency decay bonus
      const recentAt = Math.max(row.last_opened_at ?? 0, row.mtime_ms ?? 0, row.priority_at ?? 0)
      const ageDays = (now - recentAt) / (1000 * 3600 * 24)
      let recentBonus = 0
      if (ageDays < 1) recentBonus = 0.12
      else if (ageDays < 7) recentBonus = 0.08
      else if (ageDays < 30) recentBonus = 0.04
      else if (ageDays < 90) recentBonus = 0.01

      const nameScore = matchRatio * 0.7 + exactBonus + prefixBonus + crossSegmentBonus + recentBonus
      scored.push({ row, score: nameScore })
    }

    scored.sort(
      (a, b) =>
        b.score - a.score ||
        readyRank(b.row.status, b.row.content_evicted) - readyRank(a.row.status, a.row.content_evicted) ||
        b.row.updated_at - a.row.updated_at,
    )

    return scored.slice(0, limit).map(({ row, score }) => {
      const isEvicted = row.content_evicted === 1
      const unread = (row.status !== 'ready' && row.status !== 'text-only') || isEvicted
      return {
        documentId: row.id,
        path: row.path,
        name: row.name,
        chunkId: 0,
        text: unread
          ? isEvicted
            ? 'The file name matches. Its cached content was cleaned and will be re-read on demand.'
            : 'The file name matches. Its content has not been read yet (a scanned PDF waiting for OCR, or unreadable), so what it says is unknown.'
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
      contentEvicted: r.content_evicted === 1,
    }))
  }
}
