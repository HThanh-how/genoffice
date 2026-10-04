import { useCallback, useEffect, useRef, useState } from 'react'
import { IndexProgressRing } from '@genoffice/ui'
import '@genoffice/ui/index-progress.css'
import type { HomeApi, HomeIndexingActivity, DocumentMemoryStatus } from '../../../shared/home-api'
import type { IndexingNow } from '../../../shared/fork/document-index-api'
import type { IndexingMode, IndexingModeState } from '../../../shared/fork/indexing-mode'
import { INDEXING_MODES } from '../../../shared/fork/indexing-mode'
import { useI18n } from '../locale'
import { TodoTab } from './TodoTab'
import { isIndexIssueSummary, isIndexingNow, readIndexRequest } from './index-request'
import { activityCopy, fill } from '../indexing-activity-copy'
import { IndexProgressTracker, type IndexProgressReading } from './index-progress-model'
import { etaText } from '../indexing-activity/format'
import { IndexedFolders } from './IndexedFolders'
import type { IndexIssueSummary } from '../../../main/document-memory/issue-reader'
import type { IndexIssueReason } from '../../../main/document-memory/issues'
import { needsAction } from './IndexProblems'
import { IndexSettingsTab } from './IndexSettingsTab'
import './index-dashboard.css'
import './todo-workspace.css'

type Tab = 'overview' | 'folders' | 'problems' | 'settings'
const POLL_MS = 2000

const EN = {
  title: 'Document index',
  subtitle: 'Everything GenOffice has read on this computer, and how it is going.',
  back: 'Back',
  tabs: { overview: 'Overview', folders: 'Folders', problems: 'To do', settings: 'Settings' },
  pause: 'Pause',
  resume: 'Resume',
  scanNow: 'Scan again',
  addFolder: 'Add folder',
  stopScan: 'Stop scan',
  stateRunning: 'Indexing',
  stateScanning: 'Scanning folders',
  statePaused: 'Paused',
  stateIdle: 'Up to date',
  stateOff: 'Turned off',
  stateModelError: 'Search model problem',
  stateDownloading: 'Downloading search model',
  filesDone: '{ready} of {total} files',
  waiting: '{n} waiting',
  problems: '{n} problems',
  eta: 'Time left',
  etaUnknown: 'Not enough progress to estimate',
  quiet: 'No recent progress · check To do or refresh',
  passageRate: '{n} passages/min',
  rate: 'Speed',
  perMin: '{n} files/min',
  docs: 'Documents',
  chunks: 'Passages',
  vectors: 'Vectors',
  pending: 'Waiting',
  errors: 'Problems',
  model: 'Search model',
  modelReady: 'Ready',
  modelNot: 'Not loaded',
  modelDownloading: 'Downloading {p}%',
  modelError: 'Error',
  effort: 'How hard it works',
  modes: { light: 'Light', balanced: 'Balanced', fast: 'Fast' },
  modeHint: {
    light: 'Barely noticeable. Slowest.',
    balanced: 'Good for everyday use.',
    fast: 'Uses most of the computer. Fastest.',
  },
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
  },
  scanning: 'Reading folder {root}',
  seen: '{n} files seen · {m} new',
  runCommand: 'Run: “{q}”',
  runHint: 'Enter · runs here, no AI quota',
  dismiss: 'Close',
  send: 'Send',
  searchFiles: 'Find a file, or give an order: “how far is indexing?”, “pause”…',
  attentionTitle: 'Needs attention',
  attentionAll: 'See all',
  actionFailed: 'Could not complete this action. Please try again.',
  statusFailed: 'Could not refresh the index. Check the connection and try again.',
  refresh: 'Refresh',
  dismissNote: 'Dismiss message',
  suggestions: ['How far is indexing?', 'Rescan', 'Retry the errors', 'Help'],
  ocrConfirm:
    'Read this scanned PDF now with Antigravity? It uses Antigravity quota and ignores today’s limit.',
}
type Dict = typeof EN

