import type { DocumentMemoryStatus, HomeApi, HomeIndexingActivity } from '../../../shared/home-api'
import type { IndexingNow } from '../../../shared/fork/document-index-api'
import type { IndexingModeState } from '../../../shared/fork/indexing-mode'
import type { IndexIssueSummary } from '../../../main/document-memory/issue-reader'
import type { IndexIssueReason } from '../../../main/document-memory/issues'
import { useI18n } from '../locale'
import { activityCopy } from '../indexing-activity-copy'
import { needsAction } from './IndexProblems'
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
  const isVi = lang === 'vi'
  const copy = activityCopy(lang)

  const progress = activity?.folderProgress ?? null
  const folder = activity?.folder ?? null
  const paused = !!mode?.effective?.paused || memory?.enabled === false
  const pauseReason = mode?.effective?.pauseReason
  const modelState = activity?.memory.modelState ?? memory?.modelState ?? 'not-loaded'
  const pending = memory?.pending ?? activity?.memory.pending ?? 0
  const readyFiles = progress?.readyFiles ?? memory?.documents ?? 0
  const totalFiles = progress?.totalFiles ?? (readyFiles + pending)

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

  // Progress calculation
  let percent: number | null = progress?.percent ?? null
  if (percent === null && totalFiles > 0) {
    percent = Math.min(100, Math.round((readyFiles / totalFiles) * 100))
  }

  // Attention summary (issues needing action)
  const attentionGroups = (attention?.groups ?? []).filter((g) => needsAction(g.reason))
  const totalProblems = attentionGroups.reduce((acc, g) => acc + g.count, 0)

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
            <strong>{isVi ? 'Tìm kiếm tiết kiệm tài nguyên' : 'Resource Saver Mode'}</strong>
            <p>
              {isVi
                ? 'Tìm kiếm nâng cao tạm dừng để tiết kiệm tài nguyên. Tìm kiếm tên tệp và nội dung văn bản vẫn hoạt động bình thường.'
                : 'Advanced search is paused to conserve system resources. File name and text search continue to work normally.'}
            </p>
          </div>
          <button
            type="button"
            className="idx-btn idx-btn-sm"
            disabled={actionBusy}
            onClick={onTogglePause}
          >
            {paused ? (isVi ? 'Tiếp tục' : 'Resume') : isVi ? 'Tạm dừng' : 'Pause'}
          </button>
        </div>
      )}

      {/* Indexing State (Active with Clean Progress Bar) */}
      {isIndexing && (
        <div className="idx-status-card is-indexing" role="status">
          <div className="idx-status-card-header">
            <div className="idx-status-card-title">
              <span className="idx-status-indicator is-busy" aria-hidden="true" />
              <h3>{isVi ? 'Đang tối ưu hóa tìm kiếm' : 'Optimizing search'}</h3>
            </div>
            <button
              type="button"
              className="idx-btn idx-btn-sm"
              disabled={actionBusy}
              onClick={onTogglePause}
            >
              {paused ? (isVi ? 'Tiếp tục' : 'Resume') : isVi ? 'Tạm dừng' : 'Pause'}
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
                {isVi ? 'tệp còn lại' : 'files remaining'}
              </span>

              <ReleasedChip count={progress?.releasedFiles} />

              {currentFileName && (
                <span className="idx-status-current" title={currentFilePath}>
                  {isVi ? 'Đang đọc:' : 'Reading:'} <code>{currentFileName}</code>
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
                {isVi
                  ? `Sẵn sàng tìm kiếm - ${readyFiles.toLocaleString(dateLocale)} tệp có thể tìm kiếm`
                  : `Ready for search - ${readyFiles.toLocaleString(dateLocale)} searchable files`}
              </h3>
              <ReleasedChip count={progress?.releasedFiles} />
            </div>
            {paused && (
              <button
                type="button"
                className="idx-btn idx-btn-sm"
                disabled={actionBusy}
                onClick={onTogglePause}
              >
                {isVi ? 'Tiếp tục' : 'Resume'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Attention / Issues needing action card */}
      {attentionGroups.length > 0 && (
        <section
          className="idx-card idx-attn-simplified"
          aria-label={isVi ? 'Cần xử lý' : 'Needs attention'}
        >
          <header className="idx-attn-header">
            <div className="idx-attn-title">
              <span className="idx-attn-icon" aria-hidden="true">
                !
              </span>
              <h4>
                {isVi ? 'Có tệp cần bạn xử lý' : 'Files need attention'} (
                {totalProblems.toLocaleString(dateLocale)})
              </h4>
            </div>
            <button
              type="button"
              className="idx-link"
              onClick={() => onNavigateTab('issues')}
            >
              {isVi ? 'Xem tất cả' : 'View all'} →
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
