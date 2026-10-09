import { DatabaseSync } from 'node:sqlite'
import { basename, dirname, extname } from 'node:path'
import { MAX_BODY_CHARS } from './extract'
import { buildSnippet, containsAny, excerpt, type SnippetPart } from './snippet'
import { normalizeDocumentText } from '../document-memory/normalization'
import {
  parseQuery,
  termChars,
  termExpr,
  toIndexText,
  toMatchExpression,
  tokenExprs,
  tokenize,
  type QueryTerm,
} from './tokenize'

/** bump when tokenize() changes shape; the index is rebuilt from scratch */
const TOKENIZER_VERSION = 2

export type IndexStatus = 'ok' | 'name-only' | 'error' | 'pending'

export interface IndexedFile {
  path: string
  mtimeMs: number
  sizeBytes: number
  status: IndexStatus
}

export interface SearchHit {
  path: string
  name: string
  ext: string
  mtimeMs: number
  sizeBytes: number
  /** excerpt around the first content match; null when only the name/path matched */
  snippet: SnippetPart[] | null
  /** the folded query fragments this file matched, for highlighting name and folder */
  needles: string[]
  /** body text around the first hit, only when `excerptChars` was requested */
  excerpt?: string
}

export interface SearchOptions {
  /** restrict to these lowercased extensions */
  exts?: readonly string[]
  offset?: number
  limit?: number
  /** attach this many characters of body around the first hit to each result */
  excerptChars?: number
}

export interface SearchResult {
  hits: SearchHit[]
  total: number
}

/** a term with no phrase hit still matches a file covering more than this share of its characters */
const RELAXED_MIN_COVERAGE = 0.5
const RELAXED_MIN_TOKENS = 3

function namePathMatch(queryWords: readonly string[], name: string, path: string) {
  const basename = normalizeDocumentText(name.replace(/\.[^.]+$/, ''))
  const nameTokens = basename.split(' ').filter(Boolean)
  const pathTokens = normalizeDocumentText(dirname(path)).split(' ').filter(Boolean)
  const tokens = [...nameTokens, ...pathTokens]
  let exact = 0
  let prefix = 0
  for (const word of queryWords) {
    if (tokens.some((token) => token === word)) exact++
    else if (tokens.some((token) => token.startsWith(word))) prefix++
  }
  const query = queryWords.join(' ')
  const basenameRank = basename === query ? 0 : basename.startsWith(query) ? 1 : 2
  const basenameExact = queryWords.reduce(
    (count, word) => count + Number(nameTokens.includes(word)),
    0,
  )
  const coverageRank =
    exact === queryWords.length ? 0 : exact + prefix === queryWords.length ? 1 : 2
  return { coverageRank, basenameRank, basenameExact, exact, prefix }
}

interface Row {
  id: number
  path: string
  name: string
  ext: string
  mtime_ms: number
  size_bytes: number
}

/** how one file fares against the whole query */
interface Candidate {
  exact: number
  relaxed: number
  /** summed character coverage of relaxed term hits */
  cover: number
  /** summed BM25 over exact term hits (lower is better) */
  score: number
  needles: Set<string>
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  ext TEXT NOT NULL,
  mtime_ms REAL NOT NULL,
  size_bytes INTEGER NOT NULL,
  status TEXT NOT NULL,
  body TEXT
);
`

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS file_fts USING fts5(
  name, path, body, name_u, path_u, body_u,
  content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);
`

/**
 * SQLite FTS5 index over file names, folders and extracted text. FTS5 only sees
 * pre-tokenized shadow text (see tokenize.ts); the raw body stays in `files`
 * for snippets. Contentless FTS keeps the shadow text out of the database.
 */
export class FileIndexStore {
  private readonly db: DatabaseSync

  /** `readOnly`: a reader's connection (the search thread); it neither creates nor migrates anything. */
  constructor(dbPath: string, options: { readOnly?: boolean } = {}) {
    if (options.readOnly) {
      this.db = new DatabaseSync(dbPath, { readOnly: true })
      this.db.exec('PRAGMA busy_timeout = 5000')
      return
    }
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    if (this.meta('tokenizer') !== String(TOKENIZER_VERSION)) {
      this.db.exec('DROP TABLE IF EXISTS file_fts; DELETE FROM files;')
      this.setMeta('tokenizer', String(TOKENIZER_VERSION))
    }
    this.db.exec(FTS_SCHEMA)
  }

