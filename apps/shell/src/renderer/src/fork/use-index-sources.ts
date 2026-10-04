import { useEffect, useState } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import { readIndexRequest } from './index-request'

interface Source {
  root: string
  unavailable: boolean
}
const isSources = (value: unknown): value is Source[] =>
  Array.isArray(value) &&
  value.every(
    (item) => item && typeof item.root === 'string' && typeof item.unavailable === 'boolean',
  )

/** Check source roots, not every row; an unanswered request never means the drive is offline. */
export function useIndexSources(api: HomeApi) {
  const [sources, setSources] = useState<Source[]>([])
  useEffect(() => {
    if (!api.listIndexedFolders) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const result = await readIndexRequest(() => api.listIndexedFolders(), isSources)
          if (alive) setSources(result)
        } catch {
          /* Keep the last confirmed source state; do not guess from an IPC timeout. */
        }
      }
      if (alive) timer = setTimeout(() => void refresh(), 10_000)
    }
    void refresh()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [api])
  return sources
}
