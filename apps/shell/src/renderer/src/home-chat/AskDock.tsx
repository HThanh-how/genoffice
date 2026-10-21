import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Lang } from '@genoffice/i18n'
import type { HomeApi } from '../../../shared/home-api'
import { requestChatPrefill } from '../chat-events'
import { langFor, parseIndexCommand, runIndexCommand } from '../fork/index-assistant'
import { chatString } from './strings'
import {
  HOME_SEARCH_EVENT,
  canAutofocusDock,
  dockSearchQuery,
  showDockExtra,
  pickSuggestions,
  showIndexChip,
  type HomeSearchDetail,
  type IndexBrief,
} from './dock-logic'

const EN = {
  placeholder: 'Find a file, ask AI, or give an order…',
  send: 'Send',
  enterHint: 'Enter to ask AI · results are below',
  askAbout: 'Ask AI about “{q}”',
  run: 'Run: “{q}”',
  runHint: 'Enter · runs here, no AI quota',
  failed: 'Could not do it: {e}',
  status: 'Index {p}% · {w} waiting · {e} problems',
  statusIdle: 'Index up to date · {e} problems',
  statusOpen: 'Ask how far indexing is',
  close: 'Close',
  suggestions: ['Find my recent files', 'How far is indexing?', 'Retry the errors'],
}
type Words = typeof EN
const WORDS: Record<string, Words> = {
  en: EN,
  vi: {
    placeholder: 'Tìm tệp, hỏi AI hoặc ra lệnh…',
    send: 'Gửi',
    enterHint: 'Enter để hỏi AI · kết quả tìm ở bên dưới',
    askAbout: 'Hỏi AI về “{q}”',
    run: 'Chạy: “{q}”',
    runHint: 'Enter · chạy ngay trên máy, không tốn quota AI',
    failed: 'Không làm được: {e}',
    status: 'Index {p}% · {w} đang chờ · {e} lỗi',
    statusIdle: 'Index đã cập nhật · {e} lỗi',
    statusOpen: 'Hỏi index tới đâu rồi',
    close: 'Đóng',
    suggestions: ['Tìm tệp gần đây của tôi', 'Index tới đâu rồi?', 'Thử lại các lỗi'],
  },
  zh: {
    ...EN,
    placeholder: '查找文件、问 AI 或下达指令…',
    send: '发送',
    askAbout: '向 AI 询问“{q}”',
  },
}
const fill = (text: string, values: Record<string, string | number>): string =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''))

/**
 * The one box of the Home page. Typing finds files by name at once and says what state each is
 * in (read, scanned and unread, failed) with a one-click fix; Enter hands the question to the Ask AI
 * page, or carries out an index order ("pause", "rescan") right here. It is always in the page flow,
 * never hidden or moved. `children` is the model and usage strip.
 */