const VI: Dict = {
  title: 'Chỉ mục tài liệu',
  subtitle: 'Mọi thứ GenOffice đã đọc trên máy này và tiến độ hiện tại.',
  back: 'Quay lại',
  tabs: { overview: 'Tổng quan', folders: 'Thư mục', problems: 'Cần xử lý', settings: 'Cấu hình' },
  pause: 'Tạm dừng',
  resume: 'Tiếp tục',
  scanNow: 'Quét lại',
  addFolder: 'Thêm thư mục',
  stopScan: 'Dừng quét',
  stateRunning: 'Đang đọc tài liệu',
  stateScanning: 'Đang quét thư mục',
  statePaused: 'Đang tạm dừng',
  stateIdle: 'Đã cập nhật',
  stateOff: 'Đang tắt',
  stateModelError: 'Mô hình tìm kiếm gặp lỗi',
  stateDownloading: 'Đang tải mô hình tìm kiếm',
  filesDone: '{ready} / {total} tệp',
  waiting: '{n} đang chờ',
  problems: '{n} lỗi',
  eta: 'Còn lại',
  etaUnknown: 'Chưa đủ tiến độ để dự đoán',
  quiet: 'Chưa thấy tiến độ mới · xem Cần xử lý hoặc tải lại',
  passageRate: '{n} đoạn/phút',
  rate: 'Tốc độ',
  perMin: '{n} tệp/phút',
  docs: 'Tài liệu',
  chunks: 'Đoạn văn bản',
  vectors: 'Vector',
  pending: 'Đang chờ',
  errors: 'Lỗi',
  model: 'Mô hình tìm kiếm',
  modelReady: 'Sẵn sàng',
  modelNot: 'Chưa nạp',
  modelDownloading: 'Đang tải {p}%',
  modelError: 'Lỗi',
  effort: 'Mức độ làm việc',
  modes: { light: 'Nhẹ', balanced: 'Cân bằng', fast: 'Nhanh' },
  modeHint: {
    light: 'Gần như không cảm nhận được. Chậm nhất.',
    balanced: 'Hợp cho dùng hằng ngày.',
    fast: 'Dùng gần hết máy. Nhanh nhất.',
  },
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
  },
  scanning: 'Đang đọc thư mục {root}',
  seen: 'thấy {n} tệp · {m} mới',
  runCommand: 'Chạy: “{q}”',
  runHint: 'Enter · chạy ngay trên máy, không tốn quota AI',
  dismiss: 'Đóng',
  send: 'Gửi',
  searchFiles: 'Tìm tệp, hoặc ra lệnh: “index tới đâu rồi?”, “tạm dừng”…',
  attentionTitle: 'Cần chú ý',
  attentionAll: 'Xem tất cả',
  actionFailed: 'Chưa thực hiện được thao tác. Bạn thử lại nhé.',
  statusFailed: 'Chưa cập nhật được chỉ mục. Kiểm tra kết nối và thử lại.',
  refresh: 'Tải lại',
  dismissNote: 'Đóng thông báo',
  suggestions: ['Index tới đâu rồi?', 'Quét lại', 'Thử lại các lỗi', 'Trợ giúp'],
  ocrConfirm:
    'Đọc ngay tệp PDF quét này bằng Antigravity? Sẽ tốn quota Antigravity và bỏ qua giới hạn hôm nay.',
}

const TEXT: Record<string, Dict> = { en: EN, vi: VI }

const compact = (n: number, locale: string): string => n.toLocaleString(locale)

interface Snapshot {
  memory: DocumentMemoryStatus | null
  activity: HomeIndexingActivity | null
  mode: IndexingModeState | null
  now: IndexingNow | null
}

