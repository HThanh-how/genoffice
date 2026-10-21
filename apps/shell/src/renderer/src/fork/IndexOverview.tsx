import type { DocumentMemoryStatus, HomeApi, HomeIndexingActivity } from '../../../shared/home-api'
import type { IndexingNow } from '../../../shared/fork/document-index-api'
import type { IndexingModeState } from '../../../shared/fork/indexing-mode'
import type { IndexIssueSummary } from '../../../main/document-memory/issue-reader'
import type { IndexIssueReason } from '../../../main/document-memory/issues'
import { useI18n } from '../locale'
import { activityCopy, fill } from '../indexing-activity-copy'
import { TEXT, EN } from './index-dashboard-i18n'
import { deriveIndexSummary } from './index-summary'
import { RecentFiles } from './RecentFiles'
import { ReleasedChip } from './ReleasedChip'
import type { IndexTabId } from './IndexNav'

export interface IndexOverviewProps {
  api: HomeApi
  memory: DocumentMemoryStatus | null
  activity: HomeIndexingActivity | null
  mode: IndexingModeState | null
  now: IndexingNow | null
  attention: IndexIssueSummary | null
  actionBusy: boolean
  onTogglePause: () => void
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
  actionBusy,
  onTogglePause,
  onNavigateTab,
  onOpened,
}: IndexOverviewProps) {
  const { lang, dateLocale } = useI18n()
  const d = TEXT[lang] ?? EN
  const o = d.overview
  const copy = activityCopy(lang)

  const progress = activity?.folderProgress ?? null
  const folder = activity?.folder ?? null
  const paused = !!mode?.effective?.paused || memory?.enabled === false
  const pauseReason = mode?.effective?.pauseReason
  const modelState = activity?.memory.modelState ?? memory?.modelState ?? 'not-loaded'
  const summary = deriveIndexSummary({ activity, memoryPending: memory?.pending, attention })
  const pending = summary.waiting
  const readyFiles = progress?.readyFiles ?? memory?.documents ?? 0

  // 1. Trạng thái Blocked (Neutral): khi pin yếu / RAM thấp / chế độ tiết kiệm năng lượng
  const isBlocked =
    modelState === 'blocked' ||
    pauseReason === 'low-battery' ||
    pauseReason === 'battery-saver' ||
    pauseReason === 'battery' ||
    pauseReason === 'low-memory' ||
    pauseReason === 'suspended'

  // 2. Trạng thái bận (Indexing)
  const isIndexing =
    !isBlocked &&
    (folder?.running || pending > 0 || (now?.extracting && now.extracting.length > 0))

  // File currently being processed
  const activeExtractingPath = now?.extracting?.[0]?.path
  const activeEmbeddingPath = now?.activeEmbeddingPath
  const currentFilePath = activeExtractingPath || activeEmbeddingPath || (folder?.running ? folder.root : '')
  const currentFileName = currentFilePath ? currentFilePath.split(/[\\/]/).pop() : ''

  const percent = summary.percent

  // Same problem groups and total as the tab badge, sidebar entry and Home chip
  const attentionGroups = summary.problemGroups
  const totalProblems = summary.problems

  return (
    <div className="idx-overview-container">
      {/* Blocked State (Neutral Color Banner) */}
      {isBlocked && (
        <div className="idx-status-banner is-neutral" role="note">
          <div className="idx-status-banner-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
          </div>
          <div className="idx-status-banner-content">
            <strong>{o.saverTitle}</strong>
            <p>
              {o.saverBody}
            </p>
          </div>
          <button
            type="button"
            className="idx-btn idx-btn-sm"
            disabled={actionBusy}
            onClick={onTogglePause}
          >
            {paused ? d.resume : d.pause}
          </button>
        </div>
      )}

      {/* Indexing State (Active with Clean Progress Bar) */}
      {isIndexing && (
        <div className="idx-status-card is-indexing" role="status">
          <div className="idx-status-card-header">
            <div className="idx-status-card-title">
              <span className="idx-status-indicator is-busy" aria-hidden="true" />
              <h3>{o.optimizing}</h3>
            </div>
            <button
              type="button"
              className="idx-btn idx-btn-sm"
              disabled={actionBusy}
              onClick={onTogglePause}
            >
              {paused ? d.resume : d.pause}
            </button>
          </div>

          <div className="idx-status-card-body">
            {percent !== null && (
              <div className="idx-progress-wrap">
                <div className="idx-progress-bar">
                  <div
                    className="idx-progress-fill"
                    style={{ width: `${Math.max(3, Math.min(100, percent))}%` }}
                  />
                </div>
                <span className="idx-progress-percent">{percent}%</span>
              </div>
            )}

            <div className="idx-status-details">
              <span className="idx-status-remaining">
                <strong>{pending.toLocaleString(dateLocale)}</strong>{' '}
                {o.remaining}
              </span>

              <ReleasedChip count={progress?.releasedFiles} />

              {currentFileName && (
                <span className="idx-status-current" title={currentFilePath}>
                  {o.reading} <code>{currentFileName}</code>
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Idle State (Clean, Simple Readiness Indicator) */}
      {!isBlocked && !isIndexing && (
        <div className="idx-status-card is-idle">
          <div className="idx-status-card-header">
            <div className="idx-status-ready-badge">
              <span className="idx-ready-check" aria-hidden="true">
                ✓
              </span>
              <h3>
                {fill(o.ready, { n: readyFiles.toLocaleString(dateLocale) })}
              </h3>
              <ReleasedChip count={progress?.releasedFiles} />
              {summary.empty > 0 && (
                <span className="idx-muted">
                  {fill(d.summary.empty, { n: summary.empty.toLocaleString(dateLocale) })}
                </span>
              )}
            </div>
            {paused && (
              <button
                type="button"
                className="idx-btn idx-btn-sm"
                disabled={actionBusy}
                onClick={onTogglePause}
              >
                {d.resume}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Attention / Issues needing action card */}
      {attentionGroups.length > 0 && (
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
                {o.attention} (
                {totalProblems.toLocaleString(dateLocale)})
              </h4>
            </div>
            <button
              type="button"
              className="idx-link"
              onClick={() => onNavigateTab('issues')}
            >
              {o.viewAll} →
            </button>
          </header>
          <ul className="idx-attn-list">
            {attentionGroups.slice(0, 3).map((g) => (
              <li key={g.reason}>
                <button
                  type="button"
                  className="idx-attn-row"
                  onClick={() => onNavigateTab('issues', g.reason)}
                >
                  <span className="idx-attn-text">{copy.reasons[g.reason]?.title ?? g.reason}</span>
                  <span className="idx-attn-badge">{g.count.toLocaleString(dateLocale)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Recent Files Section */}
      <RecentFiles api={api} onOpened={onOpened} />
    </div>
  )
}
