import type { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import type { EmbeddingProfile } from '../../embedding-profiles'

export function floatBlob(vector: number[]): Uint8Array {
  const copy = new Float32Array(vector)
  return new Uint8Array(copy.buffer)
}

export function blobVector(blob: Uint8Array, dim: number): Float32Array {
  if (blob.byteLength !== dim * Float32Array.BYTES_PER_ELEMENT) return new Float32Array(0)
  if (blob.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0)
    return new Float32Array(blob.buffer, blob.byteOffset, dim)
  const copy = blob.slice()
  return new Float32Array(copy.buffer, copy.byteOffset, dim)
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>, aa: number): number {
  if (a.length !== b.length || !a.length) return Number.NaN
  let dot = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) {
    const y = b[i]!
    if (!Number.isFinite(y)) return Number.NaN
    dot += a[i]! * y
    bb += y * y
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0
}

export class EmbeddingRepository {
  constructor(private readonly db: DatabaseSync) {}

  ensureEmbeddingSpace(profile: EmbeddingProfile): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      profile.embeddingId,
      profile.repo,
      profile.revision,
      profile.pooling,
      profile.dimensions,
      'q8',
    )
  }

  getEmbeddingCounts(documentId: number, spaceId?: string): number {
    if (spaceId) {
      const row = this.db
        .prepare('SELECT completed_chunks FROM document_embedding_counts WHERE document_id = ? AND space_id = ?')
        .get(documentId, spaceId) as { completed_chunks: number } | undefined
      return row?.completed_chunks ?? 0
    }
    const row = this.db
      .prepare('SELECT coalesce(sum(completed_chunks), 0) AS total FROM document_embedding_counts WHERE document_id = ?')
      .get(documentId) as { total: number } | undefined
    return row?.total ?? 0
  }

  getEmbeddingSpaces(): Array<{
    id: string
    modelRepo: string
    modelRevision: string
    pooling: string
    dimensions: number
    quantization: string
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, model_repo, model_revision, pooling, dimensions, quantization
         FROM embedding_spaces ORDER BY created_at ASC`,
      )
      .all() as Array<{
        id: string
        model_repo: string
        model_revision: string
        pooling: string
        dimensions: number
        quantization: string
      }>
    return rows.map((r) => ({
      id: r.id,
      modelRepo: r.model_repo,
      modelRevision: r.model_revision,
      pooling: r.pooling,
      dimensions: r.dimensions,
      quantization: r.quantization,
    }))
  }

  setChunkEmbeddings(
    path: string,
    hash: string,
    offset: number,
    vectors: number[][],
    embeddingSpaceId: string,
    complete: boolean,
    onEmbeddingsInserted?: (chunkIds: number[], vectors: number[][]) => void,
  ): void {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid vector offset')
    if (!embeddingSpaceId) throw new Error('Embedding space ID is required')
    const dimensions = new Set(vectors.map((vector) => vector.length))
    if (
      dimensions.size > 1 ||
      vectors.some((vector) => !vector.length || vector.some((v) => !Number.isFinite(v)))
    )
      throw new Error('Vectors must have a consistent nonzero dimension and finite values')
    const normalizedPath = resolve(path)

    let chunkIdsForAnn: number[] = []

    this.db.exec('BEGIN IMMEDIATE')
    try {
      const document = this.db
        .prepare('SELECT id, hash, excluded FROM documents WHERE path = ?')
        .get(normalizedPath) as { id: number; hash: string | null; excluded: number } | undefined
      if (!document || document.excluded || document.hash !== hash)
        throw new Error('Document changed before vectors were stored')

      const chunkRows = this.db
        .prepare(
          `SELECT c.id, c.ordinal FROM chunks c
           JOIN documents d ON d.id = c.document_id
           WHERE c.document_id = ?
             AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)
             AND c.ordinal >= ?
           ORDER BY c.ordinal ASC LIMIT ?`,
        )
        .all(document.id, offset, vectors.length) as Array<{ id: number; ordinal: number }>

      if (chunkRows.length !== vectors.length) {
        throw new Error('Vector batch does not match indexed chunks')
      }

      this.db
        .prepare(
          `INSERT OR IGNORE INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
           VALUES (?, ?, 'pinned', 'last-token', ?, 'q8')`,
        )
        .run(embeddingSpaceId, embeddingSpaceId, dimensions.values().next().value ?? 384)

      const insertEmbedding = this.db.prepare(`
        INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (chunk_id, space_id)
        DO UPDATE SET
          vector = excluded.vector,
          vector_dim = excluded.vector_dim,
          created_at = unixepoch()
      `)

      vectors.forEach((vector, index) => {
        const chunk = chunkRows[index]!
        const blob = floatBlob(vector)
        insertEmbedding.run(chunk.id, embeddingSpaceId, blob, vector.length)
      })

      const count = this.db
        .prepare(
          `SELECT count(*) AS total, count(e.chunk_id) AS vectors
           FROM chunks c
           JOIN documents d ON d.id = c.document_id
           LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.space_id = ?
           WHERE c.document_id = ?
             AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)`,
        )
        .get(embeddingSpaceId, document.id) as { total: number; vectors: number }

      if (complete && count.total !== count.vectors)
        throw new Error('Document vector batches are incomplete')

      this.db
        .prepare(
          `INSERT INTO document_embedding_counts (document_id, space_id, completed_chunks)
           VALUES (?, ?, ?)
           ON CONFLICT (document_id, space_id)
           DO UPDATE SET completed_chunks = excluded.completed_chunks`,
        )
        .run(document.id, embeddingSpaceId, count.vectors)

      this.db
        .prepare(
          `UPDATE documents SET embedding_model = ?, status = ?, chunk_done = ?, error = NULL, updated_at = unixepoch()
           WHERE id = ?`,
        )
        .run(embeddingSpaceId, complete ? 'ready' : 'text-only', count.vectors, document.id)

      chunkIdsForAnn = chunkRows.map((c) => c.id)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    if (onEmbeddingsInserted && chunkIdsForAnn.length > 0) {
      onEmbeddingsInserted(chunkIdsForAnn, vectors)
    }
  }

  recordMigrationEmbeddings(
    embeddingSpaceId: string,
    batch: Array<{ chunkId: number; vector: number[] }>,
    onEmbeddingsInserted?: (chunkIds: number[], vectors: number[][]) => void,
  ): void {
    if (!batch.length) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const insert = this.db.prepare(`
        INSERT INTO chunk_embeddings (chunk_id, space_id, vector, vector_dim)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (chunk_id, space_id)
        DO UPDATE SET
          vector = excluded.vector,
          vector_dim = excluded.vector_dim,
          created_at = unixepoch()
      `)
      for (const item of batch) {
        insert.run(item.chunkId, embeddingSpaceId, floatBlob(item.vector), item.vector.length)
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    if (onEmbeddingsInserted) {
      onEmbeddingsInserted(
        batch.map((b) => b.chunkId),
        batch.map((b) => b.vector),
      )
    }
  }

  resumeEmbeddingOffset(path: string, hash: string, embeddingSpaceId: string): number | null {
    const doc = this.db
      .prepare('SELECT id, hash, embedding_model, excluded, status FROM documents WHERE path = ?')
      .get(resolve(path)) as
      | {
          id: number
          hash: string | null
          embedding_model: string | null
          excluded: number
          status: string
        }
      | undefined
    if (!doc || doc.excluded || doc.hash !== hash || doc.status === 'pending') {
      return null
    }

    const row = this.db
      .prepare(`
        SELECT min(c.ordinal) AS missing, count(*) AS total
        FROM chunks c
        JOIN documents d ON d.id = c.document_id
        LEFT JOIN chunk_embeddings e
          ON e.chunk_id = c.id
          AND e.space_id = ?
        WHERE c.document_id = ?
          AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)
          AND e.chunk_id IS NULL
      `)
      .get(embeddingSpaceId, doc.id) as { missing: number | null; total: number }

    return row.missing ?? row.total
  }
}
