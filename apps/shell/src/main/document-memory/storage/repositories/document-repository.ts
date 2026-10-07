import type { DatabaseSync } from 'node:sqlite'
import { basename, resolve, sep } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { measureSqlite } from '../../sqlite-timing'
import { activateSet, createBuildingSet } from '../../chunk-sets'
import type { OcrSidecar } from '../../ocr-sidecar'
import type { ChunkRepository } from './chunk-repository'
import type { EmbeddingRepository } from './embedding-repository'

export type DocumentStatus = 'pending' | 'ready' | 'text-only' | 'empty' | 'error' | 'excluded'
export type TruncatedReason =
  | 'chunk-limit'
  | 'content-limit'
  | 'pdf-page-limit'
  | 'tabular-sampling'

export interface StoredDocument {
  id: number
  path: string
  name: string
  status: DocumentStatus
  mtimeMs: number | null
  sizeBytes: number | null
  hash: string | null
  error: string | null
  truncated: boolean
  truncatedReason?: TruncatedReason | null
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
  indexedAt: number | null
  truncated: boolean
  truncatedReason?: TruncatedReason | null
  ocr?: boolean
  contentUnread?: boolean
}

export interface ReplacementDocument {
  hash: string
  mtimeMs: number
  sizeBytes: number
  chunks: Array<{ text: string; location: string; vector?: number[] }>
  embeddingModel: string | null
  status: 'ready' | 'text-only' | 'empty' | 'error'
  error?: string
  truncated?: boolean
  truncatedReason?: TruncatedReason | null
}

export interface SliceOptions {
  yield?: () => Promise<void>
  shouldContinue?: () => boolean
  budgetMs?: number
}

export const WRITE_SLICE_MS = 8

export interface DocRow {
  id: number
  path: string
  name: string
  status: DocumentStatus
  mtime_ms: number | null
  size_bytes: number | null
  hash: string | null
  error: string | null
  truncated: number
  truncated_reason?: string | null
}

export function toDocument(row: DocRow): StoredDocument {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    status: row.status,
    mtimeMs: row.mtime_ms,
    sizeBytes: row.size_bytes,
    hash: row.hash,
    error: row.error,
    truncated: !!row.truncated,
    truncatedReason: (row.truncated_reason as TruncatedReason | undefined) ?? null,
  }
}

export function validateReplacement(replacement: ReplacementDocument): void {
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
  const vectors = replacement.chunks.map((chunk) => chunk.vector)
  const dimensions = new Set(vectors.filter((v): v is number[] => !!v).map((v) => v.length))
  if (dimensions.size > 1) throw new Error('Document vectors must have a consistent dimension')
  if (vectors.some((v) => v && v.some((n) => !Number.isFinite(n))))
    throw new Error('Document vectors must contain only finite numbers')
}

