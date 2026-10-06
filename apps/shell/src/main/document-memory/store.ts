import type { DatabaseSync } from 'node:sqlite'
import type { DocumentIndexStorageDiagnostics } from '../../shared/fork/document-index-api'
import { OcrSidecar } from './ocr-sidecar'
import { HotMetadataSearch } from './hot-metadata-search'
import { openDatabase, runTransaction } from './storage/database'
import {
  DocumentRepository,
  type DocumentStatus,
  type TruncatedReason,
  type StoredDocument,
  type ReplacementDocument,
  type SliceOptions,
  WRITE_SLICE_MS,
} from './storage/repositories/document-repository'
import { ChunkRepository } from './storage/repositories/chunk-repository'
import { EmbeddingRepository } from './storage/repositories/embedding-repository'
import { SearchRepository } from './storage/repositories/search-repository'
import {
  ProgressRepository,
  type DocumentChunkProgress,
  type FolderChunkProgress,
  type DocumentMemoryStats,
} from './storage/repositories/progress-repository'
import {
  MaintenanceRepository,
  FTS_MERGE_PAGES,
} from './storage/repositories/maintenance-repository'
import { DiagnosticsRepository } from './storage/repositories/diagnostics-repository'
import type { EmbeddingProfile } from './embedding-profiles'
import type { USearchIndex } from './usearch-index'
import type {
  GarbageCollectionStats,
  StorageFreelistStats,
  IncrementalVacuumOptions,
  VacuumResult,
} from './storage-gc'

export type {
  DocumentStatus,
  TruncatedReason,
  StoredDocument,
  ReplacementDocument,
  DocumentChunkProgress,
  FolderChunkProgress,
  DocumentMemoryStats,
  GarbageCollectionStats,
  StorageFreelistStats,
  IncrementalVacuumOptions,
  VacuumResult,
  SliceOptions,
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

export const COUNTER_BACKFILL_SLICE = 200
export { WRITE_SLICE_MS, FTS_MERGE_PAGES }
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
  role?: 'search' | 'worker'
  cacheKiB?: number
}

/** Durable memory facade for document indexing. Fully backward-compatible. */
export class DocumentMemoryStore {
  readonly role: 'search' | 'worker'
  readonly dbPath: string
  private readonly db: DatabaseSync
  private ocrSidecar: OcrSidecar | null = null

  private readonly docRepo: DocumentRepository
  private readonly chunkRepo: ChunkRepository
  private readonly embRepo: EmbeddingRepository
  private readonly searchRepo: SearchRepository
  private readonly progressRepo: ProgressRepository
  private readonly maintRepo: MaintenanceRepository
  private readonly diagRepo: DiagnosticsRepository

  get ocr(): OcrSidecar {
    return (this.ocrSidecar ??= new OcrSidecar(this.db))
  }
  get rawDb(): DatabaseSync {
    return this.db
  }

  constructor(dbPath: string, options: DocumentMemorySearchOptions = {}) {
    this.role = options.role ?? 'search'
    this.dbPath = dbPath
    this.db = openDatabase(dbPath, { role: this.role, cacheKiB: options.cacheKiB })

    const hotMeta = new HotMetadataSearch(this.db)
    this.chunkRepo = new ChunkRepository(this.db)
    this.embRepo = new EmbeddingRepository(this.db)
    this.maintRepo = new MaintenanceRepository(this.db, dbPath, this.role)
    this.searchRepo = new SearchRepository(this.db, hotMeta, this.maintRepo)
    this.progressRepo = new ProgressRepository(this.db)
    this.diagRepo = new DiagnosticsRepository(this.db, dbPath)

    this.docRepo = new DocumentRepository(
      this.db,
      this.chunkRepo,
      this.embRepo,
      () => this.ocr,
      (spaceId, ids, vecs) => this.maintRepo.onAnnVectorsAdded(spaceId, ids, vecs),
      (ids) => this.maintRepo.onAnnVectorsRemoved(ids),
    )

    this.ensureNameFtsV1()
  }

  private ensureNameFtsV1(): void {
    const row = this.db
      .prepare("SELECT value FROM document_memory_meta WHERE key = 'name_fts_version'")
      .get() as { value: string } | undefined
    if (!row || row.value !== '1') {
      try {
        runTransaction(this.db, () => {
          this.db.prepare("INSERT INTO document_name_fts(document_name_fts) VALUES('rebuild')").run()
          this.db
            .prepare(
              "INSERT OR REPLACE INTO document_memory_meta(key, value) VALUES('name_fts_version', '1')",
            )
            .run()
        })
      } catch {
        // Retry next startup
      }
    }
  }

