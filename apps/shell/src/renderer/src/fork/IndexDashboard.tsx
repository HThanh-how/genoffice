import { useEffect, useRef, useState } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import { useI18n } from '../locale'
import { TodoTab } from './TodoTab'
import { fill } from '../indexing-activity-copy'
import { IndexedFolders } from './IndexedFolders'
import type { IndexIssueReason } from '../../../main/document-memory/issues'
import { deriveIndexSummary } from './index-summary'
import { IndexSettingsTab } from './IndexSettingsTab'
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
  const [focus, setFocus] = useState<IndexIssueReason | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionNote, setActionNote] = useState('')
  const actionInFlight = useRef(false)
  const moreRef = useRef<HTMLDetailsElement>(null)
  const closeMore = () => moreRef.current?.removeAttribute('open')

  const { snap, attention, statusFailed, loaded, kick } = useIndexSnapshot(api)
  const { memory, activity, mode, now, storageBudget } = snap
  const progress = activity?.folderProgress ?? null
  const folder = activity?.folder ?? null
  const paused = !!mode?.effective?.paused || memory?.enabled === false
  const pending = memory?.pending ?? activity?.memory.pending ?? 0

  // Search lives in the Home box: Ctrl+F leaves the index and focuses it there.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      if (e.key !== 'f' && e.key !== 'F' && e.code !== 'KeyF') return
      e.preventDefault()
      onClose()
      requestAnimationFrame(() => {
        const input = document.querySelector<HTMLInputElement>('.ask-dock .ask-form input')
        input?.focus()
        input?.select()
      })
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const runAction = async (work: () => Promise<unknown>) => {
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
    runAction(() => api.setDocumentMemoryEnabled(!(memory?.enabled ?? true)))
  const addFolder = () => runAction(() => api.scanDocumentFolder())
  const stopScan = () => runAction(() => api.stopDocumentFolderScan())
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

  const todo = deriveIndexSummary({ activity, memoryPending: memory?.pending, attention }).problems

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
            aria-pressed={memory?.enabled === false}
            onClick={() => void togglePause()}
          >
            {memory?.enabled === false ? d.resumeIndex : d.pauseIndex}
          </button>
          <details className="idx-more" ref={moreRef}>
            <summary className="idx-btn idx-more-btn" aria-label={d.more} title={d.more}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
              >
                <circle cx="3.5" cy="8" r="1.3" />
                <circle cx="8" cy="8" r="1.3" />
                <circle cx="12.5" cy="8" r="1.3" />
              </svg>
            </summary>
            <div className="idx-more-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                disabled={actionBusy}
                onClick={() => {
                  closeMore()
                  void rescanAll()
                }}
              >
                {d.scanNow}
              </button>
              {folder?.running && (
                <button
                  type="button"
                  role="menuitem"
                  disabled={actionBusy}
                  onClick={() => {
                    closeMore()
                    void stopScan()
                  }}
                >
                  {d.stopScan}
                </button>
              )}
            </div>
          </details>
        </div>
      </header>

      {statusFailed && loaded && (snap.activity || snap.memory) && (
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
      {storageBudget?.limitState === 'warning' && (
        <div className="todo-status is-warning" role="status">
          <span>{fill(d.storageWarn, { p: Math.round(storageBudget.usageRatio * 100) })}</span>
        </div>
      )}
      {storageBudget?.limitState === 'full' && (
        <div className="todo-status is-full" role="status">
          <span>{d.storageFull}</span>
        </div>
      )}

      <IndexNav activeTab={tab} onChangeTab={setTab} issuesCount={todo} />
      <div
        id="index-tab-panel"
        className="idx-panel"
        role="tabpanel"
        aria-labelledby={`index-tab-${tab}`}
      >
        {tab === 'overview' && (
          <IndexOverview
            api={api}
            memory={memory}
            activity={activity}
            mode={mode}
            now={now}
            attention={attention}
            loading={!loaded}
            failed={statusFailed}
            onRetry={kick}
            onNavigateTab={(nextTab, reason) => {
              if (reason) setFocus(reason)
              setTab(nextTab)
            }}
            onOpened={onClose}
            onViewRecent={onClose}
          />
        )}
        {tab === 'sources' && <IndexedFolders api={api} onOpenIssues={() => setTab('issues')} />}
        {tab === 'issues' && (
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
        )}
        {tab === 'settings' && <IndexSettingsTab api={api} />}
      </div>
    </main>
  )
}
