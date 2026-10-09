import type { FolderOwner } from '../../main/document-memory/folder-scan'
import type { IndexIssueReason } from '../../main/document-memory/issues'
import type { IndexIssueSummary } from '../../main/document-memory/issue-reader'
import type { DbLocationState, DbMoveError } from '../../main/document-memory/db-location'
import type { KnownSearchSource, KnownSearchSourceEntry, KnownSearchSourceStatus } from '../../main/document-memory/known-sources'

import type { DocumentMemoryStatus, HomeIndexingActivity } from '../home-api'
import type { IndexingModeState } from './indexing-mode'

export type { DbLocationState, DbMoveError, FolderOwner, KnownSearchSource, KnownSearchSourceEntry, KnownSearchSourceStatus }

/** User-visible and IPC-exposed storage snapshot. */
export interface StorageBudgetSnapshot {
  databaseBytes: number
  budgetBytes: number
  usageRatio: number
  chunksBytes: number
  embeddingsBytes: number
  ftsBytes: number
  ocrBytes: number
  backupBytes: number
  reclaimableBytes: number
  limitState: 'ok' | 'warning' | 'full'
  totalManagedBytes?: number
  protectedBytes?: number
  reusableFreelistBytes?: number
  breakdown?: {
    activeDbBytes: number
    walBytes: number
    shmBytes: number
    annBytes: number
    ocrExternalBytes: number
    tempBytes: number
    backupBytes: number
    protectedBackupBytes: number
    reusableFreelistBytes: number
    modelWeightsBytes: number
  }
  modelBytes?: number
  configVersion?: number
  measurementStatus?: 'unknown' | 'measuring' | 'fresh' | 'stale' | 'degraded'
  isDegraded?: boolean
  measuredAt?: number
  lastAttemptAt?: number
  measurementError?: string
  /** True while soft quota <= used < hardCapBytes: writes still admitted, compaction urgent. */
  graceActive?: boolean
  /** Bytes above the soft quota (0 when under it). */
  overQuotaBytes?: number
  /** Physical hard stop: the soft quota plus the grace overshoot (10%). */
  nameMetadataBytes?: number
  nameMetadataReserveBytes?: number
  contentWriteCapBytes?: number
  hardCapBytes?: number
  /** The user-facing soft quota (same value as budgetBytes). */
  softBudgetBytes?: number
}

/** Storage diagnostics breakdown and high-level database metrics. */
export interface DocumentIndexStorageDiagnostics {
  activeDbSizeBytes: number
  walSizeBytes: number
  pageSize: number
  pageCount: number
  freelistCount: number
  estimatedReclaimableBytes: number
  v2BackupSizeBytes: number | null
  schemaVersion: string
  migrationStatus: 'completed' | 'in-progress' | 'none'
  topOffendersByChunks: Array<{ id: number; path: string; name: string; chunks: number; truncated: boolean }>
  topOffendersBySize: Array<{ id: number; path: string; name: string; sizeBytes: number; chunks: number }>
  breakdown?: {
    chunksBytes: number
    embeddingsBytes: number
    ftsBytes: number
    documentsBytes: number
    ocrBytes: number
    otherBytes: number
  }
  databaseBytes?: number
  budgetBytes?: number
  usageRatio?: number
  chunksBytes?: number
  embeddingsBytes?: number
  ftsBytes?: number
  ocrBytes?: number
  backupBytes?: number | null
  reclaimableBytes?: number
  limitState?: 'ok' | 'warning' | 'full'
  /**
   * Last storage compaction run by the indexing worker (JSON: status, bytes before/after, the retention report with
   * its redundancy tiers and age buckets, released vectors/skeletons). Null/absent until a run happened.
   */
  lastCompaction?: Record<string, unknown> | null
}

/** Performance diagnostics: event-loop lag and SQLite latency profiling. */
export interface DocumentIndexPerformanceDiagnostics {
  eventLoop: {
    p50: number
    p95: number
    p99: number
    max: number
  }
  sqliteLatency: {
    slowOperationCount: number
    criticalOperations: Array<{ operation: string; durationMs: number; timestamp: number }>
  }
  paused: boolean
  cpuShare: number
}

