import {
  AgentLoop,
  composeSkills,
  createDocumentMemorySkill,
  createIpcTransport,
  type DocumentMemoryHit,
  type IpcStreamChunk,
} from '@genoffice/agent-core'
import { createGeminiRouter } from '@genoffice/ai-provider/browser'
import type { Params } from '@genoffice/i18n'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { HomeApi } from '../../shared/home-api'
import type {
  HomeChatMessage,
  HomeChatSession,
  HomeChatSessionSummary,
  HomeChatSource,
} from '../../shared/fork/home-chat-types'
import { CHAT_PREFILL_EVENT, announceChatPanel, type ChatPrefillDetail } from './chat-events'
import { ChatMessage, type ChatItem, type ChatLabels } from './home-chat/ChatMessage'
import { AgyChatBar } from '@genoffice/ui'
import { AskDock } from './home-chat/AskDock'
import './ask-dock.css'
import {
  INDEX_DIRECTIVE_PROMPT,
  extractIndexDirectives,
  indexFacts,
  langFor,
  mentionsIndex,
  parseIndexCommand,
  runIndexCommand,
} from './fork/index-assistant'
import { Composer, type ComposerLabels } from './home-chat/Composer'
import { EmptyState } from './home-chat/EmptyState'
import { HistoryRail, type HistoryLabels } from './home-chat/HistoryRail'
import { Launcher, type LauncherLabels } from './home-chat/Launcher'
import {
  IDLE_STATE,
  createLauncherController,
  finishOf,
  type LauncherController,
  type LauncherState,
} from './home-chat/launcher-status'
import {
  agySystemSuffix,
  buildRetrievalContext,
  buildRetrievalQuery,
  hitsToSources,
  type RetrievalContext,
} from './home-chat/agy-retrieval'
import { translateChat, type ChatKey } from './home-chat/translate'
import {
  WINDOW_PAGE,
  createFrameBatcher,
  isNearBottom,
  toSeedMessages,
  windowMessages,
} from './home-chat/utils'
import type { I18n } from './locale'
import './home-chat.css'

type Props = { api: HomeApi; i18n: I18n }

type Conversation = { id: string | null; dead: boolean; requested: boolean }
type Toast = { kind: 'deleted'; session: HomeChatSession } | { kind: 'cleared' }

const LS_LAST = 'genoffice.homeChat.last'
const LS_SIZE = 'genoffice.homeChat.size'
const LS_RAIL = 'genoffice.homeChat.rail'
const MIN_W = 460
const MIN_H = 380
const NARROW = 640
const SAVE_INTERVAL_MS = 1500

const readStore = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}
const writeStore = (key: string, value: string | null) => {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // storage can be unavailable; the chat still works without remembering UI state
  }
}

const clampSize = (w: number, h: number) => ({
  w: Math.round(Math.max(MIN_W, Math.min(w, window.innerWidth - 32))),
  h: Math.round(Math.max(MIN_H, Math.min(h, window.innerHeight - 96))),
})
const readSize = () => {
  try {
    const raw = JSON.parse(readStore(LS_SIZE) ?? 'null') as { w?: unknown; h?: unknown } | null
    if (raw && typeof raw.w === 'number' && typeof raw.h === 'number')
      return clampSize(raw.w, raw.h)
  } catch {
    // fall through to the default
  }
  return clampSize(880, 660)
}

const toMessages = (items: readonly ChatItem[]): HomeChatMessage[] =>
  items
    .filter((item) => item.text || item.error)
    .map((item) => {
      const message: HomeChatMessage = { role: item.role, text: item.text }
      if (item.sources?.length) message.sources = item.sources
      if (item.error) message.error = item.error
      return message
    })

