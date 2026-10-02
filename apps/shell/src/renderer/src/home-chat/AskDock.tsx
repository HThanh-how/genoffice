import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { requestChatPrefill } from '../chat-events'

const EN = {
  bubble: 'Ask AI here',
  placeholder: 'Ask about your files…',
  send: 'Send',
  open: 'Ask AI',
  suggestions: ['Find my recent files', 'Summarize my latest document', 'How far is indexing?'],
}
type Words = typeof EN
const WORDS: Record<string, Words> = {
  en: EN,
  vi: {
    bubble: 'Hỏi AI tại đây',
    placeholder: 'Hỏi về tài liệu của bạn…',
    send: 'Gửi',
    open: 'Hỏi AI',
    suggestions: ['Tìm tệp gần đây của tôi', 'Tóm tắt tài liệu mới nhất', 'Index tới đâu rồi?'],
  },
  zh: {
    bubble: '在这里问 AI',
    placeholder: '询问你的文件…',
    send: '发送',
    open: '问 AI',
    suggestions: ['查找我最近的文件', '总结我最新的文档', '索引进度如何？'],
  },
}

/** Scrolling this far down tucks the dock away; back near the top it returns. */
const COLLAPSE_AT = 56
const EXPAND_AT = 8

/**
 * The always-there ask box of the Home page. Idle, it floats at the bottom as a translucent bar
 * with a slowly turning light around it; scrolling the page tucks it into a small glowing orb in
 * the corner, and a click (or "/") brings it back. Sending hands the text to the assistant panel.
 * `children` is the model and usage strip, shown under the bar while it is focused.
 */
export function AskDock({ lang, children }: { lang: string; children?: ReactNode }) {
  const w = WORDS[lang] ?? EN
  const [collapsed, setCollapsed] = useState(false)
  const [focused, setFocused] = useState(false)
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const lastTop = useRef(0)

  // Page scroll tucks the dock away (capture: scroll does not bubble). Scrolling inside the
  // dock, the assistant panel or a text field does not count.
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

  // "/" jumps to the box from anywhere on the page that is not already a text field.
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

  const send = (value: string) => {
    const message = value.trim()
    if (!message) return
    setText('')
    inputRef.current?.blur()
    requestChatPrefill({ text: message, send: true, continue: true })
  }

  const showTip = !collapsed && !focused && !text
  const showChips = !collapsed && focused && !text
  return (
    <div
      ref={rootRef}
      className={`ask-dock${collapsed ? ' is-collapsed' : ''}${focused ? ' is-focused' : ''}`}
    >
      {showTip && (
        <div className="ask-tip" aria-hidden="true">
          {w.bubble}
        </div>
      )}
      {showChips && (
        <div className="ask-chips">
          {w.suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => send(suggestion)}
            >
              {suggestion}
            </button>
          ))}
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
            send(text)
          }}
        >
          <input
            ref={inputRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') inputRef.current?.blur()
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