/** Migration progress and current embedding space state. */
export interface DocumentIndexMigrationDiagnostics {
  activeEmbeddingSpace: string
  state: string
  completedChunks: number
  totalChunks: number
  lastGcTimestamp?: number
}

/** Detailed diagnostics breakdown for storage, migration, and performance. */
export interface DocumentIndexDiagnostics {
  storage: DocumentIndexStorageDiagnostics
  migration: DocumentIndexMigrationDiagnostics
  timestamp: number
}

/** Consolidated snapshot of document memory and background indexing status. */
export interface DocumentIndexSnapshot {
  memory: DocumentMemoryStatus
  activity: HomeIndexingActivity
  mode: IndexingModeState | null
  issues: IndexIssueSummary
  now: IndexingNow | null
  storage: DocumentIndexStorageDiagnostics
  storageBudget?: StorageBudgetSnapshot
  performance: DocumentIndexPerformanceDiagnostics
  migration: DocumentIndexMigrationDiagnostics
  timestamp: number
}

/** The answer to "move the index here": nothing moves until the app restarts. */
export type DbMoveResult =
  { ok: true; sizeBytes: number } | { ok: false; canceled?: boolean; error?: DbMoveError }

/** IPC channels added by the document-index popup rework (fork-only). */
export const DOCUMENT_INDEX_CHANNELS = {
  getDocumentIndexSnapshot: 'home:get-document-index-snapshot',
  getDocumentIndexStorageBudget: 'home:get-document-index-storage-budget',
  getDocumentIndexIssueSummary: 'home:get-document-index-issue-summary',
  retryDocumentIndexGroup: 'home:retry-document-index-group',
  listIndexedFolders: 'home:list-indexed-folders',
  setIndexedFolderPriority: 'home:set-indexed-folder-priority',
  rescanIndexedFolder: 'home:rescan-indexed-folder',
  forgetIndexedFolder: 'home:forget-indexed-folder',
  getKnownSearchSources: 'home:get-known-search-sources',
  setKnownSearchSource: 'home:set-known-search-source',
  getEmbeddingModel: 'home:get-embedding-model',
  setEmbeddingModel: 'home:set-embedding-model',
  getIndexFileDetail: 'home:get-index-file-detail',
  searchIndexedFiles: 'home:search-indexed-files',
  getIndexingNow: 'home:get-indexing-now',
  stopIndexFile: 'home:stop-index-file',
  enqueueDocumentIndex: 'home:enqueue-document-index',
  deferIndexFile: 'home:defer-index-file',
  getEverything: 'home:get-everything',
  getShowDefaultFolder: 'home:get-show-default-folder',
  openFolderInFileManager: 'home:open-folder-in-file-manager',
  copyFilesToClipboard: 'home:copy-files-to-clipboard',
  pasteFilesFromClipboard: 'home:paste-files-from-clipboard',
  setShowDefaultFolder: 'home:set-show-default-folder',
  getPdfPages: 'home:get-pdf-pages',
  setPdfPages: 'home:set-pdf-pages',
  getDbLocation: 'home:get-db-location',
  chooseDbLocation: 'home:choose-db-location',
  resetDbLocation: 'home:reset-db-location',
  cancelDbMove: 'home:cancel-db-move',
  restartForDbMove: 'home:restart-for-db-move',
  setEverything: 'home:set-everything',
  chooseEverythingExecutable: 'home:choose-everything-executable',
  setIndexFileImportance: 'home:set-index-file-importance',
  getStorageBudgetSettings: 'home:get-storage-budget-settings',
  setStorageBudgetSettings: 'home:set-storage-budget-settings',
  getDocumentIndexBackup: 'home:get-document-index-backup',
  deleteDocumentIndexBackup: 'home:delete-document-index-backup',
} as const

/** The previous (V2) index kept next to the live one after an upgrade. Not counted in the index size. */
export interface DocumentIndexBackupInfo {
  exists: boolean
  /** Bytes the "delete" action would free (backup files including their -wal/-shm). */
  totalBytes: number
  files: number
  /** Newest backup creation time (epoch ms), 0 when unknown. */
  createdAt: number
  /** Days the automatic retention policy keeps it at least. */
  retentionDays: number
  /** False while an upgrade is still in progress or the live index is not usable: deleting is then refused. */
  deletable: boolean
}

