import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Lang } from '@genoffice/i18n'
import type { HomeApi } from '../../../shared/home-api'
import type { IndexedFileHit } from '../../../shared/fork/document-index-api'
import { requestChatPrefill } from '../chat-events'
import { iconFor } from '../file-icons'
import { activityCopy } from '../indexing-activity-copy'
import { OPEN_INDEX_EVENT } from '../IndexingActivity'
import { langFor, parseIndexCommand, runIndexCommand } from '../fork/index-assistant'
import { findFilesByName, type NamedFile } from '../fork/file-name-search'

const EN = {
  bubble: 'Ask or find here',
  placeholder: 'Find a file, ask AI, or give an order…',
  send: 'Send',
  open: 'Ask AI',
  enterHint: 'Enter to ask AI',
  notIndexed: 'Not read yet',
  run: 'Run: “{q}”',
  runHint: 'Enter · runs here, no AI quota',
  indexed: 'Indexed',
  unread: 'Content not read yet (scanned)',
  retry: 'Try again',
  readNow: 'Read with Antigravity now',
  readConfirm:
    'Read this scanned PDF now with Antigravity? It uses Antigravity quota and ignores today’s limit.',
  readDone: 'Read {n} pages. It is searchable shortly.',
  failed: 'Could not do it: {e}',
  queued: 'Queued for another try.',
  status: 'Index {p}% · {w} waiting · {e} problems',
  statusIdle: 'Index up to date · {e} problems',
  statusOpen: 'Open the index page',
  close: 'Close',
  suggestions: ['Find my recent files', 'How far is indexing?', 'Retry the errors'],
}
type Words = typeof EN
const WORDS: Record<string, Words> = {
  en: EN,
  vi: {
    bubble: 'Hỏi hoặc tìm tệp tại đây',
    placeholder: 'Tìm tệp, hỏi AI hoặc ra lệnh…',
    send: 'Gửi',
    open: 'Hỏi AI',
    enterHint: 'Enter để hỏi AI',
    notIndexed: 'Chưa đọc nội dung',
    run: 'Chạy: “{q}”',
    runHint: 'Enter · chạy ngay trên máy, không tốn quota AI',
    indexed: 'Đã index',
    unread: 'Chưa đọc nội dung (PDF quét)',
    retry: 'Thử lại',
    readNow: 'Đọc bằng Antigravity ngay',
    readConfirm:
      'Đọc ngay tệp PDF quét này bằng Antigravity? Sẽ tốn quota Antigravity và bỏ qua giới hạn hôm nay.',
    readDone: 'Đã đọc {n} trang. Lát nữa là tìm được.',
    failed: 'Không làm được: {e}',
    queued: 'Đã xếp lại để thử lần nữa.',
    status: 'Index {p}% · {w} đang chờ · {e} lỗi',
    statusIdle: 'Index đã cập nhật · {e} lỗi',
    statusOpen: 'Mở trang Chỉ mục',
    close: 'Đóng',
    suggestions: ['Tìm tệp gần đây của tôi', 'Index tới đâu rồi?', 'Thử lại các lỗi'],
  },
  zh: {
    ...EN,
    bubble: '在这里提问或查找',
    placeholder: '查找文件、问 AI 或下达指令…',
    open: '问 AI',
    send: '发送',
  },
}
const fill = (text: string, values: Record<string, string | number>): string =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''))

/** Scrolling this far down tucks the dock away; back near the top it returns. */
const COLLAPSE_AT = 56
const EXPAND_AT = 8

interface Brief {
  percent: number | null
  waiting: number
  errors: number
  active: boolean
}

/**
 * The one box of the Home page. Typing finds files by name at once and says what state each is
 * in (read, scanned and unread, failed) with a one-click fix; Enter asks the AI, or carries out
 * an index order ("pause", "rescan"). Idle it is a translucent bar with a slowly turning light;
 * scrolling the page tucks it into an orb. `children` is the model and usage strip.
 */