export class DocumentRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly chunkRepo?: ChunkRepository,
    private readonly embRepo?: EmbeddingRepository,
    private readonly getOcr?: () => OcrSidecar,
    private readonly onAnnVectorsAdded?: (spaceId: string, ids: number[], vecs: number[][]) => void,
    private readonly onAnnVectorsRemoved?: (ids: number[]) => void,
  ) {
    try {
      this.db.exec(
        `UPDATE documents SET error = 'No readable text in this file; there is nothing to search'
         WHERE status = 'empty' AND error = 'No readable text; scanned documents need OCR'
           AND lower(path) NOT LIKE '%.pdf'`,
      )
    } catch {}
  }

  ensureDocument(path: string): void {
    this.db
      .prepare(
        `INSERT INTO documents(path, name, status, chunk_counted) VALUES (?, ?, 'pending', 1) ON CONFLICT(path) DO NOTHING`,
      )
      .run(path, basename(path))
  }

  remember(path: string): void {
    const normalizedPath = resolve(path)
    const openedAt = Date.now()
    this.db
      .prepare(
        `INSERT INTO documents(path, name, status, last_opened_at, priority_at, chunk_counted) VALUES (?, ?, 'pending', ?, ?, 1)
      ON CONFLICT(path) DO UPDATE SET name = excluded.name,
        last_opened_at = CASE WHEN documents.excluded = 0 THEN excluded.last_opened_at ELSE documents.last_opened_at END,
        priority_at = CASE WHEN documents.excluded = 0 THEN max(excluded.priority_at, coalesce(documents.mtime_ms, 0)) ELSE documents.priority_at END`,
      )
      .run(normalizedPath, basename(normalizedPath), openedAt, openedAt)
  }

  enrollDiscovered(path: string, mtimeMs: number, sizeBytes: number): boolean {
    const normalizedPath = resolve(path)
    this.db
      .prepare(
        `INSERT INTO documents(path, name, status, last_opened_at, priority_at, chunk_counted)
         VALUES (?, ?, 'pending', 0, ?, 1)
         ON CONFLICT(path) DO NOTHING`,
      )
      .run(normalizedPath, basename(normalizedPath), mtimeMs)
    const document = this.documentByPath(normalizedPath)
    if (!document || document.status === 'excluded') return false
    return (
      document.mtimeMs === null ||
      document.mtimeMs !== mtimeMs ||
      document.sizeBytes !== sizeBytes ||
      document.status === 'pending'
    )
  }

  listDocuments(): StoredDocument[] {
    return (
      this.db
        .prepare(
          `SELECT id, path, name, status, mtime_ms, size_bytes, hash, error, truncated, truncated_reason
      FROM documents ORDER BY priority_at DESC, id DESC`,
        )
        .all() as unknown as DocRow[]
    ).map(toDocument)
  }

  recentDocuments(limit = 20): StoredDocument[] {
    return (
      this.db
        .prepare(
          `SELECT id, path, name, status, mtime_ms, size_bytes, hash, error, truncated, truncated_reason
      FROM documents WHERE excluded = 0 ORDER BY priority_at DESC, id DESC LIMIT ?`,
        )
        .all(limit) as unknown as DocRow[]
    ).map(toDocument)
  }

  documentByPath(path: string): StoredDocument | null {
    const row = this.db
      .prepare(
        `SELECT id, path, name, status, mtime_ms, size_bytes, hash, error, truncated, truncated_reason
      FROM documents WHERE path = ?`,
      )
      .get(resolve(path)) as DocRow | undefined
    return row ? toDocument(row) : null
  }

  documentById(id: number): StoredDocument | null {
    const row = this.db
      .prepare(
        `SELECT id, path, name, status, mtime_ms, size_bytes, hash, error, truncated, truncated_reason
      FROM documents WHERE id = ?`,
      )
      .get(id) as DocRow | undefined
    return row ? toDocument(row) : null
  }

  documentPriority(path: string): number {
    const row = this.db
      .prepare('SELECT priority_at FROM documents WHERE path = ?')
      .get(resolve(path)) as { priority_at: number } | undefined
    return row?.priority_at ?? 0
  }

  boostFolder(root: string, at: number): void {
    const prefix = root.endsWith(sep) ? root : root + sep
    this.db
      .prepare(
        "UPDATE documents SET priority_at = ? WHERE excluded = 0 AND status = 'pending' AND substr(path, 1, ?) = ?",
      )
      .run(at, prefix.length, prefix)
  }

  touchMetadata(path: string, mtimeMs: number, sizeBytes: number): void {
    this.db
      .prepare('UPDATE documents SET mtime_ms = ?, size_bytes = ? WHERE path = ? AND excluded = 0')
      .run(mtimeMs, sizeBytes, resolve(path))
  }

  markPending(documentId: number): void {
    this.db
      .prepare(
        `UPDATE documents SET status = 'pending', hash = NULL, embedding_model = NULL, error = NULL
        WHERE id = ?`,
      )
      .run(documentId)
  }

  applyError(
    id: number,
    error: string,
    metadata?: { mtimeMs: number; sizeBytes: number } | null,
  ): void {
    this.db
      .prepare(
        `UPDATE documents SET status = 'error', error = ?, hash = NULL, embedding_model = NULL, truncated = 0, truncated_reason = NULL,
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
        id,
      )
  }

  lockDocumentForReplace(normalizedPath: string): { id: number } {
    this.ensureDocument(normalizedPath)
    const row = this.db
      .prepare('SELECT id, excluded FROM documents WHERE path = ?')
      .get(normalizedPath) as { id: number; excluded: number }
    if (row.excluded) throw new Error('Excluded document cannot be indexed')
    return row
  }

  updateReplacedDocument(
    id: number,
    normalizedPath: string,
    replacement: ReplacementDocument,
  ): void {
    this.db
      .prepare(
        `UPDATE documents SET name = ?, status = ?, mtime_ms = ?, priority_at = max(last_opened_at, ?), size_bytes = ?, hash = ?,
        embedding_model = ?, error = ?, truncated = ?, truncated_reason = ?, excluded = 0, updated_at = unixepoch() WHERE id = ?`,
      )
      .run(
        basename(normalizedPath),
        replacement.status,
        replacement.mtimeMs,
        replacement.mtimeMs,
        replacement.sizeBytes ?? null,
        replacement.hash ?? null,
        replacement.embeddingModel ?? null,
        replacement.error ?? null,
        replacement.truncated ? 1 : 0,
        replacement.truncated ? (replacement.truncatedReason ?? null) : null,
        id,
      )
  }

  requeueNowReadable(): number {
    const result = this.db
      .prepare(
        "UPDATE documents SET status = 'pending', error = NULL WHERE status = 'error' AND excluded = 0 AND error = 'Unsupported file type: .xls'",
      )
      .run()
    return Number(result.changes)
  }

  retryDocument(id: number): string | null {
    const document = this.documentById(id)
    if (!document || document.status === 'excluded') return null
    if (document.status === 'error' || document.status === 'empty')
      this.db
        .prepare(
          "UPDATE documents SET status = 'pending', error = NULL WHERE id = ? AND excluded = 0",
        )
        .run(id)
    return document.path
  }

  markOcrPending(path: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE documents SET status = 'pending', error = NULL, updated_at = unixepoch() WHERE path = ? AND excluded = 0",
      )
      .run(resolve(path))
    return Number(result.changes) > 0
  }

  requeueForEmbeddingModel(current: string): number {
    const result = this.db
      .prepare(
        `UPDATE documents SET status = 'pending', hash = NULL, embedding_model = NULL, error = NULL
        WHERE excluded = 0 AND embedding_model IS NOT NULL AND embedding_model <> ?`,
      )
      .run(current)
    return Number(result.changes)
  }

  requeueTruncatedPdfs(): number {
    const result = this.db
      .prepare(
        `UPDATE documents SET status = 'pending', hash = NULL, embedding_model = NULL, error = NULL
        WHERE excluded = 0 AND truncated = 1 AND lower(path) LIKE '%.pdf'`,
      )
      .run()
    return Number(result.changes)
  }

  legacyPaths(extensions: readonly string[], limit: number): string[] {
    if (extensions.length === 0) return []
    const clauses = extensions.map(() => 'lower(path) LIKE ?').join(' OR ')
    return (
      this.db
        .prepare(
          `SELECT path FROM documents WHERE excluded = 0 AND (${clauses})
          ORDER BY priority_at DESC, id DESC LIMIT ?`,
        )
        .all(...extensions.map((e) => `%${e}`), limit) as Array<{ path: string }>
    ).map((r) => r.path)
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

  documentsUnder(root: string): StoredDocument[] {
    const normalized = resolve(root)
    const prefix = normalized + (normalized.includes('\\') ? '\\' : '/')
    return (
      this.db
        .prepare(
          `SELECT id, path, name, status, mtime_ms, size_bytes, hash, error, truncated, truncated_reason
          FROM documents WHERE excluded = 0 AND (path = ? OR substr(path, 1, length(?)) = ?)`,
        )
        .all(normalized, prefix, prefix) as unknown as DocRow[]
    ).map(toDocument)
  }

  incompletePaths(): string[] {
    return (
      this.db
        .prepare(
          `SELECT path FROM documents WHERE excluded = 0 AND status IN ('pending', 'text-only')
          ORDER BY priority_at DESC, id DESC`,
        )
        .all() as Array<{ path: string }>
    ).map((r) => r.path)
  }

  documentsUnderPage(root: string, afterId: number, limit: number): StoredDocument[] {
    const normalized = resolve(root)
    const prefix = normalized + (normalized.includes('\\') ? '\\' : '/')
    return (
      this.db
        .prepare(
          `SELECT id, path, name, status, mtime_ms, size_bytes, hash, error, truncated, truncated_reason
          FROM documents WHERE excluded = 0 AND id > ? AND (path = ? OR substr(path, 1, length(?)) = ?)
          ORDER BY id LIMIT ?`,
        )
        .all(afterId, normalized, prefix, prefix, limit) as unknown as DocRow[]
    ).map(toDocument)
  }

  openedPaths(limit: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT path FROM documents WHERE excluded = 0 AND last_opened_at > 0
          ORDER BY last_opened_at DESC LIMIT ?`,
        )
        .all(limit) as Array<{ path: string }>
    ).map((r) => r.path)
  }

  errorCount(): number {
    return (
      this.db
        .prepare("SELECT count(*) AS n FROM documents WHERE excluded = 0 AND status = 'error'")
        .get() as { n: number }
    ).n
  }

  replaceDocument(path: string, replacement: ReplacementDocument): void {
    validateReplacement(replacement)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.lockDocumentForReplace(path)
      const chunkSetId = createBuildingSet(this.db, row.id, 2)
      this.updateReplacedDocument(row.id, path, replacement)
      const insert = this.chunkRepo!.chunkInserter(
        row.id,
        replacement.embeddingModel,
        chunkSetId,
        (cId, vec) => {
          if (replacement.embeddingModel) {
            this.onAnnVectorsAdded?.(replacement.embeddingModel, [cId], [vec])
          }
        },
      )
      for (let i = 0; i < replacement.chunks.length; i++) {
        insert(replacement.chunks[i]!, i)
      }
      activateSet(this.db, row.id, chunkSetId)
      this.chunkRepo!.deleteOldChunksForDocument(row.id, chunkSetId, (ids) =>
        this.onAnnVectorsRemoved?.(ids),
      )
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  async replaceDocumentSliced(
    path: string,
    replacement: ReplacementDocument,
    options: SliceOptions = {},
  ): Promise<boolean> {
    validateReplacement(replacement)
    let next = 0
    let first = true
    let documentId = 0
    let chunkSetId = 0
    let insert: ReturnType<ChunkRepository['chunkInserter']> | null = null

    return this.runSliced(
      options,
      (outOfBudget) => {
        if (first) {
          documentId = this.lockDocumentForReplace(path).id
          chunkSetId = createBuildingSet(this.db, documentId, 2)
          first = false
        } else {
          const row = this.db.prepare('SELECT excluded FROM documents WHERE id = ?').get(documentId) as { excluded: number } | undefined
          if (!row || row.excluded) return 'abort'
        }
        insert ??= this.chunkRepo!.chunkInserter(
          documentId,
          replacement.embeddingModel,
          chunkSetId,
          (cId, vec) => {
            if (replacement.embeddingModel) {
              this.onAnnVectorsAdded?.(replacement.embeddingModel, [cId], [vec])
            }
          },
        )
        while (next < replacement.chunks.length) {
          const chunk = replacement.chunks[next]!
          insert(chunk, next)
          next++
          if (next < replacement.chunks.length && outOfBudget()) return 'more'
        }
        this.updateReplacedDocument(documentId, path, replacement)
        activateSet(this.db, documentId, chunkSetId)
        this.chunkRepo!.deleteOldChunksForDocument(documentId, chunkSetId, (ids) =>
          this.onAnnVectorsRemoved?.(ids),
        )
        return 'done'
      },
      () => this.markPending(documentId),
      'replace slice',
    )
  }

  markError(path: string, error: string, metadata?: { mtimeMs: number; sizeBytes: number } | null): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.ensureDocument(path)
      const doc = this.documentByPath(path)
      if (!doc || doc.status === 'excluded') {
        this.db.exec('COMMIT')
        return
      }
      this.chunkRepo!.deleteChunks(doc.id, (ids) => this.onAnnVectorsRemoved?.(ids))
      this.applyError(doc.id, error, metadata)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  async markErrorSliced(
    path: string,
    error: string,
    metadata?: { mtimeMs: number; sizeBytes: number } | null,
    options: SliceOptions = {},
  ): Promise<boolean> {
    let documentId = 0
    let first = true
    return this.runSliced(
      options,
      (outOfBudget) => {
        if (first) {
          this.ensureDocument(path)
          first = false
        }
        const doc = documentId ? this.documentById(documentId) : this.documentByPath(path)
        if (!doc || doc.status === 'excluded') return 'abort'
        documentId = doc.id
        if (!this.chunkRepo!.deleteChunksBudgeted(documentId, outOfBudget, (id) => this.onAnnVectorsRemoved?.([id]))) {
          return 'more'
        }
        this.applyError(documentId, error, metadata)
        return 'done'
      },
      () => this.markPending(documentId),
    )
  }

  tombstone(path: string): boolean {
    let removed = false
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const doc = this.documentByPath(path)
      if (!doc || doc.status === 'excluded') {
        this.db.exec('COMMIT')
        return false
      }
      this.chunkRepo!.deleteChunks(doc.id, (ids) => this.onAnnVectorsRemoved?.(ids))
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id)
      this.getOcr?.().remove(path)
      removed = true
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return removed
  }

  async tombstoneSliced(path: string, options: SliceOptions = {}): Promise<boolean> {
    let removed = false
    await this.runSliced(
      options,
      (outOfBudget) => {
        const doc = this.documentByPath(path)
        if (!doc || doc.status === 'excluded') return 'done'
        if (!this.chunkRepo!.deleteChunksBudgeted(doc.id, outOfBudget, (id) => this.onAnnVectorsRemoved?.([id]))) {
          return 'more'
        }
        this.db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id)
        this.getOcr?.().remove(path)
        removed = true
        return 'done'
      },
      undefined,
      'tombstone slice',
    )
    return removed
  }

  purgeDiscoveredByName(isIgnored: (name: string) => boolean): number {
    let removed = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const rows = this.db
        .prepare('SELECT id, name FROM documents WHERE last_opened_at = 0')
        .all() as Array<{ id: number; name: string }>
      for (const row of rows) {
        if (!isIgnored(row.name)) continue
        this.chunkRepo!.deleteChunks(row.id, (ids) => this.onAnnVectorsRemoved?.(ids))
        this.db.prepare('DELETE FROM documents WHERE id = ?').run(row.id)
        removed++
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return removed
  }

  private async runSliced(
    options: SliceOptions,
    step: (outOfBudget: () => boolean) => 'done' | 'more' | 'abort',
    onMore?: () => void,
    op = 'slice',
  ): Promise<boolean> {
    const budget = options.budgetMs ?? WRITE_SLICE_MS
    for (;;) {
      if (options.shouldContinue && !options.shouldContinue()) return false
      const started = performance.now()
      let outcome = 'done' as 'done' | 'more' | 'abort'
      this.db.exec('BEGIN IMMEDIATE')
      try {
        outcome = measureSqlite(op, () => step(() => performance.now() - started >= budget))
        if (outcome === 'more') onMore?.()
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
      if (outcome !== 'more') return outcome === 'done'
      await (options.yield ?? yieldToEventLoop)()
      if (options.shouldContinue && !options.shouldContinue()) return false
    }
  }
}