export interface DocumentIndexBackupDeleteResult {
  ok: boolean
  freedBytes: number
  deleted: number
  /** 'migration-in-flight' | 'live-index-missing' | 'live-index-not-v3' | 'nothing-to-delete' | an error message. */
  error?: string
}

export type StorageBudgetPreset = '1gb' | '3gb' | '5gb' | 'custom'
export type StorageBudgetStatus = 'applied' | 'pending' | 'error'

export interface StorageBudgetConfig {
  maxDatabaseBytes: number
  preset: StorageBudgetPreset
  version?: number
  appliedVersion?: number | null
  status?: StorageBudgetStatus
  error?: string
  appliedBudgetBytes?: number | null
}

/** Everything (voidtools) as an optional, instant file-name search next to the document index. */
export interface EverythingState {
  /** only Windows has it */
  supported: boolean
  enabled: boolean
  /** es.exe was found, so the feature can work (Everything itself must also be running) */
  found: boolean
  /** the es.exe path the person set, if any */
  path?: string
}

/** How many pages of each PDF are read and indexed. */
export interface PdfPagesState {
  pages: number
  /** what it is until the person changes it */
  default: number
  /** the most it can be set to */
  max: number
}

/** What pasting the clipboard's files into a folder did. */
export interface PasteFilesResult {
  pasted: number
  failed: number
  /** the clipboard holds no files */
  none?: boolean
  error?: string
}

/** standard/high are the original models (kept for existing installs); base..plus are the hardware tiers. */
export type EmbeddingProfileChoice = 'standard' | 'high' | 'base' | 'balanced' | 'mid' | 'plus'

/** The search-model setting, with what this computer can run. */
export interface EmbeddingModelState {
  profile: EmbeddingProfileChoice
  /** the model that suits this computer */
  recommended: EmbeddingProfileChoice
  /** why a bigger model is not advised here (absent for the top tier) */
  limit?: 'memory' | 'cpu'
  /** whether the model files of the profile in use are already on this computer (absent = unknown) */
  modelCached?: boolean
  machine: { totalMemGiB: number; logicalCores: number }
  profiles: Record<
    EmbeddingProfileChoice,
    {
      name: string
      dimensions: number
      downloadMB: number
      memoryMB: number
      embeddingId?: string
    }
  >
}

/**
 * Why files are waiting while nothing is being read: the line is held on purpose, for a reason a person can read.
 * (A policy pause - battery, locked screen, low memory, the user - is `paused` instead.)
 */
export type IndexingBlockReason =
  /** the index process is starting or being restarted; it has not confirmed the storage limits yet */
  | 'storage-starting'
  /** the storage measurement is being redone before more is written (stale, unknown or degraded) */
  | 'storage-checking'
  /** the vector step is backing off after a refusal or an error, and extraction is waiting for it */
  | 'embedding-retry'
  /** the search model cannot run right now (downloading, blocked or failed) */
  | 'model-unavailable'
  /** files are waiting and nothing is running or armed to run: the queue is stuck (also logged to document-memory.log) */
  | 'stalled'

/** What the indexer is doing this moment, so a waiting file can show whether it is being read. */
export interface IndexingNow {
  /** Queued embedding checkpoints remain in embedding; only this path is running a batch. */
  activeEmbeddingPath?: string | null
  /** files being read right now, with when each started (epoch ms) */
  extracting: Array<{ path: string; since: number }>
  /** files whose passages are being turned into search vectors, with how far */
  embedding: Record<string, { done: number; total: number }>
  /** place in the waiting line (1 = next) for the first few hundred files */
  positions: Record<string, number>
  /** pages read so far of a large PDF that is being read in turns (reading now or waiting) */
  pages: Record<string, { done: number; total: number }>
  queued: number
  /** background work is paused (battery, locked screen, low memory, or by the user) */
  paused: boolean
  /** set while files wait and nothing runs for a reason other than `paused`: "idle but pending" is never silent */
  blocked?: IndexingBlockReason
}

/** One file found by name in the index, whatever state it is in. */
export interface IndexedFileHit {
  id: number
  path: string
  name: string
  status: string
  /** why it has a problem; absent for a file that was read fine */
  reason?: IndexIssueReason
  error?: string
  progress?: { kind: 'ocr' | 'chunks'; done: number; total: number }
  /** found on disk by name only (Everything); not in the index, so `id` is 0 */
  external?: boolean
}

