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
  type SliceOptions, type BatchSliceInfo, type BatchCommitInfo, type BatchHookDecision,
  type FileImportanceOverride,
  type FileImportanceSuggestion,
  type FileImportanceEffective,
  type FileImportanceInfo,
  WRITE_SLICE_MS,
} from './storage/repositories/document-repository'
import { ChunkRepository } from './storage/repositories/chunk-repository'
import {
  EmbeddingRepository,
  type RepairInvalidCanonicalEmbeddingsResult,
} from './storage/repositories/embedding-repository'
import { SearchRepository } from './storage/repositories/search-repository'
import { backfillNameProjectionBatch, setDbProjectionSyncGuard, clearDbProjectionSyncGuard, type NameProjectionBackfillBounds, type NameProjectionBackfillResult } from './name-search-projection'
import type { SyncMetadataGuard } from './runtime/sync-metadata-admission'
import {
  ProgressRepository,
  type DocumentChunkProgress,
  type FolderChunkProgress,
  type DocumentMemoryStats,
} from './storage/repositories/progress-repository'
import { MaintenanceRepository, FTS_MERGE_PAGES } from './storage/repositories/maintenance-repository'
import { DiagnosticsRepository } from './storage/repositories/diagnostics-repository'
import type { DocumentIndexStorageBudget } from './storage-budget'
import type { EmbeddingProfile } from './embedding-profiles'
import type { USearchIndex } from './usearch-index'
import type { AnnPreauthorizedPermit } from './ann-index'
import type {
  GarbageCollectionStats,
  StorageFreelistStats,
  IncrementalVacuumOptions,
  VacuumResult,
} from './storage-gc'

