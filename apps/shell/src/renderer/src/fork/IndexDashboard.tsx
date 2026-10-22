import { useCallback, useEffect, useRef, useState } from 'react'
import type { HomeApi } from '../../../shared/home-api'
import { useI18n } from '../locale'
import { fill } from '../indexing-activity-copy'
import { TEXT, EN } from './index-dashboard-i18n'
import { useIndexSnapshot } from './useIndexSnapshot'
import { useIndexFolders } from './IndexFolders'
import { IndexSettingsPage } from './IndexSettingsPage'
import { IndexEmpty } from './IndexAddFolder'
import { IndexMenu, MenuItem, MenuSeparator } from './IndexMenu'
import { IconBack, IconMore } from './index-icons'
import './index-dashboard.css'
import './index-screen.css'
import './index-screen-c.css'
import '../settings.css'

/**
 * The Index screen is one page, top to bottom: what is happening now (and the one control for it),
 * what needs a person, the folders being read, and, folded away, the rules and settings.
 */
export function IndexDashboard({ api, onClose }: { api: HomeApi; onClose: () => void }) {
  const { lang } = useI18n()
  const d = TEXT[lang] ?? EN
  const s = d.screen
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [advancedFocus, setAdvancedFocus] = useState<'ignore' | undefined>(undefined)
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const advancedRef = useRef<HTMLElement>(null)

  const { snap, attention, statusFailed, loaded, kick } = useIndexSnapshot(api)
  const { memory, activity, mode, storageBudget } = snap
  const { folders, failed: foldersFailed, refresh } = useIndexFolders(api, snap)
  const running = !!activity?.folder?.running
  const hasData = !!(activity || memory)

  // Search lives in the Home box: Ctrl+F leaves the index and focuses it there.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = async (work: () => Promise<unknown>) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setNote('')
    try {
      await work()
    } catch {
      setNote(d.actionFailed)
    } finally {
      inFlight.current = false
      setBusy(false)
      kick()
      void refresh()
    }
  }
  const changed = useCallback(() => {
    kick()
    void refresh()
  }, [kick, refresh])

  const togglePause = () => run(() => api.setDocumentMemoryEnabled(!(memory?.enabled ?? true)))
  const choose = () => run(() => api.scanDocumentFolder())
  const stopScan = () => run(() => api.stopDocumentFolderScan())
  const retryModel = () => run(() => api.retryDocumentIndexGroup('*', 'model'))
  const rescanAll = () =>
    run(async () => {
      const list = await api.listIndexedFolders()
      for (const f of list) if (!f.unavailable) await api.rescanIndexedFolder(f.root)
    })
  const openAdvanced = (focus?: 'ignore') => {
    setAdvancedFocus(focus)
    setAdvancedOpen(true)
    requestAnimationFrame(() =>
      advancedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    )
  }

  // One notice at a time, the most important first.
  let notice: { text: string; tone?: 'warn'; dismiss?: boolean } | null = null
  if (note) notice = { text: note, dismiss: true }
  else if (storageBudget?.limitState === 'full') notice = { text: s.storageFull, tone: 'warn' }
  else if (storageBudget?.limitState === 'warning')
    notice = {
      text: fill(s.storageWarn, { p: Math.round(storageBudget.usageRatio * 100) }),
      tone: 'warn',
    }
  else if (statusFailed && loaded && hasData) notice = { text: s.statusStale }

  const empty = loaded && folders !== null && folders.length === 0 && !running
  const close = () => setMenuOpen(false)

  return (
    <main className="content ix-page">
      <div className="ix-col">
        <header className="ix-head">
          <button type="button" className="ix-icon-btn" onClick={onClose} aria-label={d.back}>
            <IconBack />
          </button>
          <h1>{s.title}</h1>
          <div className="ix-head-actions">
                        <button
              type="button"
              ref={setMenuAnchor}
              className="ix-icon-btn"
              aria-label={d.more}
              title={d.more}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <IconMore />
            </button>
            {menuOpen && (
              <IndexMenu anchor={menuAnchor} onClose={close} label={d.more}>
                <MenuItem
                  disabled={busy || !folders?.length}
                  onClick={() => {
                    close()
                    void rescanAll()
                  }}
                >
                  {s.scanAll}
                </MenuItem>
                {running && (
                  <MenuItem
                    disabled={busy}
                    onClick={() => {
                      close()
                      void stopScan()
                    }}
                  >
                    {s.stopScan}
                  </MenuItem>
                )}
                <MenuSeparator />
                <MenuItem
                  onClick={() => {
                    close()
                    openAdvanced('ignore')
                  }}
                >
                  {s.ignoreRules}
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    close()
                    openAdvanced()
                  }}
                >
                  {s.settings}
                </MenuItem>
              </IndexMenu>
            )}
          </div>
        </header>

        {notice && (
          <div className={`ix-notice${notice.tone ? ` is-${notice.tone}` : ''}`} role="status">
            <span>{notice.text}</span>
            {notice.dismiss && (
              <button type="button" className="ix-link" onClick={() => setNote('')}>
                {d.dismissNote}
              </button>
            )}
          </div>
        )}

        {empty ? (
          <IndexEmpty api={api} busy={busy} onChoose={choose} onChanged={changed} />
        ) : (
          <IndexSettingsPage
            api={api}
            memory={memory}
            activity={activity}
            mode={mode}
            now={snap.now}
            attention={attention}
            hasFolders={!!folders?.length}
            folders={folders ?? []}
            busy={busy}
            unknown={hasData ? null : !loaded || !statusFailed ? 'loading' : 'failed'}
            onRefresh={kick}
            advancedOpen={advancedOpen}
            advancedFocus={advancedFocus}
            advancedRef={advancedRef}
            onToggleAdvanced={() => {
              setAdvancedFocus(undefined)
              setAdvancedOpen((v) => !v)
            }}
            onTogglePause={() => void togglePause()}
            onRetryModel={() => void retryModel()}
            onChoose={() => void choose()}
            onChanged={changed}
            onNote={setNote}
            onRefreshFolders={() => void refresh()}
          />
        )}
      </div>
    </main>
  )
}
