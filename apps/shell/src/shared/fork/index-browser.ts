import type { IndexIssueReason } from '../../main/document-memory/issues'
import type { IndexedFileHit } from './document-index-api'

export const INDEX_BROWSER_PAGE_SIZE = 100
export const INDEX_BROWSER_SORTS = [
  'queue',
  'name',
  'folder',
  'type',
  'progress',
  'status',
  'connection',
  'size',
  'recent',
] as const
export type IndexBrowserSort = (typeof INDEX_BROWSER_SORTS)[number]
export interface IndexBrowserQuery {
  afterId?: number
  throughId?: number
  root?: string
  reasons?: readonly IndexIssueReason[]
  query?: string
  status?: string
  type?: string
  sort?: IndexBrowserSort
  descending?: boolean
  offset?: number
}
export interface IndexBrowserPage {
  maxId?: number
  items: Array<IndexedFileHit & { sizeBytes?: number; updatedAt?: number }>
  total: number
  sizeBytes: number
}
