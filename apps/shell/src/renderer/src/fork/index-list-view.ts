import type { IndexingNow } from '../../../shared/fork/document-index-api'

export type IndexViewSort =
  'queue' | 'name' | 'folder' | 'type' | 'progress' | 'status' | 'connection'
export type IndexViewGroup = 'reason' | 'folder' | 'type' | 'none'
export interface ViewFile {
  id: number
  name: string
  path: string
  reason?: string
  offline?: boolean
  progress?: { done: number; total: number }
}
export const viewFolder = (path: string) => path.replace(/[\\/][^\\/]*$/, '')
export const viewType = (name: string) => /\.([^.]+)$/.exec(name)?.[1].toUpperCase() ?? ''

/** Use the most specific configured source, so a connected parent cannot hide an offline share. */
export function sourceOffline(
  path: string,
  roots: readonly { root: string; unavailable: boolean }[],
): boolean {
  const key = (value: string) => {
    const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
    return /^[a-z]:|^\/\//i.test(normalized) ? normalized.toLowerCase() : normalized
  }
  const target = key(path)
  const matches = roots.filter(
    ({ root }) => target === key(root) || target.startsWith(key(root) + '/'),
  )
  matches.sort((a, b) => b.root.length - a.root.length)
  return matches[0]?.unavailable === true
}

const activityRank = (item: ViewFile, now: IndexingNow | null): number => {
  if (now?.extracting.some(({ path }) => path === item.path)) return 0
  if (now?.activeEmbeddingPath === item.path) return 1
  return now?.positions[item.path] ? 2 + now.positions[item.path] : 1_000_000
}
const progressOf = (item: ViewFile, now: IndexingNow | null) => {
  const progress = now?.pages?.[item.path] ?? now?.embedding[item.path] ?? item.progress
  return progress && progress.total > 0 ? progress.done / progress.total : -1
}

/** Changes the view only. It never reprioritizes the actual indexing/OCR queue. */
export function sortViewFiles<T extends ViewFile>(
  items: readonly T[],
  sort: IndexViewSort,
  descending: boolean,
  locale: string,
  now: IndexingNow | null,
): T[] {
  const compare = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' }).compare
  return [...items].sort((a, b) => {
    // Disconnected files stay out of the person's way without disappearing from search.
    if (sort !== 'connection' && !!a.offline !== !!b.offline) return a.offline ? 1 : -1
    let primary = 0
    if (sort === 'queue') primary = activityRank(a, now) - activityRank(b, now)
    if (sort === 'name') primary = compare(a.name, b.name)
    if (sort === 'folder') primary = compare(viewFolder(a.path), viewFolder(b.path))
    if (sort === 'type') primary = compare(viewType(a.name), viewType(b.name))
    if (sort === 'status') primary = compare(a.reason ?? '', b.reason ?? '')
    if (sort === 'progress') primary = progressOf(a, now) - progressOf(b, now)
    if (sort === 'connection') primary = Number(!!a.offline) - Number(!!b.offline)
    return (
      (descending ? -primary : primary) ||
      compare(a.name, b.name) ||
      compare(a.path, b.path) ||
      a.id - b.id
    )
  })
}

export function groupViewFiles<T extends ViewFile>(
  items: readonly T[],
  mode: Exclude<IndexViewGroup, 'reason'>,
) {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key =
      mode === 'folder' ? viewFolder(item.path) : mode === 'type' ? viewType(item.name) : ''
    const current = groups.get(key) ?? []
    current.push(item)
    groups.set(key, current)
  }
  return [...groups].map(([key, items]) => ({ key, items }))
}
