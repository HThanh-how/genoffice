import type { IndexedFolder } from '../../../shared/fork/document-index-api'
import type { HomeApi } from '../../../shared/home-api'
import { useI18n } from '../locale'
import { fill } from '../indexing-activity-copy'
import { TEXT, EN } from './index-dashboard-i18n'
import { IndexProblems } from './IndexProblems'
import type { FolderRow } from './index-screen-model'

type Dict = (typeof EN)['screen']

/**
 * One folder on its own: where it is, how far along it is, what it needs, when it was last read, and
 * the few things a person can do with it. Every number here is about this folder only.
 */
export function IndexFolderDetail({
  api,
  row,
  busy,
  when,
  onRescan,
  onPriority,
  onRemove,
  onChanged,
}: {
  api: HomeApi
  row: FolderRow
  busy: boolean
  when: (at: number) => string
  onRescan: () => void
  onPriority: () => void
  onRemove: () => void
  onChanged: () => void
}) {
  const { lang, dateLocale } = useI18n()
  const s: Dict = (TEXT[lang] ?? EN).screen
  const num = (n: number) => n.toLocaleString(dateLocale)
  const f: IndexedFolder = row.folder
  const waiting = Math.max(0, f.pendingFiles)
  const pct = row.total > 0 ? Math.round((row.done / row.total) * 100) : 0
  const last = f.completedAt ? fill(s.last, { when: when(f.completedAt) }) : s.never
  const checked = f.reconciledAt ? ` · ${fill(s.checked, { when: when(f.reconciledAt) })}` : ''
  const stateText =
    row.state === 'offline'
      ? s.offline
      : row.state === 'scanning'
        ? s.scanning
        : row.state === 'stopped'
          ? s.stopped
          : null
  return (
    <section className="ixb-detail" aria-label={row.name}>
      <header className="ixb-detail-head">
        <h2>{row.name}</h2>
        <p className="ixb-path" title={row.root}>
          {row.root}
        </p>
        <p className="ixb-last">
          {stateText ? `${stateText} · ` : ''}
          {last}
          {checked}
        </p>
      </header>

      <div className="ixb-actions">
        <button
          type="button"
          className="ix-btn"
          disabled={busy || row.state === 'scanning' || row.state === 'offline'}
          onClick={onRescan}
        >
          {s.rescan}
        </button>
        <button
          type="button"
          className="ix-btn"
          aria-pressed={row.priority}
          disabled={busy}
          onClick={onPriority}
        >
          {row.priority ? s.priorityOn : s.priority}
        </button>
        {row.state !== 'offline' && (
          <button
            type="button"
            className="ix-btn"
            onClick={() => void api.openFolderInFileManager(row.root)}
          >
            {s.openFolder}
          </button>
        )}
        <button
          type="button"
          className="ix-btn is-danger"
          disabled={busy || row.state === 'scanning'}
          onClick={onRemove}
        >
          {s.remove}
        </button>
      </div>

      <dl className="ixb-stats">
        <div>
          <dt>{s.statSearchable}</dt>
          <dd>{num(row.done)}</dd>
        </div>
        <div>
          <dt>{s.statWaiting}</dt>
          <dd>{num(waiting)}</dd>
        </div>
        <div>
          <dt>{s.statNeedYou}</dt>
          <dd className={row.errors > 0 ? 'is-alert' : ''}>{num(row.errors)}</dd>
        </div>
      </dl>
      {row.state === 'indexing' && row.total > 0 && (
        <div
          className="ix-bar"
          role="progressbar"
          aria-label={row.name}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <span style={{ width: `${Math.max(2, pct)}%` }} />
        </div>
      )}
      {f.lastError && <p className="ix-note ixb-error">{f.lastError}</p>}

      {row.errors > 0 && (
        <div className="ixb-block">
          <h3>{s.attention}</h3>
          <IndexProblems
            api={api}
            root={row.root}
            onChanged={onChanged}
            hideEmpty
            hideToolbar
            bucket="all"
            sort="queue"
            grouping="reason"
            descending={false}
          />
        </div>
      )}

      <div className="ixb-block">
        <h3>{s.details}</h3>
        {f.history.length === 0 ? (
          <p className="ix-quiet">{s.noHistory}</p>
        ) : (
          <ul className="ixb-history">
            {f.history.slice(0, 6).map((run) => (
              <li key={`${run.kind}-${run.endedAt}`}>
                <span>{when(run.endedAt)}</span>
                <span>{run.kind === 'scan' ? s.kindScan : s.kindRefresh}</span>
                <span className="ixb-run">
                  {fill(s.runDetail, {
                    discovered: run.discovered,
                    enrolled: run.enrolled,
                    errors: run.errors,
                  })}
                  {run.state === 'stopped'
                    ? ` · ${s.runStopped}`
                    : run.state === 'unavailable'
                      ? ` · ${s.runUnavailable}`
                      : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