export function AskDock({
  lang,
  api,
  away = false,
  children,
}: {
  lang: string
  api: HomeApi
  /** the assistant panel is showing: the dock fades out instead of vanishing */
  away?: boolean
  children?: ReactNode
}) {
  const w = WORDS[lang] ?? EN
  const copy = activityCopy(lang as Lang)
  const [collapsed, setCollapsed] = useState(false)
  const [focused, setFocused] = useState(false)
  const [text, setText] = useState('')
  const [hits, setHits] = useState<IndexedFileHit[] | null>(null)
  const [named, setNamed] = useState<NamedFile[]>([])
  const [answer, setAnswer] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [brief, setBrief] = useState<Brief | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const lastTop = useRef(0)
  const query = text.trim()
  const command = query ? parseIndexCommand(query) : null

  // Page scroll tucks the dock away (capture: scroll does not bubble).
  useEffect(() => {
    const onScroll = (event: Event) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (target.closest('.ask-dock, .home-chat-panel, textarea, input')) return
      const top = target.scrollTop
      const goingDown = top > lastTop.current
      lastTop.current = top
      if (top <= EXPAND_AT) setCollapsed(false)
      else if (goingDown && top > COLLAPSE_AT) setCollapsed(true)
    }
    document.addEventListener('scroll', onScroll, true)
    return () => document.removeEventListener('scroll', onScroll, true)
  }, [])

  const expand = useCallback(() => {
    setCollapsed(false)
    window.setTimeout(() => inputRef.current?.focus(), 60)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const el = document.activeElement
      if (
        el instanceof HTMLElement &&
        (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
      )
        return
      event.preventDefault()
      expand()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [expand])

  // Close the popover on a click elsewhere.
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setAnswer(null)
        setHits(null)
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [])

  // The index in one line, read when the box is focused.
  useEffect(() => {
    if (!focused || query || !api.getIndexingActivity) return
    let alive = true
    void api
      .getIndexingActivity()
      .then((a) => {
        if (!alive) return
        setBrief({
          percent: a.folderProgress?.percent ?? null,
          waiting: a.folderProgress?.pendingFiles ?? a.memory.pending,
          errors:
            (a.folderProgress?.errorFiles ?? a.memory.errors) + (a.folderProgress?.emptyFiles ?? 0),
          active: !!a.folder?.running || a.memory.pending > 0,
        })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [api, focused, query])

  // Typing finds files by name right away (a command is offered too, never run by itself).
  useEffect(() => {
    if (query.length < 2 || !api.searchIndexedFiles) {
      setHits(null)
      setNamed([])
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      void api
        .searchIndexedFiles(query)
        .then((found) => alive && setHits(found.slice(0, 6)))
        .catch(() => alive && setHits([]))
      void findFilesByName(api, query, 6)
        .then((files) => alive && setNamed(files))
        .catch(() => alive && setNamed([]))
    }, 180)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [api, query])

  const submit = async (value: string) => {
    const message = value.trim()
    if (!message) return
    const parsed = parseIndexCommand(message)
    if (parsed) {
      setText('')
      setHits(null)
      setAnswer(await runIndexCommand(api, parsed, langFor(message, lang)))
      return
    }
    setText('')
    setHits(null)
    inputRef.current?.blur()
    requestChatPrefill({ text: message, send: true, continue: true })
  }

  const refreshHits = async () => {
    if (query.length >= 2) setHits((await api.searchIndexedFiles(query)).slice(0, 6))
  }
  const retry = async (hit: IndexedFileHit) => {
    setBusyId(hit.id)
    try {
      const result = await api.retryDocumentIndex(hit.id)
      setAnswer(result.ok ? w.queued : fill(w.failed, { e: result.error ?? '' }))
      await refreshHits()
    } finally {
      setBusyId(null)
    }
  }
  const readNow = async (hit: IndexedFileHit) => {
    if (!window.confirm(w.readConfirm)) return
    setBusyId(hit.id)
    try {
      const result = await api.readScannedPdfWithAgy(hit.id, true)
      setAnswer(
        result.ok
          ? fill(w.readDone, { n: result.pages ?? 0 })
          : fill(w.failed, { e: result.error ?? '' }),
      )
      await refreshHits()
    } catch (error) {
      setAnswer(fill(w.failed, { e: error instanceof Error ? error.message : '' }))
    } finally {
      setBusyId(null)
    }
  }

  const showTip = !collapsed && !focused && !text && !answer
  const showChips = !collapsed && focused && !text && !answer
  const showPop = !collapsed && (answer !== null || query.length > 0)
  return (
    <div
      ref={rootRef}
      className={`ask-dock${collapsed ? ' is-collapsed' : ''}${focused ? ' is-focused' : ''}${away ? ' is-away' : ''}`}
      inert={away}
    >
      {showTip && (
        <div className="ask-tip" aria-hidden="true">
          {w.bubble}
        </div>
      )}
      {showChips && (
        <div className="ask-chips">
          {brief?.active && (
            <button
              type="button"
              className="ask-status"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => window.dispatchEvent(new Event(OPEN_INDEX_EVENT))}
              title={w.statusOpen}
            >
              <i className={brief.active ? 'is-busy' : ''} aria-hidden="true" />
              {brief.active
                ? fill(w.status, {
                    p: brief.percent ?? 0,
                    w: brief.waiting.toLocaleString(),
                    e: brief.errors.toLocaleString(),
                  })
                : fill(w.statusIdle, { e: brief.errors.toLocaleString() })}
            </button>
          )}
          {w.suggestions.slice(0, 2).map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void submit(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
      {showPop && (
        <div className="ask-pop" role="listbox" aria-label={w.placeholder} aria-live="polite">
          {answer !== null && (
            <div className="ask-answer">
              <p>{answer}</p>
              <button
                type="button"
                aria-label={w.close}
                title={w.close}
                onClick={() => setAnswer(null)}
              >
                ×
              </button>
            </div>
          )}
          {query.length > 0 && (
            <>
              {hits?.map((hit) => {
                const queued = hit.reason === 'waiting'
                const unread = hit.reason === 'no-text' || queued
                const problem = !!hit.reason && !unread
                const tag = problem
                  ? (copy.reasons[hit.reason!]?.title ?? hit.error ?? '')
                  : unread
                    ? queued
                      ? copy.reasons.waiting.title
                      : w.unread
                    : w.indexed
                return (
                  <div className="ask-hit" key={hit.id}>
                    <button
                      type="button"
                      className="ask-hit-main"
                      title={hit.path}
                      onClick={() => void api.openPath(hit.path)}
                    >
                      <img src={iconFor(hit.name)} alt="" width="16" height="16" />
                      <span className="ask-hit-name">{hit.name}</span>
                      <span className={`ask-tag${problem ? ' is-bad' : unread ? ' is-warn' : ''}`}>
                        {tag}
                      </span>
                    </button>
                    {hit.reason === 'no-text' && (
                      <button
                        type="button"
                        className="ask-mini"
                        title={w.readNow}
                        aria-label={w.readNow}
                        disabled={busyId === hit.id}
                        onClick={() => void readNow(hit)}
                      >
                        ✦
                      </button>
                    )}
                    {(problem || queued) && (
                      <button
                        type="button"
                        className="ask-mini"
                        title={w.retry}
                        aria-label={w.retry}
                        disabled={busyId === hit.id}
                        onClick={() => void retry(hit)}
                      >
                        ↻
                      </button>
                    )}
                  </div>
                )
              })}
              {named
                .filter((file) => !hits?.some((hit) => hit.path === file.path))
                .map((file) => (
                  <div className="ask-hit" key={file.path}>
                    <button
                      type="button"
                      className="ask-hit-main"
                      title={file.path}
                      onClick={() => void api.openPath(file.path)}
                    >
                      <img src={iconFor(file.name)} alt="" width="16" height="16" />
                      <span className="ask-hit-name">{file.name}</span>
                      <span className="ask-tag is-warn">{w.notIndexed}</span>
                    </button>
                  </div>
                ))}
              {command ? (
                <button type="button" className="ask-act" onClick={() => void submit(query)}>
                  <strong>{fill(w.run, { q: query })}</strong>
                  <span>{w.runHint}</span>
                </button>
              ) : (
                <p className="ask-note">{w.enterHint}</p>
              )}
            </>
          )}
        </div>
      )}
      <div className="ask-bar">
        <span className="ask-glow" aria-hidden="true" />
        <span className="ask-ring" aria-hidden="true" />
        <button
          type="button"
          className="ask-orb"
          aria-label={w.open}
          title={w.open}
          tabIndex={collapsed ? 0 : -1}
          onClick={expand}
        >
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              d="M10 2.5 11.8 8.2 17.5 10l-5.7 1.8L10 17.5l-1.8-5.7L2.5 10l5.7-1.8L10 2.5Z"
              fill="currentColor"
            />
          </svg>
        </button>
        <form
          className="ask-form"
          onSubmit={(event) => {
            event.preventDefault()
            void submit(text)
          }}
        >
          <input
            ref={inputRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setText('')
                setAnswer(null)
                inputRef.current?.blur()
              }
            }}
            placeholder={w.placeholder}
            aria-label={w.placeholder}
            tabIndex={collapsed ? -1 : 0}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" className="ask-send" disabled={!text.trim()} aria-label={w.send}>
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                d="M10 15.5v-11m0 0-4.5 4.5M10 4.5l4.5 4.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </form>
      </div>
      {!collapsed && focused && children && <div className="ask-extra">{children}</div>}
    </div>
  )
}
