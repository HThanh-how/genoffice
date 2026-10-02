import { useCallback, useEffect, useRef, useState } from 'react'
import { IndexProgressRing } from '@genoffice/ui'
import '@genoffice/ui/index-progress.css'
import type { HomeApi, HomeIndexingActivity, DocumentMemoryStatus } from '../../../shared/home-api'
import type { IndexingMode, IndexingModeState } from '../../../shared/fork/indexing-mode'
import { INDEXING_MODES } from '../../../shared/fork/indexing-mode'
import type { IndexIssueSummary } from '../../../main/document-memory/issue-reader'
import type { IndexIssue, IndexIssueReason } from '../../../main/document-memory/issues'
import { isInformationalReason, isRetryableReason } from '../../../main/document-memory/issues'
import { useI18n } from '../locale'
import { activityCopy, fill } from '../indexing-activity-copy'
import { EtaTracker, type EtaEstimate } from '../indexing-activity-model'
import { etaText } from '../indexing-activity/format'
import { IndexedFolders } from './IndexedFolders'
import { DocumentMemorySettings } from '../DocumentMemorySettings'
import { parseIndexCommand, runIndexCommand } from './index-assistant'
import './index-dashboard.css'

type Tab = 'overview' | 'folders' | 'problems' | 'settings'
const POLL_MS = 2000

const EN = {
  title: 'Document index',
  subtitle: 'Everything GenOffice has read on this computer, and how it is going.',
  back: 'Back',
  tabs: { overview: 'Overview', folders: 'Folders', problems: 'Problems', settings: 'Settings' },
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
  etaUnknown: 'Estimating…',
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
    active: 'Working at full speed',
    idle: 'Nothing to do',
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
  assistant: 'Ask or tell the index',
  assistantHint: 'Ask how far it is or give an order. It runs here, no AI quota is used.',
  placeholder: 'e.g. "how far is indexing?", "prioritize folder Contracts", "pause"',
  send: 'Send',
  suggestions: ['How far is indexing?', 'Rescan', 'Retry the errors', 'Help'],
  noProblems: 'No problems. Every readable file is indexed.',
  noFolder: 'Scan a folder first.',
  retryGroup: 'Try again',
  showFiles: 'Show files',
  hideFiles: 'Hide files',
  reveal: 'Show in folder',
  retryOne: 'Retry',
  retried: 'Queued {n} files again.',
  skippedTitle: 'Skipped on purpose',
  attentionTitle: 'Needs attention',
  more: 'Showing the first {n} of {total}.',
}
type Dict = typeof EN

const VI: Dict = {
  title: 'Chỉ mục tài liệu',
  subtitle: 'Mọi thứ GenOffice đã đọc trên máy này và tiến độ hiện tại.',
  back: 'Quay lại',
  tabs: { overview: 'Tổng quan', folders: 'Thư mục', problems: 'Vấn đề', settings: 'Cấu hình' },
  pause: 'Tạm dừng',
  resume: 'Tiếp tục',
  scanNow: 'Quét lại',
  addFolder: 'Thêm thư mục',
  stopScan: 'Dừng quét',
  stateRunning: 'Đang index',
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
  etaUnknown: 'Đang ước tính…',
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
    active: 'Đang chạy hết tốc độ',
    idle: 'Không còn việc',
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
  assistant: 'Hỏi hoặc ra lệnh cho chỉ mục',
  assistantHint: 'Hỏi tiến độ hoặc ra lệnh. Chạy ngay trên máy, không tốn quota AI.',
  placeholder: 'vd: "index tới đâu rồi?", "ưu tiên thư mục Hợp đồng", "tạm dừng"',
  send: 'Gửi',
  suggestions: ['Index tới đâu rồi?', 'Quét lại', 'Thử lại các lỗi', 'Trợ giúp'],
  noProblems: 'Không có lỗi. Mọi tệp đọc được đều đã index.',
  noFolder: 'Hãy quét một thư mục trước.',
  retryGroup: 'Thử lại',
  showFiles: 'Xem tệp',
  hideFiles: 'Ẩn tệp',
  reveal: 'Mở thư mục chứa',
  retryOne: 'Thử lại',
  retried: 'Đã xếp lại {n} tệp.',
  skippedTitle: 'Bỏ qua có chủ đích',
  attentionTitle: 'Cần xử lý',
  more: 'Đang hiện {n} tệp đầu trong {total}.',
}

