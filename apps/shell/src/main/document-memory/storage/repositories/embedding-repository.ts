import type { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { EMBEDDING_PROFILES, type EmbeddingProfile } from '../../embedding-profiles'

export function getCanonicalProfile(id: unknown): EmbeddingProfile | null {
  if (id === 'standard' || id === EMBEDDING_PROFILES.standard.embeddingId) {
    return EMBEDDING_PROFILES.standard
  }
  if (id === 'high' || id === EMBEDDING_PROFILES.high.embeddingId) {
    return EMBEDDING_PROFILES.high
  }
  return null
}

export function isCanonicalSpaceId(id: unknown): boolean {
  return getCanonicalProfile(id) !== null
}

export interface RepairInvalidCanonicalEmbeddingsResult {
  ok: boolean
  repairedSpaces: string[]
  deletedEmbeddings: number
  deletedCount: number
  affectedDocuments: number
  requeuedDocuments: number
}

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
    const existing = this.db
      .prepare(
        `SELECT dimensions, model_repo, model_revision, pooling, quantization
         FROM embedding_spaces WHERE id = ?`,
      )
      .get(profile.embeddingId) as
      | {
          dimensions: number
          model_repo: string
          model_revision: string
          pooling: string
          quantization: string
        }
      | undefined

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO embedding_spaces (id, model_repo, model_revision, pooling, dimensions, quantization)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          profile.embeddingId,
          profile.repo,
          profile.revision,
          profile.pooling,
          profile.dimensions,
          'q8',
        )
      return
    }

    if (
      existing.dimensions !== profile.dimensions ||
      existing.model_repo !== profile.repo ||
      existing.model_revision !== profile.revision ||
      existing.pooling !== profile.pooling ||
      existing.quantization !== 'q8'
    ) {
      const isKnownPlaceholder =
        existing.dimensions === profile.dimensions &&
        existing.model_repo === profile.embeddingId &&
        existing.model_revision === 'legacy' &&
        existing.pooling === 'mean' &&
        existing.quantization === 'fp32'

      if (isKnownPlaceholder) {
        const invalidVector = this.db
          .prepare(
            `SELECT chunk_id, vector_dim, length(vector) as byte_len
             FROM chunk_embeddings
             WHERE space_id = ? AND (vector_dim != ? OR length(vector) != ?)
             LIMIT 1`,
          )
          .get(profile.embeddingId, profile.dimensions, profile.dimensions * 4)

        if (invalidVector) {
          throw new Error(
            `Cannot repair legacy placeholder space '${profile.embeddingId}': invalid existing vector dimensions detected`,
          )
        }

        this.db
          .prepare(
            `UPDATE embedding_spaces
             SET model_repo = ?, model_revision = ?, pooling = ?, dimensions = ?, quantization = 'q8'
             WHERE id = ?`,
          )
          .run(
            profile.repo,
            profile.revision,
            profile.pooling,
            profile.dimensions,
            profile.embeddingId,
          )
        return
      }

      throw new Error(
        `Embedding space mismatch for '${profile.embeddingId}': ` +
          `expected dimensions=${profile.dimensions}, model_repo='${profile.repo}', model_revision='${profile.revision}', pooling='${profile.pooling}', quantization='q8'; ` +
          `found dimensions=${existing.dimensions}, model_repo='${existing.model_repo}', model_revision='${existing.model_revision}', pooling='${existing.pooling}', quantization='${existing.quantization}'`,
      )
    }
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

    const space = this.db
      .prepare('SELECT dimensions FROM embedding_spaces WHERE id = ?')
      .get(embeddingSpaceId) as { dimensions: number } | undefined
    if (!space) {
      throw new Error(`Embedding space not found: '${embeddingSpaceId}'`)
    }
    const canonical = getCanonicalProfile(embeddingSpaceId)
    if (canonical) {
      if (space.dimensions !== canonical.dimensions) {
        throw new Error(
          `Embedding space mismatch for canonical space '${embeddingSpaceId}': expected dimensions=${canonical.dimensions}, but found dimensions=${space.dimensions}`,
        )
      }
      if (vectors.some((vector) => vector.length !== canonical.dimensions)) {
        const mismatch = vectors.find((vector) => vector.length !== canonical.dimensions)
        throw new Error(
          `Vector dimension mismatch for canonical space '${embeddingSpaceId}': expected ${canonical.dimensions}, but received ${mismatch?.length ?? 0}`,
        )
      }
    } else if (vectors.some((vector) => vector.length !== space.dimensions)) {
      const mismatch = vectors.find((vector) => vector.length !== space.dimensions)
      throw new Error(
        `Vector dimension mismatch for space '${embeddingSpaceId}': expected ${space.dimensions}, but received ${mismatch?.length ?? 0}`,
      )
    }

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
    if (!embeddingSpaceId) throw new Error('Embedding space ID is required')
    if (!batch.length) return

    const space = this.db
      .prepare('SELECT dimensions FROM embedding_spaces WHERE id = ?')
      .get(embeddingSpaceId) as { dimensions: number } | undefined
    if (!space) {
      throw new Error(`Embedding space not found: '${embeddingSpaceId}'`)
    }

    const canonical = getCanonicalProfile(embeddingSpaceId)
    if (canonical && space.dimensions !== canonical.dimensions) {
      throw new Error(
        `Embedding space mismatch for canonical space '${embeddingSpaceId}': expected dimensions=${canonical.dimensions}, but found dimensions=${space.dimensions}`,
      )
    }

    const expectedDim = canonical ? canonical.dimensions : space.dimensions
    for (const item of batch) {
      if (
        !item.vector ||
        !item.vector.length ||
        item.vector.some((v) => !Number.isFinite(v))
      ) {
        throw new Error('Vectors must have a consistent nonzero dimension and finite values')
      }
      if (item.vector.length !== expectedDim) {
        throw new Error(
          `Vector dimension mismatch for space '${embeddingSpaceId}': expected ${expectedDim}, but received ${item.vector.length}`,
        )
      }
    }

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
        insert.run(item.chunkId, embeddingSpaceId, floatBlob(item.vector), space.dimensions)
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

  repairInvalidCanonicalEmbeddings(
    onSpaceDirty?: ((spaceId: string) => void) | string | { spaceId?: string; onSpaceDirty?: (spaceId: string) => void },
    targetSpaceIdArg?: string,
  ): RepairInvalidCanonicalEmbeddingsResult {
    let spaceFilter: string | undefined
    let notifyDirty: ((spaceId: string) => void) | undefined

    if (typeof onSpaceDirty === 'function') {
      notifyDirty = onSpaceDirty
      spaceFilter = targetSpaceIdArg
    } else if (typeof onSpaceDirty === 'string') {
      spaceFilter = onSpaceDirty
    } else if (onSpaceDirty && typeof onSpaceDirty === 'object') {
      spaceFilter = onSpaceDirty.spaceId
      notifyDirty = onSpaceDirty.onSpaceDirty
    }

    const canonicalSpecs: Array<{ spaceId: string; dimensions: number; profile: EmbeddingProfile }> = [
      {
        spaceId: EMBEDDING_PROFILES.standard.embeddingId,
        dimensions: EMBEDDING_PROFILES.standard.dimensions,
        profile: EMBEDDING_PROFILES.standard,
      },
      {
        spaceId: 'standard',
        dimensions: EMBEDDING_PROFILES.standard.dimensions,
        profile: EMBEDDING_PROFILES.standard,
      },
      {
        spaceId: EMBEDDING_PROFILES.high.embeddingId,
        dimensions: EMBEDDING_PROFILES.high.dimensions,
        profile: EMBEDDING_PROFILES.high,
      },
      {
        spaceId: 'high',
        dimensions: EMBEDDING_PROFILES.high.dimensions,
        profile: EMBEDDING_PROFILES.high,
      },
    ]

    try {
      const dbSpaces = this.db
        .prepare('SELECT id, dimensions, model_repo FROM embedding_spaces')
        .all() as Array<{ id: string; dimensions: number; model_repo: string }>
      for (const dbs of dbSpaces) {
        if (!canonicalSpecs.some((c) => c.spaceId === dbs.id)) {
          if (dbs.model_repo === EMBEDDING_PROFILES.standard.repo || dbs.id.includes('f2llm-v2-80m')) {
            canonicalSpecs.push({
              spaceId: dbs.id,
              dimensions: EMBEDDING_PROFILES.standard.dimensions,
              profile: EMBEDDING_PROFILES.standard,
            })
          } else if (dbs.model_repo === EMBEDDING_PROFILES.high.repo || dbs.id.includes('qwen3-embedding-0.6b')) {
            canonicalSpecs.push({
              spaceId: dbs.id,
              dimensions: EMBEDDING_PROFILES.high.dimensions,
              profile: EMBEDDING_PROFILES.high,
            })
          }
        }
      }
    } catch {
      // Non-blocking if table is not yet created
    }

    const specsToInspect = spaceFilter
      ? canonicalSpecs.filter((s) => s.spaceId === spaceFilter || s.profile.id === spaceFilter)
      : canonicalSpecs

    const invalidRows: Array<{
      chunk_id: number
      space_id: string
      document_id: number
      vector_dim: number
      byte_len: number
    }> = []

    const findInvalidStmt = this.db.prepare(`
      SELECT e.chunk_id, e.space_id, coalesce(c.document_id, 0) AS document_id, e.vector_dim, length(e.vector) AS byte_len
      FROM chunk_embeddings e
      LEFT JOIN chunks c ON c.id = e.chunk_id
      WHERE e.space_id = ? AND (e.vector_dim != ? OR length(e.vector) != ?)
    `)

    for (const spec of specsToInspect) {
      const rows = findInvalidStmt.all(
        spec.spaceId,
        spec.dimensions,
        spec.dimensions * 4,
      ) as Array<{
        chunk_id: number
        space_id: string
        document_id: number
        vector_dim: number
        byte_len: number
      }>
      invalidRows.push(...rows)
    }

    const repairedSpacesSet = new Set<string>()

    for (const spec of specsToInspect) {
      const existing = this.db
        .prepare('SELECT id, dimensions, model_repo, model_revision, pooling, quantization FROM embedding_spaces WHERE id = ?')
        .get(spec.spaceId) as
        | {
            id: string
            dimensions: number
            model_repo: string
            model_revision: string
            pooling: string
            quantization: string
          }
        | undefined
      if (existing) {
        if (
          existing.dimensions !== spec.dimensions ||
          existing.model_repo !== spec.profile.repo ||
          existing.model_revision !== spec.profile.revision ||
          existing.pooling !== spec.profile.pooling ||
          existing.quantization !== 'q8'
        ) {
          this.db
            .prepare(
              `UPDATE embedding_spaces
               SET model_repo = ?, model_revision = ?, pooling = ?, dimensions = ?, quantization = 'q8'
               WHERE id = ?`,
            )
            .run(
              spec.profile.repo,
              spec.profile.revision,
              spec.profile.pooling,
              spec.dimensions,
              spec.spaceId,
            )
          repairedSpacesSet.add(spec.spaceId)
          try {
            this.db
              .prepare(
                `INSERT INTO ann_indexes (space_id, generation, desired_generation, indexed_count, state, updated_at)
                 VALUES (?, 0, 1, 0, 'dirty', unixepoch())
                 ON CONFLICT(space_id)
                 DO UPDATE SET
                   desired_generation = desired_generation + 1,
                   state = 'dirty',
                   updated_at = unixepoch()`,
              )
              .run(spec.spaceId)
          } catch {}
          if (notifyDirty) notifyDirty(spec.spaceId)
        }
      }
    }

    if (invalidRows.length === 0) {
      return {
        ok: true,
        repairedSpaces: Array.from(repairedSpacesSet),
        deletedEmbeddings: 0,
        deletedCount: 0,
        affectedDocuments: 0,
        requeuedDocuments: 0,
      }
    }

    const affectedDocIds = new Set<number>()
    const affectedSpaceIds = new Set<string>()

    for (const r of invalidRows) {
      if (r.document_id > 0) affectedDocIds.add(r.document_id)
      affectedSpaceIds.add(r.space_id)
      repairedSpacesSet.add(r.space_id)
    }

    this.db.exec('BEGIN IMMEDIATE')
    try {
      // 1. Delete ONLY the invalid rows from chunk_embeddings
      const deleteStmt = this.db.prepare('DELETE FROM chunk_embeddings WHERE chunk_id = ? AND space_id = ?')
      for (const r of invalidRows) {
        deleteStmt.run(r.chunk_id, r.space_id)
      }

      // 2. Ensure canonical space metadata in embedding_spaces is correct
      for (const spec of specsToInspect) {
        if (affectedSpaceIds.has(spec.spaceId)) {
          this.db
            .prepare(
              `UPDATE embedding_spaces
               SET model_repo = ?, model_revision = ?, pooling = ?, dimensions = ?, quantization = 'q8'
               WHERE id = ?`,
            )
            .run(
              spec.profile.repo,
              spec.profile.revision,
              spec.profile.pooling,
              spec.dimensions,
              spec.spaceId,
            )
        }
      }

      // 3. Recompute document_embedding_counts for affected documents and spaces
      for (const docId of affectedDocIds) {
        for (const spaceId of affectedSpaceIds) {
          const remainingRow = this.db
            .prepare(
              `SELECT count(e.chunk_id) AS remaining
               FROM chunks c
               JOIN documents d ON d.id = c.document_id
               JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.space_id = ?
               WHERE c.document_id = ?
                 AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)`,
            )
            .get(spaceId, docId) as { remaining: number } | undefined
          const remaining = remainingRow?.remaining ?? 0

          if (remaining > 0) {
            this.db
              .prepare(
                `INSERT INTO document_embedding_counts (document_id, space_id, completed_chunks)
                 VALUES (?, ?, ?)
                 ON CONFLICT (document_id, space_id)
                 DO UPDATE SET completed_chunks = excluded.completed_chunks`,
              )
              .run(docId, spaceId, remaining)
          } else {
            this.db
              .prepare('DELETE FROM document_embedding_counts WHERE document_id = ? AND space_id = ?')
              .run(docId, spaceId)
          }
        }
      }

      // 4. Update documents status and chunk_done, requeueing affected documents
      let requeuedCount = 0
      for (const docId of affectedDocIds) {
        const doc = this.db
          .prepare(
            `SELECT id, status, chunk_total, chunk_done, embedding_model, excluded
             FROM documents WHERE id = ?`,
          )
          .get(docId) as
          | {
              id: number
              status: string
              chunk_total: number
              chunk_done: number
              embedding_model: string | null
              excluded: number
            }
          | undefined

        if (doc && !doc.excluded) {
          const totalChunksRow = this.db
            .prepare(
              `SELECT count(*) AS total
               FROM chunks c
               JOIN documents d ON d.id = c.document_id
               WHERE c.document_id = ?
                 AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)`,
            )
            .get(docId) as { total: number } | undefined
          const totalChunks = totalChunksRow?.total ?? doc.chunk_total

          const modelToCheck = doc.embedding_model ?? Array.from(affectedSpaceIds)[0]
          const remainingVectorsRow = this.db
            .prepare(
              `SELECT count(e.chunk_id) AS remaining
               FROM chunks c
               JOIN documents d ON d.id = c.document_id
               JOIN chunk_embeddings e ON e.chunk_id = c.id
               WHERE c.document_id = ?
                 AND (c.chunk_set_id IS NULL OR c.chunk_set_id = d.active_chunk_set_id)
                 AND (? IS NULL OR e.space_id = ?)`,
            )
            .get(docId, modelToCheck, modelToCheck) as { remaining: number } | undefined
          const remainingVectors = remainingVectorsRow?.remaining ?? 0

          let newStatus = doc.status
          let newModel = doc.embedding_model

          if (remainingVectors < totalChunks) {
            newStatus = totalChunks > 0 ? 'text-only' : 'empty'
            if (remainingVectors === 0) {
              newModel = null
            }
            requeuedCount++
          } else if (doc.status !== 'ready' && remainingVectors === totalChunks && totalChunks > 0) {
            newStatus = 'ready'
          }

          this.db
            .prepare(
              `UPDATE documents
               SET status = ?,
                   chunk_done = ?,
                   embedding_model = ?,
                   chunk_total = ?,
                   error = NULL,
                   updated_at = unixepoch()
               WHERE id = ?`,
            )
            .run(newStatus, remainingVectors, newModel, totalChunks, docId)
        }
      }

      // 5. Mark ANN index dirty for affected spaces
      for (const spaceId of affectedSpaceIds) {
        try {
          this.db
            .prepare(
              `INSERT INTO ann_indexes (space_id, generation, desired_generation, indexed_count, state, updated_at)
               VALUES (?, 0, 1, 0, 'dirty', unixepoch())
               ON CONFLICT(space_id)
               DO UPDATE SET
                 desired_generation = desired_generation + 1,
                 state = 'dirty',
                 updated_at = unixepoch()`,
            )
            .run(spaceId)
        } catch {}
      }

      this.db.exec('COMMIT')

      if (notifyDirty) {
        for (const spaceId of affectedSpaceIds) {
          notifyDirty(spaceId)
        }
      }

      return {
        ok: true,
        repairedSpaces: Array.from(repairedSpacesSet),
        deletedEmbeddings: invalidRows.length,
        deletedCount: invalidRows.length,
        affectedDocuments: affectedDocIds.size,
        requeuedDocuments: requeuedCount,
      }
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }
}
