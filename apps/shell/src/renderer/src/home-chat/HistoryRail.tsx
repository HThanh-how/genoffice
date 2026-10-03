import { useEffect, useMemo, useRef, useState } from 'react'
import type { HomeChatSessionSummary } from '../../../shared/fork/home-chat-types'
import { groupSessions, relativeTime, type SessionGroupKey } from './utils'

export type HistoryLabels = {
  history: string
  newChat: string
  search: string
  noHistory: string
  noMatches: (query: string) => string
  groups: Record<SessionGroupKey, string>
  rename: string
  renameLabel: string
  remove: string
  clearAll: string
  clearConfirm: string
}

type Props = {
  sessions: HomeChatSessionSummary[]
  activeId: string | null
  locale: string
  labels: HistoryLabels
  onOpen: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onClear: () => void
}

/** Grouped, searchable chat history. Arrow keys move between chats, F2 renames, Delete removes. */
export function HistoryRail({
  sessions,
  activeId,
  locale,
  labels,
  onOpen,
  onNew,
  onRename,
  onDelete,
  onClear,
}: Props) {
  const [query, setQuery] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const cancelRenameRef = useRef(false)
  // grouping depends on the calendar day; the list re-buckets once a minute
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!confirmClear) return
    const timer = window.setTimeout(() => setConfirmClear(false), 4_000)
    return () => window.clearTimeout(timer)
  }, [confirmClear])

  const groups = useMemo(() => groupSessions(sessions, now, query), [sessions, now, query])

  const rows = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button.hc-row-main') ?? [])
  const moveFocus = (from: HTMLElement | null, delta: number) => {
    const all = rows()
    const at = from ? all.indexOf(from as HTMLButtonElement) : -1
    all[Math.max(0, Math.min(all.length - 1, at + delta))]?.focus()
  }

  const startRename = (session: HomeChatSessionSummary) => {
    cancelRenameRef.current = false
    setRenamingId(session.id)
    setDraft(session.title)
  }
  const commitRename = () => {
    const id = renamingId
    setRenamingId(null)
    if (cancelRenameRef.current) return
    cancelRenameRef.current = true
    if (id && draft.trim()) onRename(id, draft.trim())
  }
  const removeSession = (id: string, from: HTMLElement) => {
    const all = rows()
    const main = from.closest('li')?.querySelector<HTMLButtonElement>('button.hc-row-main')
    const at = main ? all.indexOf(main) : -1
    ;(all[at + 1] ?? all[at - 1])?.focus()
    onDelete(id)
  }

  return (
    <nav className="hc-rail" aria-label={labels.history}>
      <button type="button" className="hc-new" onClick={onNew}>
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M10 4.5v11M4.5 10h11"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </svg>
        <span>{labels.newChat}</span>
      </button>
      {sessions.length > 0 && (
        <div className="hc-search">
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="9" cy="9" r="5" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="m13 13 3.5 3.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <input
            type="search"
            value={query}
            placeholder={labels.search}
            aria-label={labels.search}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                rows()[0]?.focus()
              } else if (event.key === 'Escape' && query) {
                event.preventDefault()
                event.stopPropagation()
                setQuery('')
              }
            }}
          />
        </div>
      )}
      <div
        className="hc-groups"
        ref={listRef}
        onKeyDown={(event) => {
          if (event.target instanceof HTMLInputElement) return
          if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault()
            const all = rows()
            ;(event.key === 'Home' ? all[0] : all.at(-1))?.focus()
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            moveFocus(
              (event.target as HTMLElement).closest('li')?.querySelector('button.hc-row-main') ??
                null,
              event.key === 'ArrowDown' ? 1 : -1,
            )
          }
        }}
      >
        {groups.length === 0 && (
          <p className="hc-rail-empty">
            {sessions.length === 0 ? labels.noHistory : labels.noMatches(query.trim())}
          </p>
        )}
        {groups.map((group) => (
          <section key={group.key} className="hc-group">
            <h3>{labels.groups[group.key]}</h3>
            <ul>
              {group.items.map((session) => (
                <li key={session.id} className={session.id === activeId ? 'active' : undefined}>
                  {renamingId === session.id ? (
                    <input
                      className="hc-rename"
                      value={draft}
                      maxLength={80}
                      autoFocus
                      aria-label={labels.renameLabel}
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) => setDraft(event.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(event) => {
                        if (
                          event.key === 'Enter' &&
                          !event.nativeEvent.isComposing &&
                          event.nativeEvent.keyCode !== 229
                        ) {
                          event.preventDefault()
                          commitRename()
                        } else if (event.key === 'Escape') {
                          event.preventDefault()
                          event.stopPropagation()
                          cancelRenameRef.current = true
                          setRenamingId(null)
                        }
                      }}
                    />
                  ) : (
                    <>
                      <button
                        type="button"
                        className="hc-row-main"
                        aria-current={session.id === activeId ? 'true' : undefined}
                        onClick={() => onOpen(session.id)}
                        onKeyDown={(event) => {
                          if (event.key === 'F2') {
                            event.preventDefault()
                            startRename(session)
                          } else if (event.key === 'Delete') {
                            event.preventDefault()
                            removeSession(session.id, event.currentTarget)
                          }
                        }}
                        title={session.title}
                      >
                        <span className="hc-row-title">{session.title}</span>
                        <time
                          className="hc-row-time"
                          dateTime={new Date(session.updatedAt).toISOString()}
                        >
                          {relativeTime(session.updatedAt, now, locale)}
                        </time>
                      </button>
                      <span className="hc-row-actions">
                        <button
                          type="button"
                          aria-label={`${labels.rename}: ${session.title}`}
                          title={labels.rename}
                          onClick={() => startRename(session)}
                        >
                          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                            <path
                              d="m12.5 4.5 3 3L7 16H4v-3l8.5-8.5Z"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                        <button
                          type="button"
                          aria-label={`${labels.remove}: ${session.title}`}
                          title={labels.remove}
                          onClick={(event) => removeSession(session.id, event.currentTarget)}
                        >
                          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                            <path
                              d="M4.5 6h11M8 6V4.5h4V6m-6 0 .6 9.5h6.8L14 6"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                      </span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {sessions.length > 0 && (
        <button
          type="button"
          className={`hc-clear${confirmClear ? ' armed' : ''}`}
          onClick={() => {
            if (confirmClear) {
              setConfirmClear(false)
              onClear()
            } else setConfirmClear(true)
          }}
        >
          {confirmClear ? labels.clearConfirm : labels.clearAll}
        </button>
      )}
    </nav>
  )
}
