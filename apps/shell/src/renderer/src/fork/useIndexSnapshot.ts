import { useEffect, useRef, useState } from 'react'
import type { HomeApi, HomeIndexingActivity, DocumentMemoryStatus } from '../../../shared/home-api'
import type { IndexingNow, StorageBudgetSnapshot } from '../../../shared/fork/document-index-api'
import type { IndexingModeState } from '../../../shared/fork/indexing-mode'
import { INDEXING_MODES } from '../../../shared/fork/indexing-mode'
import type { IndexIssueSummary } from '../../../main/document-memory/issue-reader'
import { isIndexIssueSummary, isIndexingNow, readIndexRequest } from './index-request'

const ACTIVE_POLL_MS = 2000
const IDLE_POLL_MS = 5000

export interface Snapshot {
  memory: DocumentMemoryStatus | null
  activity: HomeIndexingActivity | null
  mode: IndexingModeState | null
  now: IndexingNow | null
  storageBudget?: StorageBudgetSnapshot | null
}

export function useIndexSnapshot(api: HomeApi) {
  const [snap, setSnap] = useState<Snapshot>({
    memory: null,
    activity: null,
    mode: null,
    now: null,
    storageBudget: null,
  })
  const [attention, setAttention] = useState<IndexIssueSummary | null>(null)
  const [statusFailed, setStatusFailed] = useState(false)
  const pollKick = useRef<() => void>(() => undefined)

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let loading = false
    let refreshQueued = false
    let pollIntervalMs = IDLE_POLL_MS

    const load = async () => {
      if (!alive) return
      if (loading) {
        refreshQueued = true
        return
      }
      if (document.visibilityState !== 'visible') return
      loading = true

      try {
        if (typeof api.getDocumentIndexSnapshot === 'function') {
          try {
            const snapData = await api.getDocumentIndexSnapshot(refreshQueued)
            if (!alive) return
            setStatusFailed(false)
            if (snapData.issues) setAttention(snapData.issues)
            setSnap({
              memory: snapData.memory,
              activity: snapData.activity,
              mode: snapData.mode,
              now: snapData.now,
              storageBudget: snapData.storageBudget ?? null,
            })
            const isPaused = !!snapData.mode?.effective?.paused || snapData.memory?.enabled === false
            const pendingCount = snapData.memory?.pending ?? snapData.activity?.memory?.pending ?? 0
            pollIntervalMs = isPaused || pendingCount === 0 ? IDLE_POLL_MS : ACTIVE_POLL_MS
          } catch {
            if (!alive) return
            setStatusFailed(true)
            pollIntervalMs = IDLE_POLL_MS
          }
        } else {
          const [memory, activity, mode, issues, now] = await Promise.allSettled([
            readIndexRequest(
              () => api.getDocumentMemoryStatus(),
              (v): v is DocumentMemoryStatus => !!v && typeof v === 'object' && typeof (v as any).enabled === 'boolean',
            ),
            readIndexRequest(
              () => api.getIndexingActivity(),
              (v): v is HomeIndexingActivity => !!v && typeof v === 'object' && !!(v as any).memory,
            ),
            readIndexRequest(
              () => api.getIndexingModeState?.() ?? Promise.resolve(null),
              (v): v is IndexingModeState | null => v === null || (!!v && typeof v === 'object' && INDEXING_MODES.includes((v as any).mode)),
            ),
            readIndexRequest(() => api.getDocumentIndexIssueSummary('*'), isIndexIssueSummary),
            readIndexRequest(() => api.getIndexingNow(), isIndexingNow),
          ])
          if (!alive) return
          setStatusFailed(memory.status === 'rejected' || activity.status === 'rejected' || issues.status === 'rejected')
          if (issues.status === 'fulfilled') setAttention(issues.value)
          const next: Snapshot = {
            memory: memory.status === 'fulfilled' ? memory.value : null,
            activity: activity.status === 'fulfilled' ? activity.value : null,
            mode: mode.status === 'fulfilled' ? mode.value : null,
            now: now.status === 'fulfilled' ? now.value : null,
          }
          setSnap((prev) => ({
            memory: next.memory ?? prev.memory,
            activity: next.activity ?? prev.activity,
            mode: next.mode ?? prev.mode,
            now: next.now,
          }))
          const isPaused = !!next.mode?.effective?.paused || next.memory?.enabled === false
          const pendingCount = next.memory?.pending ?? next.activity?.memory?.pending ?? 0
          pollIntervalMs = isPaused || pendingCount === 0 ? IDLE_POLL_MS : ACTIVE_POLL_MS
        }
      } finally {
        loading = false
        if (alive && document.visibilityState === 'visible') {
          timer = setTimeout(() => void load(), refreshQueued ? 0 : pollIntervalMs)
        }
        refreshQueued = false
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        if (timer) clearTimeout(timer)
        void load()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    pollKick.current = () => {
      if (timer) clearTimeout(timer)
      void load()
    }
    void load()

    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [api])

  return { snap, attention, statusFailed, kick: () => pollKick.current() }
}
