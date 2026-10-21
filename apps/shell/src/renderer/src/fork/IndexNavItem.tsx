import { useEffect, useState } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import { fill } from '../indexing-activity-copy'
import { TEXT, EN } from './index-dashboard-i18n'
import { compactCount, loadIndexSummary, type IndexSummary } from './index-summary'

// zh keeps its own short label; the other languages use the dashboard dictionary (en / vi).
const LABEL: Record<string, string> = { zh: '索引', 'zh-TW': '索引' }

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
  const [summary, setSummary] = useState<IndexSummary | null>(null)

  useEffect(() => {
    if (!api.getIndexingActivity) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const next = await loadIndexSummary(api)
          if (alive && next) setSummary(next)
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

  const d = TEXT[lang] ?? EN
  const count = summary ? compactCount(summary) : null
  const running = !!summary && summary.enabled && summary.active
  const countTitle = count
    ? fill(count.kind === 'waiting' ? d.summary.waiting : d.summary.problems, {
        n: count.n.toLocaleString(),
      })
    : undefined
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
      <span className="nav-label">{LABEL[lang] ?? d.summary.navLabel}</span>
      {count && (
        <span
          className="nav-count"
          title={countTitle}
          style={count.kind === 'waiting' && running ? { color: 'var(--accent)' } : undefined}
        >
          {count.n > 999 ? '999+' : count.n}
        </span>
      )}
    </button>
  )
}
