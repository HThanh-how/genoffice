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
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const launcherRef = useRef<HTMLButtonElement>(null)
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
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }, [])

  const closePanel = useCallback(() => {
    setOpen(false)
    window.setTimeout(() => launcherRef.current?.focus(), 0)
  }, [])

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
                ✦
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
                ＋
              </button>
              <button
                type="button"
                className="home-chat-icon-button"
                aria-label={t('homeChatClose')}
                title={t('homeChatClose')}
                onClick={closePanel}
              >
                ×
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
                  ✦
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
                          <span aria-hidden="true">▤</span>
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
                ■
              </button>
            ) : (
              <button
                type="submit"
                className="home-chat-send"
                disabled={!input.trim() || !settingsReady || settingsFailed}
                aria-label={t('homeChatSend')}
                title={t('homeChatSend')}
              >
                ↑
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
            setOpen(true)
            setInvitation(true)
            focusInput()
            void loadSettings()
          }
        }}
      >
        <span className="home-chat-launch-icon" aria-hidden="true">
          ✦
        </span>
        <span className="home-chat-launch-label">{t('homeChatLaunch')}</span>
        <span className="home-chat-invitation">{t('homeChatInvite')}</span>
      </button>
    </div>
  )
}
