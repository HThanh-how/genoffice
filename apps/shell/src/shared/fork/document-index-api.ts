import type { IndexIssueReason } from '../../main/document-memory/issues'
import type { IndexIssueSummary } from '../../main/document-memory/issue-reader'

/** IPC channels added by the document-index popup rework (fork-only). */
export const DOCUMENT_INDEX_CHANNELS = {
  getDocumentIndexIssueSummary: 'home:get-document-index-issue-summary',
  retryDocumentIndexGroup: 'home:retry-document-index-group',
} as const

/** Renderer-facing document-index methods, merged into HomeApi via ForkHomeApi. */
export interface DocumentIndexApi {
  /** Problem files below `root` grouped by plain-language reason, with counts. */
  getDocumentIndexIssueSummary(root: string): Promise<IndexIssueSummary>
  /** Re-queue every problem file (or one reason's files); reason 'model' restarts the model. */
  retryDocumentIndexGroup(
    root: string,
    reason?: IndexIssueReason,
  ): Promise<{ ok: boolean; retried: number; error?: string }>
}
