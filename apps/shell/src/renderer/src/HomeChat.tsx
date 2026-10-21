import {
  AgentLoop,
  composeSkills,
  createDocumentMemorySkill,
  createDocumentSkill,
  createIpcTransport,
  createKnowledgeBaseSkill,
  type CreateDocumentExecutionContext,
  type IpcStreamChunk,
  type KbFileInfo,
} from '@genoffice/agent-core'
import { agyErrorText, createGeminiRouter } from '@genoffice/ai-provider/browser'
import { createPortal } from 'react-dom'
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
import { HomeChatRunManager, type SessionRunStatus } from './home-chat/run-manager'
import type { HomeApi } from '../../shared/home-api'
import type {
  HomeChatMessage,
  HomeChatSession,
  HomeChatSessionSummary,
  HomeChatSource,
} from '../../shared/fork/home-chat-types'
import {
  CHAT_PREFILL_EVENT,
  announceChatPanel,
  type ChatPrefillDetail,
  type ChatLaunchIntent,
} from './chat-events'
import { ChatMessage, type ChatItem, type ChatLabels } from './home-chat/ChatMessage'
import { AgyChatBar, AiModelPicker, type AiModelPickerBridge } from '@genoffice/ui'
import '@genoffice/ui/ai-model-picker.css'
import { AskDock } from './home-chat/AskDock'
import { findFilesByName } from './fork/file-name-search'
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

import {
  agySystemSuffix,
  buildRetrievalContext,
  buildRetrievalQuery,
  namedFilesBlock,
  type RetrievalContext,
} from './home-chat/agy-retrieval'
import {
  FILE_CITATION_RULES_TOOLS,
  FileRefTable,
  pickSources,
  plainAnswer,
  refBridge,
  type PickedSources,
} from './home-chat/file-refs'
import { translateChat, type ChatKey } from './home-chat/translate'
import {
  WINDOW_PAGE,
  createFrameBatcher,
  fileNameVariants,
  fileNamesIn,
  isNearBottom,
  toSeedMessages,
  windowMessages,
} from './home-chat/utils'
import type { I18n } from './locale'
import './home-chat.css'
import { fitChatPanel } from './home-chat/panel-size'

type Props = {
  api: HomeApi
  i18n: I18n
  dockLocation?: 'home' | 'floating'
  workspaceActive?: boolean
  suppressDock?: boolean
  onNavigateToRecents?: () => void
  onOpenPath?: (path: string) => boolean | Promise<boolean> | void
  isOpenPath?: (path: string) => boolean | Promise<boolean>
  onOpenAskWorkspace?: () => void
  onOpenModelSettings?: () => void
}

type Conversation = {
  id: string | null
  executionId?: string
  dead: boolean
  requested: boolean
}
type Toast = { kind: 'deleted'; session: HomeChatSession } | { kind: 'cleared' }

const LS_LAST = 'genoffice.homeChat.last'
const LS_SIZE = 'genoffice.homeChat.size'
const LS_RAIL = 'genoffice.homeChat.rail'
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

