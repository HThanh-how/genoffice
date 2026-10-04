import { ISSUE_REASON_ORDER, type IndexIssue } from '../../../main/document-memory/issues'
import type { IndexIssueSummary } from '../../../main/document-memory/issue-reader'
import type { IndexFileDetail, IndexingNow } from '../../../shared/fork/document-index-api'

const issueReasons: ReadonlySet<string> = new Set(ISSUE_REASON_ORDER)
export const INDEX_ISSUE_PAGE_SIZE = 10

/** Bound read-only Index IPC calls so a missing preload handler cannot leave the UI loading forever. */
export async function readIndexRequest<T>(
  request: () => Promise<unknown>,
  isValid: (value: unknown) => value is T,
  timeoutMs = INDEX_ISSUE_READ_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const value = await Promise.race([
      Promise.resolve().then(request),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Index request timed out')), timeoutMs)
      }),
    ])
    if (!isValid(value)) throw new Error('Invalid index response')
    return value
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export const INDEX_ISSUE_READ_TIMEOUT_MS = 8_000

function isProgress(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const progress = value as { kind?: unknown; done?: unknown; total?: unknown }
  return (
    (progress.kind === 'ocr' || progress.kind === 'chunks') &&
    Number.isSafeInteger(progress.done) &&
    (progress.done as number) >= 0 &&
    Number.isSafeInteger(progress.total) &&
    (progress.total as number) > 0
  )
}

export function isIndexIssuePage(value: unknown): value is { total: number; items: IndexIssue[] } {
  if (typeof value !== 'object' || value === null) return false
  const page = value as { total?: unknown; items?: unknown }
  return (
    Number.isSafeInteger(page.total) &&
    (page.total as number) >= 0 &&
    Array.isArray(page.items) &&
    page.items.length <= 10 &&
    page.items.every((item) => {
      if (typeof item !== 'object' || item === null) return false
      const issue = item as Partial<IndexIssue>
      return (
        Number.isSafeInteger(issue.id) &&
        (issue.id as number) > 0 &&
        typeof issue.path === 'string' &&
        typeof issue.name === 'string' &&
        typeof issue.reason === 'string' &&
        issueReasons.has(issue.reason) &&
        (issue.error === undefined || typeof issue.error === 'string') &&
        (issue.progress === undefined || isProgress(issue.progress))
      )
    })
  )
}

export function isIndexingNow(value: unknown): value is IndexingNow {
  if (typeof value !== 'object' || value === null) return false
  const now = value as Partial<IndexingNow>
  const progressMap = (entry: unknown): boolean =>
    typeof entry === 'object' &&
    entry !== null &&
    Object.values(entry).every(
      (progress) =>
        typeof progress === 'object' &&
        progress !== null &&
        Number.isSafeInteger(progress.done) &&
        progress.done >= 0 &&
        Number.isSafeInteger(progress.total) &&
        progress.total > 0,
    )
  return (
    Array.isArray(now.extracting) &&
    now.extracting.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof entry.path === 'string' &&
        Number.isFinite(entry.since),
    ) &&
    progressMap(now.embedding) &&
    progressMap(now.pages) &&
    typeof now.positions === 'object' &&
    now.positions !== null &&
    Object.values(now.positions).every(
      (position) => Number.isSafeInteger(position) && position > 0,
    ) &&
    Number.isSafeInteger(now.queued) &&
    (now.queued as number) >= 0 &&
    typeof now.paused === 'boolean'
  )
}

export function isIndexFileDetail(value: unknown): value is IndexFileDetail | null {
  if (value === null) return true
  if (typeof value !== 'object') return false
  const detail = value as Partial<IndexFileDetail>
  return (
    Number.isSafeInteger(detail.id) &&
    (detail.id as number) > 0 &&
    typeof detail.path === 'string' &&
    typeof detail.name === 'string' &&
    typeof detail.status === 'string' &&
    Number.isFinite(detail.updatedAt) &&
    typeof detail.exists === 'boolean' &&
    typeof detail.truncated === 'boolean' &&
    (detail.sizeBytes === undefined ||
      (Number.isFinite(detail.sizeBytes) && detail.sizeBytes >= 0)) &&
    (detail.mtimeMs === undefined || Number.isFinite(detail.mtimeMs)) &&
    (detail.embeddingModel === undefined || typeof detail.embeddingModel === 'string') &&
    Number.isSafeInteger(detail.chunkTotal) &&
    (detail.chunkTotal as number) >= 0 &&
    Number.isSafeInteger(detail.chunkDone) &&
    (detail.chunkDone as number) >= 0 &&
    (detail.error === undefined || typeof detail.error === 'string') &&
    (detail.pdf === undefined ||
      (typeof detail.pdf === 'object' &&
        detail.pdf !== null &&
        Number.isSafeInteger(detail.pdf.totalPages) &&
        detail.pdf.totalPages >= 0 &&
        Number.isSafeInteger(detail.pdf.scannedPages) &&
        detail.pdf.scannedPages >= 0 &&
        Number.isSafeInteger(detail.pdf.ocrPages) &&
        detail.pdf.ocrPages >= 0 &&
        Number.isSafeInteger(detail.pdf.ocrChars) &&
        detail.pdf.ocrChars >= 0 &&
        (detail.pdf.ocrModel === undefined || typeof detail.pdf.ocrModel === 'string')))
  )
}

export function isIndexIssueSummary(value: unknown): value is IndexIssueSummary {
  if (typeof value !== 'object' || value === null) return false
  const summary = value as Partial<IndexIssueSummary>
  return (
    Number.isSafeInteger(summary.total) &&
    (summary.total as number) >= 0 &&
    Array.isArray(summary.groups) &&
    summary.groups.every(
      (group) =>
        typeof group === 'object' &&
        group !== null &&
        issueReasons.has(group.reason) &&
        Number.isSafeInteger(group.count) &&
        group.count >= 0,
    )
  )
}