const LANGUAGE_NAMES: Record<string, string> = {
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

const rafSchedule = (run: () => void) => {
  const id = window.requestAnimationFrame(run)
  return () => window.cancelAnimationFrame(id)
}

/** Floating Home assistant with a persistent history rail. It has no layout footprint. */
export function HomeChat({ api: homeApi, i18n }: Props) {
  const api = homeApi
  const [open, setOpen] = useState(false)
  useEffect(() => {
    announceChatPanel(open)
    return () => announceChatPanel(false)
  }, [open])
  const [input, setInput] = useState('')
  const [items, setItems] = useState<ChatItem[]>([])
  const [busy, setBusy] = useState(false)
  const [invitation, setInvitation] = useState(true)
  const [settingsReady, setSettingsReady] = useState(false)
  const [settingsFailed, setSettingsFailed] = useState(false)
  const [notice, setNotice] = useState('')
  const [sessions, setSessions] = useState<HomeChatSessionSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [railOpen, setRailOpen] = useState(() => readStore(LS_RAIL) !== '0')
  const [size, setSize] = useState(readSize)
  const [toast, setToast] = useState<Toast | null>(null)
  const [visibleCount, setVisibleCount] = useState(WINDOW_PAGE)
  const [showJump, setShowJump] = useState(false)
  const [pendingSend, setPendingSend] = useState<string | null>(null)
  const [launcherState, setLauncherState] = useState<LauncherState>(IDLE_STATE)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const launcherRef = useRef<HTMLButtonElement>(null)
  const openRef = useRef(false)
  const mountedRef = useRef(false)
  const loopRef = useRef<AgentLoop | null>(null)
  const runGenerationRef = useRef(0)
  const activeRunRef = useRef(0)
  const itemId = useRef(0)
  const itemsRef = useRef<ChatItem[]>([])
  const busyRef = useRef(false)
  const stickRef = useRef(true)
  const prependHeightRef = useRef<number | null>(null)
  const needsSeedRef = useRef(false)
  const convRef = useRef<Conversation>({ id: null, dead: false, requested: false })
  const lastSavedRef = useRef<ChatItem[] | null>(null)
  const saveTimerRef = useRef(0)
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve())
  const openTokenRef = useRef(0)
  const initRef = useRef(false)
  const touchedRef = useRef(false)
  const toastTimerRef = useRef(0)
  /** minimize is presentation only: the scroll spot to come back to when the panel reopens */
  const scrollMemoRef = useRef<{ top: number; stick: boolean } | null>(null)
  const restoreTopRef = useRef<number | null>(null)
  const resizingRef = useRef(false)
  const stoppedRef = useRef(false)
  const prevBusyRef = useRef(false)
  const launcherCtlRef = useRef<LauncherController | null>(null)
  if (!launcherCtlRef.current) launcherCtlRef.current = createLauncherController(setLauncherState)
  const launcherCtl = launcherCtlRef.current
  const settingsRef = useRef<Awaited<ReturnType<HomeApi['getAiSettings']>> | null>(null)
  /** retrieval-first context for the current turn when the provider cannot call tools (agy) */
  const agyContextRef = useRef<RetrievalContext | null>(null)
  const tRef = useRef<(key: ChatKey, params?: Params) => string>(() => '')
  const langRef = useRef(i18n.lang)
  tRef.current = (key, params) => translateChat(i18n, key, params)
  langRef.current = i18n.lang
  itemsRef.current = items
  busyRef.current = busy

  const t = (key: ChatKey, params?: Params) => translateChat(i18n, key, params)

  // Memoized per language (never on `t`, which is not referentially stable) so the
  // memoized ChatMessage / history rail props stay equal between renders.
  const labels = useMemo<{ chat: ChatLabels; history: HistoryLabels }>(() => {
    const tr = (key: ChatKey, params?: Params) => tRef.current(key, params)
    return {
      chat: {
        loading: tr('homeChatLoading'),
        retry: tr('homeChatRetry'),
        sources: tr('homeChatSources'),
        openSource: (name) => tr('homeChatOpenSource', { name }),
        sourceMissing: tr('homeChatSourceMissing'),
        sourceStale: tr('homeChatSourceStale'),
        sourceMissingHint: tr('homeChatSourceMissingHint'),
        sourceStaleHint: tr('homeChatSourceStaleHint'),
        copy: tr('homeChatCopy'),
        copied: tr('homeChatCopied'),
      },
      history: {
        history: tr('homeChatHistory'),
        newChat: tr('homeChatNew'),
        search: tr('homeChatSearch'),
        noHistory: tr('homeChatNoHistory'),
        noMatches: (query) => tr('homeChatNoMatches', { q: query }),
        groups: {
          today: tr('homeChatGroupToday'),
          yesterday: tr('homeChatGroupYesterday'),
          week: tr('homeChatGroupWeek'),
          older: tr('homeChatGroupOlder'),
        },
        rename: tr('homeChatRename'),
        renameLabel: tr('homeChatRenameLabel'),
        remove: tr('homeChatDelete'),
        clearAll: tr('homeChatClearAll'),
        clearConfirm: tr('homeChatClearConfirm'),
      },
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i18n.lang])

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

  const refreshList = useCallback(async () => {
    try {
      const list = await api.homeChatList()
      if (mountedRef.current) setSessions(list)
      return list
    } catch {
      return [] as HomeChatSessionSummary[]
    }
  }, [api])

  const upsertSummary = useCallback((summary: HomeChatSessionSummary) => {
    setSessions((previous) =>
      [summary, ...previous.filter((entry) => entry.id !== summary.id)].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      ),
    )
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void loadSettings()
    void refreshList()
    return () => {
      mountedRef.current = false
    }
  }, [loadSettings, refreshList])

  // Streamed tokens arrive far faster than the screen refreshes; apply at most one
  // update per animation frame and only to the streaming message.
  const batcherRef = useRef<ReturnType<typeof createFrameBatcher<string>> | null>(null)
  if (!batcherRef.current) {
    batcherRef.current = createFrameBatcher<string>((text) => {
      setItems((previous) => {
        const last = previous.at(-1)
        if (last?.role !== 'assistant' || !last.streaming || last.text === text) return previous
        const next = previous.slice()
        next[next.length - 1] = { ...last, text }
        return next
      })
    }, rafSchedule)
  }

  const updateLastAssistant = (patch: (last: ChatItem) => ChatItem) => {
    setItems((previous) => {
      const last = previous.at(-1)
      if (last?.role !== 'assistant') return previous
      const next = previous.slice()
      next[next.length - 1] = patch(last)
      return next
    })
  }

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
    // Events from a run that was stopped or replaced (conversation switch) are ignored.
    const live = () =>
      activeRunRef.current !== 0 && activeRunRef.current === runGenerationRef.current
    loopRef.current = new AgentLoop({
      transport,
      skill: composeSkills('home+remembered-documents', '', [createDocumentMemorySkill(api)]),
      maxTurns: 12,
      systemSuffix: () =>
        agyContextRef.current
          ? agySystemSuffix(LANGUAGE_NAMES[langRef.current] ?? 'English', agyContextRef.current)
          : `Reply in ${LANGUAGE_NAMES[langRef.current] ?? 'English'}. This is a home assistant: answer questions and help find files the user has opened before. Use remembered-document tools when relevant. Never guess document contents or source identifiers.`,
      events: {
        onText: (text) => {
          if (live()) batcherRef.current?.push(text)
        },
        onToolExecuted: ({ call, execution }) => {
          if (!live() || call.name !== 'search_remembered_documents') return
          try {
            const data = JSON.parse(execution.output) as { hits?: DocumentMemoryHit[] }
            const hits = Array.isArray(data.hits)
              ? data.hits.filter(
                  (hit) => Number.isSafeInteger(hit.documentId) && hit.documentId > 0,
                )
              : []
            updateLastAssistant((last) => {
              const existing = new Map(
                (last.sources ?? []).map((source) => [source.documentId, source]),
              )
              for (const hit of hits) {
                // stale / missing are optional flags added by the document-memory backend
                const flags = hit as { stale?: boolean; missing?: boolean }
                const source: HomeChatSource = {
                  documentId: hit.documentId,
                  name: hit.name,
                  location: hit.location,
                }
                if (flags.stale === true) source.stale = true
                if (flags.missing === true) source.missing = true
                existing.set(hit.documentId, source)
              }
              return { ...last, sources: [...existing.values()] }
            })
          } catch {
            // The model still receives the tool output; malformed UI-only citations are ignored.
          }
        },
        onDone: ({ text, cancelled }) => {
          if (!live()) return
          batcherRef.current?.cancel()
          updateLastAssistant((last) => {
            const finalText = text || last.text
            return {
              ...last,
              text: finalText,
              streaming: false,
              error: finalText
                ? undefined
                : cancelled
                  ? tRef.current('homeChatStopped')
                  : tRef.current('homeChatNoReply'),
            }
          })
          setBusy(false)
        },
        onError: (error) => {
          if (!live()) return
          batcherRef.current?.cancel()
          updateLastAssistant((last) => ({ ...last, error, streaming: false }))
          setBusy(false)
        },
      },
    })
  }

  // ---- persistence --------------------------------------------------------

  const saveConversation = useCallback(
    (conv: Conversation, snapshot: readonly ChatItem[]) => {
      const messages = toMessages(snapshot)
      if (messages.length === 0) return
      // Serialized: the first save must return the generated id before the next one runs.
      saveChainRef.current = saveChainRef.current.then(async () => {
        if (conv.dead) return
        try {
          const summary = await api.homeChatSave({
            ...(conv.id ? { id: conv.id } : {}),
            messages,
          })
          if (!summary || conv.dead) return
          conv.id = summary.id
          if (convRef.current === conv && mountedRef.current) {
            setActiveId(summary.id)
            setTitle(summary.title)
            writeStore(LS_LAST, summary.id)
          }
          if (mountedRef.current) upsertSummary(summary)
        } catch {
          // History is a convenience; a failed save must never interrupt the conversation.
        }
      })
    },
    [api, upsertSummary],
  )

  useEffect(() => {
    if (items.length === 0 || items === lastSavedRef.current) return
    const streaming = items.some((item) => item.streaming)
    const run = () => {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = 0
      lastSavedRef.current = itemsRef.current
      convRef.current.requested = true
      saveConversation(convRef.current, itemsRef.current)
    }
    // the first save of a chat is immediate so it shows in the rail at once
    if (!streaming || !convRef.current.requested) run()
    else if (!saveTimerRef.current) saveTimerRef.current = window.setTimeout(run, SAVE_INTERVAL_MS)
  }, [items, saveConversation])

  useEffect(
    () => () => {
      window.clearTimeout(saveTimerRef.current)
      batcherRef.current?.cancel()
      runGenerationRef.current++
      loopRef.current?.reset()
      if (itemsRef.current.length > 0 && itemsRef.current !== lastSavedRef.current)
        saveConversation(convRef.current, itemsRef.current)
    },
    [saveConversation],
  )

  // ---- scrolling ----------------------------------------------------------

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    stickRef.current = true
    setShowJump(false)
  }, [])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (restoreTopRef.current !== null) {
      el.scrollTop = restoreTopRef.current
      restoreTopRef.current = null
    } else if (prependHeightRef.current !== null) {
      // "Show earlier messages" grew the list above; keep the reading position.
      el.scrollTop += el.scrollHeight - prependHeightRef.current
      prependHeightRef.current = null
    } else if (stickRef.current) el.scrollTop = el.scrollHeight
  }, [items, visibleCount, open])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const near = isNearBottom(el)
    stickRef.current = near
    setShowJump((previous) => (previous === !near ? previous : !near))
  }

  // ---- panel chrome -------------------------------------------------------

  const focusInput = useCallback(() => {
    window.setTimeout(() => {
      if (openRef.current) inputRef.current?.focus()
    }, 0)
  }, [])

  /**
   * Minimize (the panel is never destroyed, only hidden): the conversation, draft and any
   * running reply live in this component. Focus goes back to the launcher unless the user
   * clicked somewhere else on purpose.
   */
  const closePanel = useCallback((restoreFocus = true) => {
    const el = scrollRef.current
    if (el) scrollMemoRef.current = { top: el.scrollTop, stick: stickRef.current }
    openRef.current = false
    setOpen(false)
    if (restoreFocus) window.setTimeout(() => launcherRef.current?.focus(), 0)
  }, [])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) closePanel()
    }
    // A press outside the assistant minimizes it. Not while the resize handle is being
    // dragged, and not on the launcher or the clipboard chip, which have their own jobs.
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || resizingRef.current) return
      const path = event.composedPath()
      if (rootRef.current && path.includes(rootRef.current)) return
      if (
        path.some((node) => node instanceof HTMLElement && node.classList.contains('clip-suggest'))
      )
        return
      closePanel(false)
    }
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [closePanel, open])

  // Launcher status: the controller owns the working / answer-ready / error chip.
  useEffect(() => {
    launcherCtl.setPanelOpen(open)
    if (!open) return
    const onFocus = () => launcherCtl.acknowledge()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [launcherCtl, open])
  useEffect(() => {
    if (busy && !prevBusyRef.current) {
      stoppedRef.current = false
      launcherCtl.runStarted()
    } else if (!busy && prevBusyRef.current) {
      launcherCtl.runFinished(finishOf(itemsRef.current.at(-1), stoppedRef.current))
      stoppedRef.current = false
    }
    prevBusyRef.current = busy
  }, [busy, launcherCtl])
  useEffect(() => () => launcherCtl.dispose(), [launcherCtl])

  useEffect(() => {
    const onResize = () => setSize((previous) => clampSize(previous.w, previous.h))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const toggleRail = () => {
    setRailOpen((previous) => {
      writeStore(LS_RAIL, previous ? '0' : '1')
      return !previous
    })
  }
  const collapseRailWhenNarrow = () => {
    if ((panelRef.current?.clientWidth ?? NARROW) < NARROW) setRailOpen(false)
  }

  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startY = event.clientY
    const start = size
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    resizingRef.current = true
    let latest = start
    const move = (e: PointerEvent) => {
      // the panel is anchored bottom-right, so dragging up/left grows it
      latest = clampSize(start.w + (startX - e.clientX), start.h + (startY - e.clientY))
      setSize(latest)
    }
    const end = () => {
      resizingRef.current = false
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', end)
      target.removeEventListener('pointercancel', end)
      writeStore(LS_SIZE, JSON.stringify(latest))
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', end)
    target.addEventListener('pointercancel', end)
  }
  const onResizeKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 96 : 32
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    }
    const d = delta[event.key]
    if (!d) return
    event.preventDefault()
    const next = clampSize(size.w + d[0], size.h + d[1])
    setSize(next)
    writeStore(LS_SIZE, JSON.stringify(next))
  }

  // ---- conversation lifecycle --------------------------------------------

  const stopStreamingItems = (previous: ChatItem[]): ChatItem[] =>
    previous.map((item, index) =>
      index === previous.length - 1 && item.role === 'assistant' && item.streaming
        ? {
            ...item,
            streaming: false,
            error: item.text ? undefined : tRef.current('homeChatStopped'),
          }
        : item,
    )

  /** Ends any in-flight run and keeps what has streamed so far. */
  const detachCurrent = () => {
    window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = 0
    runGenerationRef.current++
    batcherRef.current?.cancel()
    loopRef.current?.reset()
    needsSeedRef.current = true
    if (busyRef.current) {
      const settled = stopStreamingItems(itemsRef.current)
      lastSavedRef.current = settled
      saveConversation(convRef.current, settled)
    }
    setBusy(false)
  }

  const adopt = (conv: Conversation, nextItems: ChatItem[], nextTitle: string) => {
    convRef.current = conv
    itemId.current = nextItems.length
    lastSavedRef.current = nextItems
    stickRef.current = true
    scrollMemoRef.current = null
    restoreTopRef.current = null
    setItems(nextItems)
    setActiveId(conv.id)
    setTitle(nextTitle)
    setInput('')
    setNotice('')
    setVisibleCount(WINDOW_PAGE)
    setShowJump(false)
    writeStore(LS_LAST, conv.id)
  }

  const startNew = useCallback(() => {
    touchedRef.current = true
    openTokenRef.current++
    detachCurrent()
    adopt({ id: null, dead: false, requested: false }, [], '')
    collapseRailWhenNarrow()
    focusInput()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusInput])

  const openSession = useCallback(
    async (id: string) => {
      touchedRef.current = true
      if (id === convRef.current.id) {
        collapseRailWhenNarrow()
        focusInput()
        return
      }
      const token = ++openTokenRef.current
      detachCurrent()
      let session: HomeChatSession | null
      try {
        session = await api.homeChatGet(id)
      } catch {
        session = null
      }
      if (token !== openTokenRef.current || !mountedRef.current) return
      if (!session) {
        setNotice(tRef.current('homeChatLoadFailed'))
        void refreshList()
        return
      }
      const restored: ChatItem[] = session.messages.map((message, index) => ({
        id: index + 1,
        role: message.role,
        text: message.text,
        ...(message.sources ? { sources: message.sources } : {}),
        ...(message.error ? { error: message.error } : {}),
      }))
      if (restored.at(-1)?.role === 'user') {
        restored.push({
          id: restored.length + 1,
          role: 'assistant',
          text: '',
          error: tRef.current('homeChatInterrupted'),
        })
      }
      adopt({ id: session.id, dead: false, requested: true }, restored, session.title)
      collapseRailWhenNarrow()
      focusInput()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, focusInput, refreshList],
  )

  const showToast = (next: Toast) => {
    window.clearTimeout(toastTimerRef.current)
    setToast(next)
    toastTimerRef.current = window.setTimeout(() => setToast(null), 7_000)
  }
  useEffect(() => () => window.clearTimeout(toastTimerRef.current), [])

  const deleteSession = async (id: string) => {
    if (id === convRef.current.id) {
      convRef.current.dead = true
      startNew()
    }
    let full: HomeChatSession | null
    try {
      full = await api.homeChatGet(id)
    } catch {
      full = null
    }
    setSessions((previous) => previous.filter((entry) => entry.id !== id))
    try {
      await api.homeChatDelete(id)
    } catch {
      void refreshList()
      return
    }
    if (full) showToast({ kind: 'deleted', session: full })
  }

  const undoDelete = async (session: HomeChatSession) => {
    setToast(null)
    try {
      const summary = await api.homeChatSave({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messages: session.messages,
      })
      if (summary) {
        upsertSummary(summary)
        await openSession(summary.id)
      }
    } catch {
      void refreshList()
    }
  }

  const renameSession = async (id: string, next: string) => {
    try {
      const summary = await api.homeChatRename(id, next)
      if (!summary) return
      upsertSummary(summary)
      if (id === convRef.current.id) setTitle(summary.title)
    } catch {
      void refreshList()
    }
  }

  const clearHistory = async () => {
    convRef.current.dead = true
    startNew()
    setSessions([])
    try {
      await api.homeChatClear()
    } catch {
      void refreshList()
    }
    showToast({ kind: 'cleared' })
  }

  // First open: bring back the chat that was open last.
  const restoreLast = useCallback(async () => {
    if (initRef.current) return
    initRef.current = true
    const list = await refreshList()
    if (touchedRef.current || itemsRef.current.length > 0) return
    const last = readStore(LS_LAST)
    if (last && list.some((entry) => entry.id === last)) await openSession(last)
  }, [openSession, refreshList])

  const openPanel = useCallback(() => {
    openRef.current = true
    // Reopening from the "answer ready" chip lands on the latest message; a plain
    // restore returns to where the user was reading.
    const memo = scrollMemoRef.current
    const resume = memo && !memo.stick && !launcherCtl.getState().unread
    stickRef.current = !resume
    restoreTopRef.current = resume ? memo.top : null
    setOpen(true)
    setInvitation(true)
    focusInput()
    void loadSettings()
    void restoreLast()
  }, [focusInput, launcherCtl, loadSettings, restoreLast])

  // ---- sending ------------------------------------------------------------

  const submit = useCallback(
    async (raw: string, base: ChatItem[] = itemsRef.current) => {
      const message = raw.trim()
      const loop = loopRef.current
      if (!message || busyRef.current || !settingsReady || !loop) return
      touchedRef.current = true
      // "index tới đâu rồi?", "tạm dừng index"… are answered and done on this computer, no model call.
      const indexCommand = mentionsIndex(message) ? parseIndexCommand(message) : null
      if (indexCommand) {
        const userId = ++itemId.current
        const assistantId = ++itemId.current
        stickRef.current = true
        needsSeedRef.current = true
        setItems([
          ...base,
          { id: userId, role: 'user', text: message },
          { id: assistantId, role: 'assistant', text: '', streaming: true },
        ])
        setInput('')
        const answer = await runIndexCommand(api, indexCommand, langFor(message, langRef.current))
        if (!mountedRef.current) return
        setItems((current) =>
          current.map((item) =>
            item.id === assistantId ? { ...item, text: answer, streaming: false } : item,
          ),
        )
        return
      }
      if (needsSeedRef.current) {
        // New conversation, restored chat or a stopped run: rebuild the model context
        // from the visible text turns (no tool-call blocks are ever persisted).
        loop.reset()
        loop.restore(toSeedMessages(toMessages(base)))
        needsSeedRef.current = false
      }
      const generation = ++runGenerationRef.current
      activeRunRef.current = generation
      const userId = ++itemId.current
      const assistantId = ++itemId.current
      stickRef.current = true
      busyRef.current = true
      setItems([
        ...base,
        { id: userId, role: 'user', text: message },
        { id: assistantId, role: 'assistant', text: '', streaming: true },
      ])
      setInput('')
      setBusy(true)
      setNotice('')
      const loaded = await loadSettings()
      if (generation !== runGenerationRef.current || !mountedRef.current) return
      if (!loaded) {
        updateLastAssistant((last) => ({
          ...last,
          text: '',
          error: tRef.current('homeChatSettingsFailed'),
          streaming: false,
        }))
        setBusy(false)
        return
      }
      agyContextRef.current = null
      try {
        if (settingsRef.current?.provider === 'agy') {
          // agy cannot call GenOffice tools: search remembered documents first and inject the hits.
          let hits: Awaited<ReturnType<HomeApi['documentMemorySearch']>>['hits'] = []
          try {
            const query = buildRetrievalQuery(message, toMessages(base))
            hits = (await api.documentMemorySearch(query, 8)).hits
          } catch {
            // search is best-effort; the answer then says nothing matched
          }
          if (generation !== runGenerationRef.current || !mountedRef.current) return
          const context = buildRetrievalContext(hits)
          if (mentionsIndex(message)) {
            // Live index facts and the means to act on the index (the model cannot call tools here).
            const facts = await indexFacts(api, langFor(message, langRef.current)).catch(() => '')
            if (facts)
              context.block = `${context.block}\n\n<<<INDEX\n${facts}\nINDEX>>>\n${INDEX_DIRECTIVE_PROMPT}`
          }
          agyContextRef.current = context
          const sources = hitsToSources(context.used)
          if (sources.length > 0) updateLastAssistant((last) => ({ ...last, sources }))
        }
        await loop.run(message)
        if (mentionsIndex(message) && settingsRef.current?.provider === 'agy') {
          batcherRef.current?.flush()
          const reply = itemsRef.current.at(-1)
          if (reply?.role === 'assistant') {
            const { text, commands } = extractIndexDirectives(reply.text)
            if (commands.length > 0) {
              const outcomes: string[] = []
              for (const command of commands)
                outcomes.push(
                  await runIndexCommand(api, command, langFor(message, langRef.current)),
                )
              if (mountedRef.current)
                updateLastAssistant((last) => ({
                  ...last,
                  text: [text, ...outcomes].filter(Boolean).join('\n\n'),
                }))
            }
          }
        }
      } catch (error) {
        if (generation !== runGenerationRef.current) return
        const detail = error instanceof Error ? error.message : tRef.current('homeChatError')
        updateLastAssistant((last) => ({ ...last, error: detail, streaming: false }))
        setBusy(false)
      }
    },
    [api, loadSettings, settingsReady],
  )
  const submitRef = useRef(submit)
  submitRef.current = submit

  const stop = () => {
    stoppedRef.current = true
    runGenerationRef.current++
    batcherRef.current?.flush()
    loopRef.current?.reset()
    needsSeedRef.current = true
    setItems(stopStreamingItems)
    setBusy(false)
  }

  const retry = useCallback(() => {
    const current = itemsRef.current
    let at = current.length - 1
    while (at >= 0 && current[at]!.role !== 'user') at -= 1
    if (at < 0) return
    needsSeedRef.current = true
    void submitRef.current(current[at]!.text, current.slice(0, at))
  }, [])

  const openSource = useCallback(
    async (source: HomeChatSource) => {
      setNotice('')
      try {
        const result = await api.documentMemoryOpen(source.documentId)
        if (!result.ok) setNotice(result.error || tRef.current('homeChatOpenFailed'))
      } catch {
        setNotice(tRef.current('homeChatOpenFailed'))
      }
    },
    [api],
  )

  // Another part of the app (clipboard suggestions) can hand the assistant some text.
  const openPanelRef = useRef(openPanel)
  openPanelRef.current = openPanel
  const startNewRef = useRef(startNew)
  startNewRef.current = startNew
  useEffect(() => {
    const onPrefill = (event: Event) => {
      const detail = (event as CustomEvent<ChatPrefillDetail>).detail
      if (!detail || typeof detail.text !== 'string' || !detail.text.trim()) return
      touchedRef.current = true
      openPanelRef.current()
      if (itemsRef.current.length > 0 && detail.continue !== true) startNewRef.current()
      setInput(detail.text)
      setPendingSend(detail.send === true ? detail.text : null)
      window.setTimeout(() => inputRef.current?.focus(), 30)
    }
    window.addEventListener(CHAT_PREFILL_EVENT, onPrefill)
    return () => window.removeEventListener(CHAT_PREFILL_EVENT, onPrefill)
  }, [])
  useEffect(() => {
    if (pendingSend === null || !settingsReady || busy) return
    setPendingSend(null)
    void submitRef.current(pendingSend)
  }, [busy, pendingSend, settingsReady])

  // ---- render -------------------------------------------------------------

  const { shown, hidden } = windowMessages(items, visibleCount)
  const lastIndex = items.length - 1
  const composerDisabled = !settingsReady || settingsFailed
  const composerLabels = useMemo<ComposerLabels>(
    () => ({
      input: tRef.current('homeChatInputLabel'),
      placeholder: tRef.current('homeChatPlaceholder'),
      send: tRef.current('homeChatSend'),
      stop: tRef.current('homeChatStop'),
      hint: settingsFailed
        ? tRef.current('homeChatSettingsFailed')
        : settingsReady
          ? tRef.current('homeChatEnterHint')
          : tRef.current('homeChatLoading'),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [i18n.lang, settingsFailed, settingsReady],
  )
  const suggestions = useMemo(
    () =>
      (['homeChatSuggest1', 'homeChatSuggest2', 'homeChatSuggest3'] as const).map((key) =>
        tRef.current(key),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [i18n.lang],
  )
  const stopRef = useRef(stop)
  stopRef.current = stop
  const handleSend = useCallback((text: string) => void submitRef.current(text), [])
  const handleStop = useCallback(() => stopRef.current(), [])
  const heading = title || t('homeChatNew')
  const lastItem = items.at(-1)
  const launcherLabels: LauncherLabels = {
    launch: t('homeChatLaunch'),
    close: t('homeChatClose'),
    invite: t('homeChatInvite'),
    working: t('homeChatWorking'),
    done: t('homeChatDone'),
    error: t('homeChatErrorChip'),
    stop: t('homeChatStopChip'),
    elapsed: (n) => t('homeChatElapsed', { n }),
  }

  const showEarlier = () => {
    prependHeightRef.current = scrollRef.current?.scrollHeight ?? null
    setVisibleCount((count) => count + WINDOW_PAGE)
  }

  return (
    <div ref={rootRef} className="home-chat-root">
      {open && (
        <section
          ref={panelRef}
          className={`home-chat-panel${railOpen ? ' rail-open' : ''}`}
          style={{ '--hc-w': `${size.w}px`, '--hc-h': `${size.h}px` } as React.CSSProperties}
          role="dialog"
          aria-modal="false"
          aria-label={t('homeChatTitle')}
        >
          <div
            className="hc-resize"
            role="separator"
            tabIndex={0}
            aria-label={t('homeChatResize')}
            onPointerDown={onResizeStart}
            onKeyDown={onResizeKey}
          />
          {railOpen && (
            <div className="hc-rail-wrap">
              <header className="hc-brand">
                <span className="hc-mark" aria-hidden="true">
                  <svg viewBox="0 0 20 20" fill="none">
                    <path
                      d="M10 2.5 11.8 8.2 17.5 10l-5.7 1.8L10 17.5l-1.8-5.7L2.5 10l5.7-1.8L10 2.5Z"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <h2>{t('homeChatTitle')}</h2>
              </header>
              <HistoryRail
                sessions={sessions}
                activeId={activeId}
                locale={i18n.dateLocale}
                labels={labels.history}
                onOpen={(id) => void openSession(id)}
                onNew={startNew}
                onRename={(id, next) => void renameSession(id, next)}
                onDelete={(id) => void deleteSession(id)}
                onClear={() => void clearHistory()}
              />
            </div>
          )}
          <div className="hc-main">
            <header className="hc-header">
              <button
                type="button"
                className="hc-icon-button"
                aria-label={t('homeChatToggleHistory')}
                title={t('homeChatToggleHistory')}
                aria-pressed={railOpen}
                onClick={toggleRail}
              >
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <rect
                    x="3"
                    y="4"
                    width="14"
                    height="12"
                    rx="2.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                  <path d="M8 4.5v11" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </button>
              <h3 className="hc-title" title={heading}>
                {heading}
              </h3>
              <button
                type="button"
                className="hc-icon-button"
                aria-label={t('homeChatNew')}
                title={t('homeChatNew')}
                onClick={startNew}
              >
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path
                    d="M10 4.5v11M4.5 10h11"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                className="hc-icon-button"
                aria-label={t('homeChatClose')}
                title={t('homeChatClose')}
                onClick={() => closePanel()}
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
            </header>
            <div className="hc-stage">
              <div
                className="hc-scroll"
                ref={scrollRef}
                onScroll={onScroll}
                role="log"
                aria-live={busy ? 'off' : 'polite'}
                aria-relevant="additions"
              >
                {items.length === 0 ? (
                  <EmptyState
                    title={t('homeChatWelcome')}
                    body={t('homeChatWelcomeBody')}
                    suggestions={suggestions}
                    disabled={composerDisabled}
                    onPick={handleSend}
                  />
                ) : (
                  <div className="hc-thread">
                    {hidden > 0 && (
                      <button type="button" className="hc-earlier" onClick={showEarlier}>
                        {t('homeChatShowEarlier', { n: hidden })}
                      </button>
                    )}
                    {shown.map((item) => (
                      <ChatMessage
                        key={item.id}
                        item={item}
                        labels={labels.chat}
                        canRetry={!busy && item.id === items[lastIndex]?.id}
                        onOpenSource={openSource}
                        onRetry={retry}
                      />
                    ))}
                    {busy && <AgyChatBar lang={i18n.lang} part="steps" />}
                  </div>
                )}
              </div>
              {showJump && items.length > 0 && (
                <button type="button" className="hc-jump" onClick={scrollToBottom}>
                  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path
                      d="M10 4.5v10m0 0-4-4m4 4 4-4"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {t('homeChatJumpLatest')}
                </button>
              )}
            </div>
            {(notice || toast) && (
              <div className="hc-status" role="status">
                {toast ? (
                  <p className="hc-toast">
                    <span>
                      {toast.kind === 'deleted' ? t('homeChatDeleted') : t('homeChatCleared')}
                    </span>
                    {toast.kind === 'deleted' && (
                      <button
                        type="button"
                        className="hc-text-button strong"
                        onClick={() => void undoDelete(toast.session)}
                      >
                        {t('homeChatUndo')}
                      </button>
                    )}
                  </p>
                ) : (
                  <p className="hc-notice">{notice}</p>
                )}
              </div>
            )}
            <Composer
              value={input}
              busy={busy}
              disabled={composerDisabled}
              labels={composerLabels}
              inputRef={inputRef}
              onChange={setInput}
              onSend={handleSend}
              onStop={handleStop}
            />
            <div className="hc-agy">
              <AgyChatBar lang={i18n.lang} part="bar" />
            </div>
          </div>
        </section>
      )}
      <AskDock lang={i18n.lang} api={api} away={open || launcherState.phase !== 'idle'}>
        <AgyChatBar lang={i18n.lang} part="bar" />
      </AskDock>
      {(open || launcherState.phase !== 'idle') && (
        <Launcher
          state={launcherState}
          open={open}
          invitation={invitation}
          starting={
            lastItem?.role === 'assistant' && lastItem.streaming && !lastItem.text
              ? (lastItem.status ?? '')
              : ''
          }
          labels={launcherLabels}
          buttonRef={launcherRef}
          onToggle={() => (open ? closePanel() : openPanel())}
          onStop={handleStop}
          onInvitation={setInvitation}
          onHold={launcherCtl.setHovered}
        />
      )}
    </div>
  )
}