export type {
  DocumentStatus, TruncatedReason, StoredDocument, ReplacementDocument,
  DocumentChunkProgress, FolderChunkProgress, DocumentMemoryStats,
  GarbageCollectionStats, StorageFreelistStats, IncrementalVacuumOptions, VacuumResult,
  SliceOptions, BatchSliceInfo, BatchCommitInfo, BatchHookDecision,
  RepairInvalidCanonicalEmbeddingsResult, FileImportanceOverride,
  FileImportanceSuggestion, FileImportanceEffective, FileImportanceInfo,
  NameProjectionBackfillResult,
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
  media?: import('./media/media-types').MediaHitInfo // images/videos: kind, dimensions, duration, ocrCandidate, sensitive
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
  getStorageBudget?: () => DocumentIndexStorageBudget
  getConfigVersion?: () => number | null
  syncAdmission?: SyncMetadataGuard
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
    if (options.getStorageBudget) {
      this.maintRepo.setStorageBudgetProvider(options.getStorageBudget, options.getConfigVersion)
    }
    this.searchRepo = new SearchRepository(this.db, hotMeta, this.maintRepo)
    this.progressRepo = new ProgressRepository(this.db)
    this.diagRepo = new DiagnosticsRepository(this.db, dbPath)

    if (options.syncAdmission) setDbProjectionSyncGuard(this.db, options.syncAdmission)
    this.docRepo = new DocumentRepository(
      this.db,
      this.chunkRepo,
      this.embRepo,
      () => this.ocr,
      (spaceId, ids, vecs) => this.maintRepo.onAnnVectorsAdded(spaceId, ids, vecs),
      (ids) => this.maintRepo.onAnnVectorsRemoved(ids),
      options.syncAdmission,
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
      } catch (err: unknown) {
        void err
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
  backfillCounters(spaceOrLimit?: string | number, maxDocuments = COUNTER_BACKFILL_SLICE): boolean {
    return typeof spaceOrLimit === 'number'
      ? this.progressRepo.backfillCounters(undefined, spaceOrLimit)
      : this.progressRepo.backfillCounters(spaceOrLimit, maxDocuments)
  }
  hasUncountedDocuments(): boolean {
    return this.progressRepo.hasUncountedDocuments()
  }
  remember(path: string): boolean {
    return this.docRepo.remember(path)
  }
  enrollDiscovered(path: string, mtimeMs: number, sizeBytes: number): boolean {
    return this.docRepo.enrollDiscovered(path, mtimeMs, sizeBytes)
  }
  enrollMedia(path: string, mtimeMs: number, sizeBytes: number) { return this.docRepo.enrollMedia(path, mtimeMs, sizeBytes) }
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
  chunkProgress(path: string, activeSpaceId?: string): DocumentChunkProgress {
    return this.progressRepo.chunkProgress(path, activeSpaceId)
  }
  getEmbeddingCounts(documentId: number, spaceId?: string): number {
    return this.embRepo.getEmbeddingCounts(documentId, spaceId)
  }
  boostFolder(root: string, at: number): void {
    this.docRepo.boostFolder(root, at)
  }
  folderChunkProgress(root?: string, activeSpaceId?: string): FolderChunkProgress {
    return this.progressRepo.folderChunkProgress(root, activeSpaceId)
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
  markError(path: string, error: string, metadata?: { mtimeMs: number; sizeBytes: number } | null): void { this.docRepo.markError(path, error, metadata) }
  recordTransientError(path: string, error: string, metadata?: { mtimeMs: number; sizeBytes: number } | null): boolean {
    return this.docRepo.recordTransientError(path, error, metadata)
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
    this.docRepo.move(oldPath, newPath)
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
    this.docRepo.exclude(path)
  }
  clear(): void {
    this.docRepo.clear()
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
  getEmbeddingSpaces() { return this.embRepo.getEmbeddingSpaces() }
  getAnnIndex(spaceId: string, dimensions: number): USearchIndex { return this.maintRepo.getAnnIndex(spaceId, dimensions) }
  markAnnDirty(spaceId: string): void { this.maintRepo.markAnnDirty(spaceId) }
  rebuildAnnIndex(spaceId: string, hostPermit?: AnnPreauthorizedPermit) { return this.maintRepo.rebuildAnnIndex(spaceId, hostPermit) }
  syncAnnIndex(spaceId: string, hostPermit?: AnnPreauthorizedPermit) { return this.maintRepo.syncAnnIndex(spaceId, hostPermit) }
  invalidateAnnInMemory(spaceId: string): void { this.maintRepo.invalidateAnnInMemory(spaceId) }
  getAnnCanonicalMeta(spaceId: string) { return this.maintRepo.getAnnCanonicalMeta(spaceId) }
  getImportance(pathOrId: string | number) { return this.docRepo.getImportance(pathOrId) }
  setImportanceOverride(pathOrId: string | number, override: FileImportanceOverride) { return this.docRepo.setImportanceOverride(pathOrId, override) }
  setImportanceSuggestion(pathOrId: string | number, suggestion: FileImportanceSuggestion, reason: string | null) { return this.docRepo.setImportanceSuggestion(pathOrId, suggestion, reason) }
  hasNameProjection(): boolean {
    return this.searchRepo.hasNameProjection()
  }
  backfillNameProjectionBatch(batchSize = 100, bounds?: NameProjectionBackfillBounds): NameProjectionBackfillResult {
    return backfillNameProjectionBatch(this.db, batchSize, bounds)
  }
  repairInvalidCanonicalEmbeddings(
    targetSpaceIdOrOnDirty?: string | ((spaceId: string) => void) | { spaceId?: string; onSpaceDirty?: (spaceId: string) => void },
    targetSpaceIdArg?: string,
  ): RepairInvalidCanonicalEmbeddingsResult {
    const cb =
      typeof targetSpaceIdOrOnDirty === 'function'
        ? targetSpaceIdOrOnDirty
        : typeof targetSpaceIdOrOnDirty === 'object' && targetSpaceIdOrOnDirty !== null && 'onSpaceDirty' in targetSpaceIdOrOnDirty
          ? targetSpaceIdOrOnDirty.onSpaceDirty
          : undefined
    const target =
      typeof targetSpaceIdOrOnDirty === 'string'
        ? targetSpaceIdOrOnDirty
        : targetSpaceIdArg ??
          (typeof targetSpaceIdOrOnDirty === 'object' && targetSpaceIdOrOnDirty !== null && 'spaceId' in targetSpaceIdOrOnDirty
            ? targetSpaceIdOrOnDirty.spaceId
            : undefined)
    return this.embRepo.repairInvalidCanonicalEmbeddings(cb, target)
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
  setStorageBudget(budget: DocumentIndexStorageBudget): void { this.maintRepo.setStorageBudget(budget) }
  getStorageBudget(): DocumentIndexStorageBudget { return this.maintRepo.getStorageBudget() }
  close(): void {
    clearDbProjectionSyncGuard(this.db); this.maintRepo.close(); this.db.close()
  }
  getStorageDiagnostics(
    backupPath?: string,
    budget?: DocumentIndexStorageBudget,
  ): DocumentIndexStorageDiagnostics {
    return this.diagRepo.getStorageDiagnostics(backupPath, budget)
  }
}