  private meta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      { value: string } | undefined
    return row?.value ?? null
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value)
  }

  listAll(): Map<string, IndexedFile> {
    const rows = this.db
      .prepare('SELECT path, mtime_ms, size_bytes, status FROM files')
      .all() as Array<{ path: string; mtime_ms: number; size_bytes: number; status: IndexStatus }>
    const out = new Map<string, IndexedFile>()
    for (const r of rows)
      out.set(r.path, {
        path: r.path,
        mtimeMs: r.mtime_ms,
        sizeBytes: r.size_bytes,
        status: r.status,
      })
    return out
  }

  /**
   * Same result as `listAll`, read in key-ordered pages with `yieldNow` between them: one statement over a
   * million-row index is a single piece of synchronous work, a stall for every window of the app.
   */
  async listAllSliced(
    yieldNow: () => Promise<void>,
    pageSize = 2_000,
  ): Promise<Map<string, IndexedFile>> {
    const page = this.db.prepare(
      'SELECT id, path, mtime_ms, size_bytes, status FROM files WHERE id > ? ORDER BY id LIMIT ?',
    )
    const out = new Map<string, IndexedFile>()
    let after = 0
    for (;;) {
      const rows = page.all(after, pageSize) as Array<{
        id: number
        path: string
        mtime_ms: number
        size_bytes: number
        status: IndexStatus
      }>
      if (rows.length === 0) return out
      for (const r of rows)
        out.set(r.path, {
          path: r.path,
          mtimeMs: r.mtime_ms,
          sizeBytes: r.size_bytes,
          status: r.status,
        })
      after = rows[rows.length - 1]!.id
      await yieldNow()
    }
  }

  count(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n
  }

  private countCache: { n: number; at: number } | null = null

  /** `count()` at most once per `maxAgeMs`: counting a million rows is a pass over the whole index. */
  countCached(maxAgeMs = 5_000): number {
    const now = Date.now()
    if (!this.countCache || now - this.countCache.at > maxAgeMs)
      this.countCache = { n: this.count(), at: now }
    return this.countCache.n
  }

  /** insert or replace one file; `text` null indexes the name and folder only */
  upsert(
    meta: { path: string; mtimeMs: number; sizeBytes: number },
    text: string | null,
    status: IndexStatus,
  ): void {
    this.inTransaction(() => this.writeRow(meta, text, status))
  }

  /** Name-only rows for files not seen before, in one transaction (the content follows when the file is parsed). */
  upsertPendingBatch(
    files: ReadonlyArray<{ path: string; mtimeMs: number; sizeBytes: number }>,
  ): void {
    if (files.length === 0) return
    this.inTransaction(() => {
      for (const f of files) this.writeRow(f, null, 'pending')
    })
  }

  private inTransaction(run: () => void): void {
    this.db.exec('BEGIN')
    try {
      run()
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  private writeRow(
    meta: { path: string; mtimeMs: number; sizeBytes: number },
    text: string | null,
    status: IndexStatus,
  ): void {
    const name = basename(meta.path)
    const ext = extname(meta.path).slice(1).toLowerCase()
    const body = text ? text.slice(0, MAX_BODY_CHARS) : null
    const nameTok = tokenize(name)
    const pathTok = tokenize(dirname(meta.path))
    const bodyTok = body ? tokenize(body) : { bi: [], uni: [] }
    const existing = this.db.prepare('SELECT id FROM files WHERE path = ?').get(meta.path) as
      { id: number } | undefined
    if (existing) {
      this.db.prepare('DELETE FROM file_fts WHERE rowid = ?').run(existing.id)
      this.db.prepare('DELETE FROM files WHERE id = ?').run(existing.id)
    }
    const inserted = this.db
      .prepare(
        'INSERT INTO files(path, name, ext, mtime_ms, size_bytes, status, body) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(meta.path, name, ext, meta.mtimeMs, meta.sizeBytes, status, body)
    this.db
      .prepare(
        'INSERT INTO file_fts(rowid, name, path, body, name_u, path_u, body_u) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        inserted.lastInsertRowid,
        toIndexText(nameTok.bi),
        toIndexText(pathTok.bi),
        toIndexText(bodyTok.bi),
        toIndexText(nameTok.uni),
        toIndexText(pathTok.uni),
        toIndexText(bodyTok.uni),
      )
  }

  remove(paths: readonly string[]): void {
    if (paths.length === 0) return
    const select = this.db.prepare('SELECT id FROM files WHERE path = ?')
    const delFts = this.db.prepare('DELETE FROM file_fts WHERE rowid = ?')
    const delFile = this.db.prepare('DELETE FROM files WHERE id = ?')
    this.inTransaction(() => {
      for (const p of paths) {
        const row = select.get(p) as { id: number } | undefined
        if (!row) continue
        delFts.run(row.id)
        delFile.run(row.id)
      }
    })
  }

  /**
   * Each term is judged on its own: a phrase hit, or failing that a file
   * holding most of the term's tokens. Files matching every term come first;
   * when none does, any term will do. Within that, a name starting with the
   * query, then name/folder hits, then more exact terms, then BM25 and recency.
   */
  search(input: string, opts: SearchOptions = {}): SearchResult {
    const parsed = parseQuery(input)
    if (parsed.include.length === 0) return { hits: [], total: 0 }
    const candidates = new Map<number, Candidate>()
    const get = (id: number): Candidate => {
      let c = candidates.get(id)
      if (!c) {
        c = { exact: 0, relaxed: 0, cover: 0, score: 0, needles: new Set() }
        candidates.set(id, c)
      }
      return c
    }
    for (const term of parsed.include) {
      const exactIds = new Set<number>()
      for (const r of this.matchScored(termExpr(term))) {
        exactIds.add(r.rowid)
        const c = get(r.rowid)
        c.exact++
        c.score += r.score
        c.needles.add(term.text)
      }
      for (const [id, m] of this.relaxedMatches(term)) {
        if (exactIds.has(id)) continue
        const c = get(id)
        c.relaxed++
        c.cover += m.cover
        for (const t of m.tokens) c.needles.add(t)
      }
    }
    if (parsed.exclude.length) {
      const expr = toMatchExpression({ include: parsed.exclude, exclude: [] }, 'OR')
      if (expr) for (const id of this.matchIds(expr)) candidates.delete(id)
    }
    if (candidates.size === 0) return { hits: [], total: 0 }
    const wanted = parsed.include.length
    // the type filter applies before choosing all-term over any-term, so a pill never hides the fallback
    const allRows = this.fetchRows([...candidates.keys()], opts.exts)
    const fullRows = allRows.filter((r) => {
      const c = candidates.get(r.id)!
      return c.exact + c.relaxed === wanted
    })
    const rows = fullRows.length ? fullRows : allRows
    const queryWords = [
      ...new Set(parsed.include.flatMap((term) => normalizeDocumentText(term.text).split(' '))),
    ].filter(Boolean)
    const rank = new Map<
      number,
      [number, number, number, number, number, number, number, number, number, number, number]
    >()
    for (const r of rows) {
      const c = candidates.get(r.id)!
      const needles = [...c.needles]
      const meta = containsAny(r.name, needles) || containsAny(dirname(r.path), needles)
      const namePath = namePathMatch(queryWords, r.name, r.path)
      rank.set(r.id, [
        namePath.coverageRank,
        -namePath.exact,
        -namePath.prefix,
        namePath.basenameRank,
        -namePath.basenameExact,
        -(c.exact + c.relaxed),
        meta ? 0 : 1,
        -c.exact,
        -c.cover,
        c.score,
        -r.mtime_ms,
      ])
    }
    rows.sort((a, b) => {
      const ra = rank.get(a.id)!
      const rb = rank.get(b.id)!
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!
      return 0
    })
    const limit =
      opts.limit != null && Number.isFinite(opts.limit)
        ? Math.max(0, Math.min(200, opts.limit))
        : 50
    const offset =
      opts.offset != null && Number.isFinite(opts.offset) ? Math.max(0, opts.offset) : 0
    const page = rows.slice(offset, offset + limit)
    const bodies = this.fetchBodies(page.map((r) => r.id))
    const hits = page.map((r) => {
      const needles = [...candidates.get(r.id)!.needles]
      const body = bodies.get(r.id)
      return {
        path: r.path,
        name: r.name,
        ext: r.ext,
        mtimeMs: r.mtime_ms,
        sizeBytes: r.size_bytes,
        snippet: body ? buildSnippet(body, needles) : null,
        needles,
        ...(opts.excerptChars && body
          ? { excerpt: excerpt(body, needles, opts.excerptChars) }
          : {}),
      }
    })
    return { hits, total: rows.length }
  }

  /** name and body excerpt for the given paths, in that order; unknown paths are skipped */
  excerptsFor(
    paths: readonly string[],
    q: string,
    chars: number,
  ): Array<{ path: string; name: string; excerpt: string }> {
    if (paths.length === 0) return []
    const parsed = parseQuery(q)
    const needles = parsed.include.flatMap((t) => [t.text, ...t.tokens.bi])
    const rows = this.db
      .prepare(
        `SELECT path, name, body FROM files WHERE path IN (${paths.map(() => '?').join(',')})`,
      )
      .all(...paths) as unknown as Array<{ path: string; name: string; body: string | null }>
    const byPath = new Map(rows.map((r) => [r.path, r]))
    const out: Array<{ path: string; name: string; excerpt: string }> = []
    for (const p of paths) {
      const r = byPath.get(p)
      if (r)
        out.push({
          path: r.path,
          name: r.name,
          excerpt: r.body ? excerpt(r.body, needles, chars) : '',
        })
    }
    return out
  }

  private matchScored(expr: string): Array<{ rowid: number; score: number }> {
    return this.db
      .prepare(
        'SELECT rowid, bm25(file_fts, 10.0, 5.0, 1.0, 10.0, 5.0, 1.0) AS score FROM file_fts WHERE file_fts MATCH ?',
      )
      .all(expr) as unknown as Array<{ rowid: number; score: number }>
  }

  private matchIds(expr: string): number[] {
    return (
      this.db
        .prepare('SELECT rowid FROM file_fts WHERE file_fts MATCH ?')
        .all(expr) as unknown as Array<{
        rowid: number
      }>
    ).map((r) => r.rowid)
  }

  /** files covering more than half of the term's characters, with the tokens they hold */
  private relaxedMatches(term: QueryTerm): Map<number, { tokens: string[]; cover: number }> {
    const tokens = tokenExprs(term)
    const out = new Map<number, { tokens: string[]; at: Set<number> }>()
    if (tokens.length < RELAXED_MIN_TOKENS) return new Map()
    for (const t of tokens) {
      for (const id of this.matchIds(t.expr)) {
        let m = out.get(id)
        if (!m) out.set(id, (m = { tokens: [], at: new Set() }))
        m.tokens.push(t.text)
        for (const i of t.at) m.at.add(i)
      }
    }
    const total = termChars(term)
    const kept = new Map<number, { tokens: string[]; cover: number }>()
    for (const [id, m] of out) {
      const cover = m.at.size / total
      if (cover > RELAXED_MIN_COVERAGE) kept.set(id, { tokens: m.tokens, cover })
    }
    return kept
  }

  private fetchRows(ids: readonly number[], exts?: readonly string[]): Row[] {
    const lower = exts?.map((e) => e.toLowerCase()) ?? []
    const extClause = lower.length ? ` AND ext IN (${lower.map(() => '?').join(',')})` : ''
    const rows: Row[] = []
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      rows.push(
        ...(this.db
          .prepare(
            `SELECT id, path, name, ext, mtime_ms, size_bytes FROM files WHERE id IN (${chunk.map(() => '?').join(',')})${extClause}`,
          )
          .all(...chunk, ...lower) as unknown as Row[]),
      )
    }
    return rows
  }

  private fetchBodies(ids: readonly number[]): Map<number, string> {
    const out = new Map<number, string>()
    if (ids.length === 0) return out
    const rows = this.db
      .prepare(`SELECT id, body FROM files WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as unknown as Array<{ id: number; body: string | null }>
    for (const r of rows) if (r.body) out.set(r.id, r.body)
    return out
  }

  close(): void {
    this.db.close()
  }
}
