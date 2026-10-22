import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { IndexedFolder, KnownSearchSourceEntry } from '../../../shared/fork/document-index-api'
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
import { useWindowedRows } from './use-windowed-rows'
import { IconAlert, IconFolder, IconMore, IconOffline, IconSearch } from './index-icons'
import { IndexMenu, MenuItem, MenuSeparator } from './IndexMenu'

const ROW_HEIGHT = 56
type Dict = (typeof EN)['screen']

/**
 * The folder list reads on the snapshot's cadence instead of keeping a clock of its own: it asks
 * again when the screen's one status subscription has a new answer, at most every 4 seconds.
 */
export function useIndexFolders(api: HomeApi, tick: unknown) {
  const [folders, setFolders] = useState<IndexedFolder[] | null>(null)
  const [failed, setFailed] = useState(false)
  const alive = useRef(true)
  const last = useRef(0)
  const inFlight = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const load = useCallback(async () => {
    if (inFlight.current || !api.listIndexedFolders) return
    inFlight.current = true
    last.current = Date.now()
    try {
      const next = await readIndexRequest(
        () => api.listIndexedFolders(),
        (value): value is IndexedFolder[] =>
          Array.isArray(value) &&
          value.every(
            (f) =>
              typeof f.root === 'string' && Number.isFinite(f.totalFiles) && Array.isArray(f.history),
          ),
      )
      if (alive.current) {
        setFolders(next)
        setFailed(false)
      }
    } catch {
      if (alive.current) setFailed(true)
    } finally {
      inFlight.current = false
    }
  }, [api])
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      clearTimeout(timer.current)
    }
  }, [])
  useEffect(() => {
    clearTimeout(timer.current)
    const wait = Math.max(0, 4000 - (Date.now() - last.current))
    timer.current = setTimeout(() => void load(), wait)
  }, [tick, load])
  return { folders, failed, refresh: load }
}

function useWhen(lang: string, s: Dict) {
  return useCallback(
    (at: number): string => {
      const diff = at - Date.now()
      if (Math.abs(diff) < 45_000) return s.now
      const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })
      for (const [unit, ms] of [
        ['day', 86_400_000],
        ['hour', 3_600_000],
        ['minute', 60_000],
      ] as const)
        if (Math.abs(diff) >= ms || unit === 'minute') return rtf.format(Math.round(diff / ms), unit)
      return ''
    },
    [lang, s],
  )
}

interface RowProps {
  row: FolderRow
  s: Dict
  num: (n: number) => string
  menuOpen: boolean
  onMenu: (root: string, anchor: HTMLElement | null) => void
  onAttention: () => void
}

