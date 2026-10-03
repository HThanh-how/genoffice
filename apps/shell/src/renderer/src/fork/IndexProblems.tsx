import { useCallback, useEffect, useRef, useState } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import type { IndexIssueSummary } from '../../../main/document-memory/issue-reader'
import type { IndexIssue, IndexIssueReason } from '../../../main/document-memory/issues'
import { isInformationalReason, isRetryableReason } from '../../../main/document-memory/issues'
import type { Lang } from '@genoffice/i18n'
import { useI18n } from '../locale'
import { activityCopy, fill } from '../indexing-activity-copy'
import {
  FileRow,
  IChevron,
  IRetry,
  IconButton,
  liveOf,
  useFileActions,
  useIndexingNow,
} from './IndexFiles'
import { NOTHING_PICKED, pick, type PickState } from './index-selection'

/** Something the person can act on: failures, and scanned files still waiting to be read. */
export function needsAction(reason: IndexIssueReason): boolean {
  return reason === 'no-text' || !isInformationalReason(reason)
}

const BATCH = 10

/** Where a group sits in the "to do" list: scans first, what is being indexed last. */
export function attentionRank(reason: IndexIssueReason): number {
  return reason === 'no-text' ? 0 : reason === 'waiting' ? 2 : 1
}

const EN = {
  retryEverything: 'Try all errors again',
  readBatch: 'Read {n} scanned files now',
  readBatchConfirm:
    'Read {n} scanned PDFs now with Antigravity? It uses Antigravity quota and ignores today’s limit.',
  readProgress: 'Reading {i} of {n}…',
  readFinished: 'Read {ok} of {n} files.',

  empty: 'No problems. Every readable file is indexed.',
  noFolder: 'Scan a folder first.',
  attention: 'To do',
  skipped: 'Skipped on purpose',
  retryAll: 'Try all again',
  more: 'Show more ({n} left)',
  retried: 'Queued {n} files again.',
  loading: 'Loading…',
  indexingProgress: '{done} of {total} read',
  picked: '{n} selected',
  readPicked: 'Index {n} now',
  pickHint: 'Ctrl/Shift+click to select several files',
  readPickedConfirm:
    'Read {n} files now? Scanned PDFs are read with Antigravity: it uses Antigravity quota and ignores today’s limit.',
  clearPicked: 'Clear selection',
  ocrPicked: 'Read {n} scans with Antigravity',
  noPdfPicked: 'None of the selected files is a PDF.',
  selectedAll: 'Selected {n} files.',
}
type Dict = typeof EN
const VI: Dict = {
  retryEverything: 'Thử lại tất cả lỗi',
  readBatch: 'Đọc ngay {n} tệp quét',
  readBatchConfirm:
    'Đọc ngay {n} tệp PDF quét bằng Antigravity? Sẽ tốn quota Antigravity và bỏ qua giới hạn hôm nay.',
  readProgress: 'Đang đọc {i}/{n}…',
  readFinished: 'Đã đọc {ok}/{n} tệp.',

  empty: 'Không có lỗi. Mọi tệp đọc được đều đã index.',
  noFolder: 'Hãy quét một thư mục trước.',
  attention: 'Cần xử lý',
  skipped: 'Bỏ qua có chủ đích',
  retryAll: 'Thử lại cả nhóm',
  more: 'Xem thêm ({n} tệp nữa)',
  retried: 'Đã xếp lại {n} tệp.',
  loading: 'Đang tải…',
  indexingProgress: 'Đã đọc {done}/{total}',
  picked: 'Đã chọn {n}',
  readPicked: 'Index {n} tệp ngay',
  pickHint: 'Ctrl/Shift+bấm để chọn nhiều tệp',
  readPickedConfirm:
    'Đọc ngay {n} tệp? PDF quét sẽ được đọc bằng Antigravity: tốn quota Antigravity và bỏ qua giới hạn hôm nay.',
  clearPicked: 'Bỏ chọn',
  ocrPicked: 'Đọc {n} tệp quét bằng Antigravity',
  noPdfPicked: 'Không có tệp PDF nào trong số đã chọn.',
  selectedAll: 'Đã chọn {n} tệp.',
}

