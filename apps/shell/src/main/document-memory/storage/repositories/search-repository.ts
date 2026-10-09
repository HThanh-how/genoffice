import type { DatabaseSync } from 'node:sqlite'
import { lexicalMatchPlan } from '../../lexical-query'
import { measureSqlite } from '../../sqlite-timing'
import { topVectors } from '../../top-vectors'
import { fuseHybridResults, isStrictLexicalStage } from '../../hybrid-ranker'
import { embeddingProfile } from '../../embedding-profiles'
import { isOcrLocation } from '../../ocr-sidecar'
import { ANN_MIN_VECTORS } from '../../ann-index'
import type { HotMetadataSearch } from '../../hot-metadata-search'
import {
  backfillNameProjectionBatch,
  hasNameProjection,
  type NameProjectionBackfillResult,
} from '../../name-search-projection'
import { blobVector, cosine } from './embedding-repository'
import type { MaintenanceRepository } from './maintenance-repository'
import type { DocumentMemoryHit, StoredDocument, TruncatedReason } from './document-repository'

export type { NameProjectionBackfillResult }

interface HitRow {
  document_id: number
  path: string
  name: string
  hash: string | null
  mtime_ms: number | null
  size_bytes: number | null
  updated_at: number | null
  truncated: number
  truncated_reason?: string | null
  content_evicted?: number
  chunk_id: number
  text: string
  location: string
}

function indexedAt(updatedAtSeconds: number | null): number | null {
  return typeof updatedAtSeconds === 'number' ? updatedAtSeconds * 1000 : null
}