const FolderRowView = memo(function FolderRowView({
  row,
  s,
  num,
  menuOpen,
  onMenu,
  onAttention,
}: RowProps) {
  const offline = row.state === 'offline'
  let state: React.ReactNode
  if (offline) state = <span className="ix-fstate">{s.offline}</span>
  else if (row.state === 'scanning')
    state = (
      <span className="ix-fstate">
        <span className="ix-spin" aria-hidden="true" />
        {s.scanning}
      </span>
    )
  else if (row.state === 'stopped') state = <span className="ix-fstate">{s.stopped}</span>
  else if (row.state === 'indexing' && row.total > 0)
    state = (
      <span className="ix-fstate is-progress">
        {fill(s.filesOf, { done: num(row.done), total: num(row.total) })}
        <span className="ix-mini" aria-hidden="true">
          <span style={{ width: `${Math.round((row.done / row.total) * 100)}%` }} />
        </span>
      </span>
    )
  else state = (
      <span className="ix-fstate">
        {row.total === 1 ? s.file1 : fill(s.files, { n: num(row.total) })}
      </span>
    )
  return (
    <li className={`ix-frow${offline ? ' is-offline' : ''}`} style={{ height: ROW_HEIGHT }}>
      <span className="ix-ficon" aria-hidden="true">
        {offline ? <IconOffline /> : <IconFolder />}
      </span>
      <span className="ix-fname">
        <strong>{row.name}</strong>
        {row.priority && <span className="ix-tag">{s.firstTag}</span>}
        <span className="ix-fpath" title={row.root}>
          {shortPath(row.root)}
        </span>
      </span>
      <span className="ix-fside">
        {state}
        {row.errors > 0 && (
          <button type="button" className="ix-fneed" onClick={onAttention}>
            <IconAlert />
            {fill(s.needYou, { n: num(row.errors) })}
          </button>
        )}
      </span>
      <button
        type="button"
        className={`ix-icon-btn ix-fmore${menuOpen ? ' is-open' : ''}`}
        aria-label={`${s.moreActions}: ${row.name}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(event) => onMenu(row.root, event.currentTarget)}
      >
        <IconMore />
      </button>
    </li>
  )
})

export interface IndexFoldersProps {
  api: HomeApi
  folders: IndexedFolder[]
  failed: boolean
  onRefresh: () => void
  onNote: (message: string) => void
  onAttention: () => void
}

export function IndexFolders({ api, folders, failed, onRefresh, onNote, onAttention }: IndexFoldersProps) {
  const { lang, dateLocale } = useI18n()
  const s = (TEXT[lang] ?? EN).screen
  const num = useCallback((n: number) => n.toLocaleString(dateLocale), [dateLocale])
  const when = useWhen(lang, s)
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<{ root: string; anchor: HTMLElement | null; view: 'actions' | 'history' } | null>(null)
  const [busy, setBusy] = useState(false)
  const [known, setKnown] = useState<KnownSearchSourceEntry[]>([])
  const rows = useMemo(() => toFolderRows(folders), [folders])
  const shown = useMemo(() => filterFolderRows(rows, query), [rows, query])
  const open = menu ? rows.find((r) => r.root === menu.root) : undefined

  // Long lists draw only the rows near the viewport, measured against the page's own scroller.
  const listRef = useRef<HTMLUListElement>(null)
  const { windowed, range, padTop, padBottom } = useWindowedRows(
    listRef,
    shown.length,
    ROW_HEIGHT,
    '.ix-page',
  )

  const onMenu = useCallback((root: string, anchor: HTMLElement | null) => {
    setMenu((prev) => (prev?.root === root ? null : { root, anchor, view: 'actions' }))
  }, [])
  const closeMenu = useCallback(() => setMenu(null), [])

  const act = async (work: () => Promise<unknown>) => {
    setMenu(null)
    setBusy(true)
    try {
      await readIndexRequest(work, (_v): _v is unknown => true)
    } catch {
      onNote(s.folderFailed)
    } finally {
      setBusy(false)
      onRefresh()
    }
  }
  const loadKnown = async () => {
    try {
      const list = await api.getKnownSearchSources?.()
      if (Array.isArray(list)) setKnown(list)
    } catch {
      /* without it a common place is removed through the add menu */
    }
  }
  useEffect(() => {
    if (folders.some((f) => f.owners && !f.owners.includes('manual'))) void loadKnown()
    // the owners decide whether the list needs the common places at all
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders.length])

  const remove = async (row: FolderRow) => {
    setMenu(null)
    const ok = await appConfirm(s.removeBody, {
      title: s.removeTitle,
      confirmLabel: s.remove.replace('…', ''),
      tone: 'danger',
    })
    if (!ok) return
    const place = known.find((k) => k.path && k.path === row.root && k.enabled)
    if (!row.manual && place) await act(() => api.setKnownSearchSource(place.id, false))
    else await act(() => api.forgetIndexedFolder(row.root))
  }

  const slice = windowed ? shown.slice(range.start, range.end) : shown

  return (
    <section className="ix-section" aria-labelledby="ix-folders-h">
      <div className="ix-section-head">
        <h2 id="ix-folders-h">
          {s.folders} <span className="ix-count">{num(rows.length)}</span>
        </h2>
        {rows.length >= FILTER_FROM && (
          <label className="ix-filter">
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
      </div>
      {failed && (
        <p className="ix-note" role="status">
          {s.folderFailed}{' '}
          <button type="button" className="ix-link" onClick={onRefresh}>
            {s.retry}
          </button>
        </p>
      )}
      {shown.length === 0 ? (
        <p className="ix-quiet">{fill(s.noMatch, { q: query.trim() })}</p>
      ) : (
        <ul
          className="ix-flist"
          ref={listRef}
          style={windowed ? { paddingTop: padTop, paddingBottom: padBottom } : undefined}
        >
          {slice.map((row) => (
            <FolderRowView
              key={row.root}
              row={row}
              s={s}
              num={num}
              menuOpen={menu?.root === row.root}
              onMenu={onMenu}
              onAttention={onAttention}
            />
          ))}
        </ul>
      )}
      {menu && open && (
        <IndexMenu anchor={menu.anchor} onClose={closeMenu} width={menu.view === 'history' ? 320 : 232} label={open.name}>
          {menu.view === 'actions' ? (
            <>
              <MenuItem
                disabled={busy || open.state === 'scanning' || open.state === 'offline'}
                onClick={() => void act(() => api.rescanIndexedFolder(open.root))}
              >
                {s.rescan}
              </MenuItem>
              <MenuItem
                checked={open.priority}
                disabled={busy}
                onClick={() => void act(() => api.setIndexedFolderPriority(open.root, !open.priority))}
              >
                {open.priority ? s.priorityOn : s.priority}
              </MenuItem>
              <MenuItem onClick={() => setMenu({ ...menu, view: 'history' })}>{s.details}</MenuItem>
              {!open.folder.unavailable && (
                <MenuItem
                  onClick={() => {
                    setMenu(null)
                    void api.openFolderInFileManager(open.root)
                  }}
                >
                  {s.openFolder}
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem
                danger
                disabled={busy || open.state === 'scanning'}
                onClick={() => void remove(open)}
              >
                {s.remove}
              </MenuItem>
            </>
          ) : (
            <FolderHistory folder={open.folder} s={s} when={when} />
          )}
        </IndexMenu>
      )}
    </section>
  )
}

function FolderHistory({
  folder,
  s,
  when,
}: {
  folder: IndexedFolder
  s: Dict
  when: (at: number) => string
}) {
  const last = folder.completedAt ? fill(s.last, { when: when(folder.completedAt) }) : s.never
  const checked = folder.reconciledAt ? ` · ${fill(s.checked, { when: when(folder.reconciledAt) })}` : ''
  return (
    <div className="ix-history">
      <p className="ix-history-last">
        {last}
        {checked}
      </p>
      {folder.lastError && <p className="ix-history-error">{folder.lastError}</p>}
      {folder.history.length === 0 ? (
        <p className="ix-quiet">{s.noHistory}</p>
      ) : (
        <ul>
          {folder.history.slice(0, 5).map((run) => (
            <li key={`${run.kind}-${run.endedAt}`}>
              <span>{when(run.endedAt)}</span>
              <span>{run.kind === 'scan' ? s.kindScan : s.kindRefresh}</span>
              <span className="ix-history-detail">
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
  )
}