const TEXT: Record<string, Dict> = { en: EN, vi: VI }

const compact = (n: number, locale: string): string => n.toLocaleString(locale)

interface Snapshot {
  memory: DocumentMemoryStatus | null
  activity: HomeIndexingActivity | null
  mode: IndexingModeState | null
}

interface Turn {
  role: 'user' | 'index'
  text: string
}

export function IndexDashboard({ api, onClose }: { api: HomeApi; onClose: () => void }) {
  const { lang, dateLocale } = useI18n()
  const d = TEXT[lang] ?? EN
  const copy = activityCopy(lang)
  const [tab, setTab] = useState<Tab>('overview')
  const [snap, setSnap] = useState<Snapshot>({ memory: null, activity: null, mode: null })
  const [eta, setEta] = useState<EtaEstimate | null>(null)
  const [rate, setRate] = useState<number | null>(null)
  const tracker = useRef(new EtaTracker())
  const lastRate = useRef<{ at: number; done: number } | null>(null)
  const pollKick = useRef<() => void>(() => undefined)

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const load = async () => {
      if (document.visibilityState === 'visible') {
        const [memory, activity, mode] = await Promise.allSettled([
          api.getDocumentMemoryStatus(),
          api.getIndexingActivity(),
          api.getIndexingModeState?.() ?? Promise.resolve(null),
        ])
        if (!alive) return
        const next: Snapshot = {
          memory: memory.status === 'fulfilled' ? memory.value : null,
          activity: activity.status === 'fulfilled' ? activity.value : null,
          mode: mode.status === 'fulfilled' ? mode.value : null,
        }
        setSnap((previous) => ({
          memory: next.memory ?? previous.memory,
          activity: next.activity ?? previous.activity,
          mode: next.mode ?? previous.mode,
        }))
        const progress = next.activity?.folderProgress
        if (progress && progress.totalFiles > 0) {
          const done = progress.readyFiles + progress.errorFiles + (progress.emptyFiles ?? 0)
          const now = Date.now()
          tracker.current.record(now, done, progress.totalFiles)
          setEta(tracker.current.estimate())
          const last = lastRate.current
          if (last && now - last.at >= 10_000) {
            const perMin = ((done - last.done) / (now - last.at)) * 60_000
            setRate(perMin > 0 ? Math.round(perMin) : 0)
            lastRate.current = { at: now, done }
          } else if (!last) lastRate.current = { at: now, done }
        }
      }
      if (alive) timer = setTimeout(() => void load(), POLL_MS)
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

  const { memory, activity, mode } = snap
  const progress = activity?.folderProgress ?? null
  const folder = activity?.folder ?? null
  const paused = !!mode?.effective?.paused || memory?.enabled === false
  const modelState = activity?.memory.modelState ?? memory?.modelState ?? 'not-loaded'
  const pending = memory?.pending ?? activity?.memory.pending ?? 0
  const errors = (progress?.errorFiles ?? 0) + (progress?.emptyFiles ?? 0)
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
  const togglePause = async () => {
    await api.setDocumentMemoryEnabled(!(memory?.enabled ?? true))
    kick()
  }
  const addFolder = async () => {
    await api.scanDocumentFolder()
    kick()
  }
  const stopScan = async () => {
    await api.stopDocumentFolderScan()
    kick()
  }
  const rescanAll = async () => {
    const list = await api.listIndexedFolders()
    for (const f of list) if (!f.unavailable) await api.rescanIndexedFolder(f.root)
    kick()
  }
  const setMode = async (next: IndexingMode) => {
    setSnap((s) => (s.mode ? { ...s, mode: { ...s.mode, mode: next } } : s))
    await api.setIndexingMode(next)
    kick()
  }

  const effective = mode?.effective
  const tierText = effective
    ? effective.tier === 'paused'
      ? fill(d.tier.paused, { why: effective.pauseReason ? d.why[effective.pauseReason] : '' })
      : d.tier[effective.tier]
    : ''

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
            <button type="button" className="idx-btn" onClick={() => void stopScan()}>
              {d.stopScan}
            </button>
          )}
          <button type="button" className="idx-btn" onClick={() => void rescanAll()}>
            {d.scanNow}
          </button>
          <button type="button" className="idx-btn" onClick={() => void addFolder()}>
            {d.addFolder}
          </button>
          <button type="button" className="idx-btn primary" onClick={() => void togglePause()}>
            {memory?.enabled === false || paused ? d.resume : d.pause}
          </button>
        </div>
      </header>

      <nav className="idx-tabs" role="tablist">
        {(Object.keys(d.tabs) as Tab[]).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'is-active' : ''}
            onClick={() => setTab(key)}
          >
            {d.tabs[key]}
            {key === 'problems' && errors > 0 && <span className="idx-badge">{errors}</span>}
          </button>
        ))}
      </nav>

      {tab === 'overview' && (
        <div className="idx-body">
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
            </div>
            <dl className="idx-eta">
              <div>
                <dt>{d.eta}</dt>
                <dd>{state.tone === 'busy' ? (eta ? etaText(eta, copy) : d.etaUnknown) : '–'}</dd>
              </div>
              <div>
                <dt>{d.rate}</dt>
                <dd>
                  {rate && state.tone === 'busy'
                    ? fill(d.perMin, { n: compact(rate, dateLocale) })
                    : '–'}
                </dd>
              </div>
            </dl>
          </section>

          <section className="idx-stats">
            {stat(d.docs, compact(memory?.documents ?? 0, dateLocale))}
            {stat(d.chunks, compact(memory?.chunks ?? 0, dateLocale))}
            {stat(d.vectors, compact(memory?.vectors ?? 0, dateLocale))}
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

          <Assistant api={api} lang={lang} d={d} onChanged={kick} />
        </div>
      )}

      {tab === 'folders' && (
        <div className="idx-body idx-embed">
          <IndexedFolders />
        </div>
      )}

      {tab === 'problems' && (
        <div className="idx-body">
          <Problems api={api} root={folder?.root ?? ''} lang={lang} d={d} onChanged={kick} />
        </div>
      )}

      {tab === 'settings' && (
        <div className="idx-body idx-embed">
          <DocumentMemorySettings />
        </div>
      )}
    </main>
  )
}

