import type { IndexBrowserQuery } from '../../../shared/fork/index-browser'
import { INDEX_BROWSER_SORTS } from '../../../shared/fork/index-browser'
import type { IndexIssueReason } from '../../../main/document-memory/issues'
import { useI18n } from '../locale'
import { activityCopy } from '../indexing-activity-copy'
import { indexV2Words } from '../i18n/strings-index-v2'
import { IconSearch } from './index-icons'

export type FileGrouping = 'none' | 'reason' | 'folder' | 'type'
export function IndexFileToolbar({
  value,
  onChange,
  grouping,
  onGroup,
  reasons,
}: {
  value: IndexBrowserQuery
  onChange: (value: IndexBrowserQuery) => void
  grouping: FileGrouping
  onGroup: (v: FileGrouping) => void
  reasons?: readonly IndexIssueReason[]
}) {
  const { lang } = useI18n()
  const w = indexV2Words(lang)
  const change = (patch: Partial<IndexBrowserQuery>) => onChange({ ...value, ...patch, offset: 0 })
  return (
    <div className="ix-file-toolbar">
      <label className="ix-filter">
        <IconSearch />
        <input
          type="search"
          maxLength={200}
          aria-label={w.search}
          placeholder={w.search}
          value={value.query ?? ''}
          onChange={(e) => change({ query: e.target.value })}
        />
      </label>
      <details className="ix-filter-menu">
        <summary className="ix-btn is-small">{w.filters}</summary>
        <div>
          <label>
            {w.status}
            <select
              value={value.status ?? ''}
              onChange={(e) => change({ status: e.target.value || undefined })}
            >
              <option value="">{w.all}</option>
              {(['ready', 'pending', 'error', 'empty', 'released'] as const).map((key) => (
                <option key={key} value={key}>
                  {w[key]}
                </option>
              ))}
            </select>
          </label>
          <label>
            {w.type}
            <input
              aria-label={w.type}
              placeholder="pdf, docx…"
              value={value.type ?? ''}
              maxLength={12}
              onChange={(e) =>
                change({ type: e.target.value.replace(/[^a-z0-9]/gi, '') || undefined })
              }
            />
          </label>
          {reasons && reasons.length > 1 && (
            <label>
              {w.reason}
              <select
                value={value.reasons?.length === 1 ? value.reasons[0] : ''}
                onChange={(e) =>
                  change({
                    reasons: e.target.value ? [e.target.value as IndexIssueReason] : reasons,
                  })
                }
              >
                <option value="">{w.all}</option>
                {reasons.map((reason) => (
                  <option key={reason} value={reason}>
                    {activityCopy(lang).reasons[reason].title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            {w.sort}
            <select
              value={value.sort ?? 'queue'}
              onChange={(e) => change({ sort: e.target.value as IndexBrowserQuery['sort'] })}
            >
              {INDEX_BROWSER_SORTS.map((key) => (
                <option key={key} value={key}>
                  {w[key]}
                </option>
              ))}
            </select>
          </label>
          <label>
            {w.group}
            <select value={grouping} onChange={(e) => onGroup(e.target.value as FileGrouping)}>
              {(['none', 'reason', 'folder', 'type'] as const).map((key) => (
                <option key={key} value={key}>
                  {w[key]}
                </option>
              ))}
            </select>
          </label>
          <label>
            {w.reverse}
            <input
              type="checkbox"
              checked={!!value.descending}
              onChange={(e) => change({ descending: e.target.checked })}
            />
          </label>
        </div>
      </details>
    </div>
  )
}
