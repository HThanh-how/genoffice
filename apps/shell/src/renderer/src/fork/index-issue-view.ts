import { isInformationalReason, type IndexIssueReason } from '../../../main/document-memory/issues'

export type IssueBucket = 'attention' | 'background' | 'skipped'

/** A queued file needs no intervention; scans need an explicit reading action. */
export function issueBucket(reason: IndexIssueReason): IssueBucket {
  if (reason === 'waiting') return 'background'
  if (reason === 'no-text') return 'attention'
  return isInformationalReason(reason) ? 'skipped' : 'attention'
}
