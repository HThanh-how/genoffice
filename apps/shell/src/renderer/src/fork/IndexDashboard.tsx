import { useCallback, useEffect, useRef, useState } from 'react'
import { IndexProgressRing } from '@genoffice/ui'
import '@genoffice/ui/index-progress.css'
import type { HomeApi, HomeIndexingActivity, DocumentMemoryStatus } from '../../../shared/home-api'
import type { IndexingMode, IndexingModeState } from '../../../shared/fork/indexing-mode'
import { INDEXING_MODES } from '../../../shared/fork/indexing-mode'
import { useI18n } from '../locale'
import { activityCopy, fill } from '../indexing-activity-copy'
import { EtaTracker, type EtaEstimate } from '../indexing-activity-model'
import { etaText } from '../indexing-activity/format'
import { IndexedFolders } from './IndexedFolders'
import { IndexProblems } from './IndexProblems'
import { IndexSearch } from './IndexSearch'
import type { IndexIssueSummary } from '../../../main/document-memory/issue-reader'
import type { IndexIssueReason } from '../../../main/document-memory/issues'
import { isInformationalReason } from '../../../main/document-memory/issues'
import { DocumentMemorySettings } from '../DocumentMemorySettings'
import { langFor, parseIndexCommand, runIndexCommand } from './index-assistant'
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
  runCommand: 'Run: “{q}”',
  runHint: 'Enter · runs here, no AI quota',
  dismiss: 'Close',
  send: 'Send',
  searchFiles: 'Find a file, or give an order: “how far is indexing?”, “pause”…',
  attentionTitle: 'Needs attention',
  attentionAll: 'See all',
  suggestions: ['How far is indexing?', 'Rescan', 'Retry the errors', 'Help'],
  ocrConfirm:
    'Read this scanned PDF now with Antigravity? It uses Antigravity quota and ignores today’s limit.',
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
  runCommand: 'Chạy: “{q}”',
  runHint: 'Enter · chạy ngay trên máy, không tốn quota AI',
  dismiss: 'Đóng',
  send: 'Gửi',
  searchFiles: 'Tìm tệp, hoặc ra lệnh: “index tới đâu rồi?”, “tạm dừng”…',
  attentionTitle: 'Cần chú ý',
  attentionAll: 'Xem tất cả',
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
}

export function IndexDashboard({ api, onClose }: { api: HomeApi; onClose: () => void }) {
  const { lang, dateLocale } = useI18n()
  const d = TEXT[lang] ?? EN
  const copy = activityCopy(lang)
  const [tab, setTab] = useState<Tab>('overview')
  const [query, setQuery] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [focus, setFocus] = useState<IndexIssueReason | null>(null)
  const [attention, setAttention] = useState<IndexIssueSummary | null>(null)
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

  /** The one box does both jobs: Enter (or the suggestion) runs a command, typing also searches files. */
  const command = query.trim() ? parseIndexCommand(query) : null
  const run = async (text: string) => {
    const message = text.trim()
    const parsed = parseIndexCommand(message)
    if (!parsed || running) return
    setRunning(true)
    setQuery('')
    try {
      setAnswer(await runIndexCommand(api, parsed, langFor(message, lang), kick))
    } finally {
      setRunning(false)
    }
  }

  // What needs a look, for the overview card: a cheap grouped count, refreshed when it changes.
  const problemFiles = (progress?.errorFiles ?? 0) + (progress?.emptyFiles ?? 0)
  const scanRoot = folder?.root ?? ''
  useEffect(() => {
    if (!scanRoot) return
    let alive = true
    void api
      .getDocumentIndexIssueSummary(scanRoot)
      .then((next) => alive && setAttention(next))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [api, scanRoot, problemFiles])
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

      <div className="idx-search">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.4" />
          <path d="m10.6 10.6 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && command) {
              event.preventDefault()
              void run(query)
            } else if (event.key === 'Escape') setQuery('')
          }}
          placeholder={d.searchFiles}
          aria-label={d.searchFiles}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {!query.trim() && !answer && (
        <div className="idx-suggest" aria-label={d.searchFiles}>
          {d.suggestions.map((text) => (
            <button key={text} type="button" disabled={running} onClick={() => void run(text)}>
              {text}
            </button>
          ))}
        </div>
      )}

      {answer && (
        <section className="idx-answer" role="status" aria-live="polite">
          <p>{answer}</p>
          <button
            type="button"
            aria-label={d.dismiss}
            title={d.dismiss}
            onClick={() => setAnswer(null)}
          >
            ×
          </button>
        </section>
      )}

      {query.trim() ? (
        <div className="idx-body">
          {command && (
            <button type="button" className="idx-cmd" onClick={() => void run(query)}>
              <strong>{fill(d.runCommand, { q: query.trim() })}</strong>
              <span>{d.runHint}</span>
            </button>
          )}
          <IndexSearch api={api} query={query.trim()} quiet={!!command} onChanged={kick} />
        </div>
      ) : (
        <>
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
              {attention && attention.groups.some((g) => !isInformationalReason(g.reason)) && (
                <section className="idx-card idx-attn" aria-label={d.attentionTitle}>
                  <header>
                    <h2>{d.attentionTitle}</h2>
                    <button type="button" className="idx-link" onClick={() => setTab('problems')}>
                      {d.attentionAll}
                    </button>
                  </header>
                  <ul>
                    {attention.groups
                      .filter((g) => !isInformationalReason(g.reason))
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
                </div>
                <dl className="idx-eta">
                  <div>
                    <dt>{d.eta}</dt>
                    <dd>
                      {state.tone === 'busy' ? (eta ? etaText(eta, copy) : d.etaUnknown) : '–'}
                    </dd>
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
            </div>
          )}

          {tab === 'folders' && (
            <div className="idx-body idx-embed">
              <IndexedFolders />
            </div>
          )}

          {tab === 'problems' && (
            <div className="idx-body">
              <IndexProblems api={api} root={folder?.root ?? ''} focus={focus} onChanged={kick} />
            </div>
          )}

          {tab === 'settings' && (
            <div className="idx-body idx-embed">
              <DocumentMemorySettings />
            </div>
          )}
        </>
      )}
    </main>
  )
}
