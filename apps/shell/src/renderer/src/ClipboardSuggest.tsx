import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'
import { buildClipboardPrefill, CLIPBOARD_VISIBLE_MS } from '../../shared/clipboard-suggest-api'
import type {
  ClipboardActionId,
  ClipboardKind,
  ClipboardSuggestion,
} from '../../shared/clipboard-suggest-api'
import type { HomeApi } from '../../shared/home-api'
import { CHAT_PANEL_EVENT, requestChatPrefill } from './chat-events'
import type { ChatPanelDetail } from './chat-events'
import type { I18n } from './locale'
import { clipboardString, type ClipboardStringKey } from './fork/clipboard-strings'
import './clipboard-suggest.css'

type Props = { api: HomeApi; i18n: I18n }

const ACTION_LABEL: Record<ClipboardActionId, ClipboardStringKey> = {
  summarize: 'clipActSummarize',
  translate: 'clipActTranslate',
  rewrite: 'clipActRewrite',
  ask: 'clipActAsk',
  findRelated: 'clipActFindRelated',
  analyze: 'clipActAnalyze',
  toSheet: 'clipActToSheet',
  explainCode: 'clipActExplainCode',
  organize: 'clipActOrganize',
}

const ICON_PATHS: Record<ClipboardKind, ReactElement> = {
  url: (
    <>
      <path d="M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.8.8" />
      <path d="M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.8-.8" />
    </>
  ),
  longText: <path d="M2.5 4h11M2.5 7h11M2.5 10h11M2.5 13h6.5" />,
  shortText: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />,
  question: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M6.3 6.3a1.8 1.8 0 1 1 2.5 1.7c-.5.3-.8.6-.8 1.2M8 11.4v.1" />
    </>
  ),
  paths: (
    <path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.7H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
  ),
  table: <path d="M2.5 3.5h11v9h-11zM2.5 7h11M2.5 10h11M6.2 3.5v9M9.8 3.5v9" />,
  contact: (
    <>
      <circle cx="8" cy="6" r="2.4" />
      <path d="M3.2 13c.4-2.2 2.2-3.4 4.8-3.4s4.4 1.2 4.8 3.4" />
    </>
  ),
  code: <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9 3.5l-2 9" />,
}

function KindIcon({ kind }: { kind: ClipboardKind }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[kind]}
    </svg>
  )
}

function languageName(lang: string): string {
  try {
    return new Intl.DisplayNames([lang], { type: 'language' }).of(lang) ?? lang
  } catch {
    return lang
  }
}

/**
 * Calm, dismissible chip offering an AI action for what the user just copied.
 * Nothing is sent anywhere until an action is clicked; the chip never takes
 * focus, hides itself after CLIPBOARD_VISIBLE_MS and pauses while hovered or
 * keyboard-focused.
 */
export function ClipboardSuggest({ api, i18n }: Props) {
  const [suggestion, setSuggestion] = useState<ClipboardSuggestion | null>(null)
  const [paused, setPaused] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const remainingRef = useRef(CLIPBOARD_VISIBLE_MS)
  const startedRef = useRef(0)

  useEffect(() => {
    let alive = true
    void api
      .getClipboardSuggestion?.()
      .then((s) => {
        if (alive && s) setSuggestion(s)
      })
      .catch(() => {})
    const off = api.onClipboardSuggestion?.((s) => {
      if (alive) setSuggestion(s)
    })
    return () => {
      alive = false
      off?.()
    }
  }, [api])

  // The chat panel stacks above the chip; hide the chip while it is open.
  useEffect(() => {
    const onPanel = (event: Event) =>
      setChatOpen((event as CustomEvent<ChatPanelDetail>).detail.open)
    window.addEventListener(CHAT_PANEL_EVENT, onPanel)
    return () => window.removeEventListener(CHAT_PANEL_EVENT, onPanel)
  }, [])

  const id = suggestion?.id
  useEffect(() => {
    remainingRef.current = CLIPBOARD_VISIBLE_MS
    setPaused(false)
  }, [id])

  useEffect(() => {
    if (!id || paused) return
    startedRef.current = Date.now()
    const timer = window.setTimeout(() => setSuggestion(null), remainingRef.current)
    return () => {
      window.clearTimeout(timer)
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedRef.current))
    }
  }, [id, paused])

  if (!suggestion || chatOpen) return null
  const lang = i18n.lang
  const t = (key: ClipboardStringKey, params?: Parameters<typeof clipboardString>[2]) =>
    clipboardString(lang, key, params)
  const labelFor = (action: ClipboardActionId) =>
    t(ACTION_LABEL[action], { lang: languageName(lang) })

  const close = () => {
    setSuggestion(null)
    void api.dismissClipboardSuggestion?.(suggestion.id)?.catch(() => {})
  }

  const run = (action: ClipboardActionId) => {
    const label = labelFor(action)
    void api
      .getClipboardSuggestionText?.(suggestion.id)
      ?.then((text) => {
        if (text) {
          requestChatPrefill({ text: buildClipboardPrefill(action, label, text), send: false })
        }
      })
      .catch(() => {})
      .finally(close)
  }

  const turnOff = () => {
    setSuggestion(null)
    void api.setClipboardSuggestEnabled?.(false)?.catch(() => {})
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
    }
  }

  return (
    <section
      className="clip-suggest"
      role="status"
      aria-live="polite"
      aria-label={t('clipRegion')}
      onKeyDown={onKeyDown}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false)
      }}
    >
      <header className="clip-suggest-head">
        <span className="clip-suggest-icon">
          <KindIcon kind={suggestion.kind} />
        </span>
        <span className="clip-suggest-title">{t('clipHeader')}</span>
        <button
          type="button"
          className="clip-suggest-close"
          aria-label={t('clipDismiss')}
          title={t('clipDismiss')}
          onClick={close}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M4 4l8 8M12 4l-8 8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </header>
      <p className="clip-suggest-preview" dir="auto">
        {suggestion.preview}
      </p>
      {suggestion.truncated && <p className="clip-suggest-note">{t('clipTruncated')}</p>}
      <div className="clip-suggest-actions">
        {suggestion.actions.map((action, index) => (
          <button
            key={action}
            type="button"
            className={index === 0 ? 'clip-suggest-action primary' : 'clip-suggest-action'}
            onClick={() => run(action)}
          >
            {labelFor(action)}
          </button>
        ))}
        <button type="button" className="clip-suggest-off" onClick={turnOff}>
          {t('clipTurnOff')}
        </button>
      </div>
      <span
        key={suggestion.id}
        className="clip-suggest-timer"
        style={{
          animationDuration: `${CLIPBOARD_VISIBLE_MS}ms`,
          animationPlayState: paused ? 'paused' : 'running',
        }}
        aria-hidden="true"
      />
    </section>
  )
}
