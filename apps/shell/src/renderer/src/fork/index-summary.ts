import type { HomeApi, HomeIndexingActivity } from '../../../shared/home-api'
import type { IndexIssueSummary } from '../../../main/document-memory/issue-reader'
import type { IndexIssueReason } from '../../../main/document-memory/issues'
import { issueBucket } from './index-issue-view'
import { isIndexIssueSummary, readIndexRequest } from './index-request'

/**
 * One reading of the index for every place that shows a number about it (sidebar entry, tab badge,
 * overview, Home dock chip). Rules:
 *  - waiting  = files in the queue. Not a failure.
 *  - problems = files in groups the person can act on (failed, unreadable, permission...). Files with
 *    nothing to read (blank files, scans that need OCR) are skipped automatically and never counted
 *    here; they are reported on their own as `empty`.
 */
export interface IndexSummary {
  /** 0-100, or null while unknown */
  percent: number | null
  waiting: number
  problems: number
  /** the groups that make up `problems` */
  problemGroups: Array<{ reason: IndexIssueReason; count: number }>
  /** files with no text to read; informational, not a problem */
  empty: number
  /** the index is switched on */
  enabled: boolean
  /** a scan is running or files are still queued */
  active: boolean
}

export interface IndexSummaryInput {
  activity: HomeIndexingActivity | null
  /** memory status of the dashboard, when it has one (same queue size as the activity) */
  memoryPending?: number
  /** issue groups for all folders; without them the failed-file count of the activity is used */
  attention?: IndexIssueSummary | null
}

/** A group the person has to deal with. 'no-text' (scans, blank files) is skipped, not a problem. */
export function isProblemReason(reason: IndexIssueReason): boolean {
  return issueBucket(reason) === 'attention' && reason !== 'no-text'
}

export function deriveIndexSummary({
  activity,
  memoryPending,
  attention,
}: IndexSummaryInput): IndexSummary {
  const progress = activity?.folderProgress ?? null
  const waiting = Math.max(0, memoryPending ?? progress?.pendingFiles ?? activity?.memory.pending ?? 0)
  const readyFiles = progress?.readyFiles ?? 0
  const totalFiles = progress?.totalFiles ?? readyFiles + waiting
  let percent: number | null = progress?.percent ?? null
  if (percent === null && totalFiles > 0)
    percent = Math.min(100, Math.round((readyFiles / totalFiles) * 100))

  const problemGroups = attention ? attention.groups.filter((g) => isProblemReason(g.reason)) : []
  const problems = attention
    ? problemGroups.reduce((n, g) => n + g.count, 0)
    : Math.max(0, progress?.errorFiles ?? activity?.memory.errors ?? 0)

  return {
    percent,
    waiting,
    problems,
    problemGroups,
    empty: Math.max(0, progress?.emptyFiles ?? 0),
    enabled: activity?.memory.enabled ?? true,
    active: !!activity?.folder?.running || waiting > 0,
  }
}

/** Reads the activity and the issue groups once and folds them; falls back to the activity alone. */
export async function loadIndexSummary(api: HomeApi): Promise<IndexSummary | null> {
  if (!api.getIndexingActivity) return null
  const [activity, issues] = await Promise.allSettled([
    api.getIndexingActivity(),
    api.getDocumentIndexIssueSummary
      ? readIndexRequest(() => api.getDocumentIndexIssueSummary('*'), isIndexIssueSummary)
      : Promise.reject(new Error('unavailable')),
  ])
  if (activity.status !== 'fulfilled') return null
  return deriveIndexSummary({
    activity: activity.value,
    attention: issues.status === 'fulfilled' ? issues.value : null,
  })
}

/** The single number a compact surface shows: the queue first, otherwise the real problems. */
export function compactCount(s: IndexSummary): { kind: 'waiting' | 'problems'; n: number } | null {
  if (s.waiting > 0) return { kind: 'waiting', n: s.waiting }
  if (s.problems > 0) return { kind: 'problems', n: s.problems }
  return null
}
