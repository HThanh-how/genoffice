import { useEffect, useRef, useState } from 'react'
import type { DocumentMemoryStatus, HomeApi, HomeIndexingActivity } from '../../../shared/home-api'
import type { IndexingNow } from '../../../shared/fork/document-index-api'
import type { IndexingModeState } from '../../../shared/fork/indexing-mode'
import type { IndexIssueSummary } from '../../../main/document-memory/issue-reader'
import type { IndexIssueReason } from '../../../main/document-memory/issues'
import { useI18n } from '../locale'
import { activityCopy, fill } from '../indexing-activity-copy'
import { TEXT, EN } from './index-dashboard-i18n'
import { deriveIndexSummary } from './index-summary'
import { deriveIndexStatus, statusSentence } from './index-status'
import { IndexProgressTracker, type IndexProgressReading } from './index-progress-model'
import { buildIssueSections } from './index-issue-groups'
import { RecentFiles } from './RecentFiles'
import type { IndexTabId } from './IndexNav'

export interface IndexOverviewProps {
  api: HomeApi
  memory: DocumentMemoryStatus | null
  activity: HomeIndexingActivity | null
  mode: IndexingModeState | null
  now: IndexingNow | null
  attention: IndexIssueSummary | null
  /** the header owns the one Pause/Resume button; the status card only reports */
  onNavigateTab: (tab: IndexTabId, reason?: IndexIssueReason) => void
  onOpened?: () => void
}

export function IndexOverview({
  api,
  memory,
  activity,
  mode,
  now,
  attention,
  onNavigateTab,
  onOpened,
}: IndexOverviewProps) {
  const { lang, dateLocale } = useI18n()
  const d = TEXT[lang] ?? EN
  const o = d.overview
  const copy = activityCopy(lang)
  const num = (n: number) => n.toLocaleString(dateLocale)

  const folder = activity?.folder ?? null
  const progress = activity?.folderProgress ?? null
  const switchedOff = memory?.enabled === false
  const held = !!mode?.effective?.paused
  const modelState = activity?.memory.modelState ?? memory?.modelState ?? 'not-loaded'
  const summary = deriveIndexSummary({ activity, memoryPending: memory?.pending, attention })

  // Time left comes from the rolling tracker; it stays silent until the evidence is solid.
  const tracker = useRef(new IndexProgressTracker())
  const [reading, setReading] = useState<IndexProgressReading | null>(null)
  useEffect(() => {
    setReading(tracker.current.record(Date.now(), activity, held || switchedOff))
  }, [activity, held, switchedOff])

  const status = deriveIndexStatus({
    summary,
    switchedOff,
    held,
    ...(mode?.effective?.pauseReason ? { pauseReason: mode.effective.pauseReason } : {}),
    modelBlocked: modelState === 'blocked',
    reading: !!(now?.extracting && now.extracting.length > 0),
    ready: progress?.readyFiles ?? memory?.documents ?? 0,
    eta: reading?.eta ?? null,
  })
  const sentence = statusSentence(
    status,
    {
      working: d.status.working,
      left: d.status.left,
      paused: d.status.paused,
      ready: d.status.ready,
      why: d.why,
      resumeWhen: d.status.resumeWhen,
    },
    copy,
    num,
  )

  const currentPath =
    now?.extracting?.[0]?.path || now?.activeEmbeddingPath || (folder?.running ? folder.root : '')
  const currentName = currentPath ? currentPath.split(/[\\/]/).pop() : ''

  // The same groups as the Issues tab, so the numbers always agree.
  const sections = buildIssueSections(summary.problemGroups)
  const totalProblems = summary.problems
  const tone = status.kind === 'attention' ? 'is-attention' : `is-${status.kind}`

  return (
    <div className="idx-overview-container">
      <div className={`idx-status ${tone}`} role="status">
        <div className="idx-status-line">
          <span className="idx-status-dot" aria-hidden="true" />
          <p className="idx-status-text">{sentence}</p>
        </div>
        {status.kind === 'working' && status.percent !== null && (
          <div
            className="idx-progress-bar"
            role="progressbar"
            aria-label={d.status.working}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={status.percent}
          >
            <div
              className="idx-progress-fill"
              style={{ width: `${Math.max(3, Math.min(100, status.percent))}%` }}
            />
          </div>
        )}
        {status.kind === 'working' && currentName && (
          <p className="idx-status-sub" title={currentPath}>
            {o.reading} <code>{currentName}</code>
          </p>
        )}
        {status.kind === 'paused' && status.why === 'saver' && (
          <p className="idx-status-sub">{d.status.saverNote}</p>
        )}
      </div>

      {sections.needs.length > 0 && (
        <section
          className="idx-card idx-attn-simplified"
          aria-label={fill(d.summary.problems, { n: totalProblems })}
        >
          <header className="idx-attn-header">
            <div className="idx-attn-title">
              <span className="idx-attn-icon" aria-hidden="true">
                !
              </span>
              <h4>
                {o.attention} ({num(totalProblems)})
              </h4>
            </div>
            <button type="button" className="idx-link" onClick={() => onNavigateTab('issues')}>
              {o.viewAll} →
            </button>
          </header>
          <ul className="idx-attn-list">
            {sections.needs.slice(0, 3).map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className="idx-attn-row"
                  onClick={() => onNavigateTab('issues', row.reasons[0])}
                >
                  <span className="idx-attn-text">{d.issues.cat[row.id as keyof typeof d.issues.cat].title}</span>
                  <span className="idx-attn-badge">{num(row.count)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <RecentFiles api={api} onOpened={onOpened} />
    </div>
  )
}