/** Files being read go first, then the next in line, then the rest (stable order). */
function rank(live: ReturnType<typeof liveOf>): number {
  if (!live) return 1_000_000
  if (live.kind === 'reading') return 0
  if (live.kind === 'embedding') return 1
  if (live.kind === 'queued') return 2 + live.position
  return 1_000_000
}

/**
 * Reads pages (from the start) until `want` items are loaded or the list ends, so a refresh keeps a
 * list as long as it is on screen instead of shrinking it back to the first page.
 */
export async function loadAtLeast<T>(
  fetchPage: (offset: number) => Promise<{ items: T[]; total: number }>,
  want: number,
): Promise<{ items: T[]; total: number }> {
  let items: T[] = []
  let total = 0
  while (items.length < want) {
    const page = await fetchPage(items.length)
    total = page.total
    items = [...items, ...page.items]
    if (page.items.length === 0 || items.length >= page.total) break
  }
  return { items, total }
}

interface GroupState {
  items: IndexIssue[]
  total: number
  loading: boolean
}

export function IndexProblems({
  api,
  root,
  focus,
  onChanged,
}: {
  api: HomeApi
  root: string
  /** a group to open at once (picked from the overview) */
  focus?: IndexIssueReason | null
  onChanged: () => void
}) {
  const { lang, dateLocale } = useI18n()
  const d = lang === 'vi' ? VI : EN
  const copy = activityCopy(lang as Lang)
  const [summary, setSummary] = useState<IndexIssueSummary | null>(null)
  const [open, setOpen] = useState<Set<IndexIssueReason>>(new Set())
  const [groups, setGroups] = useState<Partial<Record<IndexIssueReason, GroupState>>>({})

  const loadSummary = useCallback(async () => {
    if (!root) return
    try {
      setSummary(await api.getDocumentIndexIssueSummary(root))
    } catch {
      /* keep what is shown */
    }
  }, [api, root])
  useEffect(() => {
    void loadSummary()
  }, [loadSummary])

  const groupsRef = useRef(groups)
  groupsRef.current = groups
  const now = useIndexingNow(api, true)
  // Files that were being read a moment ago and are gone from their list: shown green, then removed.
  const [finished, setFinished] = useState<IndexIssue[]>([])
  const wasLive = useRef(new Set<string>())
  const nowRef = useRef(now)
  nowRef.current = now
  const loadGroup = useCallback(
    async (reason: IndexIssueReason, append = false) => {
      const shown = groupsRef.current[reason]
      // A refresh keeps what is on screen in place (no "Loading…" row, no collapsing back to the
      // first page): only a group that has nothing to show yet, or "show more", says it is loading.
      if (append || !shown || shown.items.length === 0) {
        setGroups((current) => ({
          ...current,
          [reason]: {
            items: current[reason]?.items ?? [],
            total: current[reason]?.total ?? 0,
            loading: true,
          },
        }))
      }
      try {
        let items: IndexIssue[]
        let total: number
        if (append) {
          const page = await api.getDocumentIndexIssues(root, shown?.items.length ?? 0, reason)
          items = [...(shown?.items ?? []), ...page.items]
          total = page.total
        } else {
          // as many files as are shown now, so a list opened with "show more" stays that long
          const loaded = await loadAtLeast(
            (offset) => api.getDocumentIndexIssues(root, offset, reason),
            Math.max(shown?.items.length ?? 0, 1),
          )
          items = loaded.items
          total = loaded.total
          const gone = (shown?.items ?? []).filter(
            (item) => wasLive.current.has(item.path) && !items.some((next) => next.id === item.id),
          )
          if (gone.length > 0) {
            setFinished((current) => [...current, ...gone])
            window.setTimeout(
              () => setFinished((current) => current.filter((item) => !gone.includes(item))),
              1800,
            )
          }
        }
        // closed while it was loading: it stays forgotten
        if (!append && !openRef.current.has(reason) && !groupsRef.current[reason]) return
        setGroups((current) => {
          const before = current[reason]
          // nothing changed: keep the same objects so the list is not redrawn for nothing
          if (
            before &&
            !before.loading &&
            before.total === total &&
            before.items.length === items.length &&
            before.items.every((item, index) => item.id === items[index]?.id)
          )
            return current
          return { ...current, [reason]: { items, total, loading: false } }
        })
      } catch {
        setGroups((current) => ({
          ...current,
          [reason]: {
            items: current[reason]?.items ?? [],
            total: current[reason]?.total ?? 0,
            loading: false,
          },
        }))
      }
    },
    [api, root],
  )

  const actions = useFileActions(
    api,
    (reason) => copy.reasons[reason].title,
    onChanged,
    async (item) => {
      await loadSummary()
      if (item.reason) await loadGroup(item.reason)
    },
  )

  // While something is being read, the open lists and the counts follow along.
  const busy = !!now && (now.extracting.length > 0 || Object.keys(now.embedding).length > 0)
  useEffect(() => {
    if (!now) return
    const live = new Set<string>(now.extracting.map((entry) => entry.path))
    for (const path of Object.keys(now.embedding)) live.add(path)
    if (live.size > 0) wasLive.current = new Set([...wasLive.current, ...live])
  }, [now])
  const [pickState, setPickState] = useState<PickState>(NOTHING_PICKED)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const editing =
        event.target instanceof HTMLElement &&
        (event.target.isContentEditable || /^(input|textarea|select)$/i.test(event.target.tagName))
      if (event.key === 'Escape') setPickState(NOTHING_PICKED)
      // Ctrl/Cmd+A picks every file of the open lists
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !editing) {
        if (openRef.current.size === 0) return
        event.preventDefault()
        for (const reason of openRef.current) void selectGroupRef.current(reason)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const waitingPeak = useRef(0)
  useEffect(() => {
    waitingPeak.current = 0
  }, [root])
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => {
      void loadSummary()
      for (const reason of openRef.current) void loadGroup(reason)
    }, 3000)
    return () => clearInterval(timer)
  }, [busy, loadSummary, loadGroup])

  // The only attention group opens by itself, and a group picked on the overview opens too.
  const autoOpened = useRef(false)
  useEffect(() => {
    if (!summary) return
    const wanted =
      focus && summary.groups.some((g) => g.reason === focus)
        ? focus
        : !autoOpened.current && summary.groups.filter((g) => needsAction(g.reason)).length === 1
          ? summary.groups.find((g) => needsAction(g.reason))!.reason
          : null
    autoOpened.current = true
    if (wanted) {
      setOpen((current) => new Set(current).add(wanted))
      if (!groupsRef.current[wanted]) void loadGroup(wanted)
    }
  }, [summary, focus, loadGroup])

  const toggle = (reason: IndexIssueReason) => {
    const next = new Set(open)
    if (next.has(reason)) {
      next.delete(reason)
      // closed: forget how far it was opened, so opening it again starts from the first page
      setGroups((current) => {
        const { [reason]: _closed, ...rest } = current
        return rest
      })
    } else {
      next.add(reason)
      if (!groups[reason]) void loadGroup(reason)
    }
    setOpen(next)
  }

  const retryEverything = async () => {
    let queued = 0
    for (const group of summary?.groups ?? []) {
      if (
        !needsAction(group.reason) ||
        !isRetryableReason(group.reason) ||
        group.reason === 'waiting'
      )
        continue
      const result = await api.retryDocumentIndexGroup(root, group.reason)
      if (result.ok) queued += result.retried
    }
    actions.say(fill(d.retried, { n: queued }))
    await loadSummary()
    for (const reason of open) await loadGroup(reason)
    onChanged()
  }

  const clearPick = () => setPickState(NOTHING_PICKED)
  const pickFile = (
    ordered: readonly number[],
    item: { id: number },
    mode: 'toggle' | 'range' | 'clear',
  ) => {
    if (mode === 'clear') {
      if (pickState.picked.size > 0) clearPick()
      return
    }
    setPickState((current) => pick(current, ordered, item.id, mode))
  }

  /**
   * The picked files, one after another. "index": text files are read and scans go on to
   * Antigravity. "ocr": only the PDFs among them, all with Antigravity.
   */
  const readPicked = async (mode: 'index' | 'ocr' = 'index') => {
    const all = Object.values(groupsRef.current)
      .flatMap((group) => group?.items ?? [])
      .filter((item) => pickState.picked.has(item.id))
    const chosen = mode === 'ocr' ? all.filter((item) => /\.pdf$/i.test(item.path)) : all
    if (chosen.length === 0) {
      if (all.length > 0) actions.say(d.noPdfPicked)
      return
    }
    const question = mode === 'ocr' ? d.readBatchConfirm : d.readPickedConfirm
    if (!window.confirm(fill(question, { n: chosen.length }))) return
    let ok = 0
    for (const [index, item] of chosen.entries()) {
      actions.say(fill(d.readProgress, { i: index + 1, n: chosen.length }))
      try {
        let result =
          mode === 'ocr' || item.reason === 'no-text'
            ? await api.readScannedPdfWithAgy(item.id, true)
            : await api.retryDocumentIndex(item.id)
        if (result.ok && 'empty' in result && result.empty && /\.pdf$/i.test(item.path))
          result = await api.readScannedPdfWithAgy(item.id, true)
        if (result.ok) ok++
      } catch {
        /* the next file still gets its turn */
      }
    }
    actions.say(fill(d.readFinished, { ok, n: chosen.length }))
    clearPick()
    await loadSummary()
    for (const reason of openRef.current) await loadGroup(reason)
    onChanged()
  }

  /** Pick every file of a list, including the ones not shown yet (they are loaded for it). */
  const selectGroup = async (reason: IndexIssueReason) => {
    const total = groupsRef.current[reason]?.total ?? 0
    const loaded = await loadAtLeast(
      (offset) => api.getDocumentIndexIssues(root, offset, reason),
      Math.min(Math.max(total, 1), 2000),
    )
    setGroups((current) => ({
      ...current,
      [reason]: { items: loaded.items, total: loaded.total, loading: false },
    }))
    setPickState((current) => ({
      picked: new Set([...current.picked, ...loaded.items.map((item) => item.id)]),
      anchor: loaded.items[0]?.id ?? current.anchor,
    }))
    actions.say(fill(d.selectedAll, { n: loaded.items.length }))
  }
  const selectGroupRef = useRef(selectGroup)
  selectGroupRef.current = selectGroup

  const readBatch = async () => {
    const page = await api.getDocumentIndexIssues(root, 0, 'no-text')
    const batch = page.items.slice(0, BATCH)
    if (batch.length === 0) return
    if (!window.confirm(fill(d.readBatchConfirm, { n: batch.length }))) return
    let ok = 0
    for (const [index, item] of batch.entries()) {
      actions.say(fill(d.readProgress, { i: index + 1, n: batch.length }))
      try {
        const result = await api.readScannedPdfWithAgy(item.id, true)
        if (result.ok) ok++
        // one file that cannot be read must not stop the rest; only Antigravity being switched
        // off does
        else if (result.error === 'unavailable' || result.error === 'paused') break
      } catch {
        /* the next file still gets its turn */
      }
    }
    actions.say(fill(d.readFinished, { ok, n: batch.length }))
    await loadSummary()
    if (open.has('no-text')) await loadGroup('no-text')
    onChanged()
  }

  const retryGroup = async (reason: IndexIssueReason) => {
    const result = await api.retryDocumentIndexGroup(root, reason)
    actions.say(result.ok ? fill(d.retried, { n: result.retried }) : (result.error ?? ''))
    await Promise.all([loadSummary(), loadGroup(reason)])
    onChanged()
  }

  if (!root) return <p className="idx-muted">{d.noFolder}</p>
  const list = summary?.groups ?? []
  if (summary && list.length === 0) return <p className="idx-empty">{d.empty}</p>

  const renderGroup = (reason: IndexIssueReason, count: number) => {
    const words = copy.reasons[reason]
    // the line "N left" and a bar: how far the files seen waiting at the start have come
    const peak = reason === 'waiting' ? Math.max(waitingPeak.current, count) : 0
    if (reason === 'waiting') waitingPeak.current = peak
    const doneShare = peak > 0 ? Math.round(((peak - count) / peak) * 100) : 0
    const isOpen = open.has(reason)
    const state = groups[reason]
    // the order the files are shown in: Shift+click picks between two of them
    const sorted = [...(state?.items ?? [])].sort(
      (x, y) => rank(liveOf(now, x.path)) - rank(liveOf(now, y.path)),
    )
    const orderedIds = sorted.map((issue) => issue.id)
    return (
      <section className={`ixp-group${isOpen ? ' is-open' : ''}`} key={reason}>
        <div className="ixp-head-row">
          <button
            type="button"
            className="ixp-head"
            aria-expanded={isOpen}
            onClick={() => toggle(reason)}
          >
            <span className="ixp-chevron">
              <IChevron />
            </span>
            <span className="ixp-head-text">
              <strong>{words.title}</strong>
              <span>{words.hint}</span>
              {reason === 'waiting' && peak > 0 && (
                <span
                  className="ixp-bar"
                  role="progressbar"
                  aria-valuenow={doneShare}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  title={fill(d.indexingProgress, { done: peak - count, total: peak })}
                >
                  <span style={{ width: `${doneShare}%` }} />
                </span>
              )}
            </span>
            <span className="ixp-count">{count.toLocaleString(dateLocale)}</span>
          </button>
          {isRetryableReason(reason) && (
            <IconButton label={d.retryAll} onClick={() => void retryGroup(reason)}>
              <IRetry />
            </IconButton>
          )}
        </div>
        {isOpen && (
          <ul className="ixp-files">
            {finished
              .filter((item) => item.reason === reason)
              .map((item) => (
                <FileRow key={`done-${item.id}`} item={item} actions={actions} api={api} finished />
              ))}
            {sorted.map((issue) => (
              <FileRow
                key={issue.id}
                item={issue}
                actions={actions}
                api={api}
                live={liveOf(now, issue.path)}
                picked={pickState.picked.has(issue.id)}
                pickedCount={pickState.picked.size}
                onPick={(item, mode) => pickFile(orderedIds, item, mode)}
                onReadPicked={() => void readPicked()}
                onSelectGroup={() => void selectGroup(reason)}
                onClearPicked={clearPick}
              />
            ))}
            {state?.loading && <li className="ixp-loading">{d.loading}</li>}
            {state && !state.loading && state.total > state.items.length && (
              <li>
                <button
                  type="button"
                  className="idx-link"
                  onClick={() => void loadGroup(reason, true)}
                >
                  {fill(d.more, { n: state.total - state.items.length })}
                </button>
              </li>
            )}
          </ul>
        )}
      </section>
    )
  }

  // scans first and in a fixed place: the indexing group below changes all the time, and the
  // list above it used to jump with it
  const pickedPdfCount = Object.values(groups)
    .flatMap((group) => group?.items ?? [])
    .filter((item) => pickState.picked.has(item.id) && /\.pdf$/i.test(item.path)).length
  const attention = list
    .filter((g) => needsAction(g.reason))
    .sort((a, b) => attentionRank(a.reason) - attentionRank(b.reason))
  const skipped = list.filter((g) => !needsAction(g.reason))
  const scanned = list.find((g) => g.reason === 'no-text')?.count ?? 0
  const failures = attention.some((g) => isRetryableReason(g.reason))
  return (
    <div className="ixp">
      {actions.note && (
        <p className="ixp-note" role="status">
          {actions.note}
        </p>
      )}
      {pickState.picked.size > 0 && (
        <div className="ixp-toolbar ixp-pickbar" role="toolbar">
          <span>{fill(d.picked, { n: pickState.picked.size })}</span>
          <button type="button" className="idx-btn primary" onClick={() => void readPicked()}>
            {fill(d.readPicked, { n: pickState.picked.size })}
          </button>
          <button type="button" className="idx-btn" onClick={() => void readPicked('ocr')}>
            {fill(d.ocrPicked, { n: pickedPdfCount })}
          </button>
          <button type="button" className="idx-btn" onClick={clearPick}>
            {d.clearPicked}
          </button>
        </div>
      )}
      {(failures || scanned > 0) && (
        <div className="ixp-toolbar">
          {failures && (
            <button
              type="button"
              className="idx-btn primary"
              onClick={() => void retryEverything()}
            >
              {d.retryEverything}
            </button>
          )}
          {scanned > 0 && (
            <button type="button" className="idx-btn" onClick={() => void readBatch()}>
              {fill(d.readBatch, { n: Math.min(BATCH, scanned) })}
            </button>
          )}
        </div>
      )}
      {attention.length > 0 && (
        <>
          <h2 className="ixp-title">{d.attention}</h2>
          <p className="idx-muted">{d.pickHint}</p>
          {attention.map((g) => renderGroup(g.reason, g.count))}
        </>
      )}
      {skipped.length > 0 && (
        <>
          <h2 className="ixp-title">{d.skipped}</h2>
          {skipped.map((g) => renderGroup(g.reason, g.count))}
        </>
      )}
    </div>
  )
}