function Assistant({
  api,
  lang,
  d,
  onChanged,
}: {
  api: HomeApi
  lang: string
  d: Dict
  onChanged: () => void
}) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [turns])

  const send = async (raw: string) => {
    const message = raw.trim()
    if (!message || busy) return
    setText('')
    setBusy(true)
    setTurns((t) => [...t, { role: 'user', text: message }])
    const command = parseIndexCommand(message) ?? { kind: 'help' as const }
    const answer = await runIndexCommand(api, command, lang, onChanged)
    setTurns((t) => [...t, { role: 'index', text: answer }])
    setBusy(false)
  }

  return (
    <section className="idx-card idx-chat">
      <header>
        <h3>{d.assistant}</h3>
        <span className="idx-muted">{d.assistantHint}</span>
      </header>
      {turns.length > 0 && (
        <div className="idx-thread" role="log" aria-live="polite">
          {turns.map((turn, index) => (
            <p key={index} className={`idx-turn is-${turn.role}`}>
              {turn.text}
            </p>
          ))}
          <div ref={endRef} />
        </div>
      )}
      <div className="idx-suggest">
        {d.suggestions.map((s) => (
          <button key={s} type="button" onClick={() => void send(s)} disabled={busy}>
            {s}
          </button>
        ))}
      </div>
      <form
        className="idx-compose"
        onSubmit={(event) => {
          event.preventDefault()
          void send(text)
        }}
      >
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={d.placeholder}
          aria-label={d.assistant}
          spellCheck={false}
        />
        <button type="submit" className="idx-btn primary" disabled={busy || !text.trim()}>
          {d.send}
        </button>
      </form>
    </section>
  )
}

