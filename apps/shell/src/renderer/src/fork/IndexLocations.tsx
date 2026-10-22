import { useCallback, useMemo, useRef, useState } from 'react'
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
  shortPath,
  toFolderRows,
  type FolderRow,
} from './index-screen-model'
import { IconFolder, IconOffline, IconPlus, IconSearch } from './index-icons'
import { useWindowedRows } from './use-windowed-rows'

const ROW_HEIGHT = 48

/**
 * The folders as a table with a toolbar underneath, the way Spotlight's privacy list and Windows'
 * indexing options do it: pick a row, then act on it with the + and the buttons. Rows are quiet; the
 * only state worth a word is the one that is not "up to date".
 */
export function IndexLocations({
  api,
  folders,
  onAdd,
  onRefresh,
  onNote,
}: {
  api: HomeApi
  folders: IndexedFolder[]
  onAdd: () => void
  onRefresh: () => void
  onNote: (message: string) => void
}) {
  const { lang, dateLocale } = useI18n()
  const s = (TEXT[lang] ?? EN).screen
  const num = (n: number) => n.toLocaleString(dateLocale)
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
    '.ixc-scroll',
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
      confirmLabel: s.removeShort,
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
    if (row.state === 'indexing') return fill(s.stateIndexing, { p: row.total ? Math.round((row.done / row.total) * 100) : 0 })
    return s.stateReady
  }

  return (
    <div className="ixc-locations">
      {rows.length >= FILTER_FROM && (
        <label className="ix-filter ixc-filter">
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
      <div className="ixc-table" role="grid" aria-label={s.folders} aria-rowcount={shown.length}>
        <div className="ixc-head" role="row">
          <span role="columnheader">{s.colName}</span>
          <span role="columnheader" className="is-num">
            {s.colFiles}
          </span>
          <span role="columnheader">{s.colState}</span>
        </div>
        <div className="ixc-scroll">
          {shown.length === 0 ? (
            <p className="ix-quiet">{fill(s.noMatch, { q: query.trim() })}</p>
          ) : (
            <ul
              className="ixc-list"
              ref={listRef}
              style={windowed ? { paddingTop: padTop, paddingBottom: padBottom } : undefined}
            >
              {slice.map((row) => (
                <li key={row.root} style={{ height: ROW_HEIGHT }}>
                  <div
                    role="row"
                    tabIndex={0}
                    className={`ixc-row${row.root === selected ? ' is-selected' : ''}${row.state === 'offline' ? ' is-offline' : ''}`}
                    aria-selected={row.root === selected}
                    title={row.root}
                    onClick={() => setSelected(row.root === selected ? null : row.root)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setSelected(row.root === selected ? null : row.root)
                      }
                    }}
                  >
                    <span className="ixc-name" role="gridcell">
                      <span className="ix-ficon" aria-hidden="true">
                        {row.state === 'offline' ? <IconOffline /> : <IconFolder />}
                      </span>
                      <span className="ixc-name-text">
                        <strong>{row.name}</strong>
                        <span className="ixc-path">{shortPath(row.root, 48)}</span>
                        <span className="ixc-inline">{stateText(row)}</span>
                      </span>
                    </span>
                    <span className="is-num" role="gridcell">
                      {num(row.total)}
                    </span>
                    <span
                      role="gridcell"
                      className={`ixc-state${row.state === 'ready' ? '' : ' is-active'}`}
                    >
                      {stateText(row)}
                      {row.errors > 0 && (
                        <span className="ixc-need"> · {fill(s.needYou, { n: num(row.errors) })}</span>
                      )}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="ixc-toolbar">
        <button type="button" className="ix-btn" onClick={onAdd} disabled={busy}>
          <IconPlus />
          {s.addFolder}
        </button>
        <button
          type="button"
          className="ix-btn"
          disabled={!current || busy || current.state === 'scanning' || current.state === 'offline'}
          onClick={() => current && void act(() => api.rescanIndexedFolder(current.root))}
        >
          {s.rescan}
        </button>
        <button
          type="button"
          className="ix-btn"
          disabled={!current || busy}
          aria-pressed={!!current?.priority}
          onClick={() =>
            current && void act(() => api.setIndexedFolderPriority(current.root, !current.priority))
          }
        >
          {current?.priority ? s.priorityOn : s.priority}
        </button>
        <button
          type="button"
          className="ix-btn is-danger"
          disabled={!current || busy || current.state === 'scanning'}
          onClick={() => current && void remove(current)}
        >
          {s.removeShort}
        </button>
        {!current && <span className="ixc-hint">{s.selectHint}</span>}
      </div>
    </div>
  )
}
