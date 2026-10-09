export type StatusRequest =
  | { op: 'stats'; space?: string }
  | { op: 'folder'; root?: string; space?: string }
  | { op: 'issues'; root: string }
  | { op: 'search'; query: string }
  | { op: 'legacy'; extensions: readonly string[]; limit: number }
