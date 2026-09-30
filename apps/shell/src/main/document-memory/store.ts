import { topVectors } from './top-vectors'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { documentSearchTokens, normalizeDocumentText, queryTokens } from './normalization'

export type DocumentStatus = 'pending' | 'ready' | 'text-only' | 'empty' | 'error' | 'excluded'
export interface StoredDocument {
  id: number
  path: string
  name: string
  status: DocumentStatus
  mtimeMs: number | null
  sizeBytes: number | null
  hash: string | null
  error: string | null
}
export interface ReplacementDocument {
  hash: string
  mtimeMs: number
  sizeBytes: number
  chunks: Array<{ text: string; location: string; vector?: number[] }>
  embeddingModel: string | null
  status: 'ready' | 'text-only' | 'empty' | 'error'
  error?: string
}
export interface DocumentMemoryHit {
  documentId: number
  path: string
  name: string
  chunkId: number
  text: string
  location: string
  score: number
  hash: string | null
  mtimeMs: number | null
  sizeBytes: number | null
}
export interface DocumentMemoryStats {
  docs: number
  chunks: number
  vectors: number
  errors: number
}

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  mtime_ms REAL,
  size_bytes INTEGER,
  hash TEXT,
  embedding_model TEXT,
  error TEXT,
  excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  normalized TEXT NOT NULL,
  location TEXT NOT NULL,
  vector BLOB,
  vector_dim INTEGER,
  UNIQUE(document_id, ordinal),
  CHECK ((vector IS NULL AND vector_dim IS NULL) OR (vector IS NOT NULL AND vector_dim > 0))
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(text, tokenize='unicode61 remove_diacritics 2');
CREATE INDEX IF NOT EXISTS chunks_document_id ON chunks(document_id);
CREATE INDEX IF NOT EXISTS documents_excluded_status ON documents(excluded, status);
`

/** Durable memory for explicitly opened documents. Only enrolled documents are searchable. */
export class DocumentMemoryStore {
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath)
    this.db.exec(
      'PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;',
    )
    this.db.exec(SCHEMA)
    try {
      chmodSync(resolve(dbPath), 0o600)
    } catch {
      // Some filesystems and in-memory databases do not support chmod.
    }
  }

  remember(path: string): void {
    const normalizedPath = resolve(path)
    this.db
      .prepare(
        `INSERT INTO documents(path, name, status) VALUES (?, ?, 'pending')
      ON CONFLICT(path) DO UPDATE SET name = excluded.name, updated_at = CASE WHEN documents.excluded = 0 THEN unixepoch() ELSE documents.updated_at END`,
      )
      .run(normalizedPath, basename(normalizedPath))
  }

  listDocuments(): StoredDocument[] {
    return (
      this.db
        .prepare(
          `SELECT id, path, name, status, mtime_ms, size_bytes, hash, error
      FROM documents ORDER BY updated_at DESC, id DESC`,
        )
        .all() as unknown as DocRow[]
    ).map(toDocument)
  }

  documentByPath(path: string): StoredDocument | null {
    const row = this.db
      .prepare(
        `SELECT id, path, name, status, mtime_ms, size_bytes, hash, error
      FROM documents WHERE path = ?`,
      )
      .get(resolve(path)) as DocRow | undefined
    return row ? toDocument(row) : null
  }

  documentById(id: number): StoredDocument | null {
    const row = this.db
      .prepare(
        `SELECT id, path, name, status, mtime_ms, size_bytes, hash, error
      FROM documents WHERE id = ?`,
      )
      .get(id) as DocRow | undefined
    return row ? toDocument(row) : null
  }

  listPaths(): string[] {
    return (
      this.db
        .prepare('SELECT path FROM documents WHERE excluded = 0 ORDER BY path')
        .all() as Array<{ path: string }>
    ).map((r) => r.path)
  }

  replaceDocument(path: string, replacement: ReplacementDocument): void {
    const normalizedPath = resolve(path)
    validateReplacement(replacement)
    const vectors = replacement.chunks.map((chunk) => chunk.vector)
    const dimensions = new Set(vectors.filter((v): v is number[] => !!v).map((v) => v.length))
    if (dimensions.size > 1) throw new Error('Document vectors must have a consistent dimension')
    if (vectors.some((v) => v && v.some((n) => !Number.isFinite(n))))
      throw new Error('Document vectors must contain only finite numbers')

    this.transaction(() => {
      this.remember(normalizedPath)
      const row = this.db
        .prepare('SELECT id, excluded FROM documents WHERE path = ?')
        .get(normalizedPath) as { id: number; excluded: number }
      if (row.excluded) throw new Error('Excluded document cannot be indexed')
      this.deleteChunks(row.id)
      this.db
        .prepare(
          `UPDATE documents SET name = ?, status = ?, mtime_ms = ?, size_bytes = ?, hash = ?,
        embedding_model = ?, error = ?, excluded = 0, updated_at = unixepoch() WHERE id = ?`,
        )
        .run(
          basename(normalizedPath),
          replacement.status,
          replacement.mtimeMs,
          replacement.sizeBytes,
          replacement.hash,
          replacement.embeddingModel,
          replacement.error ?? null,
          row.id,
        )
      const addChunk = this.db
        .prepare(`INSERT INTO chunks(document_id, ordinal, text, normalized, location, vector, vector_dim)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      const addFts = this.db.prepare('INSERT INTO chunk_fts(rowid, text) VALUES (?, ?)')
      replacement.chunks.forEach((chunk, ordinal) => {
        const vec = chunk.vector ? floatBlob(chunk.vector) : null
        const result = addChunk.run(
          row.id,
          ordinal,
          chunk.text,
          normalizeDocumentText(chunk.text),
          chunk.location,
          vec,
          chunk.vector?.length ?? null,
        )
        addFts.run(result.lastInsertRowid, documentSearchTokens(chunk.text).join(' '))
      })
    })
  }

  markError(
    path: string,
    error: string,
    metadata?: { mtimeMs: number; sizeBytes: number } | null,
  ): void {
    const p = resolve(path)
    this.transaction(() => {
      this.remember(p)
      const row = this.db.prepare('SELECT id, excluded FROM documents WHERE path = ?').get(p) as {
        id: number
        excluded: number
      }
      if (row.excluded) return
      this.deleteChunks(row.id)
      this.db
        .prepare(
          `UPDATE documents SET status = 'error', error = ?, hash = NULL, embedding_model = NULL,
        mtime_ms = CASE WHEN ? = 0 THEN mtime_ms ELSE ? END,
        size_bytes = CASE WHEN ? = 0 THEN size_bytes ELSE ? END,
        updated_at = unixepoch() WHERE id = ?`,
        )
        .run(
          error,
          metadata === undefined ? 0 : 1,
          metadata?.mtimeMs ?? null,
          metadata === undefined ? 0 : 1,
          metadata?.sizeBytes ?? null,
          row.id,
        )
    })
  }

  /** Add one embedding batch without replacing chunks or invalidating their IDs. */
  setChunkVectors(
    path: string,
    hash: string,
    offset: number,
    vectors: number[][],
    embeddingModel: string,
    complete: boolean,
  ): void {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid vector offset')
    if (!embeddingModel) throw new Error('Embedding model is required')
    const dimensions = new Set(vectors.map((vector) => vector.length))
    if (
      dimensions.size > 1 ||
      vectors.some((vector) => !vector.length || vector.some((v) => !Number.isFinite(v)))
    )
      throw new Error('Vectors must have a consistent nonzero dimension and finite values')
    const normalizedPath = resolve(path)
    this.transaction(() => {
      const document = this.db
        .prepare('SELECT id, hash, excluded FROM documents WHERE path = ?')
        .get(normalizedPath) as { id: number; hash: string | null; excluded: number } | undefined
      if (!document || document.excluded || document.hash !== hash)
        throw new Error('Document changed before vectors were stored')
      const existing = this.db
        .prepare(
          'SELECT vector_dim FROM chunks WHERE document_id = ? AND vector IS NOT NULL LIMIT 1',
        )
        .get(document.id) as { vector_dim: number } | undefined
      const dimension = vectors[0]?.length ?? existing?.vector_dim
      if (dimension !== undefined && existing && existing.vector_dim !== dimension)
        throw new Error('Vector dimension does not match stored vectors')
      const update = this.db.prepare(
        'UPDATE chunks SET vector = ?, vector_dim = ? WHERE document_id = ? AND ordinal = ?',
      )
      vectors.forEach((vector, index) => {
        const result = update.run(floatBlob(vector), vector.length, document.id, offset + index)
        if (Number(result.changes) !== 1)
          throw new Error('Vector batch does not match indexed chunks')
      })
      const count = this.db
        .prepare(
          'SELECT count(*) AS total, count(vector) AS vectors FROM chunks WHERE document_id = ?',
        )
        .get(document.id) as { total: number; vectors: number }
      if (complete && count.total !== count.vectors)
        throw new Error('Document vector batches are incomplete')
      this.db
        .prepare(
          `UPDATE documents SET embedding_model = ?, status = ?, error = NULL, updated_at = unixepoch()
        WHERE id = ?`,
        )
        .run(embeddingModel, complete ? 'ready' : 'text-only', document.id)
    })
  }

  /** Find a committed embedding checkpoint, retaining chunk IDs and completed vectors. */
  resumeVectorOffset(path: string, hash: string, model: string): number | null {
    const doc = this.db
      .prepare('SELECT id, hash, embedding_model, excluded FROM documents WHERE path = ?')
      .get(resolve(path)) as
      | { id: number; hash: string | null; embedding_model: string | null; excluded: number }
      | undefined
    if (
      !doc ||
      doc.excluded ||
      doc.hash !== hash ||
      (doc.embedding_model && doc.embedding_model !== model)
    )
      return null
    const row = this.db
      .prepare(
        'SELECT min(CASE WHEN vector IS NULL THEN ordinal END) AS missing, count(*) AS total FROM chunks WHERE document_id = ?',
      )
      .get(doc.id) as { missing: number | null; total: number }
    return row.missing ?? row.total
  }

  move(oldPath: string, newPath: string): void {
    const oldResolved = resolve(oldPath)
    const nextResolved = resolve(newPath)
    this.transaction(() => {
      const row = this.db.prepare('SELECT id FROM documents WHERE path = ?').get(oldResolved) as
        { id: number } | undefined
      if (!row) return
      this.db
        .prepare('UPDATE documents SET path = ?, name = ?, updated_at = unixepoch() WHERE id = ?')
        .run(nextResolved, basename(nextResolved), row.id)
    })
  }

  exclude(path: string): void {
    const p = resolve(path)
    this.transaction(() => {
      const row = this.db.prepare('SELECT id FROM documents WHERE path = ?').get(p) as
        { id: number } | undefined
      if (!row) return
      this.deleteChunks(row.id)
      this.db
        .prepare(
          `UPDATE documents SET excluded = 1, status = 'excluded', hash = NULL, embedding_model = NULL,
        error = NULL, updated_at = unixepoch() WHERE id = ?`,
        )
        .run(row.id)
    })
  }

  clear(): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM chunk_fts').run()
      this.db.prepare('DELETE FROM chunks').run()
      this.db.prepare('DELETE FROM documents WHERE excluded = 0').run()
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
    const tokens = queryTokens(query)
    const lexical = new Map<number, number>()
    if (tokens.length) {
      const match = tokens.map(quoteFtsToken).join(' OR ')
      const rows = this.db
        .prepare(
          `SELECT f.rowid AS chunk_id, bm25(chunk_fts) AS rank
        FROM chunk_fts f JOIN chunks c ON c.id = f.rowid JOIN documents d ON d.id = c.document_id
        WHERE chunk_fts MATCH ? AND d.excluded = 0 ORDER BY rank LIMIT 200`,
        )
        .all(match) as Array<{ chunk_id: number; rank: number }>
      rows.forEach((r, i) => lexical.set(r.chunk_id, i + 1))
    }

    const semantic = new Map<number, number>()
    if (vector?.length) {
      const rows = this.db
        .prepare(
          `SELECT c.id, c.vector, c.vector_dim FROM chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE d.excluded = 0 AND c.vector IS NOT NULL AND c.vector_dim = ?
          AND (? IS NULL OR d.embedding_model = ?)`,
        )
        .iterate(vector.length, embeddingModel ?? null, embeddingModel ?? null) as Iterable<{
        id: number
        vector: Uint8Array
        vector_dim: number
      }>
      function* scoredRows() {
        for (const r of rows)
          yield { id: r.id, score: cosine(vector!, blobVector(r.vector, r.vector_dim)) }
      }
      topVectors(scoredRows(), 200).forEach((r, i) => semantic.set(r.id, i + 1))
    }

    const scores = new Map<number, number>()
    for (const [id, rank] of lexical) scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + rank))
    for (const [id, rank] of semantic) scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + rank))
    const ids = [...scores]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(0, limit))
      .map(([id]) => id)
    if (!ids.length) return []
    const get = this.db
      .prepare(`SELECT d.id AS document_id, d.path, d.name, d.hash, d.mtime_ms, d.size_bytes, c.id AS chunk_id, c.text, c.location
      FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.id = ? AND d.excluded = 0`)
    return ids.flatMap((id) => {
      const row = get.get(id) as HitRow | undefined
      return row
        ? [
            {
              documentId: row.document_id,
              path: row.path,
              name: row.name,
              chunkId: row.chunk_id,
              text: row.text,
              location: row.location,
              score: scores.get(id)!,
              hash: row.hash,
              mtimeMs: row.mtime_ms,
              sizeBytes: row.size_bytes,
            },
          ]
        : []
    })
  }

  readChunk(chunkId: number): DocumentMemoryHit | null {
    const row = this.db
      .prepare(
        `SELECT d.id AS document_id, d.path, d.name, d.hash, d.mtime_ms, d.size_bytes, c.id AS chunk_id, c.text, c.location
      FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.id = ? AND d.excluded = 0`,
      )
      .get(chunkId) as HitRow | undefined
    return row
      ? {
          documentId: row.document_id,
          path: row.path,
          name: row.name,
          chunkId: row.chunk_id,
          text: row.text,
          location: row.location,
          score: 0,
          hash: row.hash,
          mtimeMs: row.mtime_ms,
          sizeBytes: row.size_bytes,
        }
      : null
  }

  stats(): DocumentMemoryStats {
    const row = this.db
      .prepare(
        `SELECT
      (SELECT count(*) FROM documents WHERE excluded = 0) AS docs,
      (SELECT count(*) FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.excluded = 0) AS chunks,
      (SELECT count(*) FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.excluded = 0 AND c.vector IS NOT NULL) AS vectors,
      (SELECT count(*) FROM documents WHERE excluded = 0 AND status = 'error') AS errors`,
      )
      .get() as unknown as DocumentMemoryStats
    return row
  }

  close(): void {
    this.db.close()
  }

  private deleteChunks(documentId: number): void {
    const ids = this.db
      .prepare('SELECT id FROM chunks WHERE document_id = ?')
      .all(documentId) as Array<{ id: number }>
    const delFts = this.db.prepare('DELETE FROM chunk_fts WHERE rowid = ?')
    for (const { id } of ids) delFts.run(id)
    this.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId)
  }

  private transaction(work: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      work()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

interface DocRow {
  id: number
  path: string
  name: string
  status: DocumentStatus
  mtime_ms: number | null
  size_bytes: number | null
  hash: string | null
  error: string | null
}
interface HitRow {
  document_id: number
  path: string
  name: string
  hash: string | null
  mtime_ms: number | null
  size_bytes: number | null
  chunk_id: number
  text: string
  location: string
}
function toDocument(row: DocRow): StoredDocument {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    status: row.status,
    mtimeMs: row.mtime_ms,
    sizeBytes: row.size_bytes,
    hash: row.hash,
    error: row.error,
  }
}
function quoteFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`
}
function floatBlob(vector: number[]): Uint8Array {
  const copy = new Float32Array(vector)
  return new Uint8Array(copy.buffer)
}
function blobVector(blob: Uint8Array, dim: number): number[] {
  if (blob.byteLength !== dim * Float32Array.BYTES_PER_ELEMENT) return []
  const copy = blob.slice()
  return Array.from(new Float32Array(copy.buffer, copy.byteOffset, dim))
}
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length || b.some((v) => !Number.isFinite(v))) return Number.NaN
  let dot = 0,
    aa = 0,
    bb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    aa += a[i]! * a[i]!
    bb += b[i]! * b[i]!
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0
}
function validateReplacement(replacement: ReplacementDocument): void {
  if (
    !Number.isFinite(replacement.mtimeMs) ||
    !Number.isFinite(replacement.sizeBytes) ||
    replacement.sizeBytes < 0
  )
    throw new Error('Invalid document metadata')
  if (!replacement.hash) throw new Error('Document hash is required')
  if (replacement.chunks.some((chunk) => !chunk.text.trim() || !chunk.location.trim()))
    throw new Error('Document chunks must contain text and a location')
  if (replacement.chunks.some((chunk) => !!chunk.vector && chunk.vector.length === 0))
    throw new Error('Document vectors cannot be empty')
  if (replacement.chunks.some((chunk) => !!chunk.vector && !replacement.embeddingModel))
    throw new Error('An embedding model is required when vectors are stored')
}
