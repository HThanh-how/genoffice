import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import type { IndexBrowserPage, IndexBrowserQuery } from '../../../shared/fork/index-browser'
import { INDEX_BROWSER_PAGE_SIZE } from '../../../shared/fork/index-browser'
import type { IndexingNow } from '../../../shared/fork/document-index-api'
import { useI18n } from '../locale'
import { activityCopy, fill } from '../indexing-activity-copy'
import { indexV2Words } from '../i18n/strings-index-v2'
import { iconFor } from '../file-icons'
import { useFileActions, folderOf, type FileItem } from './IndexFiles'
import { IndexFileDetail } from './IndexFileDetail'
import { IndexFileToolbar, type FileGrouping } from './IndexFileToolbar'
import { NOTHING_PICKED, pick, type PickState } from './index-selection'
import { useWindowedRows } from './use-windowed-rows'
import { useIndexBulk, type IndexBulkAction, type IndexAllSelection } from './use-index-bulk'
import { readIndexRequest } from './index-request'
import { createIndexSourceLookup, sortViewFiles, type IndexViewSort } from './index-list-view'
import { foldText, indexFileActivity } from './index-screen-model'
import { IndexRuntime } from './IndexRuntime'

const FileRow = memo(function FileRow({
  item,
  active,
  picked,
  onOpen,
  onPick,
  activity,
}: {
  item: FileItem
  active: boolean
  picked: boolean
  onOpen: (item: FileItem, more?: boolean) => void
  onPick: (id: number, range: boolean) => void
  activity?: string
}) {
  const { lang } = useI18n()
  const w = indexV2Words(lang)
  return (
    <li
      className={`ix-browser-row${active ? ' is-active' : ''}${picked ? ' is-picked' : ''}`}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onOpen(item, true)
      }}
    >
      <input
        type="checkbox"
        checked={picked}
        aria-label={`${w.selectShown}: ${item.name}`}
        onChange={(e) => onPick(item.id, (e.nativeEvent as MouseEvent).shiftKey)}
      />
      <button
        type="button"
        data-file-id={item.id}
        aria-expanded={active}
        onClick={(e) =>
          e.shiftKey || e.ctrlKey || e.metaKey ? onPick(item.id, e.shiftKey) : onOpen(item)
        }
        onKeyDown={(e) => {
          if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault()
            onOpen(item, true)
            return
          }
          if (e.key === ' ') {
            e.preventDefault()
            onPick(item.id, e.shiftKey)
          }
        }}
      >
        <img src={iconFor(item.name)} alt="" width={20} height={20} />
        <span className="ix-file-text">
          <strong>{item.name}</strong>
          <span title={item.path}>{folderOf(item.path)}</span>
        </span>
        <span className="ix-browser-state">
          {item.offline
            ? w.offline
            : (activity ??
              (item.reason
                ? activityCopy(lang).reasons[item.reason].title
                : (w[item.status as 'ready'] ?? item.status)))}
        </span>
        {item.progress && item.progress.done < item.progress.total && (
          <span
            className="ix-browser-progress"
            aria-label={w.progress}
            title={item.progress.kind === 'ocr' ? 'OCR' : w.embedding}
          >
            {item.progress.done}/{item.progress.total}
          </span>
        )}
        <span aria-hidden="true">{active ? '⌄' : '›'}</span>
      </button>
    </li>
  )
})