/** How far one file got through the pipeline, for the file's detail view. */
export interface IndexFileDetail {
  id: number
  path: string
  name: string
  status: string
  /** the raw error stored with the file, if any */
  error?: string
  sizeBytes?: number
  /** when the file was last modified on disk (epoch ms) */
  mtimeMs?: number
  /** when the index last touched this file (epoch ms) */
  updatedAt: number
  /** the file is still on disk */
  exists: boolean
  /** the search model that embedded it */
  embeddingModel?: string
  /** only the first part of a long file was read */
  truncated: boolean
  chunkTotal: number
  chunkDone: number
  /** scanned-PDF reading: pages of the file, pages with their own text, pages read by OCR */
  pdf?: {
    totalPages: number
    scannedPages: number
    ocrPages: number
    ocrChars: number
    ocrModel?: string
  }
  importance?: FileImportanceInfo
}

export type FileImportanceOverride = 'auto' | 'important' | 'low'
export type FileImportanceSuggestion = 'unknown' | 'normal' | 'important'
export type FileImportanceEffective = 'important' | 'normal' | 'low'

export interface FileImportanceInfo {
  override: FileImportanceOverride
  suggestion: FileImportanceSuggestion
  reason: string | null
  effective: FileImportanceEffective
  updatedAt: number
}

/** One finished scan or refresh of a folder. */
export interface IndexedFolderRun {
  kind: 'scan' | 'refresh'
  state: 'complete' | 'stopped' | 'unavailable'
  startedAt: number
  endedAt: number
  discovered: number
  enrolled: number
  skipped: number
  errors: number
}

/** A folder the user asked to index, with when it was last read and what is in the index now. */
export interface IndexedFolder {
  root: string
  owners?: FolderOwner[]
  state: 'running' | 'complete' | 'stopped'
  priority: boolean
  /** a PC folder that is not reachable right now (unplugged drive...) */
  unavailable: boolean
  startedAt?: number
  completedAt?: number
  reconciledAt?: number
  lastError?: string
  /** files in the index below this folder */
  totalFiles: number
  readyFiles: number
  pendingFiles: number
  waitingFiles?: number
  /** vectors released to save space: still searchable, reloaded when opened */
  releasedFiles?: number
  errorFiles: number
  emptyFiles?: number
  completedChunks?: number
  totalChunks?: number
  history: IndexedFolderRun[]
}

