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
export interface DocumentChunkProgress {
  document: StoredDocument | null
  completedChunks: number
  totalChunks: number
}
export interface FolderChunkProgress {
  totalFiles: number
  readyFiles: number
  pendingFiles: number
  errorFiles: number
  completedChunks: number
  totalChunks: number
  partialFileProgress: number
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
  last_opened_at INTEGER NOT NULL DEFAULT 0,
  priority_at INTEGER NOT NULL DEFAULT 0,
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
CREATE INDEX IF NOT EXISTS chunks_vector_lookup ON chunks(vector_dim, document_id) WHERE vector IS NOT NULL;
CREATE INDEX IF NOT EXISTS documents_excluded_status ON documents(excluded, status);
`

/** Bound semantic work on large stores; weak results widen the scan to protect recall. */
export const SEMANTIC_RECENT_SCAN = 12_000
export const SEMANTIC_WIDE_SCAN = 48_000
export const SEMANTIC_FULL_SCAN_THRESHOLD = 15_000
export const SEMANTIC_RELEVANCE_THRESHOLD = 0.82
export const SEMANTIC_RELEVANCE_MARGIN = 0.12
export const SEMANTIC_RECENT_DOCUMENTS = 1_024
export const SEMANTIC_WIDE_DOCUMENTS = 4_096
export interface DocumentMemorySearchOptions {
  semanticRecentScan?: number
  semanticWideScan?: number
  semanticFullScanThreshold?: number
  semanticRelevanceThreshold?: number
  semanticRecentDocuments?: number
  semanticWideDocuments?: number
}

/** Durable memory for explicitly opened documents. Only enrolled documents are searchable. */
export class DocumentMemoryStore {
  private readonly db: DatabaseSync
  private readonly searchOptions: Required<DocumentMemorySearchOptions>

  constructor(dbPath: string, options: DocumentMemorySearchOptions = {}) {
    this.searchOptions = {
      semanticRecentScan: options.semanticRecentScan ?? SEMANTIC_RECENT_SCAN,
      semanticWideScan: options.semanticWideScan ?? SEMANTIC_WIDE_SCAN,
      semanticFullScanThreshold: options.semanticFullScanThreshold ?? SEMANTIC_FULL_SCAN_THRESHOLD,
      semanticRelevanceThreshold:
        options.semanticRelevanceThreshold ?? SEMANTIC_RELEVANCE_THRESHOLD,
      semanticRecentDocuments: options.semanticRecentDocuments ?? SEMANTIC_RECENT_DOCUMENTS,
      semanticWideDocuments: options.semanticWideDocuments ?? SEMANTIC_WIDE_DOCUMENTS,
    }
    this.db = new DatabaseSync(dbPath)
    this.db.exec(
      'PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;',
    )
    this.db.exec(SCHEMA)
    // Older databases predate explicit open timestamps. Preserve all existing rows and vectors.
    const columns = this.db.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'last_opened_at'))
      this.db.exec('ALTER TABLE documents ADD COLUMN last_opened_at INTEGER NOT NULL DEFAULT 0')
    if (!columns.some((column) => column.name === 'priority_at')) {
      this.db.exec('ALTER TABLE documents ADD COLUMN priority_at INTEGER NOT NULL DEFAULT 0')
      this.db.exec(`UPDATE documents SET priority_at = max(last_opened_at,
        coalesce(mtime_ms, 0))`)
    }
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS documents_priority ON documents(excluded, priority_at DESC)',
    )
    try {
      chmodSync(resolve(dbPath), 0o600)
    } catch {
      // Some filesystems and in-memory databases do not support chmod.
    }
  }

  remember(path: string): void {
    const normalizedPath = resolve(path)
    const openedAt = Date.now()
    this.db
      .prepare(
        `INSERT INTO documents(path, name, status, last_opened_at, priority_at) VALUES (?, ?, 'pending', ?, ?)
      ON CONFLICT(path) DO UPDATE SET name = excluded.name,
        last_opened_at = CASE WHEN documents.excluded = 0 THEN excluded.last_opened_at ELSE documents.last_opened_at END,
        priority_at = CASE WHEN documents.excluded = 0 THEN max(excluded.priority_at, coalesce(documents.mtime_ms, 0)) ELSE documents.priority_at END`,
      )
      .run(normalizedPath, basename(normalizedPath), openedAt, openedAt)
  }

  /** Enroll a file found by a folder scan without making it look recently opened. */
  enrollDiscovered(path: string, mtimeMs: number, sizeBytes: number): boolean {
    const normalizedPath = resolve(path)
    this.db
      .prepare(
        `INSERT INTO documents(path, name, status, last_opened_at, priority_at)
         VALUES (?, ?, 'pending', 0, ?)
         ON CONFLICT(path) DO NOTHING`,
      )
      .run(normalizedPath, basename(normalizedPath), mtimeMs)
    const document = this.documentByPath(normalizedPath)
    if (!document || document.status === 'excluded') return false
    // Existing rows keep their original opened time and indexed metadata. Only a new
    // row or a file whose source metadata changed needs work from the extractor.
    return (
      document.mtimeMs === null ||
      document.mtimeMs !== mtimeMs ||
      document.sizeBytes !== sizeBytes ||
      document.status === 'pending'
    )
  }

  private ensureDocument(path: string): void {
    this.db
      .prepare(
        `INSERT INTO documents(path, name, status) VALUES (?, ?, 'pending') ON CONFLICT(path) DO NOTHING`,
      )
      .run(path, basename(path))
  }

  listDocuments(): StoredDocument[] {
    return (
      this.db
        .prepare(
          `SELECT id, path, name, status, mtime_ms, size_bytes, hash, error
      FROM documents ORDER BY priority_at DESC, id DESC`,
        )
        .all() as unknown as DocRow[]
    ).map(toDocument)
  }

  recentDocuments(limit = 20): StoredDocument[] {
    return (
      this.db
        .prepare(
          `SELECT id, path, name, status, mtime_ms, size_bytes, hash, error
      FROM documents WHERE excluded = 0 ORDER BY priority_at DESC, id DESC LIMIT ?`,
        )
        .all(limit) as unknown as DocRow[]
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

  /** Read one document's persisted vector counts without loading its chunks or vectors. */
  chunkProgress(path: string): DocumentChunkProgress {
    const row = this.db
      .prepare(
        `SELECT d.id, d.path, d.name, d.status, d.mtime_ms, d.size_bytes, d.hash, d.error,
          count(c.id) AS total_chunks,
          sum(CASE WHEN c.vector IS NOT NULL THEN 1 ELSE 0 END) AS completed_chunks
        FROM documents d LEFT JOIN chunks c ON c.document_id = d.id
        WHERE d.path = ? GROUP BY d.id`,
      )
      .get(resolve(path)) as
      (DocRow & { total_chunks: number; completed_chunks: number | null }) | undefined
    return {
      document: row ? toDocument(row) : null,
      completedChunks: row?.completed_chunks ?? 0,
      totalChunks: row?.total_chunks ?? 0,
    }
  }

  /** Aggregate enrolled documents below a selected root with one bounded SQL query. */
  folderChunkProgress(root: string): FolderChunkProgress {
    const normalized = resolve(root)
    const prefix =
      normalized.endsWith('/') || normalized.endsWith('\\')
        ? normalized
        : `${normalized}${normalized.includes('\\') ? '\\' : '/'}`
    const row = this.db
      .prepare(
        `WITH per_document AS (
          SELECT d.id, d.status, count(c.id) AS total_chunks,
            coalesce(sum(CASE WHEN c.vector IS NOT NULL THEN 1 ELSE 0 END), 0) AS completed_chunks
          FROM documents d LEFT JOIN chunks c ON c.document_id = d.id
          WHERE d.excluded = 0 AND (d.path = ? OR substr(d.path, 1, length(?)) = ?)
          GROUP BY d.id
        )
        SELECT count(*) AS total_files,
          sum(CASE WHEN status IN ('ready', 'empty') THEN 1 ELSE 0 END) AS ready_files,
          sum(CASE WHEN status IN ('pending', 'text-only') THEN 1 ELSE 0 END) AS pending_files,
          sum(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_files,
          coalesce(sum(completed_chunks), 0) AS completed_chunks,
          coalesce(sum(total_chunks), 0) AS total_chunks,
          coalesce(sum(CASE WHEN status IN ('ready','empty') THEN 1.0
            WHEN status = 'text-only' AND total_chunks > 0
              THEN (completed_chunks * 1.0 / total_chunks)
            ELSE 0.0 END), 0.0) AS partial_file_progress
        FROM per_document`,
      )
      .get(normalized, prefix, prefix) as
      | {
          total_files: number
          ready_files: number
          pending_files: number
          error_files: number
          completed_chunks: number
          total_chunks: number
          partial_file_progress: number
        }
      | undefined
    return {
      totalFiles: row?.total_files ?? 0,
      readyFiles: row?.ready_files ?? 0,
      pendingFiles: row?.pending_files ?? 0,
      errorFiles: row?.error_files ?? 0,
      completedChunks: row?.completed_chunks ?? 0,
      totalChunks: row?.total_chunks ?? 0,
      partialFileProgress: row?.partial_file_progress ?? 0,
    }
  }

  documentPriority(path: string): number {
    const row = this.db
      .prepare('SELECT priority_at FROM documents WHERE path = ?')
      .get(resolve(path)) as { priority_at: number } | undefined
    return row?.priority_at ?? 0
  }

  listPaths(): string[] {
    return (
      this.db
        .prepare(
          `SELECT path FROM documents WHERE excluded = 0
          ORDER BY priority_at DESC, id DESC`,
        )
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
      this.ensureDocument(normalizedPath)
      const row = this.db
        .prepare('SELECT id, excluded FROM documents WHERE path = ?')
        .get(normalizedPath) as { id: number; excluded: number }
      if (row.excluded) throw new Error('Excluded document cannot be indexed')
      this.deleteChunks(row.id)
      this.db
        .prepare(
          `UPDATE documents SET name = ?, status = ?, mtime_ms = ?, priority_at = max(last_opened_at, ?), size_bytes = ?, hash = ?,
        embedding_model = ?, error = ?, excluded = 0, updated_at = unixepoch() WHERE id = ?`,
        )
        .run(
          basename(normalizedPath),
          replacement.status,
          replacement.mtimeMs,
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
      this.ensureDocument(p)
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
      let rank = 0
      let previousRank: number | undefined
      rows.forEach((row, index) => {
        if (previousRank !== row.rank) rank = index + 1
        lexical.set(row.chunk_id, rank)
        previousRank = row.rank
      })
    }

    const semantic = new Map<number, number>()
    if (vector?.length) {
      const docsQuery = this.db.prepare(
        `SELECT d.id, d.priority_at FROM documents d WHERE d.excluded = 0 AND EXISTS (
          SELECT 1 FROM chunks c WHERE c.document_id = d.id AND c.vector IS NOT NULL AND c.vector_dim = ?
        ) AND (? IS NULL OR d.embedding_model = ?)
        ORDER BY d.priority_at DESC, d.id DESC LIMIT ?`,
      )
      const chunksQuery = this.db.prepare(`SELECT c.id, c.vector, c.vector_dim FROM chunks c
        WHERE c.document_id = ? AND c.vector IS NOT NULL AND c.vector_dim = ?`)
      const vectorCount = (
        this.db
          .prepare(
            `SELECT count(*) AS count FROM chunks c JOIN documents d ON d.id = c.document_id
            WHERE d.excluded = 0 AND c.vector IS NOT NULL AND c.vector_dim = ?
              AND (? IS NULL OR d.embedding_model = ?)`,
          )
          .get(vector.length, embeddingModel ?? null, embeddingModel ?? null) as { count: number }
      ).count
      const vectorDocumentCount = (
        this.db
          .prepare(
            `SELECT count(DISTINCT d.id) AS count FROM chunks c JOIN documents d ON d.id = c.document_id
            WHERE d.excluded = 0 AND c.vector IS NOT NULL AND c.vector_dim = ?
              AND (? IS NULL OR d.embedding_model = ?)`,
          )
          .get(vector.length, embeddingModel ?? null, embeddingModel ?? null) as { count: number }
      ).count
      const scanLimit =
        vectorCount <= this.searchOptions.semanticFullScanThreshold
          ? vectorCount
          : this.searchOptions.semanticRecentScan
      const scan = (maxRows: number, maxDocuments: number) => {
        function* scoredRows() {
          let scanned = 0
          let documentRank = 0
          const docs = docsQuery.iterate(
            vector!.length,
            embeddingModel ?? null,
            embeddingModel ?? null,
            maxDocuments,
          ) as Iterable<{ id: number; priority_at: number }>
          for (const doc of docs) {
            documentRank++
            const rows = chunksQuery.iterate(doc.id, vector!.length) as Iterable<{
              id: number
              vector: Uint8Array
              vector_dim: number
            }>
            for (const row of rows) {
              const score = cosine(vector!, blobVector(row.vector, row.vector_dim))
              // Preserve equal semantic scores in the top-200 heap by recent document order.
              yield { id: row.id, score: score + 1e-8 / documentRank, cosineScore: score }
              if (++scanned >= maxRows) return
            }
          }
        }
        return topVectors(scoredRows(), 200)
      }
      let best = scan(
        scanLimit,
        vectorCount <= this.searchOptions.semanticFullScanThreshold
          ? Number.MAX_SAFE_INTEGER
          : this.searchOptions.semanticRecentDocuments,
      )
      let semanticRelevance = best[0] ? best[0].cosineScore : Number.NEGATIVE_INFINITY
      const informativeTokens = tokens.filter((token) => token.length >= 4 || /^\d+$/.test(token))
      const strongLexical =
        informativeTokens.length > 0
          ? !!this.db
              .prepare(
                `SELECT 1 FROM chunk_fts f JOIN chunks c ON c.id = f.rowid
          JOIN documents d ON d.id = c.document_id
          WHERE chunk_fts MATCH ? AND d.excluded = 0 LIMIT 1`,
              )
              .get(informativeTokens.map(quoteFtsToken).join(' AND '))
          : false
      const margin =
        best.length > 1 ? semanticRelevance - best[1]!.cosineScore : Number.NEGATIVE_INFINITY
      const enoughEvidence =
        strongLexical ||
        (semanticRelevance >= this.searchOptions.semanticRelevanceThreshold &&
          margin >= SEMANTIC_RELEVANCE_MARGIN)
      if (vectorCount > this.searchOptions.semanticFullScanThreshold && !enoughEvidence) {
        best = scan(
          Math.min(vectorCount, this.searchOptions.semanticWideScan),
          this.searchOptions.semanticWideDocuments,
        )
        semanticRelevance = best[0] ? best[0].cosineScore : Number.NEGATIVE_INFINITY
        const wideMargin =
          best.length > 1 ? semanticRelevance - best[1]!.cosineScore : Number.NEGATIVE_INFINITY
        if (
          !strongLexical &&
          (semanticRelevance < this.searchOptions.semanticRelevanceThreshold ||
            wideMargin < SEMANTIC_RELEVANCE_MARGIN) &&
          (vectorCount > this.searchOptions.semanticWideScan ||
            vectorDocumentCount > this.searchOptions.semanticWideDocuments)
        )
          best = scan(vectorCount, Number.MAX_SAFE_INTEGER)
      }
      let semanticRank = 0
      let previousScore: number | undefined
      best.forEach((row, index) => {
        const score = row.cosineScore
        if (previousScore !== score) semanticRank = index + 1
        semantic.set(row.id, semanticRank)
        previousScore = score
      })
    }

    const scores = new Map<number, number>()
    for (const [id, rank] of lexical) scores.set(id, (scores.get(id) ?? 0) + 2 / (60 + rank))
    for (const [id, rank] of semantic) scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + rank))
    const recency = new Map<number, number>()
    if (scores.size) {
      const placeholders = [...scores.keys()].map(() => '?').join(',')
      const rows = this.db
        .prepare(
          `SELECT c.id, max(d.last_opened_at, coalesce(d.mtime_ms, 0)) AS recent
          FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id IN (${placeholders})`,
        )
        .all(...scores.keys()) as Array<{ id: number; recent: number }>
      const now = Date.now()
      for (const row of rows) {
        const age = Math.max(0, now - row.recent)
        // At most 0.00002: enough to settle near-ties, never enough to eclipse a strong match.
        recency.set(row.id, Math.max(0, 1 - age / (90 * 24 * 60 * 60 * 1000)) * 0.00002)
      }
    }
    const ids = [...scores]
      .sort((a, b) => b[1] + (recency.get(b[0]) ?? 0) - (a[1] + (recency.get(a[0]) ?? 0)))
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
              score: scores.get(id)! + (recency.get(id) ?? 0),
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