const clampSize = (w: number, h: number) =>
  fitChatPanel(w, h, window.innerWidth, window.innerHeight)
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
export function HomeChat({
  api: homeApi,
  i18n,
  dockLocation = 'home',
  workspaceActive,
  suppressDock = false,
  onNavigateToRecents,
  onOpenPath,
  isOpenPath,
  onOpenAskWorkspace,
  onOpenModelSettings,
}: Props) {
  const api = homeApi
  const modelBridge = useMemo<AiModelPickerBridge>(
    () => ({
      getSettings: () => api.getAiSettings(),
      setSettings: (settings) => api.setAiSettings(settings),
      onSettingsChanged: (handler) => api.onAiSettingsChanged(handler),
      openModelSettings: onOpenModelSettings,
    }),
    [api, onOpenModelSettings],
  )
  const isWorkspace = workspaceActive
  const [open, setOpen] = useState(false)
  const [dockTarget, setDockTarget] = useState<HTMLElement | null>(null)
  const [workspaceTarget, setWorkspaceTarget] = useState<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const target = isWorkspace ? document.getElementById('home-ask-workspace') : null
    setWorkspaceTarget((previous) => (previous === target ? previous : target))
  }, [isWorkspace])

  useLayoutEffect(() => {
    const target =
      dockLocation === 'home' && typeof document !== 'undefined'
        ? document.getElementById('home-assistant-slot')
        : null
    setDockTarget((previous) => (previous === target ? previous : target))
  })

  const panelVisible = Boolean(isWorkspace || (workspaceActive === undefined && open))

  useEffect(() => {
    announceChatPanel(panelVisible)
    return () => announceChatPanel(false)
  }, [panelVisible])
  const [input, setInput] = useState('')
  const [items, setItems] = useState<ChatItem[]>([])
  const [busy, setBusy] = useState(false)
  const [settingsReady, setSettingsReady] = useState(false)
  const [settingsFailed, setSettingsFailed] = useState(false)
  const [notice, setNotice] = useState('')
  const [sessions, setSessions] = useState<HomeChatSessionSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string>(() => crypto.randomUUID())
  const activeSessionIdRef = useRef<string>(activeSessionId)
  activeSessionIdRef.current = activeSessionId
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null)
  const activeRequestIdRef = useRef<string | null>(null)
  const clearActiveRequest = () => {
    activeRequestIdRef.current = null
    setActiveRequestId(null)
  }
  const [title, setTitle] = useState('')
  const [railOpen, setRailOpen] = useState(() => readStore(LS_RAIL) !== '0')
  const [size, setSize] = useState(readSize)
  const [toast, setToast] = useState<Toast | null>(null)
  const [visibleCount, setVisibleCount] = useState(WINDOW_PAGE)
  const [showJump, setShowJump] = useState(false)
  const [pendingSend, setPendingSend] = useState<string | null>(null)
  const currentUserTurnIdRef = useRef<string>('')
  const openedSlotsRef = useRef<Set<string>>(new Set())
  const openedPathsRef = useRef<Set<string>>(new Set())
  const openStatesRef = useRef<Map<string, 'opening' | 'opened' | 'failed'>>(new Map())
  const inFlightOpenRef = useRef<Map<string, Promise<boolean>>>(new Map())
  const panelRef = useRef<HTMLElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
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
  const convRef = useRef<Conversation>({
    id: null,
    executionId: activeSessionId,
    dead: false,
    requested: false,
  })
  const lastSavedRef = useRef<ChatItem[] | null>(null)
  const saveTimerRef = useRef(0)
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve())
  const openTokenRef = useRef(0)
  const launchTokenRef = useRef(0)
  const initRef = useRef(false)
  const touchedRef = useRef(false)
  const toastTimerRef = useRef(0)
  /** minimize is presentation only: the scroll spot to come back to when the panel reopens */
  const scrollMemoRef = useRef<{ top: number; stick: boolean } | null>(null)
  const restoreTopRef = useRef<number | null>(null)
  const resizingRef = useRef(false)
  const stoppedRef = useRef(false)
  const settingsRef = useRef<Awaited<ReturnType<HomeApi['getAiSettings']>> | null>(null)
  /** the files the model has been given ids for; per turn for agy, per conversation otherwise */
  const toolTableRef = useRef<FileRefTable | null>(null)
  if (!toolTableRef.current) toolTableRef.current = new FileRefTable()
  const savingKeysRef = useRef(new Set<string>())
  /** the table of the running (or last) turn: the conversation's for tool providers, a fresh one for agy */
  const fileTableRef = useRef<FileRefTable>(toolTableRef.current)
  /** first id handed out in the running turn: only these are offered as "related" */
  const turnStartRef = useRef(1)
  /** prefetched evidence for the current AGY turn, alongside the available tools */
  const agyContextRef = useRef<RetrievalContext | null>(null)

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panelVisible || !panel) return
    const collapse = () => {
      if (panel.clientWidth < NARROW) setRailOpen(false)
    }
    collapse()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(collapse)
    observer.observe(panel)
    return () => observer.disconnect()
  }, [panelVisible, workspaceTarget])

  // ---- knowledge-base (starred corpus) state and skills -------------------
  const corpusRef = useRef<KbFileInfo[]>([])
  const corpusRequestRef = useRef(0)
  const createdPathsRef = useRef(new Set<string>())
  const [corpusCount, setCorpusCount] = useState<number | null>(null)
  const onOpenPathRef = useRef(onOpenPath)
  onOpenPathRef.current = onOpenPath
  const isOpenPathRef = useRef(isOpenPath)
  isOpenPathRef.current = isOpenPath

  const isAutoOpenAuthorized = useCallback(
    (
      owner: Conversation,
      generation: number,
      run: number,
      context?: CreateDocumentExecutionContext,
    ): boolean => {
      if (!mountedRef.current) return false
      if (convRef.current !== owner || owner.dead) return false
      if (generation !== runGenerationRef.current) return false
      if (run === 0 || activeRunRef.current === 0 || activeRunRef.current !== run) return false
      if (
        !context?.sessionId ||
        !convRef.current?.executionId ||
        convRef.current.executionId !== context.sessionId
      ) {
        return false
      }
      if (
        !context?.userTurnId ||
        !currentUserTurnIdRef.current ||
        currentUserTurnIdRef.current !== context.userTurnId
      ) {
        return false
      }
      return true
    },
    [],
  )

  const openDocumentPath = useCallback(
    (path: string, execContext?: CreateDocumentExecutionContext): Promise<boolean> => {
      const existing = inFlightOpenRef.current.get(path)
      if (existing) {
        return existing
      }

      const owner = convRef.current
      const generation = runGenerationRef.current
      const run = activeRunRef.current

      let cleanup = () => {}
      const openPromise = (async () => {
        try {
          if (!isAutoOpenAuthorized(owner, generation, run, execContext)) {
            return false
          }

          if (isOpenPathRef.current) {
            try {
              await isOpenPathRef.current(path)
            } catch {
              // ignore error and proceed with opening
            }
          }

          if (!isAutoOpenAuthorized(owner, generation, run, execContext)) {
            return false
          }

          openStatesRef.current.set(path, 'opening')
          let success = false
          if (onOpenPathRef.current) {
            const res = await onOpenPathRef.current(path)
            success = typeof res === 'boolean' ? res : true
          } else if (typeof api.openPath === 'function') {
            success = await api.openPath(path)
          }

          if (!isAutoOpenAuthorized(owner, generation, run, execContext)) {
            return false
          }

          if (success) {
            openStatesRef.current.set(path, 'opened')
            openedPathsRef.current.add(path)
          } else {
            openStatesRef.current.set(path, 'failed')
          }
          return success
        } catch (err) {
          console.error('Failed to open document:', err)
          if (isAutoOpenAuthorized(owner, generation, run, execContext)) {
            openStatesRef.current.set(path, 'failed')
          }
          return false
        } finally {
          cleanup()
        }
      })()

      cleanup = () => {
        if (inFlightOpenRef.current.get(path) === openPromise) {
          inFlightOpenRef.current.delete(path)
        }
      }

      inFlightOpenRef.current.set(path, openPromise)
      return openPromise
    },
    [api, isAutoOpenAuthorized],
  )

  const manualOpenPath = useCallback(
    async (path: string): Promise<boolean> => {
      if (!mountedRef.current) return false
      try {
        if (isOpenPathRef.current) {
          try {
            await isOpenPathRef.current(path)
          } catch {
            // best effort
          }
        }
        if (!mountedRef.current) return false
        if (onOpenPathRef.current) {
          const res = await onOpenPathRef.current(path)
          return typeof res === 'boolean' ? res : true
        } else if (typeof api.openPath === 'function') {
          return await api.openPath(path)
        }
        return false
      } catch (err) {
        console.error('Failed to open document manually:', err)
        return false
      }
    },
    [api],
  )

  const refreshCorpus = useCallback(async () => {
    const request = ++corpusRequestRef.current
    if (typeof api.kbList !== 'function') {
      corpusRef.current = []
      setCorpusCount(0)
      return
    }
    try {
      const files = await api.kbList()
      if (!mountedRef.current || request !== corpusRequestRef.current) return
      corpusRef.current = files
      setCorpusCount(files.length)
    } catch {
      if (!mountedRef.current || request !== corpusRequestRef.current) return
      corpusRef.current = []
      setCorpusCount(null)
    }
  }, [api])

  useEffect(() => {
    void refreshCorpus()
  }, [refreshCorpus])

  const handleSaveAnswer = useCallback(
    async (itemId: number, format: 'md' | 'docx') => {
      const sessionId = activeSessionIdRef.current
      const saveKey = `${sessionId}:${itemId}`
      if (savingKeysRef.current.has(saveKey)) return
      savingKeysRef.current.add(saveKey)

      try {
        const currentItems = itemsRef.current
        const itemIndex = currentItems.findIndex((it) => it.id === itemId)
        if (itemIndex === -1) return
        const answer = currentItems[itemIndex]
        if (!answer || answer.role !== 'assistant' || answer.saved === 'saving') return

        // Mark item as saving in UI state
        setItems((prev) => prev.map((it) => (it.id === itemId ? { ...it, saved: 'saving' } : it)))

        // Snapshot answer and question before await
        const question = [...currentItems.slice(0, itemIndex)]
          .reverse()
          .find((m) => m.role === 'user')
        const title = (question?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Answer'

        // Clean exported content: strip internal [[file:N]] artifacts
        const cleanContent = plainAnswer(answer.text, answer.sources ?? [])

        try {
          const { path } = await api.kbCreateDocument({
            title,
            format,
            content: cleanContent,
          })
          const name = path.split(/[\\/]/).pop() ?? path

          // Guard late success: ensure still mounted and session hasn't changed
          if (!mountedRef.current || activeSessionIdRef.current !== sessionId) return
          setItems((prev) =>
            prev.map((it) => (it.id === itemId ? { ...it, saved: { path, name } } : it)),
          )
        } catch (error) {
          // Guard late error: ensure still mounted and session hasn't changed
          if (!mountedRef.current || activeSessionIdRef.current !== sessionId) return
          const msg = error instanceof Error ? error.message : String(error)
          setItems((prev) =>
            prev.map((it) => (it.id === itemId ? { ...it, saved: { error: msg } } : it)),
          )
        }
      } finally {
        savingKeysRef.current.delete(saveKey)
      }
    },
    [api],
  )

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
        locale: i18n.dateLocale,
        filesInAnswer: (n) => tr('homeChatFilesInAnswer', { n }),
        relatedFiles: (n) => tr('homeChatRelatedFiles', { n }),
        open: tr('homeChatOpen'),
        openSource: (name) => tr('homeChatOpenSource', { name }),
        searchDetails: tr('homeChatSearchDetails'),
        statusOk: tr('homeChatStatusOk'),
        nameOnly: tr('homeChatNameOnly'),
        showInFolder: tr('homeChatShowInFolder'),
        copyPath: tr('homeChatCopyPath'),
        pathCopied: tr('homeChatPathCopied'),
        fileActions: (name) => tr('homeChatFileActions', { name }),
        sourceMissing: tr('homeChatSourceMissing'),
        sourceStale: tr('homeChatSourceStale'),
        sourceMissingHint: tr('homeChatSourceMissingHint'),
        sourceStaleHint: tr('homeChatSourceStaleHint'),
        sourceSkeleton: tr('homeChatSourceSkeleton'),
        sourceSkeletonHint: tr('homeChatSourceSkeletonHint'),
        copy: tr('homeChatCopy'),
        copied: tr('homeChatCopied'),
        saveMd: tr('askSaveMd'),
        saveDocx: tr('askSaveDocx'),
        savedAs: (name) => tr('askSavedAs', { name }),
        saveFailed: (error) => tr('askSaveFailed', { error }),
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

  const loadSettings = useCallback(async () => {
    try {
      const settings = await api.getAiSettings()
      if (mountedRef.current) {
        const previousProvider = settingsRef.current?.provider
        settingsRef.current = settings
        if (previousProvider && previousProvider !== settings.provider && !busyRef.current) {
          clearActiveRequest()
        }
        setSettingsReady(true)
        setSettingsFailed(false)
        setNotice((previous) =>
          previous === tRef.current('homeChatSettingsFailed') ? '' : previous,
        )
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

  const [executionStates, setExecutionStates] = useState<Map<string, SessionRunStatus>>(
    () => new Map(),
  )
  const runManagerRef = useRef<HomeChatRunManager | null>(null)
  if (!runManagerRef.current) {
    runManagerRef.current = new HomeChatRunManager({
      api,
      getLang: () => langRef.current,
      getAiSettings: async () => {
        if (!settingsRef.current) {
          await loadSettings()
        }
        return settingsRef.current!
      },
      translate: (key, params) => tRef.current(key as ChatKey, params),
      getActiveSessionId: () => activeSessionIdRef.current,
      isMounted: () => mountedRef.current,
      onOpenPath: (path) => onOpenPathRef.current?.(path),
      isOpenPath: isOpenPath
        ? (path) => (isOpenPathRef.current ? isOpenPathRef.current(path) : false)
        : undefined,
      onActiveRequestChange: (sessionId, reqId) => {
        if (sessionId === activeSessionIdRef.current && mountedRef.current) {
          activeRequestIdRef.current = reqId
          setActiveRequestId(reqId)
        }
      },
      onStatusChange: (sessionId, status) => {
        setExecutionStates((prev) => {
          const next = new Map(prev)
          next.set(sessionId, status)
          return next
        })
        if (sessionId === activeSessionIdRef.current) {
          const isBusy = status === 'running' || status === 'queued'
          setBusy(isBusy)
          busyRef.current = isBusy
          if (!isBusy) {
            activeRequestIdRef.current = null
            setActiveRequestId(null)
          }
        }
      },
      onItemsChange: (sessionId, nextItems) => {
        if (sessionId === activeSessionIdRef.current && mountedRef.current) {
          setItems(nextItems)
          itemsRef.current = nextItems
        }
      },
      onSessionUpdated: (summary) => {
        if (mountedRef.current) {
          upsertSummary(summary)
          if (summary.id === activeSessionIdRef.current || summary.id === convRef.current.id) {
            setActiveId(summary.id)
            setTitle(summary.title)
            convRef.current.id = summary.id
            writeStore(LS_LAST, summary.id)
          }
        }
      },
    })
  }

  useEffect(() => {
    runManagerRef.current?.setCorpus(corpusRef.current)
  }, [corpusCount])

  useEffect(() => {
    return () => {
      runManagerRef.current?.destroy()
      runManagerRef.current = null
    }
  }, [])

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
    if (restoreFocus) window.setTimeout(() => inputRef.current?.focus(), 0)
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
      if (panelRef.current && path.includes(panelRef.current)) return
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

  const adopt = (conv: Conversation, nextItems: ChatItem[], nextTitle: string) => {
    convRef.current = conv
    createdPathsRef.current = new Set()
    openStatesRef.current.clear()
    inFlightOpenRef.current.clear()
    const nextSessionId = conv.id ?? conv.executionId ?? crypto.randomUUID()
    conv.executionId = nextSessionId
    setActiveSessionId(nextSessionId)
    activeSessionIdRef.current = nextSessionId
    clearActiveRequest()
    itemId.current = nextItems.length
    lastSavedRef.current = nextItems
    stickRef.current = true
    scrollMemoRef.current = null
    restoreTopRef.current = null
    setItems(nextItems)
    itemsRef.current = nextItems
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
    initRef.current = true
    openTokenRef.current++
    launchTokenRef.current++
    const nextSessionId = crypto.randomUUID()
    runManagerRef.current?.ensureRun(nextSessionId, [], null, '')
    adopt({ id: null, executionId: nextSessionId, dead: false, requested: false }, [], '')
    setBusy(false)
    busyRef.current = false
    activeRequestIdRef.current = null
    setActiveRequestId(null)
    collapseRailWhenNarrow()
    focusInput()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusInput])

  const openSession = useCallback(
    async (id: string) => {
      touchedRef.current = true
      initRef.current = true
      if (id === convRef.current.id && id === activeSessionIdRef.current) {
        collapseRailWhenNarrow()
        focusInput()
        return
      }
      const token = ++openTokenRef.current
      launchTokenRef.current++

      const existingRun = runManagerRef.current?.getRun(id)
      if (existingRun && !existingRun.dead) {
        adopt(
          { id: existingRun.persistedId || id, executionId: id, dead: false, requested: true },
          existingRun.items,
          existingRun.title,
        )
        const isBusy = existingRun.status === 'running' || existingRun.status === 'queued'
        setBusy(isBusy)
        busyRef.current = isBusy
        const reqId = existingRun.activeRequestId ?? null
        activeRequestIdRef.current = reqId
        setActiveRequestId(reqId)
        collapseRailWhenNarrow()
        focusInput()
        return
      }

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
      runManagerRef.current?.ensureRun(session.id, restored, session.id, session.title)
      adopt(
        { id: session.id, executionId: session.id, dead: false, requested: true },
        restored,
        session.title,
      )
      setBusy(false)
      busyRef.current = false
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
    runManagerRef.current?.delete(id)
    if (id === convRef.current.id || id === activeSessionIdRef.current) {
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
      setNotice(tRef.current('homeChatError'))
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
      setNotice(tRef.current('homeChatError'))
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
      setNotice(tRef.current('homeChatError'))
    }
  }

  const clearHistory = async () => {
    convRef.current.dead = true
    for (const s of sessions) {
      runManagerRef.current?.delete(s.id)
    }
    startNew()
    setSessions([])
    try {
      await api.homeChatClear()
    } catch {
      void refreshList()
      setNotice(tRef.current('homeChatError'))
      return
    }
    showToast({ kind: 'cleared' })
  }

  // First open: bring back the chat that was open last.
  const restoreLast = useCallback(
    async (token: number) => {
      if (initRef.current) return
      initRef.current = true
      const list = await refreshList()
      if (
        token !== launchTokenRef.current ||
        touchedRef.current ||
        itemsRef.current.length > 0 ||
        !mountedRef.current
      ) {
        return
      }
      const last = readStore(LS_LAST)
      if (last && list.some((entry) => entry.id === last)) {
        if (token !== launchTokenRef.current || itemsRef.current.length > 0) return
        await openSession(last)
      }
    },
    [openSession, refreshList],
  )

  const openPanel = useCallback(
    (intent: ChatLaunchIntent = 'resume', targetSessionId?: string) => {
      openRef.current = true
      const token = ++launchTokenRef.current
      // Reopening from the "answer ready" chip lands on the latest message; a plain
      // restore returns to where the user was reading.
      const memo = scrollMemoRef.current
      const resume = Boolean(memo && !memo.stick)
      stickRef.current = !resume
      restoreTopRef.current = resume ? memo!.top : null
      setOpen(true)
      focusInput()
      void loadSettings()

      if (intent === 'new') {
        initRef.current = true
        touchedRef.current = true
        startNew()
        return
      }
      if (intent === 'open-existing' && targetSessionId) {
        initRef.current = true
        touchedRef.current = true
        void openSession(targetSessionId)
        return
      }

      // 'resume' intent: if active conversation exists or already touched, keep it
      if (convRef.current.id !== null || itemsRef.current.length > 0 || touchedRef.current) {
        return
      }
      // Pristine open: restore the last conversation
      void restoreLast(token)
    },
    [focusInput, loadSettings, openSession, restoreLast, startNew],
  )

  useEffect(() => {
    if (workspaceActive) {
      if (!initRef.current) {
        openPanel('resume')
      }
    } else if (workspaceActive !== undefined) {
      closePanel(false)
    }
  }, [workspaceActive, openPanel, closePanel])

  // ---- sending ------------------------------------------------------------

  const submit = useCallback(
    async (raw: string, base: ChatItem[] = itemsRef.current) => {
      const message = raw.trim()
      const loop = loopRef.current
      if (!message || busyRef.current) return
      touchedRef.current = true
      // "index tới đâu rồi?", "tạm dừng index"… are answered and done on this computer, no model call.
      const indexCommand = mentionsIndex(message) ? parseIndexCommand(message) : null
      if (indexCommand) {
        const generation = ++runGenerationRef.current
        clearActiveRequest()
        busyRef.current = true
        setBusy(true)
        setNotice('')
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
        try {
          const answer = await runIndexCommand(api, indexCommand, langFor(message, langRef.current))
          if (!mountedRef.current || generation !== runGenerationRef.current) return
          setItems((current) =>
            current.map((item) =>
              item.id === assistantId ? { ...item, text: answer, streaming: false } : item,
            ),
          )
        } catch {
          if (!mountedRef.current || generation !== runGenerationRef.current) return
          setItems((current) =>
            current.map((item) =>
              item.id === assistantId
                ? { ...item, error: tRef.current('homeChatError'), streaming: false }
                : item,
            ),
          )
        } finally {
          if (mountedRef.current && generation === runGenerationRef.current) {
            clearActiveRequest()
            busyRef.current = false
            setBusy(false)
          }
        }
        return
      }
      if (!settingsReady) {
        const ok = await loadSettings()
        if (!ok) return
      }
      setBusy(true)
      busyRef.current = true
      await runManagerRef.current?.submit(activeSessionIdRef.current, message, base)
    },
    [settingsReady],
  )
  const submitRef = useRef(submit)
  submitRef.current = submit

  const stop = useCallback(() => {
    runManagerRef.current?.stop(activeSessionIdRef.current)
    activeRequestIdRef.current = null
    setActiveRequestId(null)
    setBusy(false)
    busyRef.current = false
  }, [])

  const retry = useCallback(() => {
    const current = itemsRef.current
    let at = current.length - 1
    while (at >= 0 && current[at]!.role !== 'user') at -= 1
    if (at < 0) return
    needsSeedRef.current = true
    void submitRef.current(current[at]!.text, current.slice(0, at))
  }, [])

  /**
   * Opens a cited file. An indexed document opens by its id (the main process resolves the path);
   * a file found by name opens by the path it was found at, in its GenOffice app or, for other
   * types, the system default app. The path is only ever one the search itself handed out.
   */
  const openSource = useCallback(
    async (source: HomeChatSource) => {
      setNotice('')
      try {
        if (source.documentId > 0) {
          const result = await api.documentMemoryOpen(source.documentId)
          if (!result.ok) setNotice(tRef.current('homeChatOpenFailed'))
          return
        }
        if (!source.path) {
          setNotice(tRef.current('homeChatOpenFailed'))
          return
        }
        const offered = await api.documentMemoryOpen(0, source.path)
        if (!offered.ok) await api.openPath(source.path)
      } catch {
        setNotice(tRef.current('homeChatOpenFailed'))
      }
    },
    [api],
  )

  const revealSource = useCallback(
    async (source: HomeChatSource) => {
      setNotice('')
      try {
        if (source.documentId > 0) {
          const result = await api.revealDocumentIndexFile(source.documentId)
          if (result.ok) return
        }
        if (source.path) await api.revealPath(source.path)
        else setNotice(tRef.current('homeChatOpenFailed'))
      } catch {
        setNotice(tRef.current('homeChatOpenFailed'))
      }
    },
    [api],
  )

  // Another part of the app (clipboard suggestions) can hand the assistant some text.
  const openPanelRef = useRef(openPanel)
  openPanelRef.current = openPanel
  const onOpenAskWorkspaceRef = useRef(onOpenAskWorkspace)
  onOpenAskWorkspaceRef.current = onOpenAskWorkspace
  useEffect(() => {
    const onPrefill = (event: Event) => {
      const detail = (event as CustomEvent<ChatPrefillDetail>).detail
      if (!detail || typeof detail.text !== 'string' || !detail.text.trim()) return
      const intent: ChatLaunchIntent =
        detail.intent ?? (detail.continue === true ? 'resume' : 'new')
      touchedRef.current = true
      launchTokenRef.current++
      if (onOpenAskWorkspaceRef.current) {
        onOpenAskWorkspaceRef.current()
      }
      openPanelRef.current(intent, detail.sessionId)
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

  const showEarlier = () => {
    prependHeightRef.current = scrollRef.current?.scrollHeight ?? null
    setVisibleCount((count) => count + WINDOW_PAGE)
  }
  const showDock = !isWorkspace && !suppressDock
  const modelControls = (
    <div className="hc-model-controls">
      <AiModelPicker bridge={modelBridge} lang={i18n.lang} />
      <AgyChatBar lang={i18n.lang} part="bar" showModel={false} />
    </div>
  )
  const activeDockTarget =
    (dockTarget && typeof document !== 'undefined' && document.contains(dockTarget)
      ? dockTarget
      : null) ??
    (dockLocation === 'home'
      ? typeof document !== 'undefined'
        ? document.getElementById('home-assistant-slot')
        : null
      : null)
  const dock = showDock ? (
    <AskDock lang={i18n.lang} api={api} away={open} inline={!!activeDockTarget}>
      {modelControls}
    </AskDock>
  ) : null

  const panelNode = panelVisible ? (
    <section
      ref={panelRef}
      className={`home-chat-panel${railOpen ? ' rail-open' : ''}${isWorkspace ? ' is-workspace' : ''}`}
      style={
        isWorkspace
          ? undefined
          : ({ '--hc-w': `${size.w}px`, '--hc-h': `${size.h}px` } as React.CSSProperties)
      }
      role={isWorkspace ? 'region' : 'dialog'}
      aria-modal={isWorkspace ? undefined : 'false'}
      aria-label={t('homeChatTitle')}
    >
      {!isWorkspace && (
        <div
          className="hc-resize"
          role="separator"
          tabIndex={0}
          aria-label={t('homeChatResize')}
          aria-orientation="vertical"
          aria-valuenow={size.w}
          aria-valuemin={1}
          aria-valuemax={Math.max(1, window.innerWidth - 32)}
          aria-valuetext={`${size.w} × ${size.h}`}
          onPointerDown={onResizeStart}
          onKeyDown={onResizeKey}
        />
      )}
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
            executionStates={executionStates}
            onOpen={(id) => void openSession(id)}
            onNew={startNew}
            onRename={(id, next) => void renameSession(id, next)}
            onDelete={(id) => void deleteSession(id)}
            onClear={() => void clearHistory()}
            onStop={(id) => runManagerRef.current?.stop(id)}
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
          <div className="hc-head-text">
            <h3 className="hc-title" title={heading}>
              {heading}
            </h3>
            {corpusCount !== null && corpusCount > 0 && (
              <span
                className="hc-corpus-badge"
                title={t('askCorpusCount', { n: String(corpusCount) })}
              >
                {t('askCorpusCount', { n: String(corpusCount) })}
              </span>
            )}
          </div>
          <div className="home-chat-header-actions">
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
            {!isWorkspace && (
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
            )}
          </div>
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
              isWorkspace && corpusCount === 0 ? (
                <div className="kb-ask-hero">
                  <div className="kb-ask-hero-icon" aria-hidden="true">
                    <IconBookOpen />
                  </div>
                  <h3>{t('askTitle')}</h3>
                  <p>{t('askHeroTagline')}</p>
                  <div className="kb-ask-steps">
                    <div className="kb-ask-step">
                      <span className="kb-ask-step-num">1</span>
                      <div>
                        <b>{t('askStep1Title')}</b>
                        <span>{t('askStep1Desc')}</span>
                      </div>
                    </div>
                    <div className="kb-ask-step">
                      <span className="kb-ask-step-num">2</span>
                      <div>
                        <b>{t('askStep2Title')}</b>
                        <span>{t('askStep2Desc')}</span>
                      </div>
                    </div>
                    <div className="kb-ask-step">
                      <span className="kb-ask-step-num">3</span>
                      <div>
                        <b>{t('askStep3Title')}</b>
                        <span>{t('askStep3Desc')}</span>
                      </div>
                    </div>
                  </div>
                  {onNavigateToRecents && (
                    <button className="kb-ask-cta" type="button" onClick={onNavigateToRecents}>
                      <IconStar />
                      {t('askCtaRecents')}
                    </button>
                  )}
                </div>
              ) : (
                <EmptyState
                  title={t('homeChatWelcome')}
                  body={t('homeChatWelcomeBody')}
                  suggestions={suggestions}
                  disabled={composerDisabled}
                  onPick={handleSend}
                />
              )
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
                    activity={
                      item.streaming && !item.text ? (
                        <AgyChatBar
                          lang={i18n.lang}
                          part="steps"
                          mode="home-chat"
                          busy={busy}
                          sessionId={activeSessionId}
                          activeRequestId={activeRequestId}
                          getActiveRequestId={() => activeRequestIdRef.current}
                        />
                      ) : undefined
                    }
                    onOpenSource={openSource}
                    onRevealSource={revealSource}
                    onRetry={retry}
                    onSaveAnswer={handleSaveAnswer}
                    onOpenPath={(p) => void manualOpenPath(p)}
                  />
                ))}
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
              <div className="hc-notice">
                <span>{notice}</span>
                {settingsFailed && (
                  <button
                    type="button"
                    className="hc-text-button strong"
                    onClick={() => void loadSettings()}
                  >
                    {t('homeChatRetry')}
                  </button>
                )}
                <button
                  type="button"
                  className="hc-icon-button"
                  aria-label={t('homeChatClose')}
                  onClick={() => setNotice('')}
                >
                  ×
                </button>
              </div>
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
        <div className="hc-agy">{modelControls}</div>
      </div>
    </section>
  ) : null

  const target =
    workspaceTarget ?? (isWorkspace ? document.getElementById('home-ask-workspace') : null)

  return (
    <>
      <span className="home-chat-sr-only" role="status" aria-live="polite">
        {!busy && lastItem?.role === 'assistant'
          ? lastItem.error
            ? t('homeChatErrorChip')
            : lastItem.text
              ? t('homeChatDone')
              : ''
          : ''}
      </span>
      {target ? createPortal(panelNode, target) : workspaceActive === false ? null : panelNode}
      {activeDockTarget && dock ? createPortal(dock, activeDockTarget) : null}
    </>
  )
}

function IconBookOpen(): React.JSX.Element {
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 6.8C10.2 5.4 7.9 4.7 5.5 4.7c-.4 0-.8 0-1.2.1v12.9c.4-.1.8-.1 1.2-.1 2.4 0 4.7.7 6.5 2.1 1.8-1.4 4.1-2.1 6.5-2.1.4 0 .8 0 1.2.1V4.8c-.4-.1-.8-.1-1.2-.1-2.4 0-4.7.7-6.5 2.1z" />
      <path d="M12 6.8v12.9" />
    </svg>
  )
}

function IconStar(): React.JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3.6l2.6 5.2 5.8.9-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.9z" />
    </svg>
  )
}
