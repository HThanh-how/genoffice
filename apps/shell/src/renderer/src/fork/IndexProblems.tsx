import { appConfirm } from '../ui-feedback'
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import type { IndexIssueSummary } from '../../../main/document-memory/issue-reader'
import type { IndexIssue, IndexIssueReason } from '../../../main/document-memory/issues'
import { isRetryableReason } from '../../../main/document-memory/issues'
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
import { matchesQuery } from './todo-model'
import { issueBucket, type IssueBucket } from './index-issue-view'
import {
  INDEX_ISSUE_PAGE_SIZE,
  INDEX_ISSUE_READ_TIMEOUT_MS,
  isIndexIssuePage,
  isIndexIssueSummary,
  readIndexRequest,
} from './index-request'

/** What the cards above the lists can ask the lists to do. */
export interface ProblemCommands {
  openReason(reason: IndexIssueReason): void
  retryAll(): Promise<void>
  readAllScans(): Promise<void>
}

/** Something the person can act on: failures, and scanned files still waiting to be read. */
export function needsAction(reason: IndexIssueReason): boolean {
  return issueBucket(reason) === 'attention'
}

const BATCH = 10
const MAX_ISSUE_PAGE_REQUESTS = 200

function loadIssuePage(api: HomeApi, root: string, offset: number, reason?: IndexIssueReason) {
  return readIndexRequest(() => api.getDocumentIndexIssues(root, offset, reason), isIndexIssuePage)
}

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
  readAllConfirm:
    'Read all {n} scanned PDFs with Antigravity, one after another? It uses Antigravity quota and ignores today’s limit.',
  noMatch: 'No file matches “{q}”.',

  empty: 'No problems. Every readable file is indexed.',
  noFolder: 'Scan a folder first.',
  attention: 'Needs attention',
  background: 'Running in the background',
  expandAll: 'Expand all',
  collapseAll: 'Collapse all',
  selectVisible: 'Select shown files',
  deselectVisible: 'Deselect shown files',
  working: 'Working…',
  actionFailed: 'Could not complete this action. Try again.',
  searchSubset: 'Searched {n} of {total} files. Load more to search the rest.',
  noLoadedMatch: 'No matches in the files loaded so far.',
  matches: '{n} matches',
  skipped: 'Skipped on purpose',
  retryAll: 'Try all again',
  more: 'Show more ({n} left)',
  retried: 'Queued {n} files again.',
  loading: 'Loading…',
  summaryFailed: 'Could not load the file groups. Refresh to try again.',
  indexingProgress: '{done} of {total} read',
  picked: '{n} selected',
  readPicked: 'Read {n} files now',
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
  readAllConfirm:
    'Đọc lần lượt cả {n} tệp PDF quét bằng Antigravity? Sẽ tốn quota Antigravity và bỏ qua giới hạn hôm nay.',
  noMatch: 'Không có tệp nào khớp “{q}”.',

  empty: 'Không có lỗi. Mọi tệp đọc được đều đã index.',
  noFolder: 'Hãy quét một thư mục trước.',
  attention: 'Cần xử lý',
  background: 'Đang chạy nền',
  expandAll: 'Mở tất cả',
  collapseAll: 'Thu gọn tất cả',
  selectVisible: 'Chọn tệp đang hiển thị',
  deselectVisible: 'Bỏ chọn tệp đang hiển thị',
  working: 'Đang xử lý…',
  actionFailed: 'Không thể hoàn thành. Hãy thử lại.',
  searchSubset: 'Đã tìm trong {n}/{total} tệp. Tải thêm để tìm phần còn lại.',
  noLoadedMatch: 'Chưa có kết quả trong các tệp đã tải.',
  matches: '{n} kết quả',
  skipped: 'Bỏ qua có chủ đích',
  retryAll: 'Thử lại cả nhóm',
  more: 'Xem thêm ({n} tệp nữa)',
  retried: 'Đã xếp lại {n} tệp.',
  loading: 'Đang tải…',
  summaryFailed: 'Không thể tải nhóm tệp. Làm mới để thử lại.',
  indexingProgress: 'Đã đọc {done}/{total}',
  picked: 'Đã chọn {n}',
  readPicked: 'Đọc {n} tệp ngay',
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
  let requests = 0
  const deadline = Date.now() + INDEX_ISSUE_READ_TIMEOUT_MS
  const pageSignatures = new Set<string>()
  while (items.length < want) {
    if (++requests > MAX_ISSUE_PAGE_REQUESTS)
      throw new Error('Index issue list exceeded the page limit')
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) throw new Error('Index issue list timed out')
    const page = await readIndexRequest(
      () => fetchPage(items.length),
      (value): value is { items: T[]; total: number } => {
        if (typeof value !== 'object' || value === null) return false
        const candidate = value as { items?: unknown; total?: unknown }
        return (
          Number.isSafeInteger(candidate.total) &&
          (candidate.total as number) >= 0 &&
          Array.isArray(candidate.items) &&
          candidate.items.length <= INDEX_ISSUE_PAGE_SIZE
        )
      },
      remainingMs,
    )
    const signature = JSON.stringify(page.items)
    if (page.items.length > 0 && pageSignatures.has(signature))
      throw new Error('Index issue list did not advance')
    pageSignatures.add(signature)
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
  failed?: boolean
}

