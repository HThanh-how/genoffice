import type { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'
import { basename, resolve, sep } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { measureSqlite } from '../../sqlite-timing'
import { activateSet, createBuildingSet } from '../../chunk-sets'
import type { OcrSidecar } from '../../ocr-sidecar'
import type { ChunkRepository } from './chunk-repository'
import type { EmbeddingRepository } from './embedding-repository'
import {
  type FileImportanceOverride,
  type FileImportanceSuggestion,
  type FileImportanceEffective,
  type FileImportanceInfo,
  computeEffectiveImportance,
  inferDocumentImportance,
} from '../../document-importance'
import {
  syncProjectionInsert,
  syncProjectionUpdate,
  syncProjectionMove,
  syncProjectionExclude,
  syncProjectionTombstone,
  syncProjectionDelete,
  estimateNewDocumentMetadataBytes,
  estimateDocumentProjectionBytes,
  buildDocumentProjection,
  isProjectionUpToDate,
  getDbProjectionSyncGuard,
} from '../../name-search-projection'
import type { SyncMetadataGuard } from '../../runtime/sync-metadata-admission'
import { hasContentEvictedColumn } from '../migration/cache-retention'
import { clearVectorEvictions, hasVectorEvictionTable, VECTOR_EVICTION_APPLIES_SQL } from '../vector-eviction-marker'
import { mediaKindOfPath } from '../../media/media-kinds'
import { enrollMediaRow, type MediaEnrollResult } from '../../media/media-enrollment'
import { isMediaDocument } from '../../media/media-repository'

export type {
  FileImportanceOverride,
  FileImportanceSuggestion,
  FileImportanceEffective,
  FileImportanceInfo,
}

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
  importanceOverride?: FileImportanceOverride
  importanceSuggestion?: FileImportanceSuggestion
  importanceReason?: string | null
  importanceUpdatedAt?: number
  contentEvicted?: boolean
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

export interface BatchSliceInfo {
  batchIndex: number
  startChunkIndex: number
  chunkCount: number
  estimatedBytes: number
  totalEstimatedRemainingBytes: number
  documentId: number
  path: string
}

export interface BatchCommitInfo {
  batchIndex: number
  committedChunks: number
  committedBytes: number
  remainingChunks: number
  remainingBytes: number
  documentId: number
  path: string
}

export interface BatchHookDecision {
  proceed: boolean
  reason?: string
}

export interface SliceOptions {
  yield?: () => Promise<void>
  shouldContinue?: () => boolean
  budgetMs?: number
  maxBatchBytes?: number
  maxBatchChunks?: number
  beforeBatch?: (info: BatchSliceInfo) => Promise<boolean | BatchHookDecision> | boolean | BatchHookDecision
  postCommit?: (info: BatchCommitInfo) => Promise<void> | void
  estimateChunkBytes?: (chunk: ReplacementDocument['chunks'][number]) => number
}

export const WRITE_SLICE_MS = 8
export const CONTENT_BATCH_DEFAULT_MAX_BYTES = 256 * 1024
export const CONTENT_BATCH_DEFAULT_MAX_CHUNKS = 50
export const MAX_SINGLE_CHUNK_TEXT_CHARS = 32_768
export const BASE_METADATA_WRITE_BYTES = 1024

function defaultEstimateChunkBytes(chunk: { text: string; location?: string; vector?: number[] }): number {
  const textBytes = Buffer.byteLength(chunk.text || '', 'utf8')
  const locBytes = Buffer.byteLength(chunk.location || '', 'utf8')
  const vectorBytes = chunk.vector && Array.isArray(chunk.vector) ? chunk.vector.length * 4 + 64 : 0
  const ftsBytes = Math.ceil(textBytes * 2.0) + 128
  const rowBytes = textBytes + locBytes + vectorBytes + 256 + ftsBytes
  return Math.max(512, Math.ceil(rowBytes * 1.5))
}

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
  importance_override?: string | null
  importance_suggestion?: string | null
  importance_reason?: string | null
  importance_updated_at?: number | null
  content_evicted?: number | null
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
    importanceOverride: (row.importance_override ?? 'auto') as FileImportanceOverride,
    importanceSuggestion: (row.importance_suggestion ?? 'unknown') as FileImportanceSuggestion,
    importanceReason: row.importance_reason ?? null,
    importanceUpdatedAt: (row.importance_updated_at ?? 0) * 1000,
    contentEvicted: row.content_evicted === 1,
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
  private lastAdmissionError: string | undefined

  constructor(
    private readonly db: DatabaseSync,
    private readonly chunkRepo?: ChunkRepository,
    private readonly embRepo?: EmbeddingRepository,
    private readonly getOcr?: () => OcrSidecar,
    private readonly onAnnVectorsAdded?: (spaceId: string, ids: number[], vecs: number[][]) => void,
    private readonly onAnnVectorsRemoved?: (ids: number[]) => void,
    private readonly syncGuard?: SyncMetadataGuard,
  ) {
    try {
      this.db.exec(
        `UPDATE documents SET error = 'No readable text in this file; there is nothing to search'
         WHERE status = 'empty' AND error = 'No readable text; scanned documents need OCR'
           AND lower(path) NOT LIKE '%.pdf'`,
      )
    } catch (err: unknown) {
      void err
    }
  }

  getEffectiveSyncGuard(): SyncMetadataGuard | null {
    return this.syncGuard ?? (getDbProjectionSyncGuard(this.db) as SyncMetadataGuard | null)
  }

  getLastAdmissionError(): string | undefined {
    return this.lastAdmissionError ?? this.getEffectiveSyncGuard()?.getLastRejectionReason()
  }

  private ensureDocumentInternal(norm: string): { admitted: boolean; reservationId?: string; ownerToken?: string; isNew?: boolean } {
    const existing = this.db.prepare('SELECT id FROM documents WHERE path = ?').get(norm) as { id: number } | undefined
    const name = basename(norm)
    const guard = this.getEffectiveSyncGuard()

    if (existing) {
      const proj = buildDocumentProjection(name, norm)
      if (isProjectionUpToDate(this.db, existing.id, proj)) {
        return { admitted: true, isNew: false }
      }
      let reservationId: string | undefined
      let ownerToken: string | undefined
      if (guard) {
        const estBytes = estimateDocumentProjectionBytes(name, norm)
        const decision = guard.canAdmitNewDocument({ name, path: norm }, estBytes)
        if (!decision.admitted) {
          this.lastAdmissionError = decision.error ?? decision.reason
          return { admitted: false, isNew: false }
        }
        reservationId = decision.reservationId
        ownerToken = decision.ownerToken
      }
      try {
        if (!syncProjectionInsert(this.db, { id: existing.id, path: norm, name }, guard ?? undefined)) {
          throw new Error('Storage admission rejected projection write')
        }
        return { admitted: true, isNew: false, reservationId, ownerToken }
      } catch (err) {
        if (reservationId && ownerToken) guard?.rollbackCommit(reservationId, ownerToken)
        throw err
      }
    }

    let reservationId: string | undefined
    let ownerToken: string | undefined
    if (guard) {
      const estBytes = estimateNewDocumentMetadataBytes(name, norm)
      const dec = guard.canAdmitNewDocument({ name, path: norm }, estBytes)
      if (!dec.admitted) {
        this.lastAdmissionError = dec.error ?? dec.reason
        return { admitted: false, isNew: true }
      }
      reservationId = dec.reservationId
      ownerToken = dec.ownerToken
    }
    try {
      this.db
        .prepare(
          `INSERT INTO documents(path, name, status, chunk_counted) VALUES (?, ?, 'pending', 1) ON CONFLICT(path) DO NOTHING`,
        )
        .run(norm, name)
      const row = this.db.prepare('SELECT id FROM documents WHERE path = ?').get(norm) as { id: number } | undefined
      if (row) {
        syncProjectionInsert(this.db, { id: row.id, path: norm, name }, guard ?? undefined)
      }
      return { admitted: true, reservationId, ownerToken, isNew: true }
    } catch (err) {
      if (guard && reservationId && ownerToken) {
        guard.rollbackCommit(reservationId, ownerToken)
      }
      throw err
    }
  }

  ensureDocument(path: string): boolean {
    const norm = resolve(path)
    const guard = this.getEffectiveSyncGuard()
    this.db.exec('SAVEPOINT ensure_doc')
    let res: { admitted: boolean; reservationId?: string; ownerToken?: string; isNew?: boolean } | undefined
    try {
      res = this.ensureDocumentInternal(norm)
      if (!res.admitted) {
        try {
          this.db.exec('ROLLBACK TO ensure_doc')
        } catch {
          // ignore rollback failure during reject cleanup
        }
        try {
          this.db.exec('RELEASE ensure_doc')
        } catch {
          // preserve transaction state
        }
        if (res.reservationId && res.ownerToken) {
          guard?.rollbackCommit(res.reservationId, res.ownerToken)
        }
        return false
      }
      this.db.exec('RELEASE ensure_doc')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK TO ensure_doc')
      } catch {
        // preserve original error
      }
      try {
        this.db.exec('RELEASE ensure_doc')
      } catch {
        // preserve original error
      }
      if (res?.reservationId && res?.ownerToken) {
        try {
          guard?.rollbackCommit(res.reservationId, res.ownerToken)
        } catch {
          // preserve original error
        }
      }
      throw err
    }

    // Settle commit-debt ONLY AFTER savepoint successfully released
    if (res.reservationId && res.ownerToken) {
      guard?.settleCommit(res.reservationId, res.ownerToken)
    }
    return true
  }

  /**
   * Images/videos are name+metadata rows ('ready', no chunks, never extracted). Never throws on a
   * vanished file. See media/media-enrollment.ts for the status / admission rationale.
   */
  enrollMedia(path: string, mtimeMs: number, sizeBytes: number): MediaEnrollResult {
    const result = enrollMediaRow(this.db, this.getEffectiveSyncGuard(), path, mtimeMs, sizeBytes)
    if (result.outcome === 'refused') this.lastAdmissionError = result.error
    return result
  }

  remember(path: string): boolean {
    const normalizedPath = resolve(path)
    if (mediaKindOfPath(normalizedPath)) {
      try {
        const file = statSync(normalizedPath)
        const outcome = file.isFile() ? this.enrollMedia(normalizedPath, file.mtimeMs, file.size).outcome : 'skipped'
        return outcome !== 'refused' && outcome !== 'skipped' && outcome !== 'excluded'
      } catch {
        return false
      }
    }
    const fileName = basename(normalizedPath)
    const openedAt = Date.now()
    const guard = this.getEffectiveSyncGuard()
    let reservationId: string | undefined
    let ownerToken: string | undefined
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.db.prepare('SELECT id FROM documents WHERE path = ?').get(normalizedPath) as { id: number } | undefined
      const proj = buildDocumentProjection(fileName, normalizedPath)
      const isUpToDate = existing ? isProjectionUpToDate(this.db, existing.id, proj) : false

      if (!existing && guard) {
        // New document prospective footprint
        const estBytes = estimateNewDocumentMetadataBytes(fileName, normalizedPath)
        const dec = guard.canAdmitNewDocument({ name: fileName, path: normalizedPath }, estBytes)
        if (!dec.admitted) {
          this.lastAdmissionError = dec.error ?? dec.reason
          this.db.exec('ROLLBACK')
          return false
        }
        reservationId = dec.reservationId
        ownerToken = dec.ownerToken
      } else if (existing && !isUpToDate && guard) {
        // Existing document with stale/changed projection: reserve before writes
        const estBytes = estimateDocumentProjectionBytes(fileName, normalizedPath)
        const dec = guard.canAdmitNewDocument({ name: fileName, path: normalizedPath }, estBytes)
        if (!dec.admitted) {
          this.lastAdmissionError = dec.error ?? dec.reason
          this.db.exec('ROLLBACK')
          // Preserve old searchable projection on denial; do not mutate document then silently skip projection
          return false
        }
        reservationId = dec.reservationId
        ownerToken = dec.ownerToken
      }

      this.db
        .prepare(
          `INSERT INTO documents(path, name, status, last_opened_at, priority_at, chunk_counted) VALUES (?, ?, 'pending', ?, ?, 1)
        ON CONFLICT(path) DO UPDATE SET name = excluded.name,
          last_opened_at = CASE WHEN documents.excluded = 0 THEN excluded.last_opened_at ELSE documents.last_opened_at END,
          priority_at = CASE WHEN documents.excluded = 0 THEN max(excluded.priority_at, coalesce(documents.mtime_ms, 0)) ELSE documents.priority_at END`,
        )
        .run(normalizedPath, fileName, openedAt, openedAt)
      const row = this.db.prepare('SELECT id FROM documents WHERE path = ?').get(normalizedPath) as { id: number } | undefined
      if (row && (!existing || !isUpToDate)) {
        syncProjectionInsert(this.db, { id: row.id, path: normalizedPath, name: fileName }, guard ?? undefined)
      }
      this.db.exec('COMMIT')
      if (guard && reservationId && ownerToken) {
        guard.settleCommit(reservationId, ownerToken)
      }
      return true
    } catch (err) {
      this.db.exec('ROLLBACK')
      if (guard && reservationId && ownerToken) {
        guard.rollbackCommit(reservationId, ownerToken)
      }
      throw err
    }
  }

  enrollDiscovered(path: string, mtimeMs: number, sizeBytes: number): boolean {
    // Media is finished work at enrollment: never "needs indexing" (callers would queue extraction).
    if (mediaKindOfPath(path)) {
      this.enrollMedia(path, mtimeMs, sizeBytes)
      return false
    }
    const normalizedPath = resolve(path)
    const fileName = basename(normalizedPath)
    const inference = inferDocumentImportance({ name: fileName, path: normalizedPath })
    const guard = this.getEffectiveSyncGuard()
    let reservationId: string | undefined
    let ownerToken: string | undefined
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.db.prepare('SELECT id, mtime_ms, size_bytes, status FROM documents WHERE path = ?').get(normalizedPath) as { id: number; mtime_ms: number | null; size_bytes: number | null; status: string } | undefined
      const proj = buildDocumentProjection(fileName, normalizedPath)
      const isUpToDate = existing ? isProjectionUpToDate(this.db, existing.id, proj) : false

      if (!existing && guard) {
        const estBytes = estimateNewDocumentMetadataBytes(fileName, normalizedPath)
        const dec = guard.canAdmitNewDocument({ name: fileName, path: normalizedPath }, estBytes)
        if (!dec.admitted) {
          this.lastAdmissionError = dec.error ?? dec.reason
          this.db.exec('ROLLBACK')
          return false
        }
        reservationId = dec.reservationId
        ownerToken = dec.ownerToken
      } else if (existing && !isUpToDate && guard) {
        // Existing document with changed/stale projection: reserve before writes
        const estBytes = estimateDocumentProjectionBytes(fileName, normalizedPath)
        const dec = guard.canAdmitNewDocument({ name: fileName, path: normalizedPath }, estBytes)
        if (!dec.admitted) {
          this.lastAdmissionError = dec.error ?? dec.reason
          this.db.exec('ROLLBACK')
          // Preserve old searchable projection on denial
          return false
        }
        reservationId = dec.reservationId
        ownerToken = dec.ownerToken
      }

      this.db
        .prepare(
          `INSERT INTO documents(path, name, status, last_opened_at, priority_at, chunk_counted, importance_suggestion, importance_reason)
           VALUES (?, ?, 'pending', 0, ?, 1, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             importance_suggestion = CASE WHEN documents.importance_suggestion = 'unknown' OR documents.importance_suggestion = 'normal' THEN excluded.importance_suggestion ELSE documents.importance_suggestion END,
             importance_reason = CASE WHEN documents.importance_suggestion = 'unknown' OR documents.importance_suggestion = 'normal' THEN excluded.importance_reason ELSE documents.importance_reason END`,
        )
        .run(normalizedPath, fileName, mtimeMs, inference.suggestion, inference.reason)
      const document = this.documentByPath(normalizedPath)
      if (!document || document.status === 'excluded') {
        this.db.exec('COMMIT')
        if (guard && reservationId && ownerToken) guard.settleCommit(reservationId, ownerToken)
        return false
      }
      if (!existing || !isUpToDate) {
        syncProjectionInsert(this.db, { id: document.id, path: normalizedPath, name: fileName }, guard ?? undefined)
      }
      this.db.exec('COMMIT')
      if (guard && reservationId && ownerToken) {
        guard.settleCommit(reservationId, ownerToken)
      }
      return (
        document.mtimeMs === null ||
        document.mtimeMs !== mtimeMs ||
        document.sizeBytes !== sizeBytes ||
        document.status === 'pending'
      )
    } catch (err) {
      this.db.exec('ROLLBACK')
      if (guard && reservationId && ownerToken) {
        guard.rollbackCommit(reservationId, ownerToken)
      }
      throw err
    }
  }

  listDocuments(): StoredDocument[] {
    return (
      this.db
        .prepare(
          `SELECT id, path, name, status, mtime_ms, size_bytes, hash, error, truncated, truncated_reason,
                  importance_override, importance_suggestion, importance_reason, importance_updated_at, content_evicted
      FROM documents ORDER BY priority_at DESC, id DESC`,
        )
        .all() as unknown as DocRow[]
    ).map(toDocument)
  }

  recentDocuments(limit = 20): StoredDocument[] {
    return (
      this.db
        .prepare(
          `SELECT id, path, name, status, mtime_ms, size_bytes, hash, error, truncated, truncated_reason,
                  importance_override, importance_suggestion, importance_reason, importance_updated_at, content_evicted
      FROM documents WHERE excluded = 0 ORDER BY priority_at DESC, id DESC LIMIT ?`,
        )
        .all(limit) as unknown as DocRow[]
    ).map(toDocument)
  }

  documentByPath(path: string): StoredDocument | null {
    const row = this.db
      .prepare(
        `SELECT id, path, name, status, mtime_ms, size_bytes, hash, error, truncated, truncated_reason,
                importance_override, importance_suggestion, importance_reason, importance_updated_at, content_evicted
      FROM documents WHERE path = ?`,
      )
      .get(resolve(path)) as DocRow | undefined
    return row ? toDocument(row) : null
  }

  documentById(id: number): StoredDocument | null {
    const row = this.db
      .prepare(
        `SELECT id, path, name, status, mtime_ms, size_bytes, hash, error, truncated, truncated_reason,
                importance_override, importance_suggestion, importance_reason, importance_updated_at, content_evicted
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
    if (isMediaDocument(this.db, documentId)) return // media is never extraction work
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
    // Extraction was attempted on an image/video (opened by the user): it has no text, which is not an error.
    if (isMediaDocument(this.db, id)) return
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

  recordTransientError(
    path: string,
    error: string,
    metadata?: { mtimeMs: number; sizeBytes: number } | null,
  ): boolean {
    const norm = resolve(path)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const doc = this.documentByPath(norm)
      if (!doc || doc.status === 'excluded' || isMediaDocument(this.db, doc.id)) {
        this.db.exec('COMMIT')
        return false
      }
      const hasActiveCachedContent =
        (doc.hash !== null && doc.hash.length > 0) || doc.status === 'ready' || doc.status === 'text-only'
      const newStatus = hasActiveCachedContent ? 'pending' : 'error'
      const shouldUpdateMeta = !hasActiveCachedContent && metadata !== undefined
      const newMtime = shouldUpdateMeta ? (metadata?.mtimeMs ?? null) : doc.mtimeMs
      const newSize = shouldUpdateMeta ? (metadata?.sizeBytes ?? null) : doc.sizeBytes

      this.db
        .prepare(
          `UPDATE documents SET error = ?, status = ?, mtime_ms = ?, size_bytes = ?, updated_at = unixepoch() WHERE id = ?`,
        )
        .run(error, newStatus, newMtime, newSize, doc.id)
      this.db.exec('COMMIT')
      return true
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  lockDocumentForReplace(normalizedPath: string): { id: number; reservationId?: string; ownerToken?: string } {
    const res = this.ensureDocumentInternal(normalizedPath)
    const row = this.db
      .prepare('SELECT id, excluded FROM documents WHERE path = ?')
      .get(normalizedPath) as { id: number; excluded: number } | undefined
    if (!row || !res.admitted) {
      if (res.reservationId && res.ownerToken) {
        this.getEffectiveSyncGuard()?.rollbackCommit(res.reservationId, res.ownerToken)
      }
      throw new Error(`Could not ensure document: ${normalizedPath}`)
    }
    if (row.excluded) {
      if (res.reservationId && res.ownerToken) {
        this.getEffectiveSyncGuard()?.rollbackCommit(res.reservationId, res.ownerToken)
      }
      throw new Error('Excluded document cannot be indexed')
    }
    return { id: row.id, reservationId: res.reservationId, ownerToken: res.ownerToken }
  }

  updateReplacedDocument(
    id: number,
    normalizedPath: string,
    replacement: ReplacementDocument,
  ): void {
    const isRehydrated = replacement.status === 'ready' || replacement.status === 'text-only'
    const resetEvictedClause = isRehydrated ? ', content_evicted = 0' : ''
    const fileName = basename(normalizedPath)
    this.db
      .prepare(
        `UPDATE documents SET name = ?, status = ?, mtime_ms = ?, priority_at = CASE WHEN EXISTS (SELECT 1 FROM document_media dm WHERE dm.document_id = documents.id) THEN priority_at ELSE max(last_opened_at, ?) END, size_bytes = ?, hash = ?,
        embedding_model = ?, error = ?, truncated = ?, truncated_reason = ?, excluded = 0, updated_at = unixepoch()${resetEvictedClause} WHERE id = ?`,
      )
      .run(
        fileName,
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
    const proj = buildDocumentProjection(fileName, normalizedPath)
    if (!isProjectionUpToDate(this.db, id, proj)) {
      syncProjectionUpdate(this.db, { id, path: normalizedPath, name: fileName }, this.getEffectiveSyncGuard() ?? undefined)
    }
    const textSample = replacement.chunks.slice(0, 5).map((c) => c.text).join(' ')
    const inference = inferDocumentImportance({
      name: basename(normalizedPath),
      path: normalizedPath,
      content: textSample,
    })
    if (inference.suggestion === 'important') {
      try {
        this.db
          .prepare(
            `UPDATE documents SET importance_suggestion = ?, importance_reason = ?
             WHERE id = ? AND (importance_suggestion IS NULL OR importance_suggestion != 'important')`,
          )
          .run(inference.suggestion, inference.reason, id)
      } catch (err: unknown) {
        void err
      }
    }
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
    const hasEvicted = hasContentEvictedColumn(this.db)
    const resetEvicted = hasEvicted ? ', content_evicted = 0' : ''
    this.db
      .prepare(
        `UPDATE documents SET status = 'pending', error = NULL${resetEvicted} WHERE id = ? AND excluded = 0`,
      )
      .run(id)
    clearVectorEvictions(this.db, [id])
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
          `SELECT id, path, name, status, mtime_ms, size_bytes, hash, error, truncated, truncated_reason, content_evicted
          FROM documents WHERE excluded = 0 AND (path = ? OR substr(path, 1, length(?)) = ?)`,
        )
        .all(normalized, prefix, prefix) as unknown as DocRow[]
    ).map(toDocument)
  }

  incompletePaths(): string[] {
    const hasEvicted = hasContentEvictedColumn(this.db)
    // Vectors evicted by retention are not pending work: re-embedding them is released explicitly
    // (open / retry / read-now) or by the maintenance step once usage is far below budget.
    const evictedClause =
      (hasEvicted ? ' AND (content_evicted IS NULL OR content_evicted = 0)' : '') +
      (hasVectorEvictionTable(this.db) ? ` AND NOT ${VECTOR_EVICTION_APPLIES_SQL}` : '')
    return (
      this.db
        .prepare(
          `SELECT path FROM documents WHERE excluded = 0 AND status IN ('pending', 'text-only')${evictedClause}
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
          `SELECT id, path, name, status, mtime_ms, size_bytes, hash, error, truncated, truncated_reason, content_evicted
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
    const guard = this.getEffectiveSyncGuard()
    let reservationId: string | undefined
    let ownerToken: string | undefined
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.lockDocumentForReplace(path)
      reservationId = row.reservationId
      ownerToken = row.ownerToken
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
      if (guard && reservationId && ownerToken) {
        guard.settleCommit(reservationId, ownerToken)
      }
    } catch (err) {
      this.db.exec('ROLLBACK')
      if (guard && reservationId && ownerToken) {
        guard.rollbackCommit(reservationId, ownerToken)
      }
      throw err
    }
  }

  async replaceDocumentSliced(
    path: string,
    replacement: ReplacementDocument,
    options: SliceOptions = {},
  ): Promise<boolean> {
    if (options.shouldContinue && !options.shouldContinue()) return false
    const guard = this.getEffectiveSyncGuard()

    const rawMaxBytes = options.maxBatchBytes ?? CONTENT_BATCH_DEFAULT_MAX_BYTES
    const maxBatchBytes = Number.isFinite(rawMaxBytes) && Math.floor(rawMaxBytes) >= 512
      ? Math.floor(rawMaxBytes)
      : CONTENT_BATCH_DEFAULT_MAX_BYTES
    const rawMaxChunks = options.maxBatchChunks ?? CONTENT_BATCH_DEFAULT_MAX_CHUNKS
    const maxBatchChunks = Number.isFinite(rawMaxChunks) && Math.floor(rawMaxChunks) >= 1
      ? Math.floor(rawMaxChunks)
      : CONTENT_BATCH_DEFAULT_MAX_CHUNKS
    const rawBudgetMs = options.budgetMs ?? WRITE_SLICE_MS
    const budgetMs = Number.isFinite(rawBudgetMs) && rawBudgetMs > 0 ? rawBudgetMs : WRITE_SLICE_MS

    const userEstimator = options.estimateChunkBytes ?? defaultEstimateChunkBytes
    const estimateBytes = (chunk: ReplacementDocument['chunks'][number]): number => {
      try {
        const val = userEstimator(chunk)
        if (typeof val === 'number' && Number.isFinite(val) && val >= 512) return Math.ceil(val)
      } catch {}
      return defaultEstimateChunkBytes(chunk)
    }

    for (let i = 0; i < replacement.chunks.length; i++) {
      const c = replacement.chunks[i]!
      if (c.text.length > MAX_SINGLE_CHUNK_TEXT_CHARS) {
        c.text = c.text.slice(0, MAX_SINGLE_CHUNK_TEXT_CHARS)
        replacement.truncated = true
        replacement.truncatedReason ??= 'content-limit'
      }
      let truncateIter = 0
      while (c.text.length > 0 && estimateBytes(c) > maxBatchBytes && truncateIter < 50) {
        truncateIter++
        const excess = estimateBytes(c) - maxBatchBytes
        const charsToRemove = Math.max(1, Math.ceil(excess / 4))
        c.text = c.text.slice(0, Math.max(0, c.text.length - charsToRemove))
        replacement.truncated = true
        replacement.truncatedReason ??= 'content-limit'
      }
      if (estimateBytes(c) > maxBatchBytes) {
        if (c.text.length > 0) {
          c.text = ''
          replacement.truncated = true
          replacement.truncatedReason ??= 'content-limit'
        }
        if (estimateBytes(c) > maxBatchBytes) {
          throw new Error(`Single chunk exceeds maximum batch byte cap (${maxBatchBytes})`)
        }
      }
    }
    validateReplacement(replacement)

    const normalizedPath = resolve(path)
    let documentId: number
    let chunkSetId = 0
    let first = true

    // Read-only lookup before any awaits or mutations
    const existing = this.db
      .prepare('SELECT id, excluded FROM documents WHERE path = ?')
      .get(normalizedPath) as { id: number; excluded: number } | undefined
    if (existing?.excluded) {
      return false
    }
    documentId = existing?.id ?? 0

    const N = replacement.chunks.length

    // Handle empty chunks with full hooks and non-zero metadata/WAL estimation
    if (N === 0) {
      if (options.shouldContinue && !options.shouldContinue()) return false
      if (options.beforeBatch) {
        const decision = await options.beforeBatch({
          batchIndex: 0,
          startChunkIndex: 0,
          chunkCount: 0,
          estimatedBytes: BASE_METADATA_WRITE_BYTES,
          totalEstimatedRemainingBytes: BASE_METADATA_WRITE_BYTES,
          documentId,
          path: normalizedPath,
        })
        if (options.shouldContinue && !options.shouldContinue()) return false
        const proceed = typeof decision === 'boolean' ? decision : decision.proceed
        if (!proceed) return false
      }

      this.db.exec('BEGIN IMMEDIATE')
      let reservationId: string | undefined
      let ownerToken: string | undefined
      try {
        const row = this.lockDocumentForReplace(normalizedPath)
        reservationId = row.reservationId
        ownerToken = row.ownerToken
        documentId = row.id
        chunkSetId = createBuildingSet(this.db, documentId, 2)
        this.updateReplacedDocument(documentId, normalizedPath, replacement)
        activateSet(this.db, documentId, chunkSetId)
        this.chunkRepo!.deleteOldChunksForDocument(documentId, chunkSetId, (ids) =>
          this.onAnnVectorsRemoved?.(ids),
        )
        this.db.exec('COMMIT')
        if (guard && reservationId && ownerToken) {
          guard.settleCommit(reservationId, ownerToken)
        }
      } catch (err) {
        this.db.exec('ROLLBACK')
        if (guard && reservationId && ownerToken) {
          guard.rollbackCommit(reservationId, ownerToken)
        }
        throw err
      }

      if (options.postCommit) {
        await options.postCommit({
          batchIndex: 0,
          committedChunks: 0,
          committedBytes: BASE_METADATA_WRITE_BYTES,
          remainingChunks: 0,
          remainingBytes: 0,
          documentId,
          path: normalizedPath,
        })
      }
      return true
    }

    // Linear suffix sum array for remaining bytes (O(N) precomputation, O(1) per batch)
    const chunkBytes = new Array<number>(N)
    for (let i = 0; i < N; i++) {
      chunkBytes[i] = estimateBytes(replacement.chunks[i]!)
    }
    const suffixRemaining = new Array<number>(N + 1)
    suffixRemaining[N] = 0
    for (let i = N - 1; i >= 0; i--) {
      suffixRemaining[i] = suffixRemaining[i + 1] + chunkBytes[i]!
    }

    let next = 0
    let batchIndex = 0
    let insert: ReturnType<ChunkRepository['chunkInserter']> | null = null

    while (next < N) {
      if (options.shouldContinue && !options.shouldContinue()) return false

      let batchChunkCount = 0
      let batchEstimatedBytes = 0
      let scanIdx = next
      while (scanIdx < N) {
        const cBytes = chunkBytes[scanIdx]!
        const willBeFinal = scanIdx + 1 >= N
        const candidateMeta = (first ? BASE_METADATA_WRITE_BYTES : 0) + (willBeFinal ? BASE_METADATA_WRITE_BYTES : 0)
        if (
          batchChunkCount > 0 &&
          (batchChunkCount >= maxBatchChunks || batchEstimatedBytes + cBytes + candidateMeta > maxBatchBytes)
        ) {
          break
        }
        batchChunkCount++
        batchEstimatedBytes += cBytes
        scanIdx++
      }

      const isFinalBatch = scanIdx >= N
      const batchMetadataBytes = (first ? BASE_METADATA_WRITE_BYTES : 0) + (isFinalBatch ? BASE_METADATA_WRITE_BYTES : 0)
      const totalRemainingBytes = suffixRemaining[next] + BASE_METADATA_WRITE_BYTES

      if (options.beforeBatch) {
        const decision = await options.beforeBatch({
          batchIndex,
          startChunkIndex: next,
          chunkCount: batchChunkCount,
          estimatedBytes: batchEstimatedBytes + batchMetadataBytes,
          totalEstimatedRemainingBytes: totalRemainingBytes,
          documentId,
          path: normalizedPath,
        })
        if (options.shouldContinue && !options.shouldContinue()) return false
        const proceed = typeof decision === 'boolean' ? decision : decision.proceed
        if (!proceed) {
          if (documentId > 0 && !first) {
            this.markPending(documentId)
          }
          return false
        }
      }

      const started = performance.now()
      let batchCommittedChunks = 0
      let batchCommittedBytes = 0
      const wasFirst = first

      this.db.exec('BEGIN IMMEDIATE')
      let reservationId: string | undefined
      let ownerToken: string | undefined
      try {
        if (first) {
          const row = this.lockDocumentForReplace(normalizedPath)
          reservationId = row.reservationId
          ownerToken = row.ownerToken
          documentId = row.id
          chunkSetId = createBuildingSet(this.db, documentId, 2)
          first = false
        } else {
          const row = this.db.prepare('SELECT id, excluded FROM documents WHERE id = ?').get(documentId) as { id: number; excluded: number } | undefined
          if (!row || row.excluded) {
            this.db.exec('ROLLBACK')
            return false
          }
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

        while (next < N) {
          const chunk = replacement.chunks[next]!
          const cBytes = chunkBytes[next]!

          if (batchCommittedChunks > 0) {
            const timeOver = performance.now() - started >= budgetMs
            const willBeFinal = next + 1 >= N
            const curMeta = (wasFirst && batchCommittedChunks === 0 ? BASE_METADATA_WRITE_BYTES : 0) + (willBeFinal ? BASE_METADATA_WRITE_BYTES : 0)
            const bytesOver = batchCommittedBytes + cBytes + curMeta > maxBatchBytes
            const chunksOver = batchCommittedChunks >= maxBatchChunks
            if (timeOver || bytesOver || chunksOver) {
              break
            }
          }

          insert(chunk, next)
          next++
          batchCommittedChunks++
          batchCommittedBytes += cBytes
        }

        const isComplete = next >= N
        if (isComplete) {
          this.updateReplacedDocument(documentId, normalizedPath, replacement)
          activateSet(this.db, documentId, chunkSetId)
          this.chunkRepo!.deleteOldChunksForDocument(documentId, chunkSetId, (ids) =>
            this.onAnnVectorsRemoved?.(ids),
          )
        } else {
          this.markPending(documentId)
        }

        this.db.exec('COMMIT')
        if (guard && reservationId && ownerToken) {
          guard.settleCommit(reservationId, ownerToken)
        }
      } catch (err) {
        this.db.exec('ROLLBACK')
        if (guard && reservationId && ownerToken) {
          guard.rollbackCommit(reservationId, ownerToken)
        }
        throw err
      }

      const remainingBytesAfter = next < N ? suffixRemaining[next] + BASE_METADATA_WRITE_BYTES : 0

      if (options.postCommit) {
        await options.postCommit({
          batchIndex,
          committedChunks: batchCommittedChunks,
          committedBytes: batchCommittedBytes + (wasFirst ? BASE_METADATA_WRITE_BYTES : 0) + (next >= N ? BASE_METADATA_WRITE_BYTES : 0),
          remainingChunks: N - next,
          remainingBytes: remainingBytesAfter,
          documentId,
          path: normalizedPath,
        })
      }

      if (next >= N) {
        return true
      }

      await (options.yield ?? yieldToEventLoop)()
      if (options.shouldContinue && !options.shouldContinue()) return false
      batchIndex++
    }

    return true
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
    let removed: boolean
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const doc = this.documentByPath(path)
      if (!doc || doc.status === 'excluded') {
        this.db.exec('COMMIT')
        return false
      }
      this.chunkRepo!.deleteChunks(doc.id, (ids) => this.onAnnVectorsRemoved?.(ids))
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id)
      syncProjectionTombstone(this.db, doc.id)
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
        syncProjectionTombstone(this.db, doc.id)
        this.getOcr?.().remove(path)
        removed = true
        return 'done'
      },
      undefined,
      'tombstone slice',
    )
    return removed
  }

  /**
   * One bounded slice of the junk purge: walks the never-opened rows by id from a persisted cursor, deletes the ones whose
   * name `isIgnored`, and stops after `maxMs` (a transaction per page, so a writer on another connection waits for a
   * few milliseconds, not for the whole purge). Safe to interrupt at any point: the cursor moves in the transaction
   * that deleted the rows before it, and the one-time flag is set only when the walk reaches the end.
   */
  purgeDiscoveredByNameStep(
    isIgnored: (name: string) => boolean,
    options: { maxMs: number; pageSize?: number; flagKey: string },
  ): { removed: number; scanned: number; done: boolean } {
    const cursorKey = `${options.flagKey}_cursor`
    const readMeta = this.db.prepare('SELECT value FROM document_memory_meta WHERE key = ?')
    const writeMeta = this.db.prepare('INSERT OR REPLACE INTO document_memory_meta(key, value) VALUES(?, ?)')
    let cursor = Number((readMeta.get(cursorKey) as { value: string } | undefined)?.value ?? 0) || 0
    const page = this.db.prepare(
      'SELECT id, name FROM documents WHERE id > ? AND last_opened_at = 0 ORDER BY id LIMIT ?',
    )
    const started = performance.now()
    let removed = 0
    let scanned = 0
    for (;;) {
      const rows = page.all(cursor, options.pageSize ?? 200) as Array<{ id: number; name: string }>
      if (rows.length === 0) {
        this.db.exec('BEGIN IMMEDIATE')
        try {
          writeMeta.run(options.flagKey, String(Date.now()))
          this.db.prepare('DELETE FROM document_memory_meta WHERE key = ?').run(cursorKey)
          this.db.exec('COMMIT')
        } catch (err) {
          this.db.exec('ROLLBACK')
          throw err
        }
        return { removed, scanned, done: true }
      }
      this.db.exec('BEGIN IMMEDIATE')
      try {
        let last = cursor
        for (const row of rows) {
          if (isIgnored(row.name)) {
            this.chunkRepo!.deleteChunks(row.id, (ids) => this.onAnnVectorsRemoved?.(ids))
            this.db.prepare('DELETE FROM documents WHERE id = ?').run(row.id)
            syncProjectionDelete(this.db, row.id)
            removed++
          }
          last = row.id
          scanned++
          if (performance.now() - started >= options.maxMs) break
        }
        cursor = last
        writeMeta.run(cursorKey, String(cursor))
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
      if (performance.now() - started >= options.maxMs) return { removed, scanned, done: false }
    }
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
        syncProjectionDelete(this.db, row.id)
        removed++
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return removed
  }

  move(oldPath: string, newPath: string): void {
    const oldNorm = resolve(oldPath)
    const newNorm = resolve(newPath)
    const newName = basename(newNorm)
    const guard = this.getEffectiveSyncGuard()
    let reservationId: string | undefined
    let ownerToken: string | undefined
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const doc = this.documentByPath(oldNorm)
      if (!doc) {
        this.db.exec('COMMIT')
        return
      }
      if (guard) {
        const estBytes = estimateNewDocumentMetadataBytes(newName, newNorm)
        const dec = guard.canAdmitNewDocument({ name: newName, path: newNorm }, estBytes)
        if (!dec.admitted) {
          this.lastAdmissionError = dec.error ?? dec.reason
          throw new Error(dec.error ?? 'Storage admission rejected moving document')
        }
        reservationId = dec.reservationId
        ownerToken = dec.ownerToken
      }
      this.db
        .prepare('UPDATE documents SET path = ?, name = ?, updated_at = unixepoch() WHERE id = ?')
        .run(newNorm, newName, doc.id)
      syncProjectionMove(this.db, doc.id, newNorm, newName, guard ?? undefined)
      this.getOcr?.().rename(oldNorm, newNorm)
      this.db.exec('COMMIT')
      if (guard && reservationId && ownerToken) {
        guard.settleCommit(reservationId, ownerToken)
      }
    } catch (err) {
      this.db.exec('ROLLBACK')
      if (guard && reservationId && ownerToken) {
        guard.rollbackCommit(reservationId, ownerToken)
      }
      throw err
    }
  }

  exclude(path: string): void {
    const norm = resolve(path)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const doc = this.documentByPath(norm)
      if (!doc) {
        this.db.exec('COMMIT')
        return
      }
      this.chunkRepo?.deleteChunks(doc.id, (ids) => this.onAnnVectorsRemoved?.(ids))
      this.getOcr?.().remove(norm)
      this.db
        .prepare(
          `UPDATE documents SET excluded = 1, status = 'excluded', hash = NULL, embedding_model = NULL,
        error = NULL, updated_at = unixepoch() WHERE id = ?`,
        )
        .run(doc.id)
      syncProjectionExclude(this.db, doc.id)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  clear(): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM chunk_fts').run()
      this.db.prepare('DELETE FROM chunks').run()
      this.db.prepare('DELETE FROM documents WHERE excluded = 0').run()
      try {
        this.db.prepare('DELETE FROM document_name_projection WHERE document_id NOT IN (SELECT id FROM documents)').run()
      } catch (err: unknown) {
        void err
      }
      this.getOcr?.().clearAll()
      this.db.exec(
        'UPDATE documents SET chunk_total = 0, chunk_done = 0 WHERE chunk_total <> 0 OR chunk_done <> 0',
      )
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  getImportance(pathOrId: string | number): FileImportanceInfo | null {
    const isId = typeof pathOrId === 'number'
    const where = isId ? 'id = ?' : 'path = ?'
    const val = isId ? pathOrId : resolve(pathOrId)
    const row = this.db
      .prepare(
        `SELECT importance_override, importance_suggestion, importance_reason, importance_updated_at
         FROM documents WHERE ${where}`,
      )
      .get(val) as
      | {
          importance_override?: string
          importance_suggestion?: string
          importance_reason?: string | null
          importance_updated_at?: number
        }
      | undefined
    if (!row) return null
    const override = (row.importance_override ?? 'auto') as FileImportanceOverride
    const suggestion = (row.importance_suggestion ?? 'unknown') as FileImportanceSuggestion
    const effective = computeEffectiveImportance(override, suggestion)
    return {
      override,
      suggestion,
      reason: row.importance_reason ?? null,
      effective,
      updatedAt: (row.importance_updated_at ?? 0) * 1000,
    }
  }

  setImportanceOverride(pathOrId: string | number, override: FileImportanceOverride): boolean {
    if (!['auto', 'important', 'low'].includes(override)) {
      throw new Error(`Invalid importance override: ${override}`)
    }
    const isId = typeof pathOrId === 'number'
    if (isId && (!Number.isSafeInteger(pathOrId) || pathOrId < 1)) {
      throw new Error('Invalid document id')
    }
    if (!isId && (typeof pathOrId !== 'string' || !pathOrId.trim())) {
      throw new Error('Invalid document path')
    }
    const where = isId ? 'id = ?' : 'path = ?'
    const val = isId ? pathOrId : resolve(pathOrId)
    const result = this.db
      .prepare(
        `UPDATE documents SET importance_override = ?, importance_updated_at = unixepoch() WHERE ${where}`,
      )
      .run(override, val)
    return Number(result.changes) > 0
  }

  setImportanceSuggestion(
    pathOrId: string | number,
    suggestion: FileImportanceSuggestion,
    reason: string | null,
  ): boolean {
    if (!['unknown', 'normal', 'important'].includes(suggestion)) {
      throw new Error(`Invalid importance suggestion: ${suggestion}`)
    }
    const isId = typeof pathOrId === 'number'
    if (isId && (!Number.isSafeInteger(pathOrId) || pathOrId < 1)) {
      throw new Error('Invalid document id')
    }
    if (!isId && (typeof pathOrId !== 'string' || !pathOrId.trim())) {
      throw new Error('Invalid document path')
    }
    const where = isId ? 'id = ?' : 'path = ?'
    const val = isId ? pathOrId : resolve(pathOrId)
    const result = this.db
      .prepare(
        `UPDATE documents SET importance_suggestion = ?, importance_reason = ?, importance_updated_at = unixepoch() WHERE ${where}`,
      )
      .run(suggestion, reason, val)
    return Number(result.changes) > 0
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
      let outcome: 'done' | 'more' | 'abort'
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
