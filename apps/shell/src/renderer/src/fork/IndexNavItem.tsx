import { useEffect, useState } from 'react'
import type { HomeApi } from '../../../shared/home-api'

const LABEL: Record<string, string> = { vi: 'Chỉ mục', zh: '索引', 'zh-TW': '索引' }

/** Sidebar entry for the indexing dashboard, with a live count of what is still waiting. */
export function IndexNavItem({
  api,
  lang,
  active,
  onOpen,
}: {
  api: HomeApi
  lang: string
  active: boolean
  onOpen: () => void
}) {
  const [state, setState] = useState<{ pending: number; errors: number; running: boolean }>({
    pending: 0,
    errors: 0,
    running: false,
  })

  useEffect(() => {
    if (!api.getIndexingActivity) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const a = await api.getIndexingActivity()
          if (alive)
            setState({
              pending: a.memory.pending,
              errors: a.memory.errors,
              running: a.memory.enabled && (a.memory.pending > 0 || !!a.folder?.running),
            })
        } catch {
          /* keep the last numbers */
        }
      }
      if (alive) timer = setTimeout(() => void tick(), 6000)
    }
    void tick()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [api])

  const count = state.pending > 0 ? state.pending : state.errors
  return (
    <button className={`nav-item${active ? ' active' : ''}`} onClick={onOpen}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <ellipse cx="8" cy="4" rx="5.2" ry="2.1" stroke="currentColor" strokeWidth="1.3" />
        <path
          d="M2.8 4v8c0 1.16 2.33 2.1 5.2 2.1s5.2-.94 5.2-2.1V4M2.8 8c0 1.16 2.33 2.1 5.2 2.1s5.2-.94 5.2-2.1"
          stroke="currentColor"
          strokeWidth="1.3"
        />
      </svg>
      <span className="nav-label">{LABEL[lang] ?? 'Index'}</span>
      {count > 0 && (
        <span className="nav-count" style={state.running ? { color: 'var(--accent)' } : undefined}>
          {count > 999 ? '999+' : count}
        </span>
      )}
    </button>
  )
}