function Problems({
  api,
  root,
  lang,
  d,
  onChanged,
}: {
  api: HomeApi
  root: string
  lang: string
  d: Dict
  onChanged: () => void
}) {
  const copy = activityCopy(lang as never)
  const [summary, setSummary] = useState<IndexIssueSummary | null>(null)
  const [open, setOpen] = useState<IndexIssueReason | null>(null)
  const [files, setFiles] = useState<{ items: IndexIssue[]; total: number }>({
    items: [],
    total: 0,
  })
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    if (!root) return
    try {
      setSummary(await api.getDocumentIndexIssueSummary(root))
    } catch {
      /* keep what is shown */
    }
  }, [api, root])
  useEffect(() => {
    void load()
  }, [load])

  const show = async (reason: IndexIssueReason) => {
    if (open === reason) return setOpen(null)
    setOpen(reason)
    setFiles({ items: [], total: 0 })
    try {
      setFiles(await api.getDocumentIndexIssues(root, 0, reason))
    } catch {
      /* empty list */
    }
  }
  const retry = async (reason: IndexIssueReason) => {
    const result = await api.retryDocumentIndexGroup(root, reason)
    setNote(result.ok ? fill(d.retried, { n: result.retried }) : (result.error ?? ''))
    await load()
    onChanged()
  }

  if (!root) return <p className="idx-muted">{d.noFolder}</p>
  const groups = summary?.groups ?? []
  if (summary && groups.length === 0) return <p className="idx-empty">{d.noProblems}</p>

  const section = (title: string, list: typeof groups) =>
    list.length > 0 && (
      <section className="idx-card">
        <header>
          <h3>{title}</h3>
        </header>
        {list.map((group) => {
          const words = copy.reasons[group.reason]
          return (
            <div className="idx-issue" key={group.reason}>
              <div className="idx-issue-head">
                <div>
                  <strong>{words.title}</strong>
                  <span className="idx-count">{group.count}</span>
                  <p>{words.hint}</p>
                </div>
                <div className="idx-issue-actions">
                  <button type="button" className="idx-btn" onClick={() => void show(group.reason)}>
                    {open === group.reason ? d.hideFiles : d.showFiles}
                  </button>
                  {isRetryableReason(group.reason) && (
                    <button
                      type="button"
                      className="idx-btn"
                      onClick={() => void retry(group.reason)}
                    >
                      {d.retryGroup}
                    </button>
                  )}
                </div>
              </div>
              {open === group.reason && (
                <ul className="idx-files">
                  {files.items.map((file) => (
                    <li key={file.id} title={file.path}>
                      <span>{file.name}</span>
                      <span className="idx-muted">{file.error ?? ''}</span>
                      <span className="idx-file-actions">
                        <button
                          type="button"
                          onClick={() => void api.revealDocumentIndexFile(file.id)}
                        >
                          {d.reveal}
                        </button>
                        {isRetryableReason(group.reason) && (
                          <button
                            type="button"
                            onClick={() => void api.retryDocumentIndex(file.id).then(load)}
                          >
                            {d.retryOne}
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                  {files.total > files.items.length && (
                    <li className="idx-muted">
                      {fill(d.more, { n: files.items.length, total: files.total })}
                    </li>
                  )}
                </ul>
              )}
            </div>
          )
        })}
      </section>
    )

  return (
    <>
      {note && <p className="idx-note">{note}</p>}
      {section(
        d.attentionTitle,
        groups.filter((g) => !isInformationalReason(g.reason)),
      )}
      {section(
        d.skippedTitle,
        groups.filter((g) => isInformationalReason(g.reason)),
      )}
    </>
  )
}
