/**
 * Plain-language classification of document-index failures.
 *
 * The raw `error` strings come from the extraction worker, the filesystem and the
 * embedding model. This module turns them into a small, stable set of reasons the UI
 * can explain and act on. It is pure (no I/O) so both main and renderer code can use it.
 */
export type IndexIssueReason =
  /** the file was moved or deleted after it was found */
  | 'unavailable'
  /** the OS refused access (permissions, file locked by another program) */
  | 'permission'
  | 'password'
  /** the file is damaged or its structure cannot be parsed */
  | 'corrupt'
  | 'unsupported'
  | 'timeout'
  /** nothing readable inside a scanned PDF: only OCR can read it */
  | 'no-text'
  /** an Office, text or Markdown file with nothing in it (a blank document): nothing to search */
  | 'empty'
  | 'too-large'
  | 'changed'
  /** the local embedding model could not load or run */
  | 'model'
  /** read in the queue, not read yet */
  | 'waiting'
  | 'other'

export interface IndexIssue {
  id: number
  path: string
  name: string
  reason: IndexIssueReason
  error?: string
  /** Optional: set when only the first part of a long file was indexed. */
  truncated?: boolean
  /** Optional: set when the file is known to have been deleted from disk. */
  deleted?: boolean
  /** Optional: how far the file got (scanned-PDF pages read, or passages embedded). */
  progress?: { kind: 'ocr' | 'chunks'; done: number; total: number }
}

/** Every reason, in the order the UI lists groups (needs-action first, informational last). */
export const ISSUE_REASON_ORDER: readonly IndexIssueReason[] = [
  'model',
  'waiting',
  'timeout',
  'permission',
  'unavailable',
  'corrupt',
  'changed',
  'other',
  'password',
  'no-text',
  'empty',
  'too-large',
  'unsupported',
]

/**
 * Reasons that are a property of the file, not a failure to fix: a retry cannot change
 * the outcome, so the UI treats them as quiet information rather than a warning.
 */
export function isInformationalReason(reason: IndexIssueReason): boolean {
  return (
    reason === 'no-text' ||
    reason === 'empty' ||
    reason === 'too-large' ||
    reason === 'unsupported' ||
    reason === 'password'
  )
}

/** Whether running the index again could plausibly succeed. */
export function isRetryableReason(reason: IndexIssueReason): boolean {
  return (
    reason !== 'no-text' && reason !== 'empty' && reason !== 'too-large' && reason !== 'unsupported'
  )
}

export function issueReason(error: string | null, status: string): IndexIssueReason {
  if (status === 'pending') return 'waiting'
  const value = (error ?? '').toLowerCase()
  // Order matters: the most specific signals first. "Local embedding model unavailable"
  // must not fall into the file-unavailable bucket.
  if (
    /embedding|model (?:is |was )?(?:unavailable|failed|not)|onnx|huggingface|transformers|enotfound|econnreset|etimedout|econnrefused|fetch failed/.test(
      value,
    )
  )
    return 'model'
  if (/password|encrypted|encryption/.test(value)) return 'password'
  if (
    /eacces|eperm|ebusy|permission denied|access is denied|operation not permitted|being used by another process|sharing violation|locked/.test(
      value,
    )
  )
    return 'permission'
  if (/timeout|timed out/.test(value)) return 'timeout'
  if (/128 mb|exceeds|too large/.test(value)) return 'too-large'
  if (/changed/.test(value)) return 'changed'
  if (
    /unavailable|enoent|enotdir|not found|cannot find|no such file|moved|deleted|file is missing|missing file|unknown: unknown error|unknown error, (?:stat|open|read|scandir)/.test(
      value,
    )
  )
    return 'unavailable'
  if (
    /corrupt|malformed|damaged|bad zip|not a zip|zip archive|end of central directory|unexpected end|invalid (?:zip|pdf|xref|header|signature|document|file|format)|failed to parse|cannot parse/.test(
      value,
    )
  )
    return 'corrupt'
  // a file that is not a PDF cannot be OCR'd: blank means blank
  if (/no readable text in this file/.test(value)) return 'empty'
  if (status === 'empty' || /no readable|no text|ocr/.test(value)) return 'no-text'
  if (/unsupported|cannot extract|not supported|invalid/.test(value)) return 'unsupported'
  return 'other'
}

export interface IssueGroupCount {
  reason: IndexIssueReason
  count: number
}

/** Fold per-(status,error) counts into one count per reason, ordered for display. */
export function groupIssueCounts(
  rows: ReadonlyArray<{ status: string; error: string | null; count: number }>,
): IssueGroupCount[] {
  const counts = new Map<IndexIssueReason, number>()
  for (const row of rows) {
    const reason = issueReason(row.error, row.status)
    counts.set(reason, (counts.get(reason) ?? 0) + row.count)
  }
  return ISSUE_REASON_ORDER.flatMap((reason) => {
    const count = counts.get(reason)
    return count ? [{ reason, count }] : []
  })
}

/**
 * A short, human-readable cause for display. Strips stack frames, absolute paths and
 * long repeated whitespace so a raw exception can be shown as a single line.
 */
export function shortCause(error: string | null | undefined, max = 140): string {
  const first = (error ?? '').split(/\r?\n/).find((line) => line.trim()) ?? ''
  const cleaned = first
    .replace(/^(?:[A-Za-z]*Error:\s*)+/, '')
    .replace(/\s+at\s+.+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned
}
