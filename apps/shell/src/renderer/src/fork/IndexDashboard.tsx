import { useCallback, useEffect, useRef, useState } from 'react'
import type { HomeApi, HomeIndexingActivity, DocumentMemoryStatus } from '../../../shared/home-api'
import type { IndexingNow } from '../../../shared/fork/document-index-api'
import type { IndexingModeState } from '../../../shared/fork/indexing-mode'
import { INDEXING_MODES } from '../../../shared/fork/indexing-mode'
import { useI18n } from '../locale'
import { TodoTab } from './TodoTab'
import { isIndexIssueSummary, isIndexingNow, readIndexRequest } from './index-request'
import { fill } from '../indexing-activity-copy'
import { IndexedFolders } from './IndexedFolders'
import type { IndexIssueSummary } from '../../../main/document-memory/issue-reader'
import type { IndexIssueReason } from '../../../main/document-memory/issues'
import { needsAction } from './IndexProblems'
import { IndexSettingsTab } from './IndexSettingsTab'
import { SearchHero } from './SearchHero'
import { SearchResults } from './SearchResults'
import { IndexNav, type IndexTabId } from './IndexNav'
import { IndexOverview } from './IndexOverview'
import './index-dashboard.css'
import './todo-workspace.css'

const POLL_MS = 2000

const EN = {
  title: 'Document index',
  subtitle: 'Everything GenOffice has read on this computer, and how it is going.',
  back: 'Back',
  pause: 'Pause',
  resume: 'Resume',
  scanNow: 'Scan again',
  addFolder: 'Add folder',
  stopScan: 'Stop scan',
  tier: {
    paused: 'Paused ({why})',
    battery: 'Slowed to save battery',
    light: 'Working gently',
    active: 'Adjusting while you use the computer',
    idle: 'Computer is idle · extra capacity available',
  },
  why: {
    battery: 'on battery',
    'low-battery': 'battery is low',
    'battery-saver': 'battery saver is on',
    locked: 'screen locked',
    'low-memory': 'low memory',
    thermal: 'computer is hot',
    user: 'you paused it',
    suspended: 'computer is asleep',
  },
  actionFailed: 'Could not complete this action. Please try again.',
  statusFailed: 'Could not refresh the index. Check the connection and try again.',
  refresh: 'Refresh',
  dismissNote: 'Dismiss message',
}

const VI: typeof EN = {
  title: 'Chỉ mục tài liệu',
  subtitle: 'Mọi thứ GenOffice đã đọc trên máy này và tiến độ hiện tại.',
  back: 'Quay lại',
  pause: 'Tạm dừng',
  resume: 'Tiếp tục',
  scanNow: 'Quét lại',
  addFolder: 'Thêm thư mục',
  stopScan: 'Dừng quét',
  tier: {
    paused: 'Đang tạm dừng ({why})',
    battery: 'Chạy chậm để tiết kiệm pin',
    light: 'Đang làm nhẹ nhàng',
    active: 'Điều chỉnh khi bạn đang dùng máy',
    idle: 'Máy đang rảnh · có thể xử lý nhiều hơn',
  },
  why: {
    battery: 'đang dùng pin',
    'low-battery': 'pin yếu',
    'battery-saver': 'đang bật tiết kiệm pin',
    locked: 'màn hình đang khoá',
    'low-memory': 'thiếu RAM',
    thermal: 'máy đang nóng',
    user: 'bạn đã tạm dừng',
    suspended: 'máy đang ở chế độ ngủ',
  },
  actionFailed: 'Chưa thực hiện được thao tác. Bạn thử lại nhé.',
  statusFailed: 'Chưa cập nhật được chỉ mục. Kiểm tra kết nối và thử lại.',
  refresh: 'Tải lại',
  dismissNote: 'Đóng thông báo',
}

const TEXT: Record<string, typeof EN> = { en: EN, vi: VI }

interface Snapshot {
  memory: DocumentMemoryStatus | null
  activity: HomeIndexingActivity | null
  mode: IndexingModeState | null
  now: IndexingNow | null
}

