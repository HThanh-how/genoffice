import type { IndexIssueSummary } from '../../../main/document-memory/issue-reader'
import { isRetryableReason, type IndexIssueReason } from '../../../main/document-memory/issues'

/**
 * The ~13 technical reasons a file can fail are folded into a handful of groups a person can read at
 * a glance. Waiting files are not a problem (they are just queued) and blank files are skipped on
 * purpose, so both sit apart from the groups that need a person.
 */
export type IssueCategory = 'locked' | 'damaged' | 'unsupported' | 'ocr' | 'gone' | 'other'

export const ISSUE_CATEGORIES: readonly IssueCategory[] = [
  'locked',
  'damaged',
  'ocr',
  'unsupported',
  'gone',
  'other',
]

export type IssueSection = IssueCategory | 'waiting' | 'auto'

const SECTION_OF: Record<IndexIssueReason, IssueSection> = {
  permission: 'locked',
  timeout: 'locked',
  changed: 'locked',
  corrupt: 'damaged',
  password: 'damaged',
  'too-large': 'unsupported',
  unsupported: 'unsupported',
  'no-text': 'ocr',
  unavailable: 'gone',
  model: 'other',
  other: 'other',
  waiting: 'waiting',
  empty: 'auto',
}

export function sectionOf(reason: IndexIssueReason): IssueSection {
  return SECTION_OF[reason] ?? 'other'
}

export interface IssueSectionRow {
  id: IssueSection
  reasons: IndexIssueReason[]
  count: number
  /** one tap can queue these files again (a retry may change the outcome) */
  retryable: boolean
}

export interface IssueSections {
  /** groups that need a person, biggest first */
  needs: IssueSectionRow[]
  /** queued files; not a problem */
  waiting: IssueSectionRow | null
  /** blank files skipped automatically; not an error */
  auto: IssueSectionRow | null
}

/** Whether a retry button makes sense: some reason in the group can succeed on a second try. */
function groupRetryable(id: IssueSection, reasons: IndexIssueReason[]): boolean {
  // A deleted file cannot come back by retrying; the person removes it or scans the folder.
  if (id === 'gone' || id === 'waiting' || id === 'auto') return false
  return reasons.some(isRetryableReason)
}

export function buildIssueSections(
  groups: ReadonlyArray<{ reason: IndexIssueReason; count: number }>,
): IssueSections {
  const rows = new Map<IssueSection, IssueSectionRow>()
  for (const g of groups) {
    if (g.count <= 0) continue
    const id = sectionOf(g.reason)
    const row = rows.get(id) ?? { id, reasons: [], count: 0, retryable: false }
    row.reasons.push(g.reason)
    row.count += g.count
    rows.set(id, row)
  }
  for (const row of rows.values()) row.retryable = groupRetryable(row.id, row.reasons)
  const needs = ISSUE_CATEGORIES.map((id) => rows.get(id)).filter(
    (row): row is IssueSectionRow => !!row,
  )
  return { needs, waiting: rows.get('waiting') ?? null, auto: rows.get('auto') ?? null }
}

/** The same summary narrowed to some reasons, so a list can show just one group. */
export function narrowSummary(
  summary: IndexIssueSummary,
  reasons: readonly IndexIssueReason[],
): IndexIssueSummary {
  const groups = summary.groups.filter((g) => reasons.includes(g.reason))
  return { ...summary, groups, total: groups.reduce((n, g) => n + g.count, 0) }
}