export function IndexFileBrowser({
  api,
  scope = {},
  onChanged,
  now: explicitNow,
  revision = 0,
  fixedItems,
  hideToolbar = false,
  groupMode,
}: {
  api: HomeApi
  scope?: IndexBrowserQuery
  onChanged: () => void
  now?: IndexingNow | null
  revision?: unknown
  fixedItems?: FileItem[]
  hideToolbar?: boolean
  groupMode?: FileGrouping
}) {
  const { now: snapshotNow, sources } = useContext(IndexRuntime)
  const isOffline = useMemo(() => createIndexSourceLookup(sources), [sources])
  const now = explicitNow ?? snapshotNow
  const { lang, dateLocale } = useI18n()
  const w = indexV2Words(lang)
  const [view, setView] = useState<IndexBrowserQuery>({ sort: 'queue', ...scope })
  const [grouping, setGrouping] = useState<FileGrouping>('none')
  useEffect(() => {
    if (groupMode) setGrouping(groupMode)
  }, [groupMode])
  const [page, setPage] = useState<IndexBrowserPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const [pickState, setPick] = useState<PickState>(NOTHING_PICKED)
  const [allSelection, setAllSelection] = useState<IndexAllSelection | null>(null)
  const allRef = useRef(allSelection)
  allRef.current = allSelection
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [active, setActive] = useState<FileItem | null>(null)
  const request = useRef(0)
  const key = JSON.stringify(view)
  const filterKey = JSON.stringify({ ...view, offset: 0 })
  const scopeKey = JSON.stringify(scope)
  useEffect(() => {
    setView({ sort: 'queue', ...JSON.parse(scopeKey) })
    setActive(null)
    setPick(NOTHING_PICKED)
  }, [scopeKey])
  const changed = useCallback(() => {
    setReload((n) => n + 1)
    setAllSelection(null)
    setPick(NOTHING_PICKED)
    onChanged()
  }, [onChanged])
  useEffect(() => {
    if (fixedItems) {
      const q = JSON.parse(key) as IndexBrowserQuery
      let matches = fixedItems.filter(
        (item) =>
          (!q.query || foldText(`${item.name} ${item.path}`).includes(foldText(q.query))) &&
          (!q.status || item.status === q.status) &&
          (!q.type || item.name.toLowerCase().endsWith(`.${q.type.toLowerCase()}`)),
      )
      if (q.sort === 'recent' || q.sort === 'size') {
        const value = (item: FileItem) =>
          q.sort === 'recent' ? (item.mtimeMs ?? -1) : (item.sizeBytes ?? -1)
        matches.sort((a, b) => (value(a) - value(b)) * (q.descending ? -1 : 1))
      } else if (q.sort && q.sort !== 'queue')
        matches = sortViewFiles(matches, q.sort as IndexViewSort, !!q.descending, dateLocale, null)
      setPage({
        items: matches.map((i) => ({ ...i, status: i.status ?? 'ready' })),
        total: matches.length,
        sizeBytes: 0,
      })
      return
    }
    let alive = true
    const generation = ++request.current
    setLoading(true)
    setFailed(false)
    void readIndexRequest(
      () => api.getIndexBrowserPage!(JSON.parse(key)),
      (v): v is IndexBrowserPage =>
        !!v &&
        typeof v === 'object' &&
        Array.isArray((v as IndexBrowserPage).items) &&
        Number.isFinite((v as IndexBrowserPage).total),
    )
      .then((next) => {
        if (alive && generation === request.current) {
          setPage(next)
          if (!allRef.current)
            setPick((current) => ({
              ...current,
              picked: new Set(
                [...current.picked].filter((id) => next.items.some((i) => i.id === id)),
              ),
            }))
        }
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [api, key, revision, reload, fixedItems, dateLocale])
  const items = useMemo(
    () => (page?.items ?? []).map((i) => ({ ...i, offline: isOffline(i.path) })),
    [page, isOffline],
  )
  const ids = useMemo(() => items.map((i) => i.id), [items])
  const actions = useFileActions(
    api,
    (reason) => activityCopy(lang).reasons[reason].title,
    changed,
    () => {},
    snapshotNow ?? revision,
  )
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const open = useCallback((item: FileItem, more = false) => {
    setActive((current) => (more ? item : current?.id === item.id ? null : item))
    if (!more || actionsRef.current.open !== item.id) actionsRef.current.toggle(item)
    if (more)
      requestAnimationFrame(() => {
        const detail = scrollRef.current
          ?.closest('.ix-browser')
          ?.querySelector<HTMLDetailsElement>('.ix-detail-more')
        if (detail) {
          detail.open = true
          detail.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
        }
      })
  }, [])
  const onPick = useCallback(
    (id: number, range: boolean) => {
      if (allRef.current && id > (allRef.current.query.throughId ?? Infinity)) {
        setAllSelection(null)
        setPick(pick(NOTHING_PICKED, ids, id, 'toggle'))
      } else setPick((current) => pick(current, ids, id, range ? 'range' : 'toggle'))
    },
    [ids],
  )
  const bulk = useIndexBulk(api, changed)
  const select = (members: FileItem[]) => {
    if (allSelection && members.some((i) => i.id > (allSelection.query.throughId ?? Infinity))) {
      setAllSelection(null)
      setPick({ picked: new Set(members.map((i) => i.id)), anchor: members[0]?.id ?? null })
      return
    }
    setPick((current) => {
      const next = new Set(current.picked)
      const all = members.every((i) => (allRef.current ? !next.has(i.id) : next.has(i.id)))
      for (const i of members) {
        if (all === !allRef.current) next.delete(i.id)
        else next.add(i.id)
      }
      return { picked: next, anchor: members[0]?.id ?? null }
    })
  }
  const groups = useMemo(() => {
    const result = new Map<string, FileItem[]>()
    for (const item of items) {
      const group =
        grouping === 'folder'
          ? folderOf(item.path)
          : grouping === 'type'
            ? (item.name.split('.').pop()?.toUpperCase() ?? '')
            : grouping === 'reason'
              ? (item.reason ?? item.status ?? '')
              : ''
      const list = result.get(group) ?? []
      list.push(item)
      result.set(group, list)
    }
    return [...result].map(([name, members]) => ({ name, members }))
  }, [items, grouping])
  const entries = useMemo(
    () =>
      groups.flatMap((group) => [
        ...(grouping === 'none' ? [] : [{ kind: 'group' as const, group }]),
        ...(collapsed.has(group.name)
          ? []
          : group.members.map((item) => ({ kind: 'file' as const, item }))),
      ]),
    [groups, grouping, collapsed],
  )
  const listRef = useRef<HTMLUListElement>(null)
  const navigableIds = entries.flatMap((entry) => (entry.kind === 'file' ? [entry.item.id] : []))
  const scrollRef = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef<{ id: number; selectRange: boolean } | null>(null)
  const { windowed, range, padTop, padBottom } = useWindowedRows(
    listRef,
    entries.length,
    56,
    '.ix-browser-scroll',
  )
  const focusPendingRow = useCallback(() => {
    const pending = pendingFocus.current
    if (!pending) return
    const button = scrollRef.current?.querySelector<HTMLButtonElement>(
      `[data-file-id="${pending.id}"]`,
    )
    if (!button) return
    pendingFocus.current = null
    button.focus()
    if (pending.selectRange) onPick(pending.id, true)
  }, [onPick])
  useEffect(focusPendingRow, [focusPendingRow, range, entries])
  useEffect(() => {
    scrollRef.current?.scrollTo?.(0, 0)
    setActive(null)
    actionsRef.current.close()
    if (!allRef.current) setPick(NOTHING_PICKED)
  }, [key])
  useEffect(() => {
    setPick(NOTHING_PICKED)
    setAllSelection(null)
  }, [filterKey])
  const selected = items.filter((i) =>
    allSelection
      ? i.id <= (allSelection.query.throughId ?? Infinity) && !pickState.picked.has(i.id)
      : pickState.picked.has(i.id),
  )
  const selectedCount = allSelection
    ? Math.max(0, allSelection.total - pickState.picked.size)
    : selected.length
  const close = () => {
    setActive(null)
    actions.close()
    if (active)
      requestAnimationFrame(() =>
        scrollRef.current
          ?.querySelector<HTMLButtonElement>(`[data-file-id="${active.id}"]`)
          ?.focus(),
      )
  }
  const offset = view.offset ?? 0
  const bulkButton = (mode: IndexBulkAction, text: string) => (
    <button
      type="button"
      className="ix-btn is-small"
      disabled={bulk.busy}
      onClick={() =>
        void bulk.run(mode, allSelection ? { ...allSelection, except: pickState.picked } : selected)
      }
    >
      {text}
    </button>
  )
  return (
    <div className={`ix-browser${active ? ' has-detail' : ''}`}>
      <div className="ix-browser-list">
        {!hideToolbar && (
          <IndexFileToolbar
            value={view}
            onChange={setView}
            grouping={grouping}
            onGroup={(v) => {
              setGrouping(v)
              setCollapsed(new Set())
            }}
            reasons={scope.reasons}
          />
        )}
        <div className="ix-browser-tools">
          <button
            type="button"
            className="ix-link"
            onClick={() => select(items)}
            disabled={!items.length}
          >
            {w.selectShown}
          </button>
          {!fixedItems && page && page.total > page.items.length && page.maxId !== undefined && (
            <button
              type="button"
              className="ix-link"
              onClick={() => {
                setPick(NOTHING_PICKED)
                setAllSelection({
                  query: { ...view, offset: 0, throughId: page.maxId },
                  total: page.total,
                })
              }}
            >
              {fill(w.selectAll, { n: page.total.toLocaleString(dateLocale) })}
            </button>
          )}
          {grouping !== 'none' && (
            <>
              <button type="button" className="ix-link" onClick={() => setCollapsed(new Set())}>
                {w.expandAll}
              </button>
              <button
                type="button"
                className="ix-link"
                onClick={() => setCollapsed(new Set(groups.map((g) => g.name)))}
              >
                {w.collapseAll}
              </button>
            </>
          )}
        </div>
        <p className="ix-sr-only">{w.fileHint}</p>
        {selectedCount > 0 && (
          <div
            className="ix-bulk"
            role="toolbar"
            aria-label={fill(w.selected, { n: selectedCount })}
          >
            <strong>{fill(w.selected, { n: selectedCount.toLocaleString(dateLocale) })}</strong>
            {bulkButton('retry', w.retry)}
            {bulkButton('ocr', w.ocr)}
            <details>
              <summary className="ix-btn is-small">{w.more}</summary>
              <div className="ix-bulk-more">
                {bulkButton('exclude', w.exclude)}
                {bulkButton('remove', w.remove)}
                {bulkButton('reveal', w.showFirst)}
                {bulkButton('later', w.later)}
                {bulkButton('stop', w.stop)}
                {bulkButton('copy', w.copy)}
                {bulkButton('trash', w.trash)}
              </div>
            </details>
            <button
              type="button"
              className="ix-link"
              onClick={() => {
                setPick(NOTHING_PICKED)
                setAllSelection(null)
              }}
            >
              {w.clear}
            </button>
          </div>
        )}
        {(bulk.note || actions.note) && (
          <p className="ix-note" role="status">
            {bulk.note || actions.note}
          </p>
        )}
        {failed && (
          <p className="ix-note" role="status">
            {w.failed}{' '}
            <button type="button" className="ix-link" onClick={() => setReload((n) => n + 1)}>
              {w.retry}
            </button>
          </p>
        )}
        <div
          className="ix-browser-scroll"
          ref={scrollRef}
          aria-busy={loading}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              close()
              setPick(NOTHING_PICKED)
              setAllSelection(null)
              return
            }
            if (
              !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) ||
              !(e.target as HTMLElement).closest('[data-file-id]')
            )
              return
            e.preventDefault()
            const current = navigableIds.indexOf(
              Number(
                (e.target as HTMLElement).closest<HTMLElement>('[data-file-id]')?.dataset.fileId,
              ),
            )
            const target =
              e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? navigableIds.length - 1
                  : Math.max(
                      0,
                      Math.min(navigableIds.length - 1, current + (e.key === 'ArrowDown' ? 1 : -1)),
                    )
            const id = navigableIds[target]
            const entryIndex = entries.findIndex(
              (entry) => entry.kind === 'file' && entry.item.id === id,
            )
            pendingFocus.current = { id, selectRange: e.shiftKey }
            scrollRef.current!.scrollTop = entryIndex * 56
            requestAnimationFrame(focusPendingRow)
          }}
        >
          {!page && loading ? (
            <p className="ix-note">{w.loading}</p>
          ) : !items.length ? (
            <p className="ix-note">{w.noMatch}</p>
          ) : (
            <ul
              className="ix-browser-rows"
              ref={listRef}
              style={windowed ? { paddingTop: padTop, paddingBottom: padBottom } : undefined}
            >
              {(windowed ? entries.slice(range.start, range.end) : entries).map((entry) =>
                entry.kind === 'file' ? (
                  <FileRow
                    key={entry.item.id}
                    item={entry.item}
                    active={active?.id === entry.item.id}
                    picked={
                      allSelection
                        ? entry.item.id <= (allSelection.query.throughId ?? Infinity) &&
                          !pickState.picked.has(entry.item.id)
                        : pickState.picked.has(entry.item.id)
                    }
                    onOpen={open}
                    onPick={onPick}
                    activity={indexFileActivity(entry.item.path, now, w)}
                  />
                ) : (
                  <li className="ix-browser-group" key={`g:${entry.group.name}`}>
                    <button
                      type="button"
                      className="ix-link"
                      aria-expanded={!collapsed.has(entry.group.name)}
                      onClick={() =>
                        setCollapsed((current) => {
                          const next = new Set(current)
                          if (next.has(entry.group.name)) next.delete(entry.group.name)
                          else next.add(entry.group.name)
                          return next
                        })
                      }
                    >
                      {grouping === 'reason'
                        ? (activityCopy(lang).reasons[
                            entry.group.name as NonNullable<FileItem['reason']>
                          ]?.title ??
                          w[entry.group.name as 'ready'] ??
                          entry.group.name)
                        : entry.group.name}{' '}
                      · {entry.group.members.length}
                    </button>
                    <button
                      type="button"
                      className="ix-link"
                      onClick={() => select(entry.group.members)}
                    >
                      {w.selectGroup}
                    </button>
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
        {page && (
          <footer className="ix-browser-footer">
            <span>
              {fill(w.coverage, {
                from: page.total ? (offset + 1).toLocaleString(dateLocale) : 0,
                to: (offset + page.items.length).toLocaleString(dateLocale),
                total: page.total.toLocaleString(dateLocale),
              })}
            </span>
            {page.total > INDEX_BROWSER_PAGE_SIZE && (
              <>
                <button
                  type="button"
                  className="ix-btn is-small"
                  disabled={!offset || loading}
                  onClick={() =>
                    setView((v) => ({
                      ...v,
                      offset: Math.max(0, offset - INDEX_BROWSER_PAGE_SIZE),
                    }))
                  }
                >
                  {w.previous}
                </button>
                <button
                  type="button"
                  className="ix-btn is-small"
                  disabled={offset + page.items.length >= page.total || loading}
                  onClick={() =>
                    setView((v) => ({ ...v, offset: offset + INDEX_BROWSER_PAGE_SIZE }))
                  }
                >
                  {w.next}
                </button>
              </>
            )}
          </footer>
        )}
      </div>
      {active && (
        <IndexFileDetail
          api={api}
          item={items.find((i) => i.id === active.id) ?? active}
          actions={actions}
          now={now}
          onClose={close}
          onIgnorePath={(path) => {
            void api
              .addIndexIgnore?.(path)
              .then((result) => {
                if (!result.ok) actions.say(w.failed)
                else {
                  setActive(null)
                  actions.close()
                  actions.say(w.done)
                  changed()
                }
              })
              .catch(() => actions.say(w.failed))
          }}
        />
      )}
    </div>
  )
}
