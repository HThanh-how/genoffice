import { useCallback, useEffect, useRef, useState } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import { useI18n } from '../locale'
import { TodoTab } from './TodoTab'
import { fill } from '../indexing-activity-copy'
import { IndexedFolders } from './IndexedFolders'
import type { IndexIssueReason } from '../../../main/document-memory/issues'
import { needsAction } from './IndexProblems'
import { IndexSettingsTab } from './IndexSettingsTab'
import { SearchHero } from './SearchHero'
import { SearchResults } from './SearchResults'
import { IndexNav, type IndexTabId } from './IndexNav'
import { IndexOverview } from './IndexOverview'
import { TEXT, EN } from './index-dashboard-i18n'
import { useIndexSnapshot } from './useIndexSnapshot'
import './index-dashboard.css'
import './todo-workspace.css'

export function IndexDashboard({ api, onClose }: { api: HomeApi; onClose: () => void }) {
  const { lang } = useI18n()
  const d = TEXT[lang] ?? EN
  const [tab, setTab] = useState<IndexTabId>('overview')
  const [searchQuery, setSearchQuery] = useState('')
  const [settingsFocus, _setSettingsFocus] = useState<'ocr' | undefined>()
  const [focus, setFocus] = useState<IndexIssueReason | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionNote, setActionNote] = useState('')
  const actionInFlight = useRef(false)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const { snap, attention, statusFailed, kick } = useIndexSnapshot(api)
  const { memory, activity, mode, now, storageBudget } = snap
  const progress = activity?.folderProgress ?? null
  const folder = activity?.folder ?? null
  const paused = !!mode?.effective?.paused || memory?.enabled === false
  const pending = memory?.pending ?? activity?.memory.pending ?? 0

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const runAction = useCallback(async (work: () => Promise<void>) => {
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
  }, [d.actionFailed, kick])

  const togglePause = () => runAction(async () => { await api.setDocumentMemoryEnabled(!(memory?.enabled ?? true)) })
  const addFolder = () => runAction(async () => { await api.scanDocumentFolder() })
  const stopScan = () => runAction(async () => { await api.stopDocumentFolderScan() })
  const rescanAll = () => runAction(async () => {
    const list = await api.listIndexedFolders()
    for (const f of list) if (!f.unavailable) await api.rescanIndexedFolder(f.root)
  })

  const effective = mode?.effective
  const tierText = effective
    ? effective.tier === 'paused'
      ? fill(d.tier.paused, { why: effective.pauseReason ? d.why[effective.pauseReason] : '' })
      : d.tier[effective.tier]
    : ''

  const todo = (attention?.groups ?? []).filter((g) => needsAction(g.reason)).reduce((n, g) => n + g.count, 0)

  return (
    <main className="content idx-page">
      <header className="idx-head">
        <button type="button" className="idx-back" onClick={onClose} aria-label={d.back}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M10 3 5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="idx-title">
          <h1>{d.title}</h1>
          <p>{d.subtitle}</p>
        </div>
        <div className="idx-actions">
          {folder?.running && (
            <button type="button" disabled={actionBusy} className="idx-btn" onClick={() => void stopScan()}>{d.stopScan}</button>
          )}
          <button type="button" disabled={actionBusy} className="idx-btn" onClick={() => void rescanAll()}>{d.scanNow}</button>
          <button type="button" disabled={actionBusy} className="idx-btn" onClick={() => void addFolder()}>{d.addFolder}</button>
          <button type="button" disabled={actionBusy || !memory} className="idx-btn primary" onClick={() => void togglePause()}>
            {memory?.enabled === false ? d.resume : d.pause}
          </button>
        </div>
      </header>

      {statusFailed && (
        <div className="todo-status" role="status">
          <span>{d.statusFailed}</span>
          <button type="button" className="idx-btn" onClick={kick}>{d.refresh}</button>
        </div>
      )}
      {actionNote && (
        <div className="todo-status" role="status">
          <span>{actionNote}</span>
          <button type="button" className="ixp-icon" aria-label={d.dismissNote} onClick={() => setActionNote('')}>×</button>
        </div>
      )}
      {storageBudget?.limitState === 'warning' && (
        <div className="todo-status is-warning" role="status">
          <span>
            {lang === 'vi'
              ? `Dung lượng chỉ mục đạt ${Math.round(storageBudget.usageRatio * 100)}% (Cảnh báo). Đang tối ưu hóa nền.`
              : `Index storage at ${Math.round(storageBudget.usageRatio * 100)}% (Warning). Running background maintenance.`}
          </span>
        </div>
      )}
      {storageBudget?.limitState === 'full' && (
        <div className="todo-status is-full" role="status">
          <span>
            {lang === 'vi'
              ? `Dung lượng chỉ mục đạt giới hạn tối đa. Tạm dừng tìm kiếm ngữ nghĩa để bảo vệ dữ liệu.`
              : `Index storage budget full. Pausing semantic indexing to protect disk space.`}
          </span>
        </div>
      )}

      <SearchHero ref={searchInputRef} value={searchQuery} onChange={setSearchQuery} onClear={() => setSearchQuery('')} />

      {searchQuery.trim().length > 0 ? (
        <SearchResults api={api} query={searchQuery} onOpened={onClose} />
      ) : (
        <>
          <IndexNav activeTab={tab} onChangeTab={setTab} issuesCount={todo} />
          <div id="index-tab-panel" role="tabpanel" aria-labelledby={`index-tab-${tab}`}>
            {tab === 'overview' && (
              <IndexOverview
                api={api} memory={memory} activity={activity} mode={mode} now={now}
                attention={attention} actionBusy={actionBusy}
                onTogglePause={() => void togglePause()}
                onNavigateTab={(nextTab, reason) => { if (reason) setFocus(reason); setTab(nextTab) }}
                onOpened={onClose}
              />
            )}
            {tab === 'sources' && <div className="idx-body idx-embed"><IndexedFolders api={api} /></div>}
            {tab === 'issues' && (
              <div className="idx-body">
                <TodoTab
                  api={api} ready={progress?.readyFiles ?? memory?.documents ?? 0}
                  pending={pending} switchedOff={memory?.enabled === false}
                  held={paused && memory?.enabled !== false} heldWhy={tierText}
                  scanning={!!folder?.running} focus={focus}
                  onAddFolder={() => void addFolder()} onRescan={() => void rescanAll()}
                  onResume={() => void togglePause()} onChanged={kick}
                />
              </div>
            )}
            {tab === 'settings' && <div className="idx-body idx-embed"><IndexSettingsTab api={api} focus={settingsFocus} /></div>}
          </div>
        </>
      )}
    </main>
  )
}
