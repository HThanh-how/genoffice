import type { IndexIssueReason } from '../../main/document-memory/issues'
import type { IndexIssueSummary } from '../../main/document-memory/issue-reader'

/** IPC channels added by the document-index popup rework (fork-only). */
export const DOCUMENT_INDEX_CHANNELS = {
  getDocumentIndexIssueSummary: 'home:get-document-index-issue-summary',
  retryDocumentIndexGroup: 'home:retry-document-index-group',
  listIndexedFolders: 'home:list-indexed-folders',
  setIndexedFolderPriority: 'home:set-indexed-folder-priority',
  rescanIndexedFolder: 'home:rescan-indexed-folder',
  forgetIndexedFolder: 'home:forget-indexed-folder',
  getEmbeddingModel: 'home:get-embedding-model',
  setEmbeddingModel: 'home:set-embedding-model',
  getIndexFileDetail: 'home:get-index-file-detail',
  searchIndexedFiles: 'home:search-indexed-files',
  getIndexingNow: 'home:get-indexing-now',
} as const

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
    { name: string; dimensions: number; downloadMB: number; memoryMB: number }
  >
}

/** What the indexer is doing this moment, so a waiting file can show whether it is being read. */
export interface IndexingNow {
  /** files being read right now, with when each started (epoch ms) */
  extracting: Array<{ path: string; since: number }>
  /** files whose passages are being turned into search vectors, with how far */
  embedding: Record<string, { done: number; total: number }>
  /** place in the waiting line (1 = next) for the first few hundred files */
  positions: Record<string, number>
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
  history: IndexedFolderRun[]
}

/** Renderer-facing document-index methods, merged into HomeApi via ForkHomeApi. */
export interface DocumentIndexApi {
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
  /** Files in the index whose name or folder matches every word typed (accents ignored). */
  searchIndexedFiles(query: string): Promise<IndexedFileHit[]>
  /** Which files the indexer is reading now and who is next. */
  getIndexingNow(): Promise<IndexingNow>
  /** How far one file got: found, read, OCR, embedded. Null when the file is not in the index. */
  getIndexFileDetail(documentId: number): Promise<IndexFileDetail | null>
  getEmbeddingModel(): Promise<EmbeddingModelState>
  /** Switch the search model; documents are read again with it in the background. */
  setEmbeddingModel(profile: EmbeddingProfileChoice): Promise<{ ok: boolean; requeued: number }>
}