export function IndexDashboard({ api, onClose }: { api: HomeApi; onClose: () => void }) {
  const { lang, dateLocale } = useI18n()
  const d = TEXT[lang] ?? EN
  const copy = activityCopy(lang)
  const [tab, setTab] = useState<Tab>('overview')
  const [focus, setFocus] = useState<IndexIssueReason | null>(null)
  const [attention, setAttention] = useState<IndexIssueSummary | null>(null)
  const [snap, setSnap] = useState<Snapshot>({
    memory: null,
    activity: null,
    mode: null,
    now: null,
  })
  const [progressReading, setProgressReading] = useState<IndexProgressReading>({
    eta: null,
    filesPerMinute: null,
    passagesPerMinute: null,
    quiet: false,
  })
  const [actionBusy, setActionBusy] = useState(false)
  const [actionNote, setActionNote] = useState('')
  const [statusFailed, setStatusFailed] = useState(false)
  const actionInFlight = useRef(false)
  const tracker = useRef(new IndexProgressTracker())
  const pollKick = useRef<() => void>(() => undefined)

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
        setProgressReading(
          tracker.current.record(
            Date.now(),
            next.activity,
            !!next.mode?.effective?.paused || next.memory?.enabled === false,
          ),
        )
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
  const modelState = activity?.memory.modelState ?? memory?.modelState ?? 'not-loaded'
  const pending = memory?.pending ?? activity?.memory.pending ?? 0
  const errors = (attention?.groups ?? [])
    .filter((group) => needsAction(group.reason) && group.reason !== 'no-text')
    .reduce((count, group) => count + group.count, 0)
  const state: { text: string; tone: 'ok' | 'busy' | 'warn' | 'idle' } = !memory
    ? { text: '…', tone: 'idle' }
    : !memory.enabled
      ? { text: d.stateOff, tone: 'warn' }
      : paused
        ? { text: d.statePaused, tone: 'warn' }
        : modelState === 'error' && pending > 0
          ? { text: d.stateModelError, tone: 'warn' }
          : modelState === 'downloading'
            ? { text: d.stateDownloading, tone: 'busy' }
            : folder?.running
              ? { text: d.stateScanning, tone: 'busy' }
              : pending > 0
                ? { text: d.stateRunning, tone: 'busy' }
                : { text: d.stateIdle, tone: 'ok' }
  const percent = progress?.percent ?? (progress && progress.totalFiles === 0 ? 100 : null)

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
  const setMode = (next: IndexingMode) =>
    runAction(async () => {
      await api.setIndexingMode(next)
      setSnap((s) => (s.mode ? { ...s, mode: { ...s.mode, mode: next } } : s))
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
  const stat = (label: string, value: string, tone = '') => (
    <div className={`idx-stat ${tone}`} key={label}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
  const modelText =
    modelState === 'ready'
      ? d.modelReady
      : modelState === 'downloading'
        ? fill(d.modelDownloading, {
            p: Math.round(
              (activity?.memory.modelProgress ?? 0) *
                ((activity?.memory.modelProgress ?? 0) <= 1 ? 100 : 1),
            ),
          })
        : modelState === 'error'
          ? d.modelError
          : d.modelNot

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
      {statusFailed && tab !== 'problems' && (
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

      <>
        <nav className="idx-tabs" role="tablist" aria-label={d.title}>
          {(Object.keys(d.tabs) as Tab[]).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              id={`index-tab-${key}`}
              aria-controls="index-tab-panel"
              aria-selected={tab === key}
              tabIndex={tab === key ? 0 : -1}
              className={tab === key ? 'is-active' : ''}
              onClick={() => setTab(key)}
              onKeyDown={(event) => {
                const tabs = Object.keys(d.tabs) as Tab[]
                const index = tabs.indexOf(key)
                const next =
                  event.key === 'Home'
                    ? tabs[0]
                    : event.key === 'End'
                      ? tabs[tabs.length - 1]
                      : event.key === 'ArrowRight'
                        ? tabs[(index + 1) % tabs.length]
                        : event.key === 'ArrowLeft'
                          ? tabs[(index + tabs.length - 1) % tabs.length]
                          : null
                if (!next) return
                event.preventDefault()
                setTab(next)
                document.getElementById(`index-tab-${next}`)?.focus()
              }}
            >
              {d.tabs[key]}
              {key === 'problems' && todo > 0 && (
                <span className="idx-badge">{compact(todo, dateLocale)}</span>
              )}
            </button>
          ))}
        </nav>

        <div id="index-tab-panel" role="tabpanel" aria-labelledby={`index-tab-${tab}`}>
          {tab === 'overview' && (
            <div className="idx-body">
              {attention && attention.groups.some((g) => needsAction(g.reason)) && (
                <section className="idx-card idx-attn" aria-label={d.attentionTitle}>
                  <header>
                    <h2>{d.attentionTitle}</h2>
                    <button type="button" className="idx-link" onClick={() => setTab('problems')}>
                      {d.attentionAll}
                    </button>
                  </header>
                  <ul>
                    {attention.groups
                      .filter((g) => needsAction(g.reason))
                      .map((g) => (
                        <li key={g.reason}>
                          <button
                            type="button"
                            onClick={() => {
                              setFocus(g.reason)
                              setTab('problems')
                            }}
                          >
                            <span>{copy.reasons[g.reason].title}</span>
                            <span className="idx-attn-hint">{copy.reasons[g.reason].hint}</span>
                            <strong>{compact(g.count, dateLocale)}</strong>
                          </button>
                        </li>
                      ))}
                  </ul>
                </section>
              )}
              <section className="idx-hero">
                <div className="idx-ring">
                  <IndexProgressRing
                    percent={percent}
                    complete={state.tone === 'ok'}
                    label={d.title}
                    active={state.tone === 'busy'}
                    state={state.tone === 'warn' ? 'paused' : 'running'}
                  />
                </div>
                <div className="idx-hero-text">
                  <span className={`idx-pill is-${state.tone}`}>{state.text}</span>
                  {progress && (
                    <h2>
                      {fill(d.filesDone, {
                        ready: compact(progress.readyFiles, dateLocale),
                        total: compact(progress.totalFiles, dateLocale),
                      })}
                    </h2>
                  )}
                  <p>
                    {progress &&
                      [
                        fill(d.waiting, { n: compact(progress.pendingFiles, dateLocale) }),
                        errors > 0 ? fill(d.problems, { n: compact(errors, dateLocale) }) : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                  </p>
                  {folder?.running && folder.root && (
                    <p className="idx-scan" title={folder.root}>
                      {fill(d.scanning, { root: folder.root })} ·{' '}
                      {fill(d.seen, {
                        n: compact(folder.discovered, dateLocale),
                        m: compact(folder.enrolled, dateLocale),
                      })}
                    </p>
                  )}
                  {now &&
                    !paused &&
                    (now.extracting.length > 0 || Object.keys(now.embedding).length > 0) && (
                      <p className="idx-live-work" role="status">
                        {now.extracting.length > 0
                          ? (lang === 'vi' ? 'Đang đọc: ' : 'Reading: ') +
                            now.extracting.map((item) => item.path.split(/[\\/]/).pop()).join(', ')
                          : lang === 'vi'
                            ? 'Đang chuẩn bị nội dung cho tìm kiếm'
                            : 'Preparing content for search'}
                        {Object.keys(now.embedding).length > 0 &&
                          ` · ${Object.values(now.embedding)
                            .reduce((n, item) => n + item.done, 0)
                            .toLocaleString(lang)} / ${Object.values(now.embedding)
                            .reduce((n, item) => n + item.total, 0)
                            .toLocaleString(lang)} ${lang === 'vi' ? 'đoạn' : 'passages'}`}
                      </p>
                    )}
                </div>
                <dl className="idx-eta">
                  <div>
                    <dt>{d.eta}</dt>
                    <dd>
                      {pending > 0 && !paused && !folder?.running && modelState === 'ready'
                        ? progressReading.eta
                          ? etaText(progressReading.eta, copy)
                          : progressReading.quiet
                            ? d.quiet
                            : d.etaUnknown
                        : '–'}
                    </dd>
                  </div>
                  <div>
                    <dt>{d.rate}</dt>
                    <dd>
                      {state.tone === 'busy' && progressReading.passagesPerMinute !== null
                        ? fill(progressReading.passagesPerMinute > 0 ? d.passageRate : d.perMin, {
                            n: compact(
                              progressReading.passagesPerMinute ||
                                progressReading.filesPerMinute ||
                                0,
                              dateLocale,
                            ),
                          })
                        : '–'}
                    </dd>
                  </div>
                </dl>
              </section>

              <section className="idx-stats">
                {stat(d.docs, compact(memory?.documents ?? 0, dateLocale))}
                {stat(d.pending, compact(pending, dateLocale))}
                {stat(d.errors, compact(errors, dateLocale), errors > 0 ? 'is-warn' : '')}
                {stat(d.model, modelText, modelState === 'error' ? 'is-warn' : '')}
              </section>

              <section className="idx-card">
                <header>
                  <h3>{d.effort}</h3>
                  <span className="idx-muted">{tierText}</span>
                </header>
                <div className="idx-seg" role="radiogroup" aria-label={d.effort}>
                  {INDEXING_MODES.map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      disabled={actionBusy}
                      aria-checked={mode?.mode === m}
                      className={mode?.mode === m ? 'is-active' : ''}
                      onClick={() => void setMode(m)}
                    >
                      <strong>{d.modes[m]}</strong>
                      <span>{d.modeHint[m]}</span>
                    </button>
                  ))}
                </div>
              </section>
            </div>
          )}

          {tab === 'folders' && (
            <div className="idx-body idx-embed">
              <IndexedFolders />
            </div>
          )}

          {tab === 'problems' && (
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
              <IndexSettingsTab api={api} />
            </div>
          )}
        </div>
      </>
    </main>
  )
}
