import { useEffect, useState } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import { fill } from '../indexing-activity-copy'
import { TEXT, EN } from './index-dashboard-i18n'
import { nextPollDelay } from './index-poll'
import { capBadge, loadIndexSummary, navIndicator, type IndexSummary } from './index-summary'

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
      try {
        const next = await loadIndexSummary(api)
        if (alive && next) setSummary(next)
      } catch {
        /* keep the last numbers */
      }
      if (alive) timer = setTimeout(() => void tick(), nextPollDelay(6000))
    }
    void tick()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [api])

  const d = TEXT[lang] ?? EN
  const indicator = summary ? navIndicator(summary) : null
  // The queue is background work: it only shows in the tooltip, never as a number.
  const parts: string[] = []
  if (indicator?.kind === 'problems')
    parts.push(fill(d.summary.problems, { n: indicator.n.toLocaleString() }))
  if (summary && summary.enabled && summary.waiting > 0)
    parts.push(fill(d.summary.navWorking, { n: summary.waiting.toLocaleString() }))
  const hint = parts.join(' · ') || undefined
  const label = LABEL[lang] ?? d.summary.navLabel
  return (
    <button
      data-app-action="index"
      className={`nav-item${active ? ' active' : ''}`}
      onClick={onOpen}
      title={hint}
      aria-label={hint ? `${label}: ${hint}` : label}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <ellipse cx="8" cy="4" rx="5.2" ry="2.1" stroke="currentColor" strokeWidth="1.3" />
        <path
          d="M2.8 4v8c0 1.16 2.33 2.1 5.2 2.1s5.2-.94 5.2-2.1V4M2.8 8c0 1.16 2.33 2.1 5.2 2.1s5.2-.94 5.2-2.1"
          stroke="currentColor"
          strokeWidth="1.3"
        />
      </svg>
      <span className="nav-label">{label}</span>
      {indicator?.kind === 'problems' && (
        <span className="nav-count" style={{ color: 'var(--text)', fontWeight: 600 }}>
          {capBadge(indicator.n)}
        </span>
      )}
      {indicator?.kind === 'working' && (
        <span
          className="nav-count"
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            minWidth: 6,
            borderRadius: '50%',
            background: 'var(--text-tertiary)',
            marginRight: 8,
          }}
        />
      )}
    </button>
  )
}