export function IndexDashboard({ api, onClose }: { api: HomeApi; onClose: () => void }) {
  const { lang } = useI18n()
  const d = TEXT[lang] ?? EN
  const [tab, setTab] = useState<IndexTabId>('overview')
  const [searchQuery, setSearchQuery] = useState('')
  const [settingsFocus, setSettingsFocus] = useState<'ocr' | undefined>()
  const [focus, setFocus] = useState<IndexIssueReason | null>(null)
  const [attention, setAttention] = useState<IndexIssueSummary | null>(null)
  const [snap, setSnap] = useState<Snapshot>({
    memory: null,
    activity: null,
    mode: null,
    now: null,
  })
  const [actionBusy, setActionBusy] = useState(false)
  const [actionNote, setActionNote] = useState('')
  const [statusFailed, setStatusFailed] = useState(false)
  const actionInFlight = useRef(false)
  const pollKick = useRef<() => void>(() => undefined)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Focus SearchHero input on Ctrl+F or Cmd+F
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let loading = false
    let refreshQueued = false
    const load = async () => {
      if (!alive) return
      if (loading) {
        refreshQueued = true
        return
      }
      loading = true
      if (document.visibilityState === 'visible') {
        const [memory, activity, mode, issues, now] = await Promise.allSettled([
          readIndexRequest(
            () => api.getDocumentMemoryStatus(),
            (value): value is DocumentMemoryStatus =>
              !!value &&
              typeof value === 'object' &&
              typeof (value as DocumentMemoryStatus).enabled === 'boolean',
          ),
          readIndexRequest(
            () => api.getIndexingActivity(),
            (value): value is HomeIndexingActivity =>
              !!value && typeof value === 'object' && !!(value as HomeIndexingActivity).memory,
          ),
          readIndexRequest(
            () => api.getIndexingModeState?.() ?? Promise.resolve(null),
            (value): value is IndexingModeState | null =>
              value === null ||
              (!!value &&
                typeof value === 'object' &&
                INDEXING_MODES.includes((value as IndexingModeState).mode)),
          ),
          readIndexRequest(() => api.getDocumentIndexIssueSummary('*'), isIndexIssueSummary),
          readIndexRequest(() => api.getIndexingNow(), isIndexingNow),
        ])
        if (!alive) return
        setStatusFailed(
          memory.status === 'rejected' ||
            activity.status === 'rejected' ||
            issues.status === 'rejected',
        )
        if (issues.status === 'fulfilled') setAttention(issues.value)
        const next: Snapshot = {
          memory: memory.status === 'fulfilled' ? memory.value : null,
          activity: activity.status === 'fulfilled' ? activity.value : null,
          mode: mode.status === 'fulfilled' ? mode.value : null,
          now: now.status === 'fulfilled' ? now.value : null,
        }
        setSnap((previous) => ({
          memory: next.memory ?? previous.memory,
          activity: next.activity ?? previous.activity,
          mode: next.mode ?? previous.mode,
          now: next.now,
        }))
      }
      loading = false
      if (alive) timer = setTimeout(() => void load(), refreshQueued ? 0 : POLL_MS)
      refreshQueued = false
    }
    pollKick.current = () => {
      if (timer) clearTimeout(timer)
      void load()
    }
    void load()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [api])

  const { memory, activity, mode, now } = snap
  const progress = activity?.folderProgress ?? null
  const folder = activity?.folder ?? null
  const paused = !!mode?.effective?.paused || memory?.enabled === false
  const pending = memory?.pending ?? activity?.memory.pending ?? 0

  const kick = useCallback(() => pollKick.current(), [])

  const runAction = async (work: () => Promise<void>) => {
    if (actionInFlight.current) return
    actionInFlight.current = true
    setActionBusy(true)
    setActionNote('')
    try {
      await work()
    } catch {
      setActionNote(d.actionFailed)
    } finally {
      actionInFlight.current = false
      setActionBusy(false)
      kick()
    }
  }

  const togglePause = () =>
    runAction(async () => {
      await api.setDocumentMemoryEnabled(!(memory?.enabled ?? true))
    })
  const addFolder = () =>
    runAction(async () => {
      await api.scanDocumentFolder()
    })
  const stopScan = () =>
    runAction(async () => {
      await api.stopDocumentFolderScan()
    })
  const rescanAll = () =>
    runAction(async () => {
      const list = await api.listIndexedFolders()
      for (const f of list) if (!f.unavailable) await api.rescanIndexedFolder(f.root)
    })

  const effective = mode?.effective
  const tierText = effective
    ? effective.tier === 'paused'
      ? fill(d.tier.paused, { why: effective.pauseReason ? d.why[effective.pauseReason] : '' })
      : d.tier[effective.tier]
    : ''

  const todo = (attention?.groups ?? [])
    .filter((g) => needsAction(g.reason))
    .reduce((n, g) => n + g.count, 0)

  return (
    <main className="content idx-page">
      <header className="idx-head">
        <button type="button" className="idx-back" onClick={onClose} aria-label={d.back}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M10 3 5 8l5 5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <div className="idx-title">
          <h1>{d.title}</h1>
          <p>{d.subtitle}</p>
        </div>
        <div className="idx-actions">
          {folder?.running && (
            <button
              type="button"
              disabled={actionBusy}
              className="idx-btn"
              onClick={() => void stopScan()}
            >
              {d.stopScan}
            </button>
          )}
          <button
            type="button"
            disabled={actionBusy}
            className="idx-btn"
            onClick={() => void rescanAll()}
          >
            {d.scanNow}
          </button>
          <button
            type="button"
            disabled={actionBusy}
            className="idx-btn"
            onClick={() => void addFolder()}
          >
            {d.addFolder}
          </button>
          <button
            type="button"
            disabled={actionBusy || !memory}
            className="idx-btn primary"
            onClick={() => void togglePause()}
          >
            {memory?.enabled === false ? d.resume : d.pause}
          </button>
        </div>
      </header>

      {statusFailed && (
        <div className="todo-status" role="status">
          <span>{d.statusFailed}</span>
          <button type="button" className="idx-btn" onClick={kick}>
            {d.refresh}
          </button>
        </div>
      )}
      {actionNote && (
        <div className="todo-status" role="status">
          <span>{actionNote}</span>
          <button
            type="button"
            className="ixp-icon"
            aria-label={d.dismissNote}
            onClick={() => setActionNote('')}
          >
            ×
          </button>
        </div>
      )}

      {/* Search Hero (always placed at top) */}
      <SearchHero
        ref={searchInputRef}
        value={searchQuery}
        onChange={setSearchQuery}
        onClear={() => setSearchQuery('')}
      />

      {/* If actively searching, display SearchResults; otherwise display Navigation & Tabs */}
      {searchQuery.trim().length > 0 ? (
        <SearchResults api={api} query={searchQuery} onOpened={onClose} />
      ) : (
        <>
          <IndexNav activeTab={tab} onChangeTab={setTab} issuesCount={todo} />

          <div id="index-tab-panel" role="tabpanel" aria-labelledby={`index-tab-${tab}`}>
            {tab === 'overview' && (
              <IndexOverview
                api={api}
                memory={memory}
                activity={activity}
                mode={mode}
                now={now}
                attention={attention}
                actionBusy={actionBusy}
                onTogglePause={() => void togglePause()}
                onNavigateTab={(nextTab, reason) => {
                  if (reason) setFocus(reason)
                  setTab(nextTab)
                }}
                onOpened={onClose}
              />
            )}

            {tab === 'sources' && (
              <div className="idx-body idx-embed">
                <IndexedFolders />
              </div>
            )}

            {tab === 'issues' && (
              <div className="idx-body">
                <TodoTab
                  api={api}
                  ready={progress?.readyFiles ?? memory?.documents ?? 0}
                  pending={pending}
                  switchedOff={memory?.enabled === false}
                  held={paused && memory?.enabled !== false}
                  heldWhy={tierText}
                  scanning={!!folder?.running}
                  focus={focus}
                  onAddFolder={() => void addFolder()}
                  onRescan={() => void rescanAll()}
                  onResume={() => void togglePause()}
                  onChanged={kick}
                />
              </div>
            )}

            {tab === 'settings' && (
              <div className="idx-body idx-embed">
                <IndexSettingsTab api={api} focus={settingsFocus} />
              </div>
            )}
          </div>
        </>
      )}
    </main>
  )
}
