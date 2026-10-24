export type StatusRequest =
  | { op: 'issueIds'; root: string; reason?: import('../issues').IndexIssueReason }
  | { op: 'browse'; query: import('../../../shared/fork/index-browser').IndexBrowserQuery }
  | { op: 'detail'; id: number }
  | { op: 'stats'; space?: string }
  | { op: 'folder'; root?: string; space?: string }
  | { op: 'issues'; root: string }
  | { op: 'search'; query: string }
  | { op: 'legacy'; extensions: readonly string[]; limit: number }
