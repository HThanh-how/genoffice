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
  getEmbeddingModel(): Promise<EmbeddingModelState>
  /** Switch the search model; documents are read again with it in the background. */
  setEmbeddingModel(profile: EmbeddingProfileChoice): Promise<{ ok: boolean; requeued: number }>
}
