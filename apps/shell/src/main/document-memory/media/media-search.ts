import type { DatabaseSync } from 'node:sqlite'
import type { DocumentMemoryHit } from '../store'
import { mediaInfoFor, toMediaHitInfo } from './media-repository'
import { parseMediaIntent, type MediaIntent } from './media-query'
import type { MediaHitInfo } from './media-types'

const pad = (n: number): string => String(n).padStart(2, '0')

function formatDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** One line a reader (or the assistant) can rely on: what is known, and that the content is not. */
export function describeMedia(info: MediaHitInfo): string {
  const facts = [
    info.kind === 'video' && info.durationMs ? formatDuration(info.durationMs) : null,
    info.width && info.height ? `${info.width}x${info.height}` : null,
    info.container ? info.container.toUpperCase() : null,
    info.takenMs ? formatDate(info.takenMs) : null,
  ].filter(Boolean)
  const head = info.kind === 'video' ? 'Video file' : 'Image file'
  const tail =
    info.kind === 'video'
      ? 'Only its name and container metadata are indexed; its content is never analyzed.'
      : 'Only its name and header metadata are indexed; the picture itself has not been read.'
  return `${head}${facts.length ? ` (${facts.join(', ')})` : ''}. ${tail}`
}

interface HitRow {
  id: number
  path: string
  name: string
  mtime_ms: number | null
  size_bytes: number | null
  updated_at: number
  kind: 'image' | 'video'
  container: string | null
  width: number | null
  height: number | null
  duration_ms: number | null
  taken_ms: number | null
  ocr_candidate: number
  sensitive: number
}

function ftsQuery(words: readonly string[]): string | null {
  const terms = words.map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean)
  return terms.length ? terms.map((w) => `"${w}"*`).join(' AND ') : null
}

function withMedia(hit: DocumentMemoryHit, info: MediaHitInfo): DocumentMemoryHit {
  return { ...hit, text: describeMedia(info), contentUnread: true, media: info }
}

function toHit(row: HitRow, score: number): DocumentMemoryHit {
  const info = toMediaHitInfo({ ...row, document_id: row.id })
  return withMedia(
    {
      documentId: row.id,
      path: row.path,
      name: row.name,
      chunkId: 0,
      text: '',
      location: 'file name',
      score,
      hash: null,
      mtimeMs: row.mtime_ms,
      sizeBytes: row.size_bytes,
      indexedAt: row.updated_at * 1000,
      truncated: false,
    },
    info,
  )
}

/**
 * Media rows a query asks for by type word / extension / date, newest first. `[]` for document queries.
 * A date selects by the capture date / mtime (index on kind+ts) UNION the same date written in the name
 * (name projection FTS), so the cost follows the number of matches, never the size of the library.
 */
export function searchMediaIntent(
  db: DatabaseSync,
  intent: MediaIntent,
  limit: number,
): DocumentMemoryHit[] {
  const run = (withNameDate: boolean): HitRow[] => {
    const params: Array<string | number> = []
    const where: string[] = ['d.excluded = 0']
    let from = 'document_media m JOIN documents d ON d.id = m.document_id'
    if (intent.range) {
      let byTime: string
      if (intent.kind) {
        byTime =
          'SELECT document_id AS id FROM document_media WHERE kind = ? AND ts_ms >= ? AND ts_ms < ?'
        params.push(intent.kind, intent.range.from, intent.range.to)
      } else {
        byTime = 'SELECT document_id AS id FROM document_media WHERE ts_ms >= ? AND ts_ms < ?'
        params.push(intent.range.from, intent.range.to)
      }
      let ids = byTime
      if (withNameDate && intent.nameDateMatch) {
        ids +=
          ' UNION SELECT rowid FROM document_name_projection_fts WHERE document_name_projection_fts MATCH ?'
        params.push(intent.nameDateMatch)
      }
      from = `(${ids}) ids JOIN document_media m ON m.document_id = ids.id JOIN documents d ON d.id = ids.id`
    }
    if (intent.kind) {
      where.push('m.kind = ?')
      params.push(intent.kind)
    }
    if (intent.extensions.length) {
      where.push(`(${intent.extensions.map(() => 'lower(d.name) LIKE ?').join(' OR ')})`)
      params.push(...intent.extensions.map((e) => `%${e}`))
    }
    const fts = ftsQuery(intent.words)
    if (fts) {
      from += ' JOIN document_name_fts fts ON fts.rowid = d.id'
      where.push('document_name_fts MATCH ?')
      params.push(fts)
    }
    return db
      .prepare(
        `SELECT d.id AS id, d.path AS path, d.name AS name, d.mtime_ms AS mtime_ms, d.size_bytes AS size_bytes,
                d.updated_at AS updated_at, m.kind AS kind, m.container AS container, m.width AS width,
                m.height AS height, m.duration_ms AS duration_ms, m.taken_ms AS taken_ms,
                m.ocr_candidate AS ocr_candidate, m.sensitive AS sensitive
         FROM ${from} WHERE ${where.join(' AND ')} ORDER BY m.ts_ms DESC, d.id DESC LIMIT ?`,
      )
      .all(...params, limit) as unknown as HitRow[]
  }
  let rows: HitRow[]
  try {
    rows = run(true)
  } catch {
    rows = run(false) // no name projection (old database): the date still works through ts_ms
  }
  // Asked for by type ("ảnh", "video"): above weak name matches, below a document named exactly like the
  // query. A bare date is weaker still: documents dated in their name come first.
  const score = intent.kind ? 0.8 + (intent.words.length ? 0.1 : 0) : 0.45
  return rows.map((row) => toHit(row, score))
}

/**
 * The name-search entry point's media step: describe media hits the normal name search found, and add the
 * hits a type word / extension / date asks for. Never throws (search must not fail because of media).
 */
export function mergeMediaHits(
  db: DatabaseSync,
  query: string,
  base: DocumentMemoryHit[],
  limit: number,
): DocumentMemoryHit[] {
  try {
    const info = mediaInfoFor(
      db,
      base.map((hit) => hit.documentId),
    )
    const described = info.size
      ? base.map((hit) =>
          info.has(hit.documentId) ? withMedia(hit, info.get(hit.documentId)!) : hit,
        )
      : base
    const intent = parseMediaIntent(query)
    if (!intent) return described
    const extra = searchMediaIntent(db, intent, limit)
    if (!extra.length) return described
    const byId = new Map(described.map((hit) => [hit.documentId, hit]))
    for (const hit of extra) {
      const known = byId.get(hit.documentId)
      if (!known || hit.score > known.score)
        byId.set(hit.documentId, known ? { ...known, score: hit.score } : hit)
    }
    return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit)
  } catch {
    return base
  }
}