export function IndexProblems({
  api,
  root,
  focus,
  onChanged,
  query = '',
  hideEmpty = false,
  hideToolbar = false,
  commandRef,
  bucket = 'all',
  sort = 'queue',
  summary: externalSummary,
}: {
  api: HomeApi
  root: string
  /** a group to open at once (picked from the overview) */
  focus?: IndexIssueReason | null
  onChanged: () => void
  /** only files whose name or folder match these words are listed */
  query?: string
  /** draw nothing when there are no problems (the page shows its own healthy state) */
  hideEmpty?: boolean
  /** the page has its own buttons for "try again" and "read the scans" */
  hideToolbar?: boolean
  commandRef?: MutableRefObject<ProblemCommands | null>
  bucket?: 'all' | IssueBucket
  sort?: 'queue' | 'name'
  summary?: IndexIssueSummary | null
}) {
  const { lang, dateLocale } = useI18n()
  const d = lang === 'vi' ? VI : EN
  const copy = activityCopy(lang as Lang)
  const [localSummary, setSummary] = useState<IndexIssueSummary | null>(null)
  const summary = externalSummary === undefined ? localSummary : externalSummary
  const [summaryFailed, setSummaryFailed] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)
  const batchInFlight = useRef(false)
  const generation = useRef(0)
  const mounted = useRef(true)
  const groupRequests = useRef(new Map<IndexIssueReason, number>())
  const selectionEpoch = useRef(0)
  const bucketRef = useRef(bucket)
  bucketRef.current = bucket
  const [open, setOpen] = useState<Set<IndexIssueReason>>(new Set())
  const [groups, setGroups] = useState<Partial<Record<IndexIssueReason, GroupState>>>({})

  const loadSummary = useCallback(async () => {
    if (!root || externalSummary !== undefined) return
    const currentGeneration = generation.current
    try {
      const next = await readIndexRequest(
        () => api.getDocumentIndexIssueSummary(root),
        isIndexIssueSummary,
      )
      if (mounted.current && generation.current === currentGeneration) {
        setSummary(next)
        setSummaryFailed(false)
      }
    } catch {
      if (mounted.current && generation.current === currentGeneration) setSummaryFailed(true)
    }
  }, [api, root, externalSummary])

  const groupsRef = useRef(groups)
  groupsRef.current = groups
  const now = useIndexingNow(api, true)
  // Files that were being read a moment ago and are gone from their list: shown green, then removed.
  const [finished, setFinished] = useState<IndexIssue[]>([])
  const wasLive = useRef(new Set<string>())
  const loadGroup = useCallback(
    async (reason: IndexIssueReason, append = false) => {
      if (!root) return
      const currentGeneration = generation.current
      const request = (groupRequests.current.get(reason) ?? 0) + 1
      groupRequests.current.set(reason, request)
      const isCurrent = () =>
        mounted.current &&
        generation.current === currentGeneration &&
        groupRequests.current.get(reason) === request
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
          const page = await loadIssuePage(api, root, shown?.items.length ?? 0, reason)
          items = [...(shown?.items ?? []), ...page.items]
          total = page.total
        } else {
          // as many files as are shown now, so a list opened with "show more" stays that long
          const loaded = await loadAtLeast(
            (offset) => loadIssuePage(api, root, offset, reason),
            Math.max(shown?.items.length ?? 0, 1),
          )
          items = loaded.items
          total = loaded.total
          if (!isCurrent()) return
          const gone = (shown?.items ?? []).filter(
            (item) => wasLive.current.has(item.path) && !items.some((next) => next.id === item.id),
          )
          if (gone.length > 0) {
            setFinished((current) => [...current, ...gone])
            window.setTimeout(() => {
              if (mounted.current && generation.current === currentGeneration)
                setFinished((current) => current.filter((item) => !gone.includes(item)))
            }, 1800)
          }
        }
        if (!isCurrent()) return
        const removed = new Set(
          (shown?.items ?? [])
            .filter((item) => !items.some((next) => next.id === item.id))
            .map((item) => item.id),
        )
        if (removed.size > 0)
          setPickState((current) => ({
            picked: new Set([...current.picked].filter((id) => !removed.has(id))),
            anchor: current.anchor !== null && removed.has(current.anchor) ? null : current.anchor,
          }))
        // closed while it was loading: it stays forgotten
        if (!append && !openRef.current.has(reason) && !groupsRef.current[reason]) return
        setGroups((current) => {
          const before = current[reason]
          // nothing changed: keep the same objects so the list is not redrawn for nothing
          if (
            before &&
            !before.loading &&
            !before.failed &&
            before.total === total &&
            before.items.length === items.length &&
            before.items.every(
              (item, index) => JSON.stringify(item) === JSON.stringify(items[index]),
            )
          )
            return current
          return { ...current, [reason]: { items, total, loading: false } }
        })
      } catch {
        if (!isCurrent()) return
        setGroups((current) => ({
          ...current,
          [reason]: {
            items: current[reason]?.items ?? [],
            total: current[reason]?.total ?? 0,
            loading: false,
            failed: true,
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
      if (event.key === 'Escape') {
        selectionEpoch.current++
        setPickState(NOTHING_PICKED)
      }
      // Ctrl/Cmd+A picks every file of the open lists
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !editing) {
        if (openRef.current.size === 0) return
        event.preventDefault()
        for (const reason of openRef.current) {
          if (bucketRef.current === 'all' || issueBucket(reason) === bucketRef.current)
            void selectGroupRef.current(reason)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    selectionEpoch.current++
    setPickState(NOTHING_PICKED)
    setOpen(
      (current) =>
        new Set(
          [...current].filter((reason) => bucket === 'all' || issueBucket(reason) === bucket),
        ),
    )
  }, [bucket])
  useEffect(() => {
    selectionEpoch.current++
    setPickState(NOTHING_PICKED)
  }, [query])
  const waitingPeak = useRef(0)
  useEffect(() => {
    waitingPeak.current = 0
  }, [root])
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    mounted.current = true
    const lifetime = generation.current + 1
    generation.current = lifetime
    groupRequests.current.clear()
    setSummary(null)
    setSummaryFailed(false)
    setGroups({})
    groupsRef.current = {}
    setOpen(new Set())
    openRef.current = new Set()
    setFinished([])
    setPickState(NOTHING_PICKED)
    wasLive.current.clear()
    autoOpened.current = false
    return () => {
      mounted.current = false
      generation.current = lifetime + 1
    }
  }, [root])
  useEffect(() => {
    void loadSummary()
  }, [loadSummary])
  useEffect(() => {
    if (externalSummary !== undefined) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      if (document.visibilityState !== 'hidden') {
        await loadSummary()
        await Promise.all([...openRef.current].map((reason) => loadGroup(reason)))
      }
      if (!stopped) timer = setTimeout(() => void refresh(), 3000)
    }
    timer = setTimeout(() => void refresh(), 3000)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [loadSummary, loadGroup, externalSummary])
  useEffect(() => {
    if (externalSummary === undefined || document.visibilityState === 'hidden') return
    for (const reason of openRef.current) void loadGroup(reason)
  }, [externalSummary, loadGroup])

  // The only attention group opens by itself, and a group picked on the overview opens too.
  const autoOpened = useRef(false)
  useEffect(() => {
    if (!summary) return
    const visible = summary.groups.filter(
      (g) => bucket === 'all' || issueBucket(g.reason) === bucket,
    )
    const wanted =
      focus && visible.some((g) => g.reason === focus)
        ? focus
        : !autoOpened.current && visible.filter((g) => needsAction(g.reason)).length === 1
          ? visible.find((g) => needsAction(g.reason))!.reason
          : null
    autoOpened.current = true
    if (wanted) {
      setOpen((current) => new Set(current).add(wanted))
      if (!groupsRef.current[wanted]) void loadGroup(wanted)
    }
  }, [summary, focus, loadGroup, bucket])

  const toggle = (reason: IndexIssueReason) => {
    const next = new Set(open)
    if (next.has(reason)) {
      next.delete(reason)
      selectionEpoch.current++
      const removed = new Set(groupsRef.current[reason]?.items.map((item) => item.id) ?? [])
      setPickState((current) => ({
        picked: new Set([...current.picked].filter((id) => !removed.has(id))),
        anchor: current.anchor !== null && removed.has(current.anchor) ? null : current.anchor,
      }))
      groupRequests.current.set(reason, (groupRequests.current.get(reason) ?? 0) + 1)
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

  const runBatch = async (work: (isCurrent: () => boolean) => Promise<void>) => {
    if (batchInFlight.current) return
    const currentGeneration = generation.current
    const isCurrent = () => mounted.current && generation.current === currentGeneration
    batchInFlight.current = true
    setBatchBusy(true)
    try {
      await work(isCurrent)
    } catch {
      if (isCurrent()) actions.say(d.actionFailed)
    } finally {
      batchInFlight.current = false
      if (mounted.current) setBatchBusy(false)
    }
  }

  const retryEverything = async () =>
    runBatch(async (isCurrent) => {
      let queued = 0
      let failed = false
      for (const group of summary?.groups ?? []) {
        if (!isCurrent()) return
        if (
          !needsAction(group.reason) ||
          !isRetryableReason(group.reason) ||
          group.reason === 'waiting'
        )
          continue
        try {
          const result = await api.retryDocumentIndexGroup(root, group.reason)
          if (result.ok) queued += result.retried
          else failed = true
        } catch {
          failed = true
        }
      }
      if (!isCurrent()) return
      actions.say(
        failed
          ? `${fill(d.retried, { n: queued })} ${d.actionFailed}`
          : fill(d.retried, { n: queued }),
      )
      await loadSummary()
      for (const reason of open) await loadGroup(reason)
      onChanged()
    })

  const clearPick = () => {
    selectionEpoch.current++
    setPickState(NOTHING_PICKED)
  }
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
  const readPicked = async (mode: 'index' | 'ocr' = 'index') =>
    runBatch(async (isCurrent) => {
      const all = Object.values(groupsRef.current)
        .flatMap((group) => group?.items ?? [])
        .filter((item) => pickState.picked.has(item.id))
      const chosen = mode === 'ocr' ? all.filter((item) => /\.pdf$/i.test(item.path)) : all
      if (chosen.length === 0) {
        if (all.length > 0) actions.say(d.noPdfPicked)
        return
      }
      const question = mode === 'ocr' ? d.readBatchConfirm : d.readPickedConfirm
      if (!(await appConfirm(fill(question, { n: chosen.length })))) return
      let ok = 0
      for (const [index, item] of chosen.entries()) {
        if (!isCurrent()) return
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
      if (!isCurrent()) return
      actions.say(fill(d.readFinished, { ok, n: chosen.length }))
      clearPick()
      await loadSummary()
      for (const reason of openRef.current) await loadGroup(reason)
      onChanged()
    })

  /** Load up to 2,000 files and select the files matching the current query. */
  const selectGroup = async (reason: IndexIssueReason) => {
    if (batchInFlight.current) return
    const currentGeneration = generation.current
    const currentSelection = selectionEpoch.current
    try {
      const total = groupsRef.current[reason]?.total ?? 0
      const loaded = await loadAtLeast(
        (offset) => loadIssuePage(api, root, offset, reason),
        Math.min(Math.max(total, 1), 2000),
      )
      if (
        !mounted.current ||
        generation.current !== currentGeneration ||
        selectionEpoch.current !== currentSelection
      )
        return
      setGroups((current) => ({
        ...current,
        [reason]: { items: loaded.items, total: loaded.total, loading: false },
      }))
      const matching = loaded.items.filter((item) => !query.trim() || matchesQuery(item, query))
      setPickState((current) => ({
        picked: new Set([...current.picked, ...matching.map((item) => item.id)]),
        anchor: matching[0]?.id ?? current.anchor,
      }))
      actions.say(fill(d.selectedAll, { n: matching.length }))
    } catch {
      actions.say(d.actionFailed)
    }
  }
  const selectGroupRef = useRef(selectGroup)
  selectGroupRef.current = selectGroup

  const readBatch = async () =>
    runBatch(async (isCurrent) => {
      const page = await loadIssuePage(api, root, 0, 'no-text')
      if (!isCurrent()) return
      const batch = page.items.slice(0, BATCH)
      if (batch.length === 0) return
      if (!(await appConfirm(fill(d.readBatchConfirm, { n: batch.length })))) return
      let ok = 0
      for (const [index, item] of batch.entries()) {
        if (!isCurrent()) return
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
      if (!isCurrent()) return
      actions.say(fill(d.readFinished, { ok, n: batch.length }))
      await loadSummary()
      if (open.has('no-text')) await loadGroup('no-text')
      onChanged()
    })

  const readAllScans = async () =>
    runBatch(async (isCurrent) => {
      const total = summary?.groups.find((g) => g.reason === 'no-text')?.count ?? 0
      const loaded = await loadAtLeast(
        (offset) => loadIssuePage(api, root, offset, 'no-text'),
        Math.max(total, 1),
      )
      if (!isCurrent() || loaded.items.length === 0) return
      if (!(await appConfirm(fill(d.readAllConfirm, { n: loaded.items.length })))) return
      let ok = 0
      for (const [index, item] of loaded.items.entries()) {
        if (!isCurrent()) return
        actions.say(fill(d.readProgress, { i: index + 1, n: loaded.items.length }))
        try {
          const result = await api.readScannedPdfWithAgy(item.id, true)
          if (result.ok) ok++
          else if (result.error === 'unavailable' || result.error === 'paused') break
        } catch {
          /* the next file still gets its turn */
        }
      }
      if (!isCurrent()) return
      actions.say(fill(d.readFinished, { ok, n: loaded.items.length }))
      await loadSummary()
      if (openRef.current.has('no-text')) await loadGroup('no-text')
      onChanged()
    })

  const openReason = (reason: IndexIssueReason) => {
    setOpen((current) => new Set(current).add(reason))
    if (!groupsRef.current[reason]) void loadGroup(reason)
  }
  const commands: ProblemCommands = { openReason, retryAll: retryEverything, readAllScans }
  const commandsRef = useRef(commands)
  commandsRef.current = commands
  useEffect(() => {
    if (!commandRef) return
    commandRef.current = {
      openReason: (reason) => commandsRef.current.openReason(reason),
      retryAll: () => commandsRef.current.retryAll(),
      readAllScans: () => commandsRef.current.readAllScans(),
    }
    return () => {
      commandRef.current = null
    }
  }, [commandRef])

  // Search only promises coverage of the pages loaded. Large groups stay explicitly partial.
  const searching = query.trim().length > 0
  const searchGroups = JSON.stringify(
    (summary?.groups ?? []).filter((g) => bucket === 'all' || issueBucket(g.reason) === bucket),
  )
  useEffect(() => {
    if (!searching) return
    const currentGeneration = generation.current
    let cancelled = false
    const visible = JSON.parse(searchGroups) as Array<{ reason: IndexIssueReason; count: number }>
    for (const group of visible) {
      setOpen((current) => new Set(current).add(group.reason))
      const request = (groupRequests.current.get(group.reason) ?? 0) + 1
      groupRequests.current.set(group.reason, request)
      setGroups((current) => ({
        ...current,
        [group.reason]: {
          items: current[group.reason]?.items ?? [],
          total: group.count,
          loading: true,
        },
      }))
      void (async () => {
        try {
          const loaded = await loadAtLeast(
            (offset) => loadIssuePage(api, root, offset, group.reason),
            Math.max(
              groupsRef.current[group.reason]?.items.length ?? 0,
              Math.min(group.count, 100),
            ),
          )
          if (
            cancelled ||
            !mounted.current ||
            generation.current !== currentGeneration ||
            groupRequests.current.get(group.reason) !== request
          )
            return
          const removed = new Set(
            (groupsRef.current[group.reason]?.items ?? [])
              .filter((item) => !loaded.items.some((next) => next.id === item.id))
              .map((item) => item.id),
          )
          if (removed.size > 0)
            setPickState((current) => ({
              picked: new Set([...current.picked].filter((id) => !removed.has(id))),
              anchor:
                current.anchor !== null && removed.has(current.anchor) ? null : current.anchor,
            }))
          setGroups((current) => ({
            ...current,
            [group.reason]: { items: loaded.items, total: loaded.total, loading: false },
          }))
        } catch {
          if (
            cancelled ||
            !mounted.current ||
            generation.current !== currentGeneration ||
            groupRequests.current.get(group.reason) !== request
          )
            return
          setGroups((current) => ({
            ...current,
            [group.reason]: {
              items: current[group.reason]?.items ?? [],
              total: group.count,
              loading: false,
              failed: true,
            },
          }))
        }
      })()
    }
    return () => {
      cancelled = true
    }
  }, [searching, searchGroups, api, root])

  const retryGroup = async (reason: IndexIssueReason) =>
    runBatch(async (isCurrent) => {
      if (!needsAction(reason) || !isRetryableReason(reason)) return
      const result = await api.retryDocumentIndexGroup(root, reason)
      if (!isCurrent()) return
      actions.say(result.ok ? fill(d.retried, { n: result.retried }) : d.actionFailed)
      await Promise.all([loadSummary(), loadGroup(reason)])
      onChanged()
    })

  if (!root) return <p className="idx-muted">{d.noFolder}</p>
  if (!summary)
    return (
      <p className="idx-muted" role="status">
        {summaryFailed ? d.summaryFailed : d.loading}
      </p>
    )
  const list = (summary?.groups ?? []).filter(
    (g) => bucket === 'all' || issueBucket(g.reason) === bucket,
  )
  if (summary && list.length === 0) return hideEmpty ? null : <p className="idx-empty">{d.empty}</p>

  const rowActions = batchBusy
    ? {
        ...actions,
        busy: new Set([
          ...actions.busy,
          ...Object.values(groups).flatMap((group) => group?.items.map((item) => item.id) ?? []),
        ]),
      }
    : actions
  const renderGroup = (reason: IndexIssueReason, count: number) => {
    const words = copy.reasons[reason]
    // the line "N left" and a bar: how far the files seen waiting at the start have come
    const peak = reason === 'waiting' ? Math.max(waitingPeak.current, count) : 0
    if (reason === 'waiting') waitingPeak.current = peak
    const doneShare = peak > 0 ? Math.round(((peak - count) / peak) * 100) : 0
    const isOpen = open.has(reason)
    const state = groups[reason]
    // the order the files are shown in: Shift+click picks between two of them
    const sorted = [...(state?.items ?? [])]
      .filter((item) => !searching || matchesQuery(item, query))
      .sort((x, y) =>
        sort === 'name'
          ? x.name.localeCompare(y.name, dateLocale)
          : rank(liveOf(now, x.path)) - rank(liveOf(now, y.path)),
      )
    const orderedIds = sorted.map((issue) => issue.id)
    const allShownSelected =
      sorted.length > 0 && sorted.every((issue) => pickState.picked.has(issue.id))
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
            {searching && state && !state.loading && (
              <span className="ixp-matches">{fill(d.matches, { n: sorted.length })}</span>
            )}
          </button>
          {isOpen && sorted.length > 0 && (
            <button
              type="button"
              className="idx-btn ixp-select"
              disabled={batchBusy}
              onClick={() =>
                setPickState((current) => {
                  const picked = new Set(current.picked)
                  for (const item of sorted) {
                    if (allShownSelected) picked.delete(item.id)
                    else picked.add(item.id)
                  }
                  return { picked, anchor: sorted[0]?.id ?? current.anchor }
                })
              }
            >
              {allShownSelected ? d.deselectVisible : d.selectVisible}
            </button>
          )}
          {needsAction(reason) && isRetryableReason(reason) && (
            <IconButton
              label={d.retryAll}
              disabled={batchBusy}
              onClick={() => void retryGroup(reason)}
            >
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
                actions={rowActions}
                api={api}
                live={liveOf(now, issue.path)}
                picked={pickState.picked.has(issue.id)}
                pickedCount={pickState.picked.size}
                onPick={(item, mode) => pickFile(orderedIds, item, mode)}
                onReadPicked={() => {
                  if (!batchBusy) void readPicked()
                }}
                onSelectGroup={() => {
                  if (!batchBusy) void selectGroup(reason)
                }}
                onClearPicked={clearPick}
              />
            ))}
            {state?.loading && <li className="ixp-loading">{d.loading}</li>}
            {state?.failed && (
              <li className="ixp-loading" role="status">
                {d.summaryFailed}
              </li>
            )}
            {searching && state && !state.loading && !state.failed && sorted.length === 0 && (
              <li className="ixp-loading">
                {state.items.length < state.total
                  ? d.noLoadedMatch
                  : fill(d.noMatch, { q: query.trim() })}
              </li>
            )}
            {searching && state && !state.loading && state.items.length < state.total && (
              <li className="ixp-search-coverage">
                {fill(d.searchSubset, { n: state.items.length, total: state.total })}
              </li>
            )}
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
  const background = list.filter((g) => issueBucket(g.reason) === 'background')
  const skipped = list.filter((g) => issueBucket(g.reason) === 'skipped')
  const scanned = list.find((g) => g.reason === 'no-text')?.count ?? 0
  const failures = attention.some((g) => isRetryableReason(g.reason))
  return (
    <div className="ixp" aria-busy={batchBusy}>
      <div className="ixp-toolbar ixp-viewbar">
        {!hideToolbar && (failures || scanned > 0) && (
          <div className="ixp-bulk">
            {failures && (
              <button
                type="button"
                className="idx-btn primary"
                disabled={batchBusy}
                onClick={() => void retryEverything()}
              >
                {d.retryEverything}
              </button>
            )}
            {scanned > 0 && (
              <button
                type="button"
                className="idx-btn"
                disabled={batchBusy}
                onClick={() => void readBatch()}
              >
                {fill(d.readBatch, { n: Math.min(BATCH, scanned) })}
              </button>
            )}
          </div>
        )}
        <div className="ixp-view-actions">
          <button
            type="button"
            className="idx-btn"
            onClick={() => {
              setOpen(new Set(list.map((g) => g.reason)))
              for (const group of list)
                if (!groupsRef.current[group.reason]) void loadGroup(group.reason)
            }}
          >
            {d.expandAll}
          </button>
          <button
            type="button"
            className="idx-btn"
            onClick={() => {
              for (const group of list)
                groupRequests.current.set(
                  group.reason,
                  (groupRequests.current.get(group.reason) ?? 0) + 1,
                )
              selectionEpoch.current++
              setPickState(NOTHING_PICKED)
              setOpen(new Set())
              setGroups({})
            }}
          >
            {d.collapseAll}
          </button>
          {batchBusy && <span role="status">{d.working}</span>}
        </div>
      </div>
      {actions.note && (
        <p className="ixp-note" role="status">
          {actions.note}
        </p>
      )}
      {pickState.picked.size > 0 && (
        <div className="ixp-toolbar ixp-pickbar" role="toolbar">
          <span>{fill(d.picked, { n: pickState.picked.size })}</span>
          <button
            type="button"
            className="idx-btn primary"
            disabled={batchBusy}
            onClick={() => void readPicked()}
          >
            {fill(d.readPicked, { n: pickState.picked.size })}
          </button>
          <button
            type="button"
            className="idx-btn"
            disabled={batchBusy || pickedPdfCount === 0}
            onClick={() => void readPicked('ocr')}
          >
            {fill(d.ocrPicked, { n: pickedPdfCount })}
          </button>
          <button type="button" className="idx-btn" disabled={batchBusy} onClick={clearPick}>
            {d.clearPicked}
          </button>
        </div>
      )}
      {attention.length > 0 && (
        <>
          {bucket === 'all' && <h2 className="ixp-title">{d.attention}</h2>}
          {attention.map((g) => renderGroup(g.reason, g.count))}
        </>
      )}
      {background.length > 0 && (
        <>
          {bucket === 'all' && <h2 className="ixp-title">{d.background}</h2>}
          {background.map((g) => renderGroup(g.reason, g.count))}
        </>
      )}
      {skipped.length > 0 && (
        <>
          {bucket === 'all' && <h2 className="ixp-title">{d.skipped}</h2>}
          {skipped.map((g) => renderGroup(g.reason, g.count))}
        </>
      )}
    </div>
  )
}
