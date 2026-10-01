import {
  AgentLoop,
  composeSkills,
  createDocumentMemorySkill,
  createIpcTransport,
  type DocumentMemoryHit,
  type IpcStreamChunk,
} from '@genoffice/agent-core'
import { createGeminiRouter } from '@genoffice/ai-provider/browser'
import { Markdown } from '@genoffice/ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { HomeApi } from '../../shared/home-api'
import type { I18n, StringKey } from './locale'
import './home-chat.css'

type ChatItem = {
  id: number
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
  error?: string
  sources?: DocumentMemoryHit[]
}

type Props = { api: HomeApi; i18n: I18n }

/** Floating Home assistant. It intentionally has no layout footprint. */
export function HomeChat({ api, i18n }: Props) {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [items, setItems] = useState<ChatItem[]>([])
  const [busy, setBusy] = useState(false)
  const [invitation, setInvitation] = useState(true)
  const [settingsReady, setSettingsReady] = useState(false)
  const [settingsFailed, setSettingsFailed] = useState(false)
  const [notice, setNotice] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const launcherRef = useRef<HTMLButtonElement>(null)
  const openRef = useRef(false)
  const mountedRef = useRef(false)
  const loopRef = useRef<AgentLoop | null>(null)
  const runGenerationRef = useRef(0)
  const itemId = useRef(0)
  const settingsRef = useRef<Awaited<ReturnType<HomeApi['getAiSettings']>> | null>(null)
  const tRef = useRef(i18n.t)
  const langRef = useRef(i18n.lang)
  tRef.current = i18n.t
  langRef.current = i18n.lang

  const t = (key: StringKey, params?: Parameters<I18n['t']>[1]) => i18n.t(key, params)

  useEffect(() => {
    const timer = window.setTimeout(() => setInvitation(false), 8_000)
    return () => window.clearTimeout(timer)
  }, [])

  const loadSettings = useCallback(async () => {
    try {
      const settings = await api.getAiSettings()
      if (mountedRef.current) {
        settingsRef.current = settings
        setSettingsReady(true)
        setSettingsFailed(false)
      }
      return true
    } catch {
      if (mountedRef.current) {
        setSettingsFailed(true)
        setNotice(tRef.current('homeChatSettingsFailed'))
      }
      return false
    }
  }, [api])

  useEffect(() => {
    mountedRef.current = true
    void loadSettings()
    return () => {
      mountedRef.current = false
    }
  }, [loadSettings])

  if (!loopRef.current) {
    const transport = createIpcTransport({
      route: createGeminiRouter(),
      onStream: (listener) => api.onAiStream(listener as (chunk: IpcStreamChunk) => void),
      start: (request) => api.aiStream(request),
      cancel: (requestId) => void api.aiStreamCancel(requestId),
      getSettings: () => {
        if (!settingsRef.current) throw new Error('AI settings are not ready')
        return settingsRef.current
      },
      unknownErrorText: () => tRef.current('homeChatError'),
      timeoutErrorText: () => tRef.current('homeChatError'),
      creditsErrorText: () => tRef.current('homeChatCredits'),
      networkErrorText: () => tRef.current('homeChatNetwork'),
      overloadedErrorText: () => tRef.current('homeChatBusy'),
    })
    loopRef.current = new AgentLoop({
      transport,
      skill: composeSkills('home+remembered-documents', '', [createDocumentMemorySkill(api)]),
      maxTurns: 12,
      systemSuffix: () => {
        const language: Record<string, string> = {
          vi: 'Vietnamese',
          en: 'English',
          zh: 'Chinese',
          'zh-TW': 'Traditional Chinese',
          ja: 'Japanese',
          ko: 'Korean',
          fr: 'French',
          de: 'German',
          es: 'Spanish',
          th: 'Thai',
          id: 'Indonesian',
          ru: 'Russian',
          ar: 'Arabic',
          pt: 'Portuguese',
          it: 'Italian',
          pl: 'Polish',
          cs: 'Czech',
          nl: 'Dutch',
          ms: 'Malay',
          he: 'Hebrew',
          hi: 'Hindi',
        }
        return `Reply in ${language[langRef.current] ?? 'English'}. This is a home assistant: answer questions and help find files the user has opened before. Use remembered-document tools when relevant. Never guess document contents or source identifiers.`
      },
      events: {
        onText: (text) => {
          setItems((previous) => {
            const next = [...previous]
            const last = next.at(-1)
            if (last?.role === 'assistant')
              next[next.length - 1] = { ...last, text, streaming: true }
            return next
          })
        },
        onToolExecuted: ({ call, execution }) => {
          if (call.name !== 'search_remembered_documents') return
          try {
            const data = JSON.parse(execution.output) as { hits?: DocumentMemoryHit[] }
            const hits = Array.isArray(data.hits)
              ? data.hits.filter(
                  (hit) => Number.isSafeInteger(hit.documentId) && hit.documentId > 0,
                )
              : []
            setItems((previous) => {
              const next = [...previous]
              const last = next.at(-1)
              if (last?.role !== 'assistant') return previous
              const existing = new Map(
                (last.sources ?? []).map((source) => [source.documentId, source]),
              )
              for (const hit of hits) existing.set(hit.documentId, hit)
              next[next.length - 1] = { ...last, sources: [...existing.values()] }
              return next
            })
          } catch {
            // The model still receives the tool output; malformed UI-only citations are ignored.
          }
        },
        onDone: ({ text, cancelled }) => {
          setItems((previous) => {
            const next = [...previous]
            const last = next.at(-1)
            if (last?.role === 'assistant') {
              next[next.length - 1] = {
                ...last,
                text:
                  text ||
                  (cancelled ? tRef.current('homeChatStopped') : tRef.current('homeChatNoReply')),
                streaming: false,
                error: undefined,
              }
            }
            return next
          })
          setBusy(false)
        },
        onError: (error) => {
          setItems((previous) => {
            const next = [...previous]
            const last = next.at(-1)
            if (last?.role === 'assistant')
              next[next.length - 1] = { ...last, error, streaming: false }
            return next
          })
          setBusy(false)
        },
      },
    })
  }

  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [items])

  useEffect(
    () => () => {
      runGenerationRef.current++
      loopRef.current?.cancel()
    },
    [],
  )

  const focusInput = useCallback(() => {
    window.setTimeout(() => {
      if (openRef.current) inputRef.current?.focus()
    }, 0)
  }, [])

  const closePanel = useCallback(() => {
    openRef.current = false
    setOpen(false)
    window.setTimeout(() => launcherRef.current?.focus(), 0)
  }, [])

  const collapsePanel = useCallback(() => {
    openRef.current = false
    setOpen(false)
  }, [])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current
      if (root && event.target instanceof Node && !root.contains(event.target)) {
        // Leave the pointer event alone so the clicked control still receives it.
        // Collapsing is presentation only; an active response keeps running.
        collapsePanel()
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [collapsePanel, open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePanel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closePanel, open])

  const send = useCallback(async () => {
    const message = input.trim()
    const loop = loopRef.current
    if (!message || busy || !settingsReady || !loop) return
    const generation = ++runGenerationRef.current
    const userId = ++itemId.current
    const assistantId = ++itemId.current
    setItems((previous) => [
      ...previous,
      { id: userId, role: 'user', text: message },
      { id: assistantId, role: 'assistant', text: '', streaming: true },
    ])
    setInput('')
    setBusy(true)
    setNotice('')
    const loaded = await loadSettings()
    if (generation !== runGenerationRef.current || !mountedRef.current) return
    if (!loaded) {
      setItems((previous) =>
        previous.map((item) =>
          item.id === assistantId
            ? { ...item, text: '', error: tRef.current('homeChatSettingsFailed'), streaming: false }
            : item,
        ),
      )
      setBusy(false)
      return
    }
    try {
      await loop.run(message)
    } catch (error) {
      const detail = error instanceof Error ? error.message : tRef.current('homeChatError')
      setItems((previous) => {
        const next = [...previous]
        const last = next.at(-1)
        if (last?.role === 'assistant')
          next[next.length - 1] = { ...last, error: detail, streaming: false }
        return next
      })
      setBusy(false)
    }
  }, [busy, input, loadSettings, settingsReady])

  const stop = () => {
    runGenerationRef.current++
    loopRef.current?.cancel()
    setItems((previous) =>
      previous.map((item, index) =>
        index === previous.length - 1 && item.role === 'assistant' && item.streaming
          ? { ...item, text: tRef.current('homeChatStopped'), streaming: false }
          : item,
      ),
    )
    setBusy(false)
  }
  const reset = () => {
    runGenerationRef.current++
    if (busy) loopRef.current?.cancel()
    loopRef.current?.reset()
    setItems([])
    setInput('')
    setBusy(false)
    setNotice('')
    focusInput()
  }

  const openSource = async (source: DocumentMemoryHit) => {
    setNotice('')
    try {
      const result = await api.documentMemoryOpen(source.documentId)
      if (!result.ok) setNotice(result.error || t('homeChatOpenFailed'))
    } catch {
      setNotice(t('homeChatOpenFailed'))
    }
  }

  return (
    <div
      ref={rootRef}
      className="home-chat-root"
      onMouseEnter={() => setInvitation(true)}
      onMouseLeave={() => setInvitation(false)}
    >
      {open && (
        <section
          className="home-chat-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="home-chat-title"
        >
          <header className="home-chat-header">
            <div className="home-chat-heading">
              <span className="home-chat-mark" aria-hidden="true">
                <svg viewBox="0 0 20 20" fill="none">
                  <path
                    d="M10 2.5 11.8 8.2 17.5 10l-5.7 1.8L10 17.5l-1.8-5.7L2.5 10l5.7-1.8L10 2.5Z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <div>
                <h2 id="home-chat-title">{t('homeChatTitle')}</h2>
                <p>{t('homeChatSubtitle')}</p>
              </div>
            </div>
            <div className="home-chat-header-actions">
              <button
                type="button"
                className="home-chat-icon-button"
                aria-label={t('homeChatNew')}
                title={t('homeChatNew')}
                onClick={reset}
              >
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path
                    d="M10 4v12M4 10h12"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                className="home-chat-icon-button"
                aria-label={t('homeChatClose')}
                title={t('homeChatClose')}
                onClick={closePanel}
              >
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path
                    d="m5.5 5.5 9 9m0-9-9 9"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          </header>
          <div
            className="home-chat-messages"
            ref={listRef}
            aria-live="polite"
            aria-relevant="additions text"
          >
            {items.length === 0 ? (
              <div className="home-chat-welcome">
                <span className="home-chat-welcome-mark" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none">
                    <path
                      d="M12 3.25 14.2 9.8l6.55 2.2-6.55 2.2L12 20.75 9.8 14.2l-6.55-2.2L9.8 9.8 12 3.25Z"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <h3>{t('homeChatWelcome')}</h3>
                <p>{t('homeChatWelcomeBody')}</p>
              </div>
            ) : (
              items.map((item) => (
                <article className={`home-chat-message ${item.role}`} key={item.id}>
                  {item.role === 'user' ? (
                    <p>{item.text}</p>
                  ) : (
                    <>
                      <div className="home-chat-answer">
                        <Markdown text={item.text || (item.streaming ? '…' : '')} />
                      </div>
                      {item.error && (
                        <p className="home-chat-error" role="alert">
                          {item.error}
                        </p>
                      )}
                    </>
                  )}
                  {item.sources && item.sources.length > 0 && (
                    <div className="home-chat-sources" aria-label={t('homeChatSources')}>
                      {item.sources.map((source) => (
                        <button
                          type="button"
                          key={source.documentId}
                          className="home-chat-source"
                          onClick={() => void openSource(source)}
                          aria-label={t('homeChatOpenSource', { name: source.name })}
                          title={`${source.name} · ${source.location}`}
                        >
                          <span className="home-chat-file-icon" aria-hidden="true">
                            <svg viewBox="0 0 20 20" fill="none">
                              <path
                                d="M5.25 2.75h6l3.5 3.5v11h-9.5v-14.5Z"
                                stroke="currentColor"
                                strokeWidth="1.4"
                                strokeLinejoin="round"
                              />
                              <path
                                d="M11.25 2.9v3.6h3.45M7.5 10h5M7.5 13h5"
                                stroke="currentColor"
                                strokeWidth="1.4"
                                strokeLinecap="round"
                              />
                            </svg>
                          </span>
                          <span>{source.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </article>
              ))
            )}
            {notice && (
              <p className="home-chat-notice" role="status">
                {notice}
              </p>
            )}
          </div>
          <form
            className="home-chat-composer"
            onSubmit={(event) => {
              event.preventDefault()
              send()
            }}
          >
            <label className="home-chat-sr-only" htmlFor="home-chat-input">
              {t('homeChatInputLabel')}
            </label>
            <textarea
              id="home-chat-input"
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  closePanel()
                }
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  send()
                }
              }}
              onFocus={() => setInvitation(true)}
              onBlur={() => setInvitation(false)}
              placeholder={t('homeChatPlaceholder')}
              disabled={!settingsReady || settingsFailed}
            />
            {busy ? (
              <button
                type="button"
                className="home-chat-send stop"
                onClick={stop}
                aria-label={t('homeChatStop')}
                title={t('homeChatStop')}
              >
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <rect x="5" y="5" width="10" height="10" rx="2" fill="currentColor" />
                </svg>
              </button>
            ) : (
              <button
                type="submit"
                className="home-chat-send"
                disabled={!input.trim() || !settingsReady || settingsFailed}
                aria-label={t('homeChatSend')}
                title={t('homeChatSend')}
              >
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path
                    d="M10 15.75V4.5m0 0L5.5 9m4.5-4.5L14.5 9"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
            <span className="home-chat-hint">
              {settingsFailed
                ? t('homeChatSettingsFailed')
                : settingsReady
                  ? t('homeChatEnterHint')
                  : t('homeChatLoading')}
            </span>
          </form>
        </section>
      )}
      <button
        type="button"
        ref={launcherRef}
        className={`home-chat-launcher${invitation ? ' invitation-visible' : ''}${open ? ' panel-open' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={open ? t('homeChatClose') : t('homeChatLaunch')}
        onFocus={() => setInvitation(true)}
        onBlur={() => setInvitation(false)}
        onClick={() => {
          if (open) closePanel()
          else {
            openRef.current = true
            setOpen(true)
            setInvitation(true)
            focusInput()
            void loadSettings()
          }
        }}
      >
        <span className="home-chat-launch-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none">
            <path
              d="M10 2.5 11.8 8.2 17.5 10l-5.7 1.8L10 17.5l-1.8-5.7L2.5 10l5.7-1.8L10 2.5Z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="home-chat-launch-label">{t('homeChatLaunch')}</span>
      </button>
      {!open && invitation && (
        <span className="home-chat-idle-hint" aria-hidden="true">
          {t('homeChatInvite')}
        </span>
      )}
    </div>
  )
}
