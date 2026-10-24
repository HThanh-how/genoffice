import { createContext } from 'react'
import type { IndexingNow } from '../../../shared/fork/document-index-api'

export const IndexRuntime = createContext<{
  now: IndexingNow | null
  sources: readonly { root: string; unavailable: boolean }[]
  offlineRoots?: readonly { root: string; since: number }[]
}>({ now: null, sources: [] })
