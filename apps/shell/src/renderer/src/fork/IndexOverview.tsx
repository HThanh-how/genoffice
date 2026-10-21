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
  /** no reading has answered yet: show placeholders, never a made-up "0 files" */
  loading?: boolean
  /** the first reading failed; the block says so and offers a retry */
  failed?: boolean
  onRetry?: () => void
  /** opens the full Recent list on Home */
  onViewRecent?: () => void
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
  loading = false,
  failed = false,
  onRetry,
  onViewRecent,
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
  const searchable = progress
    ? progress.readyFiles + (progress.releasedFiles ?? 0)
    : (memory?.documents ?? 0)
  const totalFiles = progress?.totalFiles ?? null

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
    // released files keep their text and stay searchable; only their vectors were let go
    ready: searchable,
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

  const unknown = loading || (!activity && !memory)

  return (
    <div className="idx-overview-container">
      {unknown && failed ? (
        <div className="idx-status is-error" role="alert">
          <p className="idx-status-text">{o.failed}</p>
          {onRetry && (
            <button type="button" className="idx-link idx-status-retry" onClick={onRetry}>
              {o.retry}
            </button>
          )}
        </div>
      ) : unknown ? (
        <div className="idx-status is-loading" role="status" aria-busy="true" aria-label={o.loading}>
          <span className="idx-skel idx-skel-line" />
          <span className="idx-skel idx-skel-bar" />
          <span className="idx-skel idx-skel-facts" />
        </div>
      ) : (
        <section className={`idx-status ${tone}`} role="status" aria-label={d.title}>
          <div className="idx-status-line">
            <span className="idx-status-dot" aria-hidden="true" />
            <p className="idx-status-text">{sentence}</p>
          </div>
          {status.percent !== null && status.kind !== 'ready' && (
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
                style={{ width: `${Math.max(0, Math.min(100, status.percent))}%` }}
              />
            </div>
          )}
          <dl className="idx-facts">
            <div>
              <dt>{o.searchable}</dt>
              <dd>
                {num(searchable)}
                {totalFiles !== null && (
                  <span className="idx-facts-of"> / {num(totalFiles)}</span>
                )}
              </dd>
            </div>
            <div>
              <dt>{o.waiting}</dt>
              <dd>{num(summary.waiting)}</dd>
            </div>
            <div>
              <dt>{o.problems}</dt>
              <dd>{num(totalProblems)}</dd>
            </div>
          </dl>
          {status.kind === 'working' && currentName && (
            <p className="idx-status-sub" title={currentPath}>
              {o.reading} <code>{currentName}</code>
            </p>
          )}
          {status.kind === 'paused' && status.why === 'saver' && (
            <p className="idx-status-sub">{d.status.saverNote}</p>
          )}
          {sections.needs.length > 0 && (
            <div className="idx-status-needs">
              <div className="idx-status-needs-head">
                <strong>{fill(o.needsYou, { n: num(totalProblems) })}</strong>
                <button type="button" className="idx-link" onClick={() => onNavigateTab('issues')}>
                  {o.viewAll}
                </button>
              </div>
              <ul>
                {sections.needs.slice(0, 3).map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      className="idx-status-need"
                      onClick={() => onNavigateTab('issues', row.reasons[0])}
                    >
                      <span>{d.issues.cat[row.id as keyof typeof d.issues.cat].title}</span>
                      <span className="idx-status-need-count">{num(row.count)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <RecentFiles api={api} onOpened={onOpened} {...(onViewRecent ? { onViewAll: onViewRecent } : {})} />
    </div>
  )
}