export class SearchRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly hotMetadataSearch: HotMetadataSearch,
    private readonly maintRepo?: MaintenanceRepository,
  ) {}

  searchNames(query: string, limit = 5): DocumentMemoryHit[] {
    return this.hotMetadataSearch.searchNames(query, limit)
  }

  recent(limit = 20): StoredDocument[] {
    return this.hotMetadataSearch.recent(limit)
  }

  hasNameProjection(): boolean {
    return hasNameProjection(this.db)
  }

  backfillNameProjectionBatch(batchSize = 100): NameProjectionBackfillResult {
    return backfillNameProjectionBatch(this.db, batchSize)
  }

  searchLexical(
    query: string,
    limit = 200,
  ): Array<{ chunkId: number; rank: number; score: number; documentId: number; strict?: boolean }> {
    return measureSqlite('searchLexical', () => {
      const plan = lexicalMatchPlan(query)
      if (!plan.length) return []
      const stmt = this.db.prepare(
        `SELECT f.rowid AS chunk_id, bm25(chunk_fts) AS rank, c.document_id
         FROM chunk_fts f
         JOIN chunks c ON c.id = f.rowid
         JOIN documents d ON d.id = c.document_id
         WHERE chunk_fts MATCH ? AND d.excluded = 0
           AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)
         ORDER BY rank LIMIT ?`,
      )
      // Strongest stage first (phrase, then all words, then any word); a later stage only
      // fills the slots the earlier ones left, so exact phrase hits are never outranked.
      const rows: Array<{ chunk_id: number; rank: number; document_id: number; stage: number }> = []
      const seen = new Set<number>()
      for (let stage = 0; stage < plan.length && rows.length < limit; stage++) {
        const found = stmt.all(plan[stage]!, limit + rows.length) as Array<{
          chunk_id: number
          rank: number
          document_id: number
        }>
        for (const row of found) {
          if (seen.has(row.chunk_id) || rows.length >= limit) continue
          seen.add(row.chunk_id)
          rows.push({ ...row, stage })
        }
      }

      const results: Array<{ chunkId: number; rank: number; score: number; documentId: number; strict?: boolean }> = []
      let rank = 0
      let previous: { rank: number; stage: number } | undefined
      rows.forEach((row, index) => {
        if (previous?.rank !== row.rank || previous.stage !== row.stage) rank = index + 1
        results.push({
          chunkId: row.chunk_id,
          rank,
          score: row.rank,
          documentId: row.document_id,
          strict: isStrictLexicalStage(row.stage, plan.length),
        })
        previous = row
      })
      return results
    })
  }

  hydrateChunkHits(
    hits: Array<{ chunkId: number; rank?: number; score?: number }>,
  ): DocumentMemoryHit[] {
    return measureSqlite('hydrateChunkHits', () => {
      if (!hits.length) return []
      const placeholders = hits.map(() => '?').join(',')
      const chunkIds = hits.map((h) => h.chunkId)
      const rows = this.db
        .prepare(
          `SELECT
             c.id, c.text, c.location, c.document_id,
             d.path, d.name, d.status, d.hash, d.mtime_ms, d.size_bytes, d.updated_at, d.truncated, d.truncated_reason, d.content_evicted
           FROM chunks c
           JOIN documents d ON d.id = c.document_id
           WHERE c.id IN (${placeholders})
             AND d.excluded = 0
             AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)`,
        )
        .all(...chunkIds) as Array<{
        id: number
        text: string
        location: string
        document_id: number
        path: string
        name: string
        status: string
        hash: string | null
        mtime_ms: number | null
        size_bytes: number | null
        updated_at: number
        truncated: number
        truncated_reason: string | null
        content_evicted?: number
      }>

      const rowMap = new Map<number, (typeof rows)[number]>()
      for (const row of rows) {
        rowMap.set(row.id, row)
      }

      const result: DocumentMemoryHit[] = []
      for (const hit of hits) {
        const row = rowMap.get(hit.chunkId)
        if (!row) continue
        result.push({
          documentId: row.document_id,
          path: row.path,
          name: row.name,
          chunkId: row.id,
          text: row.text,
          location: row.location,
          score: hit.score ?? 0,
          hash: row.hash,
          mtimeMs: row.mtime_ms,
          sizeBytes: row.size_bytes,
          indexedAt: indexedAt(row.updated_at),
          truncated: row.truncated === 1,
          truncatedReason: (row.truncated_reason as TruncatedReason | undefined) ?? null,
          ...(row.content_evicted === 1 ? { contentUnread: true } : {}),
        })
      }
      return result
    })
  }

  searchSemantic(
    vector: number[],
    limit = 200,
    spaceId?: string,
  ): Array<{ chunkId: number; rank: number; score: number; documentId: number }> {
    if (!vector || !vector.length) return []
    if (vector.some((v) => !Number.isFinite(v)))
      throw new Error('Query vector must contain only finite numbers')

    const countRow = this.db
      .prepare(
        `SELECT count(*) AS count FROM chunk_embeddings e
         JOIN chunks c ON c.id = e.chunk_id
         JOIN documents d ON d.id = c.document_id
         WHERE d.excluded = 0 AND (? IS NULL OR e.space_id = ?)
           AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)`,
      )
      .get(spaceId ?? null, spaceId ?? null) as { count: number }

    if (countRow.count === 0) return []

    if (countRow.count >= ANN_MIN_VECTORS && spaceId && this.maintRepo) {
      try {
        const annMeta = this.db
          .prepare('SELECT generation, desired_generation, indexed_count, state FROM ann_indexes WHERE space_id = ?')
          .get(spaceId) as { generation: number; desired_generation: number; indexed_count: number; state: string } | undefined
        const ann = this.maintRepo.getAnnIndex(spaceId, vector.length)
        if (
          annMeta &&
          annMeta.state === 'ready' &&
          ann.isHealthy() &&
          typeof ann.getLoadedGeneration === 'function' &&
          typeof ann.reloadSync === 'function' &&
          annMeta.generation !== ann.getLoadedGeneration()
        ) {
          ann.reloadSync(annMeta.generation)
        }
        if (
          annMeta &&
          annMeta.state === 'ready' &&
          annMeta.generation === annMeta.desired_generation &&
          annMeta.indexed_count === countRow.count &&
          ann.isHealthy() &&
          typeof ann.getLoadedGeneration === 'function' &&
          ann.getLoadedGeneration() === annMeta.generation
        ) {
          const annHits = ann.searchSync(vector, limit * 2)
          if (!ann.isHealthy()) {
            this.maintRepo.markAnnDirty(spaceId)
          } else if (annHits.length > 0) {
            const chunkIds = annHits.map((h) => h.chunkId)
            const placeholders = chunkIds.map(() => '?').join(',')
            const validRows = this.db
              .prepare(
                `SELECT c.id, c.document_id FROM chunks c JOIN documents d ON d.id = c.document_id
                 WHERE c.id IN (${placeholders}) AND d.excluded = 0
                   AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)`,
              )
              .all(...chunkIds) as Array<{ id: number; document_id: number }>
            const validMap = new Map(validRows.map((r) => [r.id, r]))
            const hits: Array<{ chunkId: number; rank: number; score: number; documentId: number }> = []
            let rank = 1
            for (const annHit of annHits) {
              const row = validMap.get(annHit.chunkId)
              if (row) {
                hits.push({ chunkId: annHit.chunkId, rank: rank++, score: Math.max(0, 1 - annHit.distance), documentId: row.document_id })
                if (hits.length >= limit) break
              }
            }
            if (hits.length > 0) return hits
          }
        }
      } catch (err: unknown) {
        void err
        // fallback to exact scan
      }
    }
    return this.searchSemanticExact(vector, limit, spaceId)
  }

  searchSemanticExact(
    vector: number[],
    limit: number,
    embeddingSpaceId?: string,
  ): Array<{ chunkId: number; rank: number; score: number; documentId: number }> {
    let queryNorm = 0
    for (const value of vector) queryNorm += value * value

    const db = this.db
    function* scoredRows() {
      const rows = db
        .prepare(
          `SELECT e.chunk_id AS id, e.vector, e.vector_dim, c.document_id, d.priority_at
           FROM chunk_embeddings e
           JOIN chunks c ON c.id = e.chunk_id
           JOIN documents d ON d.id = c.document_id
           WHERE d.excluded = 0 AND (? IS NULL OR e.space_id = ?)
             AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)
           ORDER BY d.priority_at DESC, d.id DESC`,
        )
        .iterate(embeddingSpaceId ?? null, embeddingSpaceId ?? null) as Iterable<{
        id: number
        vector: Uint8Array
        vector_dim: number
        document_id: number
        priority_at: number
      }>

      let documentRank = 0
      for (const row of rows) {
        if (row.vector_dim !== vector.length) continue
        documentRank++
        const score = cosine(vector, blobVector(row.vector, row.vector_dim), queryNorm)
        yield {
          id: row.id,
          score: score + 1e-8 / documentRank,
          cosineScore: score,
          documentId: row.document_id,
        }
      }
    }

    const top = topVectors(scoredRows(), limit)
    let rank = 0
    let previousScore: number | undefined
    return top.map((item, index) => {
      if (previousScore !== item.cosineScore) rank = index + 1
      previousScore = item.cosineScore
      return {
        chunkId: item.id,
        rank,
        score: item.cosineScore,
        documentId: item.documentId,
      }
    })
  }

  search(
    query: string,
    vector: number[] | null,
    limit = 8,
    embeddingModel?: string,
  ): DocumentMemoryHit[] {
    if (vector && vector.some((v) => !Number.isFinite(v)))
      throw new Error('Query vector must contain only finite numbers')

    const lexicalHits = this.searchLexical(query, 200)
    const semanticHits = vector?.length ? this.searchSemantic(vector, 200, embeddingModel) : []

    if (!lexicalHits.length && !semanticHits.length) return []

    const candidateChunkIds = new Set<number>()
    const chunkToDoc = new Map<number, number>()
    for (const item of lexicalHits) {
      candidateChunkIds.add(item.chunkId)
      chunkToDoc.set(item.chunkId, item.documentId)
    }
    for (const item of semanticHits) {
      candidateChunkIds.add(item.chunkId)
      chunkToDoc.set(item.chunkId, item.documentId)
    }

    const recencyScores = new Map<number, number>()
    if (candidateChunkIds.size > 0) {
      const placeholders = [...candidateChunkIds].map(() => '?').join(',')
      const rows = this.db
        .prepare(
          `SELECT c.id, max(d.last_opened_at, coalesce(d.mtime_ms, 0)) AS recent
           FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id IN (${placeholders})`,
        )
        .all(...candidateChunkIds) as Array<{ id: number; recent: number }>
      const now = Date.now()
      for (const row of rows) {
        const age = Math.max(0, now - row.recent)
        recencyScores.set(row.id, Math.max(0, 1 - age / (90 * 24 * 60 * 60 * 1000)) * 0.00002)
      }
    }

    const fusedHits = fuseHybridResults(
      lexicalHits.map((h) => ({ chunkId: h.chunkId, rank: h.rank, documentId: h.documentId, strict: h.strict })),
      semanticHits.map((h) => ({ chunkId: h.chunkId, rank: h.rank, documentId: h.documentId })),
      {
        query: { text: query, tier: embeddingProfile(embeddingModel).tier },
        limit,
        maxChunksPerDocument: 2,
        chunkToDocument: chunkToDoc,
        recencyScores,
      },
    )

    if (!fusedHits.length) return []
    const get = this.db
      .prepare(`SELECT d.id AS document_id, d.path, d.name, d.hash, d.mtime_ms, d.size_bytes, d.updated_at, d.truncated, d.truncated_reason, d.content_evicted, c.id AS chunk_id, c.text, c.location
      FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.id = ? AND d.excluded = 0
        AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)`)

    return fusedHits.flatMap((hit) => {
      const row = get.get(hit.chunkId) as HitRow | undefined
      return row
        ? [
            {
              documentId: row.document_id,
              path: row.path,
              name: row.name,
              chunkId: row.chunk_id,
              text: row.text,
              location: row.location,
              score: hit.score,
              hash: row.hash,
              mtimeMs: row.mtime_ms,
              sizeBytes: row.size_bytes,
              indexedAt: indexedAt(row.updated_at),
              truncated: !!row.truncated,
              truncatedReason: (row.truncated_reason as TruncatedReason | undefined) ?? null,
              ...(row.content_evicted === 1 ? { contentUnread: true } : {}),
              ...(isOcrLocation(row.location) ? { ocr: true } : {}),
            },
          ]
        : []
    })
  }
}