export function AskDock({
  lang,
  api,
  children,
}: {
  lang: string
  api: HomeApi
  children?: ReactNode
}) {
  const w = WORDS[lang] ?? EN
  const [focused, setFocused] = useState(false)
  const [text, setText] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [commandBusy, setCommandBusy] = useState(false)
  const [brief, setBrief] = useState<IndexBrief | null>(null)
  const [briefTick, setBriefTick] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const composingRef = useRef(false)
  const commandBusyRef = useRef(false)
  const commandGenerationRef = useRef(0)
  const mountedRef = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const query = text.trim()
  const command = query ? parseIndexCommand(query) : null
  const searchQuery = dockSearchQuery(text, !!command)
  const searchPushed = useRef(false)
  const working = chatString(lang as Lang, 'homeChatWorking')

  useEffect(() => {
    const generationCounter = commandGenerationRef
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      generationCounter.current++
    }
  }, [])
  const focusInput = useCallback(() => {
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }, [])

  // Ready to type on arrival at Home, unless a dialog, another field or a selection has the user.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (canAutofocusDock(document)) inputRef.current?.focus({ preventScroll: true })
    }, 60)
    return () => window.clearTimeout(timer)
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
      focusInput()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [focusInput])

  // Close the popover on a click elsewhere.
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setAnswer(null)
        setFocused(false)
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [])

  // The index in one line, read on arrival and whenever the box is focused again.
  useEffect(() => {
    if (query || !api.getIndexingActivity) return
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
  }, [api, focused, query, briefTick])

  // While indexing, the chip follows the progress.
  const indexActive = !!brief?.active
  useEffect(() => {
    if (!indexActive) return
    const timer = window.setInterval(() => setBriefTick((n) => n + 1), 6000)
    return () => window.clearInterval(timer)
  }, [indexActive])

  // Typing a file query runs the Home search (below this box) as you type; an empty or non-search text ends
  // it. Home owns the results, filters and ranking; this box only sends the words.
  const pushSearch = useCallback((q: string) => {
    if (!q && !searchPushed.current) return
    searchPushed.current = !!q
    const detail: HomeSearchDetail = { q, source: 'dock' }
    window.dispatchEvent(new CustomEvent(HOME_SEARCH_EVENT, { detail }))
  }, [])
  useEffect(() => {
    let timer = 0
    const run = () => {
      if (composingRef.current) {
        timer = window.setTimeout(run, 150)
        return
      }
      pushSearch(searchQuery)
    }
    timer = window.setTimeout(run, searchQuery ? 200 : 0)
    return () => window.clearTimeout(timer)
  }, [searchQuery, pushSearch])
  // Leaving Home ends the search this box started.
  useEffect(() => () => pushSearch(''), [pushSearch])

  const submit = async (value: string) => {
    const message = value.trim()
    if (!message || commandBusyRef.current || !mountedRef.current) return
    const parsed = parseIndexCommand(message)
    if (parsed) {
      commandBusyRef.current = true
      setCommandBusy(true)
      const generation = ++commandGenerationRef.current
      setText('')
      setAnswer(null)
      try {
        const result = await runIndexCommand(api, parsed, langFor(message, lang))
        if (mountedRef.current && generation === commandGenerationRef.current) {
          setAnswer(result)
        }
      } catch (error) {
        if (mountedRef.current && generation === commandGenerationRef.current) {
          setAnswer(fill(w.failed, { e: error instanceof Error ? error.message : '' }))
        }
      } finally {
        commandBusyRef.current = false
        if (mountedRef.current) setCommandBusy(false)
      }
      return
    }
    setText('')
    inputRef.current?.blur()
    requestChatPrefill({ text: message, send: true, intent: 'new' })
  }

  const showChips = !text && !answer && !commandBusy
  const showPop = answer !== null || (focused && query.length > 0)
  return (
    <div
      ref={rootRef}
      className="ask-dock"
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
          event.preventDefault()
          event.stopPropagation()
          setText('')
          setAnswer(null)
          inputRef.current?.blur()
        }
      }}
    >
      <form
        className="ask-form"
        aria-busy={commandBusy}
        onSubmit={(event) => {
          event.preventDefault()
          event.stopPropagation()
          if (!composingRef.current) void submit(text)
        }}
      >
        <input
          ref={inputRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onCompositionEnd={() => {
            composingRef.current = false
          }}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              (event.nativeEvent.isComposing ||
                composingRef.current ||
                event.nativeEvent.keyCode === 229)
            ) {
              event.preventDefault()
            } else if (event.key === 'ArrowDown') {
              const first = rootRef.current?.querySelector<HTMLButtonElement>('.ask-pop button')
              if (first) {
                event.preventDefault()
                first.focus()
              }
            }
          }}
          placeholder={commandBusy ? working : w.placeholder}
          disabled={commandBusy}
          aria-label={w.placeholder}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="submit"
          className="ask-send"
          disabled={commandBusy || !text.trim()}
          aria-label={commandBusy ? working : w.send}
        >
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
      {children && (
        <div className={showDockExtra(!!searchQuery) ? 'ask-extra' : 'ask-extra is-hidden'}>
          {children}
        </div>
      )}
      {commandBusy && (
        <p className="ask-working" role="status">
          {working}
        </p>
      )}
      {showChips && (
        <div className="ask-chips">
          {showIndexChip(brief) && (
            <button
              type="button"
              className="ask-status"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void submit(w.suggestions[1])}
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
          {pickSuggestions(w.suggestions, brief).map((suggestion) => (
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
        <div className="ask-pop" role="group" aria-label={w.placeholder}>
          {answer !== null && (
            <div className="ask-answer" role="status">
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
          {query.length > 0 &&
            (command ? (
              <button type="button" className="ask-act" onClick={() => void submit(query)}>
                <strong>{fill(w.run, { q: query })}</strong>
                <span>{w.runHint}</span>
              </button>
            ) : (
              <>
                <button type="button" className="ask-act" onClick={() => void submit(query)}>
                  <strong>{fill(w.askAbout, { q: query })}</strong>
                </button>
                {searchQuery && <p className="ask-note">{w.enterHint}</p>}
              </>
            ))}
        </div>
      )}
    </div>
  )
}
