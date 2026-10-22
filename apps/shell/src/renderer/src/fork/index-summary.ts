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

/**
 * A group the person has to deal with. 'no-text' (scans), blank, too large and unsupported files are
 * skipped, not problems. A password-protected file is one: the person can remove the password and try
 * again, and the Issues tab asks exactly that.
 */
export function isProblemReason(reason: IndexIssueReason): boolean {
  if (reason === 'password') return true
  return issueBucket(reason) === 'attention' && reason !== 'no-text'
}

export function deriveIndexSummary({
  activity,
  memoryPending,
  attention,
}: IndexSummaryInput): IndexSummary {
  const progress = activity?.folderProgress ?? null
  const waiting = Math.max(
    0,
    memoryPending ?? progress?.pendingFiles ?? activity?.memory.pending ?? 0,
  )
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

/** Largest number a badge prints; beyond it the badge says "99+". */
export const BADGE_CAP = 99

export function capBadge(n: number): string {
  return n > BADGE_CAP ? `${BADGE_CAP}+` : String(n)
}

/**
 * What the sidebar entry shows next to its name. A number is reserved for real problems the person
 * can act on; a long queue is background work, so it only gets a quiet "working" mark and never a
 * count. Nothing at all when the index is calm.
 */
export type NavIndicator = { kind: 'problems'; n: number } | { kind: 'working' } | null

export function navIndicator(s: IndexSummary): NavIndicator {
  if (s.problems > 0) return { kind: 'problems', n: s.problems }
  if (s.enabled && s.active) return { kind: 'working' }
  return null
}
