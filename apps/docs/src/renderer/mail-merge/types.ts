/**
 * Mail-merge session types shared by the ribbon, the dialogs and the export
 * pipeline. Recipient identity is the row index in the source: filtering and
 * sorting never renumber a recipient, so an export always writes the rows the
 * user actually chose.
 */

export type MailMergeSourceKind = 'csv' | 'xlsx' | 'sheets'

export interface MailMergeColumn {
  /** the name merge fields refer to (deduplicated, non-empty) */
  name: string
  /** the header text exactly as the source wrote it */
  header: string
  /** >1 when the source has more than one column with this name */
  duplicateOf?: number
}

export interface MailMergeRecipient {
  /** stable index into the source rows */
  id: number
  values: Record<string, string>
  selected: boolean
}

export interface MailMergeSource {
  kind: MailMergeSourceKind
  /** file name, or the workbook title for an open spreadsheet */
  label: string
  sheet?: string
  columns: MailMergeColumn[]
  recipients: MailMergeRecipient[]
  hasHeader: boolean
  delimiter?: string
}

export interface MailMergeFilter {
  search: string
  column: string
  operator: 'contains' | 'equals' | 'empty' | 'notempty'
  value: string
  sortColumn: string
  sortDir: 'asc' | 'desc'
}

export interface MailMergeExportOptions {
  format: 'docx' | 'pdf'
  scope: 'selected' | 'all'
  outputDir: string
  pattern: string
  /** what to do when the target file already exists */
  overwrite: 'skip' | 'rename' | 'overwrite'
  /** PDF only: merge every recipient's pages into one file */
  combined: boolean
}

export interface MailMergeExportError {
  recipient: string
  message: string
}

export interface MailMergeExportProgress {
  total: number
  done: number
  succeeded: number
  failed: number
  skipped: number
  current: string
  errors: MailMergeExportError[]
  cancelled: boolean
}

export interface MailMergeValidationIssue {
  severity: 'error' | 'warning'
  key: string
  detail?: string
}