  ensureEmbeddingSpace(profile: EmbeddingProfile): void {
    this.embRepo.ensureEmbeddingSpace(profile)
  }
  mergeFtsStep(pages = FTS_MERGE_PAGES): boolean {
    return this.maintRepo.mergeFtsStep(pages)
  }
  backfillCounters(maxDocuments = COUNTER_BACKFILL_SLICE): boolean {
    return this.progressRepo.backfillCounters(maxDocuments)
  }
  hasUncountedDocuments(): boolean {
    return this.progressRepo.hasUncountedDocuments()
  }
  remember(path: string): void {
    this.docRepo.remember(path)
  }
  enrollDiscovered(path: string, mtimeMs: number, sizeBytes: number): boolean {
    return this.docRepo.enrollDiscovered(path, mtimeMs, sizeBytes)
  }
  listDocuments(): StoredDocument[] {
    return this.docRepo.listDocuments()
  }
  recentDocuments(limit = 20): StoredDocument[] {
    return this.docRepo.recentDocuments(limit)
  }
  documentByPath(path: string): StoredDocument | null {
    return this.docRepo.documentByPath(path)
  }
  documentById(id: number): StoredDocument | null {
    return this.docRepo.documentById(id)
  }
  chunkProgress(path: string): DocumentChunkProgress {
    return this.progressRepo.chunkProgress(path)
  }
  getEmbeddingCounts(documentId: number, spaceId?: string): number {
    return this.embRepo.getEmbeddingCounts(documentId, spaceId)
  }
  boostFolder(root: string, at: number): void {
    this.docRepo.boostFolder(root, at)
  }
  folderChunkProgress(root?: string): FolderChunkProgress {
    return this.progressRepo.folderChunkProgress(root)
  }
  indexIssues(root: string, offset = 0) {
    return this.progressRepo.indexIssues(root, offset)
  }
  requeueNowReadable(): number {
    return this.docRepo.requeueNowReadable()
  }
  retryDocument(id: number): string | null {
    return this.docRepo.retryDocument(id)
  }
  markOcrPending(path: string): boolean {
    return this.docRepo.markOcrPending(path)
  }
  documentPriority(path: string): number {
    return this.docRepo.documentPriority(path)
  }
  legacyPaths(extensions: readonly string[], limit: number): string[] {
    return this.docRepo.legacyPaths(extensions, limit)
  }
  listPaths(): string[] {
    return this.docRepo.listPaths()
  }
  replaceDocument(path: string, replacement: ReplacementDocument): void {
    this.docRepo.replaceDocument(path, replacement)
  }
  async replaceDocumentSliced(path: string, replacement: ReplacementDocument, options: SliceOptions = {}): Promise<boolean> {
    return this.docRepo.replaceDocumentSliced(path, replacement, options)
  }
  deleteOldChunksForDocument(documentId: number, activeChunkSetId: number): void {
    this.chunkRepo.deleteOldChunksForDocument(documentId, activeChunkSetId, (ids) => this.maintRepo.onAnnVectorsRemoved(ids))
  }
  cleanupDanglingBuildingSets(): number {
    return this.chunkRepo.cleanupDanglingBuildingSets()
  }
  getDocumentsNeedingChunkUpgrade(limit = 100) {
    return this.chunkRepo.getDocumentsNeedingChunkUpgrade(limit)
  }
  getChunkMigrationProgress(version = 2) {
    return this.chunkRepo.getChunkMigrationProgress(version)
  }
  requeueForEmbeddingModel(current: string): number {
    return this.docRepo.requeueForEmbeddingModel(current)
  }
  requeueTruncatedPdfs(): number {
    return this.docRepo.requeueTruncatedPdfs()
  }
  markError(path: string, error: string, metadata?: { mtimeMs: number; sizeBytes: number } | null): void {
    this.docRepo.markError(path, error, metadata)
  }
  async markErrorSliced(path: string, error: string, metadata?: { mtimeMs: number; sizeBytes: number } | null, options: SliceOptions = {}): Promise<boolean> {
    return this.docRepo.markErrorSliced(path, error, metadata, options)
  }
  setChunkEmbeddings(path: string, hash: string, offset: number, vectors: number[][], embeddingSpaceId: string, complete: boolean): void {
    this.embRepo.setChunkEmbeddings(path, hash, offset, vectors, embeddingSpaceId, complete, (ids, vecs) => this.maintRepo.onAnnVectorsAdded(embeddingSpaceId, ids, vecs))
  }
  setChunkVectors(path: string, hash: string, offset: number, vectors: number[][], model: string, complete: boolean): void {
    this.setChunkEmbeddings(path, hash, offset, vectors, model, complete)
  }
  recordMigrationEmbeddings(embeddingSpaceId: string, batch: Array<{ chunkId: number; vector: number[] }>): void {
    this.embRepo.recordMigrationEmbeddings(embeddingSpaceId, batch, (ids, vecs) => this.maintRepo.onAnnVectorsAdded(embeddingSpaceId, ids, vecs))
  }
  resumeEmbeddingOffset(path: string, hash: string, spaceId: string): number | null {
    return this.embRepo.resumeEmbeddingOffset(path, hash, spaceId)
  }
  resumeVectorOffset(path: string, hash: string, model: string): number | null {
    return this.embRepo.resumeEmbeddingOffset(path, hash, model)
  }
  move(oldPath: string, newPath: string): void {
    runTransaction(this.db, () => {
      const doc = this.docRepo.documentByPath(oldPath)
      if (!doc) return
      this.db
        .prepare('UPDATE documents SET path = ?, name = ?, updated_at = unixepoch() WHERE id = ?')
        .run(newPath, newPath.split(/[\\/]/).pop() ?? newPath, doc.id)
      this.ocr.rename(oldPath, newPath)
    })
  }
  tombstone(path: string): boolean {
    return this.docRepo.tombstone(path)
  }
  async tombstoneSliced(path: string, options: SliceOptions = {}): Promise<boolean> {
    return this.docRepo.tombstoneSliced(path, options)
  }
  purgeDiscoveredByName(isIgnored: (name: string) => boolean): number {
    return this.docRepo.purgeDiscoveredByName(isIgnored)
  }
  touchMetadata(path: string, mtimeMs: number, sizeBytes: number): void {
    this.docRepo.touchMetadata(path, mtimeMs, sizeBytes)
  }
  documentsUnder(root: string): StoredDocument[] {
    return this.docRepo.documentsUnder(root)
  }
  incompletePaths(): string[] {
    return this.docRepo.incompletePaths()
  }
  documentsUnderPage(root: string, afterId: number, limit: number): StoredDocument[] {
    return this.docRepo.documentsUnderPage(root, afterId, limit)
  }
  openedPaths(limit: number): string[] {
    return this.docRepo.openedPaths(limit)
  }
  exclude(path: string): void {
    runTransaction(this.db, () => {
      const doc = this.docRepo.documentByPath(path)
      if (!doc) return
      this.chunkRepo.deleteChunks(doc.id, (ids) => this.maintRepo.onAnnVectorsRemoved(ids))
      this.ocr.remove(path)
      this.db
        .prepare(
          `UPDATE documents SET excluded = 1, status = 'excluded', hash = NULL, embedding_model = NULL,
        error = NULL, updated_at = unixepoch() WHERE id = ?`,
        )
        .run(doc.id)
    })
  }
  clear(): void {
    runTransaction(this.db, () => {
      this.db.prepare('DELETE FROM chunk_fts').run()
      this.db.prepare('DELETE FROM chunks').run()
      this.db.prepare('DELETE FROM documents WHERE excluded = 0').run()
      this.ocr.clearAll()
      this.db.exec(
        'UPDATE documents SET chunk_total = 0, chunk_done = 0 WHERE chunk_total <> 0 OR chunk_done <> 0',
      )
    })
  }
  searchNames(query: string, limit = 5): DocumentMemoryHit[] {
    return this.searchRepo.searchNames(query, limit)
  }
  recent(limit = 20): StoredDocument[] {
    return this.searchRepo.recent(limit)
  }
  hydrateChunkHits(hits: Array<{ chunkId: number; rank?: number; score?: number }>): DocumentMemoryHit[] {
    return this.searchRepo.hydrateChunkHits(hits)
  }
  searchLexical(query: string, limit = 200) {
    return this.searchRepo.searchLexical(query, limit)
  }
  searchSemantic(vector: number[], limit = 200, spaceId?: string) {
    return this.searchRepo.searchSemantic(vector, limit, spaceId)
  }
  search(query: string, vector: number[] | null, limit = 8, embeddingModel?: string): DocumentMemoryHit[] {
    return this.searchRepo.search(query, vector, limit, embeddingModel)
  }
  readChunk(chunkId: number): DocumentMemoryHit | null {
    return this.chunkRepo.readChunk(chunkId)
  }
  stats(activeEmbeddingSpace?: string): DocumentMemoryStats {
    return this.progressRepo.stats(activeEmbeddingSpace)
  }
  getEmbeddingSpaces() {
    return this.embRepo.getEmbeddingSpaces()
  }
  getAnnIndex(spaceId: string, dimensions: number): USearchIndex {
    return this.maintRepo.getAnnIndex(spaceId, dimensions)
  }
  markAnnDirty(spaceId: string): void {
    this.maintRepo.markAnnDirty(spaceId)
  }
  rebuildAnnIndex(spaceId: string) {
    return this.maintRepo.rebuildAnnIndex(spaceId)
  }
  syncAnnIndex(spaceId: string) {
    return this.maintRepo.syncAnnIndex(spaceId)
  }
  errorCount(): number {
    return this.docRepo.errorCount()
  }
  runMaintenanceGc(): GarbageCollectionStats {
    return this.maintRepo.runMaintenanceGc()
  }
  getStorageFreelistStats(): StorageFreelistStats {
    return this.maintRepo.getStorageFreelistStats()
  }
  runIncrementalVacuum(options?: IncrementalVacuumOptions): VacuumResult {
    return this.maintRepo.runIncrementalVacuum(options)
  }
  close(): void {
    this.db.close()
  }
  getStorageDiagnostics(backupPath?: string): DocumentIndexStorageDiagnostics {
    return this.diagRepo.getStorageDiagnostics(backupPath)
  }
}
