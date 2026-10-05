import type { IndexIssueReason } from '../../main/document-memory/issues'
import type { IndexIssueSummary } from '../../main/document-memory/issue-reader'
import type { DbLocationState, DbMoveError } from '../../main/document-memory/db-location'
import type { KnownSearchSource, KnownSearchSourceEntry } from '../../main/document-memory/known-sources'

export type { DbLocationState, DbMoveError, KnownSearchSource, KnownSearchSourceEntry }

/** The answer to "move the index here": nothing moves until the app restarts. */
export type DbMoveResult =
  { ok: true; sizeBytes: number } | { ok: false; canceled?: boolean; error?: DbMoveError }

/** IPC channels added by the document-index popup rework (fork-only). */
export const DOCUMENT_INDEX_CHANNELS = {
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
} as const

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

export type EmbeddingProfileChoice = 'standard' | 'high'

/** The search-model setting, with what this computer can run. */
export interface EmbeddingModelState {
  profile: EmbeddingProfileChoice
  /** the model that suits this computer */
  recommended: EmbeddingProfileChoice
  /** why "high" is not advised here (absent when it is) */
  limit?: 'memory' | 'cpu'
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
  setKnownSearchSource(id: KnownSearchSource, enabled: boolean): Promise<void>
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
  getEmbeddingModel(): Promise<EmbeddingModelState>
  /** Switch the search model; documents are read again with it in the background. */
  setEmbeddingModel(profile: EmbeddingProfileChoice): Promise<{ ok: boolean; requeued: number }>
}