/** Renderer-facing document-index methods, merged into HomeApi via ForkHomeApi. */
export interface DocumentIndexApi {
  /** Prioritise a bounded batch without waiting for parsing/embedding to complete. */
  enqueueDocumentIndex?(
    documentIds: number[],
  ): Promise<{ queued: number; skipped: number; error?: string }>
  /** Problem files below `root` grouped by plain-language reason, with counts. */
  getDocumentIndexIssueSummary(root: string): Promise<IndexIssueSummary>
  /** Re-queue every problem file (or one reason's files); reason 'model' restarts the model. */
  retryDocumentIndexGroup(
    root: string,
    reason?: IndexIssueReason,
  ): Promise<{ ok: boolean; retried: number; error?: string }>
  /** Every folder that was scanned, most recent first, with history and live index counts. */
  listIndexedFolders(): Promise<IndexedFolder[]>
  /** Index this folder's waiting files before other folders'. */
  setIndexedFolderPriority(root: string, priority: boolean): Promise<boolean>
  /** Scan the folder again now. */
  rescanIndexedFolder(root: string): Promise<{ ok: boolean; error?: string }>
  /** Stop watching a folder and drop it from the list (indexed files stay searchable). */
  forgetIndexedFolder(root: string): Promise<boolean>
  /** Retrieve the list of known search sources (Documents, Downloads, Desktop) with their paths and enabled states. */
  getKnownSearchSources(): Promise<KnownSearchSourceEntry[]>
  /** Enable or disable a known search source; toggles scanning and watching. */
  setKnownSearchSource(id: KnownSearchSource, enabled: boolean): Promise<KnownSearchSourceEntry | void>
  /** Files in the index whose name or folder matches every word typed (accents ignored). */
  searchIndexedFiles(query: string): Promise<IndexedFileHit[]>
  /** Which files the indexer is reading now and who is next. */
  getIndexingNow(): Promise<IndexingNow>
  /** Where the index file is kept, how big it is, and any move waiting for a restart. */
  getDbLocation(): Promise<DbLocationState>
  /** Pick a folder for the index; the move is scheduled and done at the next start. */
  chooseDbLocation(): Promise<DbMoveResult>
  /** Schedule moving the index back to the app's own data folder. */
  resetDbLocation(): Promise<DbMoveResult>
  /** Drop a scheduled move. */
  cancelDbMove(): Promise<void>
  /** Restart the app now so the scheduled move is carried out. */
  restartForDbMove(): Promise<void>
  /** How many pages of each PDF are read (the first ones: a book's contents are in them). */
  getPdfPages(): Promise<PdfPagesState>
  /** Change it (1 to 400); raising it reads the PDFs that were cut short again. */
  setPdfPages(pages: number): Promise<PdfPagesState & { requeued: number }>
  /** Open a folder in Explorer / Finder (the folder itself, not its parent). */
  openFolderInFileManager(dir: string): Promise<boolean>
  /** Put files on the system clipboard so Explorer / Finder can paste them. */
  copyFilesToClipboard(paths: string[]): Promise<boolean>
  /** Paste the files that are on the system clipboard (copied in Explorer too) into a folder. */
  pasteFilesFromClipboard(dir: string): Promise<PasteFilesResult>
  /** Whether the app's own save folder ("GenOffice") is listed in the Folders tree (off by default). */
  getShowDefaultFolder(): Promise<boolean>
  setShowDefaultFolder(show: boolean): Promise<boolean>
  /** Whether the Everything search is on, and whether this computer has es.exe. */
  getEverything(): Promise<EverythingState>
  /** Turn it on or off, optionally pointing at es.exe; returns the new state. */
  setEverything(change: { enabled: boolean; path?: string }): Promise<EverythingState>
  /** Pick an Everything executable via system file picker; returns the new state. */
  chooseEverythingExecutable(): Promise<EverythingState>
  /** Push one file to the back of the line (cutting its read short if it is being read). */
  deferIndexFile(documentId: number): Promise<{ ok: boolean; error?: string }>
  /** Stop reading one waiting file; it stays in the list as a problem to retry. */
  stopIndexFile(documentId: number): Promise<{ ok: boolean; error?: string }>
  /** How far one file got: found, read, OCR, embedded. Null when the file is not in the index. */
  getIndexFileDetail(documentId: number): Promise<IndexFileDetail | null>
  /** Set file importance override (auto | important | low). */
  setIndexFileImportance?(documentId: number, importance: FileImportanceOverride): Promise<{ ok: boolean; error?: string }>
  getEmbeddingModel(): Promise<EmbeddingModelState>
  /** Switch the search model; documents are read again with it in the background. */
  setEmbeddingModel(profile: EmbeddingProfileChoice): Promise<{ ok: boolean; requeued: number }>
  /** Consolidated snapshot of document memory and background indexing status (cached on main thread). */
  getDocumentIndexSnapshot(forceRefresh?: boolean): Promise<DocumentIndexSnapshot>
  /** Storage budget snapshot and user-visible limits. */
  getDocumentIndexStorageBudget?(): Promise<StorageBudgetSnapshot>
  /** Storage budget configuration (presets: 1GB, 3GB, 5GB, custom). */
  getStorageBudgetSettings?(): Promise<StorageBudgetConfig>
  /** Update storage budget configuration. */
  setStorageBudgetSettings?(
    settings: { maxDatabaseBytes?: number; preset?: StorageBudgetPreset; version?: number } | number,
  ): Promise<{ ok: boolean; settings?: StorageBudgetConfig; error?: string }>
  /** The old index backup kept after an upgrade (size, age, whether it can be deleted now). */
  getDocumentIndexBackup?(): Promise<DocumentIndexBackupInfo>
  /** Deletes the old index backup. Only the backup files next to the live index; never the user's documents. */
  deleteDocumentIndexBackup?(): Promise<DocumentIndexBackupDeleteResult>
}
