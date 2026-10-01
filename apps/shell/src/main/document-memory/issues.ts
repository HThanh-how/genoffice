export type IndexIssueReason =
  | 'unavailable'
  | 'password'
  | 'unsupported'
  | 'timeout'
  | 'no-text'
  | 'too-large'
  | 'changed'
  | 'other'
export interface IndexIssue {
  id: number
  path: string
  name: string
  reason: IndexIssueReason
  error?: string
}

export function issueReason(error: string | null, status: string): IndexIssueReason {
  const value = (error ?? '').toLowerCase()
  if (/unavailable|enoent|eacces|eperm|not found|cannot find/.test(value)) return 'unavailable'
  if (/password|encrypted|encryption/.test(value)) return 'password'
  if (/timeout|timed out/.test(value)) return 'timeout'
  if (/128 mb|exceeds|too large/.test(value)) return 'too-large'
  if (/changed/.test(value)) return 'changed'
  if (status === 'empty' || /no readable|no text|ocr/.test(value)) return 'no-text'
  if (/unsupported|cannot extract|not supported|invalid|corrupt/.test(value)) return 'unsupported'
  return 'other'
}
