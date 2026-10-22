import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import type { IndexedFolder } from '../../../shared/fork/document-index-api'
import type { HomeApi } from '../../../shared/home-api'
import { useI18n } from '../locale'
import { appConfirm } from '../ui-feedback'
import { fill } from '../indexing-activity-copy'
import { TEXT, EN } from './index-dashboard-i18n'
import { readIndexRequest } from './index-request'
import {
  FILTER_FROM,
  filterFolderRows,
  toFolderRows,
  type FolderRow,
} from './index-screen-model'
import { IconBack, IconFolder, IconSearch } from './index-icons'
import { useWindowedRows } from './use-windowed-rows'
import { useWhen } from './IndexFolders'
import { IndexFolderDetail } from './IndexFolderDetail'

const ROW_HEIGHT = 52

/**
 * Master and detail. The left column is the whole library at a glance (one line per folder, with its
 * own state); the right pane is either the overview (status, what needs a person, settings) or the
 * one folder that is selected. On a narrow page the two take turns.
 */
export function IndexMaster({
  api,
  folders,
  overview,
  attentionCount,
  statusLine,
  onRefresh,
  onNote,
}: {
  api: HomeApi
  folders: IndexedFolder[]
  /** the right pane when no folder is selected */
  overview: ReactNode
  attentionCount: number
  /** the one-line state shown on the overview entry */
  statusLine: string
  onRefresh: () => void
  onNote: (message: string) => void
}) {
  const { lang, dateLocale } = useI18n()
  const s = (TEXT[lang] ?? EN).screen
  const num = (n: number) => n.toLocaleString(dateLocale)
  const when = useWhen(lang, s)
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const rows = useMemo(() => toFolderRows(folders), [folders])
  const shown = useMemo(() => filterFolderRows(rows, query), [rows, query])
  const current = selected ? rows.find((r) => r.root === selected) : undefined
  const listRef = useRef<HTMLUListElement>(null)
  const { windowed, range, padTop, padBottom } = useWindowedRows(
    listRef,
    shown.length,
    ROW_HEIGHT,
    '.ixb-list-scroll',
  )
  const slice = windowed ? shown.slice(range.start, range.end) : shown

  const act = useCallback(
    async (work: () => Promise<unknown>) => {
      setBusy(true)
      try {
        await readIndexRequest(work, (_v): _v is unknown => true)
      } catch {
        onNote(s.folderFailed)
      } finally {
        setBusy(false)
        onRefresh()
      }
    },
    [onNote, onRefresh, s.folderFailed],
  )
  const remove = async (row: FolderRow) => {
    const ok = await appConfirm(s.removeBody, {
      title: s.removeTitle,
      confirmLabel: s.remove.replace('…', ''),
      tone: 'danger',
    })
    if (!ok) return
    setSelected(null)
    await act(() => api.forgetIndexedFolder(row.root))
  }

  const stateText = (row: FolderRow): string => {
    if (row.state === 'offline') return s.offline
    if (row.state === 'scanning') return s.scanning
    if (row.state === 'stopped') return s.stopped
    if (row.state === 'indexing' && row.total > 0)
      return fill(s.filesOf, { done: num(row.done), total: num(row.total) })
    return row.total === 1 ? s.file1 : fill(s.files, { n: num(row.total) })
  }

  return (
    <div className={`ixb${current ? ' has-selection' : ''}`}>
      <nav className="ixb-side" aria-label={s.folders}>
        <button
          type="button"
          className={`ixb-overview${current ? '' : ' is-selected'}`}
          aria-current={current ? undefined : 'page'}
          onClick={() => setSelected(null)}
        >
          <span className="ixb-overview-text">
            <strong>{s.overview}</strong>
            <span>{statusLine}</span>
          </span>
          {attentionCount > 0 && <span className="ixb-badge">{num(attentionCount)}</span>}
        </button>
        <div className="ixb-side-head">
          <span>
            {s.folders} <span className="ix-count">{num(rows.length)}</span>
          </span>
        </div>
        {rows.length >= FILTER_FROM && (
          <label className="ix-filter ixb-filter">
            <IconSearch />
            <input
              type="search"
              value={query}
              placeholder={s.filter}
              aria-label={s.filter}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.key === 'Escape' && setQuery('')}
            />
          </label>
        )}
        <div className="ixb-list-scroll">
          {shown.length === 0 ? (
            <p className="ix-quiet">{fill(s.noMatch, { q: query.trim() })}</p>
          ) : (
            <ul
              className="ixb-list"
              ref={listRef}
              style={windowed ? { paddingTop: padTop, paddingBottom: padBottom } : undefined}
            >
              {slice.map((row) => (
                <li key={row.root} style={{ height: ROW_HEIGHT }}>
                  <button
                    type="button"
                    className={`ixb-row${row.root === selected ? ' is-selected' : ''}${row.state === 'offline' ? ' is-offline' : ''}`}
                    aria-current={row.root === selected ? 'true' : undefined}
                    title={row.root}
                    onClick={() => setSelected(row.root)}
                  >
                    <span className="ix-ficon" aria-hidden="true">
                      <IconFolder />
                    </span>
                    <span className="ixb-row-text">
                      <strong>{row.name}</strong>
                      <span>{stateText(row)}</span>
                    </span>
                    {row.errors > 0 && (
                      <span className="ixb-dot is-alert" aria-label={fill(s.needYou, { n: row.errors })} />
                    )}
                    {row.state === 'indexing' && <span className="ixb-dot is-busy" aria-hidden="true" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </nav>
      <div className="ixb-main">
        {current ? (
          <>
            <button type="button" className="ixb-back ix-link" onClick={() => setSelected(null)}>
              <IconBack />
              {s.back}
            </button>
            <IndexFolderDetail
              api={api}
              row={current}
              busy={busy}
              when={when}
              onRescan={() => void act(() => api.rescanIndexedFolder(current.root))}
              onPriority={() => void act(() => api.setIndexedFolderPriority(current.root, !current.priority))}
              onRemove={() => void remove(current)}
              onChanged={onRefresh}
            />
          </>
        ) : (
          overview
        )}
      </div>
    </div>
  )
}
