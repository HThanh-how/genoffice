import {
  AgentLoop,
  composeSkills,
  createDocumentMemorySkill,
  createDocumentSkill,
  createIpcTransport,
  createKnowledgeBaseSkill,
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
    const target = dockLocation === 'home' ? document.getElementById('home-assistant-slot') : null
    setDockTarget((previous) => (previous === target ? previous : target))
  }, [dockLocation])

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

  const openDocumentPath = useCallback(
    async (path: string): Promise<boolean> => {
      const existing = inFlightOpenRef.current.get(path)
      if (existing) {
        return existing
      }

      if (isOpenPathRef.current) {
        try {
          if (await isOpenPathRef.current(path)) {
            return true
          }
        } catch {
          // ignore error and proceed with opening
        }
      }

      const owner = convRef.current
      const generation = runGenerationRef.current

      openStatesRef.current.set(path, 'opening')
      let cleanup = () => {}
      const openPromise = (async () => {
        try {
          let success = false
          if (onOpenPathRef.current) {
            const res = await onOpenPathRef.current(path)
            success = typeof res === 'boolean' ? res : true
          } else if (typeof api.openPath === 'function') {
            success = await api.openPath(path)
          }

          if (
            mountedRef.current &&
            convRef.current === owner &&
            !owner.dead &&
            generation === runGenerationRef.current
          ) {
            if (success) {
              openStatesRef.current.set(path, 'opened')
              openedPathsRef.current.add(path)
            } else {
              openStatesRef.current.set(path, 'failed')
            }
          }
          return success
        } catch (err) {
          console.error('Failed to open document:', err)
          if (
            mountedRef.current &&
            convRef.current === owner &&
            !owner.dead &&
            generation === runGenerationRef.current
          ) {
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
    [api],
  )

  const docSkillRef = useRef<ReturnType<typeof createDocumentSkill> | null>(null)
  if (!docSkillRef.current) {
    docSkillRef.current = createDocumentSkill({
      getSessionId: () => convRef.current?.executionId || activeSessionIdRef.current || undefined,
      getUserTurnId: () => currentUserTurnIdRef.current || undefined,
      fileExists: async (path: string) => {
        try {
          if (typeof api.statPaths === 'function') {
            const entries = await api.statPaths([path])
            return Boolean(entries[0] && !entries[0].missing)
          }
          return true
        } catch {
          return false
        }
      },
      create: async (request) => {
        const owner = convRef.current
        const table = fileTableRef.current
        const generation = runGenerationRef.current
        const run = activeRunRef.current
        const sessionId =
          request.sessionId ||
          convRef.current?.executionId ||
          activeSessionIdRef.current ||
          undefined
        const userTurnId = request.userTurnId || currentUserTurnIdRef.current || undefined
        const hostOpId = request.callId || request.documentSlot || undefined
        const documentSlot = request.documentSlot || hostOpId

        const result = await api.kbCreateDocument({
          title: request.title,
          format: request.format,
          content: request.content,
          sessionId,
          userTurnId,
          documentSlot,
          callId: hostOpId,
          documentType: request.documentType,
        })

        if (
          mountedRef.current &&
          convRef.current === owner &&
          !owner.dead &&
          generation === runGenerationRef.current &&
          activeRunRef.current !== 0 &&
          activeRunRef.current === run
        ) {
          createdPathsRef.current.add(result.path)
          table.addFile({
            path: result.path,
            name: result.path.split(/[\\/]/).pop() ?? result.path,
          })
        }
        return { path: result.path }
      },
      open: (path) => openDocumentPath(path),
      isOpen: (path) => {
        if (isOpenPathRef.current) return isOpenPathRef.current(path)
        return false
      },
    })
  }

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

  /**
   * The files a finished answer relies on, offered under it: the ones it cites by id or by name
   * (in order of citation); only when it cites none, the files retrieved for this turn as related.
   * Never invents a file: everything comes from the table or from the file index.
   */
  const settleFiles = (text: string, fallback: boolean): PickedSources => {
    const table = fileTableRef.current
    const all = table.list()
    return pickSources(text, all, {
      fallback,
      pool: all.filter((source) => (source.ref ?? 0) >= turnStartRef.current),
    })
  }

  /** Names the answer wrote that are not in the table: looked up (exact name) in recents / the file index. */
  const resolveUnlistedNames = async (answer: string, itemId: number, run: number) => {
    const table = fileTableRef.current
    const known = new Set(table.list().map((source) => source.name.normalize('NFC').toLowerCase()))
    const unlisted = fileNamesIn(answer).filter(
      (name) => !known.has(name.normalize('NFC').toLowerCase()),
    )
    for (const name of unlisted.slice(0, 6)) {
      for (const variant of fileNameVariants(name)) {
        const wanted = variant.normalize('NFC').toLowerCase()
        const matches = await findFilesByName(api, variant, 12, 60).catch(() => [])
        const file = matches.find((match) => match.name.normalize('NFC').toLowerCase() === wanted)
        if (!file) continue
        table.addFile(file)
        break
      }
      if (!mountedRef.current || run !== runGenerationRef.current) return
    }
    const picked = settleFiles(answer, true)
    updateLastAssistant((last) =>
      last.id !== itemId
        ? last
        : { ...last, ...(picked.sources.length > 0 ? { sources: picked.sources } : {}) },
    )
  }

  if (!loopRef.current) {
    const transport = createIpcTransport({
      route: createGeminiRouter(),
      sessionId: () => activeSessionIdRef.current,
      onAttemptStarted: ({ requestId }) => {
        if (
          !mountedRef.current ||
          activeRunRef.current === 0 ||
          activeRunRef.current !== runGenerationRef.current
        ) {
          return
        }
        activeRequestIdRef.current = requestId
        setActiveRequestId(requestId)
      },
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
      quotaErrorText: (resetAt) => agyErrorText(langRef.current, 'quota', { resetAt }),
      authErrorText: () => agyErrorText(langRef.current, 'auth'),
    })
    // Events from a run that was stopped or replaced (conversation switch) are ignored.
    const live = () =>
      activeRunRef.current !== 0 && activeRunRef.current === runGenerationRef.current
    // IPC work can outlive an aborted run. Keep its citations attached to its owner.
    const captureCitationOwner = () => {
      const table = fileTableRef.current
      const owner = convRef.current
      const generation = runGenerationRef.current
      return {
        table,
        isCurrent: () =>
          mountedRef.current &&
          !owner.dead &&
          convRef.current === owner &&
          generation === runGenerationRef.current &&
          live() &&
          fileTableRef.current === table,
      }
    }
    loopRef.current = new AgentLoop({
      transport,
      skill: composeSkills('home+remembered-documents+kb', '', [
        createDocumentMemorySkill(refBridge(api, () => fileTableRef.current)),
        createKnowledgeBaseSkill({
          listFiles: () => {
            const list = corpusRef.current
            for (const f of list) {
              fileTableRef.current.addFile({
                path: f.path,
                name: f.name,
                location: f.folder,
              })
            }
            return list
          },
          search: async (query, limit) => {
            const citationOwner = captureCitationOwner()
            const hits = await api.kbSearch({ q: query, limit })
            if (!citationOwner.isCurrent()) return hits
            for (const hit of hits) {
              citationOwner.table.addFile({
                path: hit.path,
                name: hit.name,
                location: hit.folder,
              })
            }
            return hits
          },
          read: async (path, offset) => {
            const citationOwner = captureCitationOwner()
            const f = corpusRef.current.find((file) => file.path === path)
            const page = await api.kbRead(path, offset)
            if (!citationOwner.isCurrent()) return page
            citationOwner.table.addFile({
              path,
              name: f?.name ?? path.split(/[\\/]/).pop() ?? 'Document',
              location: f?.folder ?? '',
            })
            return page
          },
          alsoCitable: () => [...createdPathsRef.current],
        }),
        docSkillRef.current!,
      ]),
      maxTurns: 12,
      formatUserMessage: (instruction, context) =>
        [instruction, context, agyContextRef.current?.block].filter(Boolean).join('\n\n'),
      systemSuffix: () =>
        agyContextRef.current
          ? agySystemSuffix(LANGUAGE_NAMES[langRef.current] ?? 'English', {
              ...agyContextRef.current,
              block: '',
            })
          : `Reply in ${LANGUAGE_NAMES[langRef.current] ?? 'English'}. This is a home assistant: answer questions, search knowledge base and help find files the user has opened or starred. Use remembered-document and knowledge-base tools when relevant. Never guess document contents or source identifiers. ${FILE_CITATION_RULES_TOOLS}`,
      events: {
        onText: (text) => {
          if (live()) batcherRef.current?.push(text)
        },
        onToolExecuted: ({ call }) => {
          if (
            !live() ||
            ![
              'search_remembered_documents',
              'search_knowledge_base',
              'read_knowledge_file',
              'create_document',
            ].includes(call.name)
          )
            return
          // the hits were numbered while the tool ran (refBridge): make them resolvable at once
          updateLastAssistant((last) => ({ ...last, candidates: fileTableRef.current.list() }))
        },
        onDone: ({ text, cancelled }) => {
          if (!live()) return
          batcherRef.current?.cancel()
          const finalText = text || itemsRef.current.at(-1)?.text || ''
          const names = cancelled ? [] : fileNamesIn(finalText)
          const known = new Set(
            fileTableRef.current.list().map((source) => source.name.normalize('NFC').toLowerCase()),
          )
          const unlisted = names.some((name) => !known.has(name.normalize('NFC').toLowerCase()))
          // with names still to look up, wait before falling back to "related" files
          const picked = settleFiles(finalText, !cancelled && !unlisted)
          const itemId = itemsRef.current.at(-1)?.id ?? 0
          updateLastAssistant((last) => {
            const answer = text || last.text
            const { candidates: _candidates, ...rest } = last
            return {
              ...rest,
              text: answer,
              streaming: false,
              ...(picked.sources.length > 0 ? { sources: picked.sources } : {}),
              error: answer
                ? undefined
                : cancelled
                  ? tRef.current('homeChatStopped')
                  : tRef.current('homeChatNoReply'),
            }
          })
          clearActiveRequest()
          setBusy(false)
          // names the answer wrote without an id become files to open, not only words
          if (unlisted && finalText)
            void resolveUnlistedNames(finalText, itemId, runGenerationRef.current)
        },
        onError: (error) => {
          if (!live()) return
          batcherRef.current?.cancel()
          updateLastAssistant((last) => ({ ...last, error, streaming: false }))
          clearActiveRequest()
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
    previous.map((item, index) => {
      if (index !== previous.length - 1 || item.role !== 'assistant' || !item.streaming) return item
      const { candidates: _candidates, ...rest } = item
      const picked = item.text ? settleFiles(item.text, false) : null
      return {
        ...rest,
        streaming: false,
        ...(picked && picked.sources.length > 0 ? { sources: picked.sources } : {}),
        error: item.text ? undefined : tRef.current('homeChatStopped'),
      }
    })

  /** Ends any in-flight run and keeps what has streamed so far. */
  const detachCurrent = () => {
    window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = 0
    runGenerationRef.current++
    batcherRef.current?.cancel()
    loopRef.current?.reset()
    clearActiveRequest()
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
    detachCurrent()
    adopt({ id: null, executionId: crypto.randomUUID(), dead: false, requested: false }, [], '')
    collapseRailWhenNarrow()
    focusInput()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusInput])

  const openSession = useCallback(
    async (id: string) => {
      touchedRef.current = true
      initRef.current = true
      if (id === convRef.current.id) {
        collapseRailWhenNarrow()
        focusInput()
        return
      }
      const token = ++openTokenRef.current
      launchTokenRef.current++
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
      adopt(
        { id: session.id, executionId: session.id, dead: false, requested: true },
        restored,
        session.title,
      )
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
      if (!settingsReady || !loop) return
      if (needsSeedRef.current) {
        // New conversation, restored chat or a stopped run: rebuild the model context
        // from the visible text turns (no tool-call blocks are ever persisted).
        loop.reset()
        // the model's memory of earlier ids is gone with its history: start numbering again
        toolTableRef.current = new FileRefTable()
        loop.restore(toSeedMessages(toMessages(base)))
        needsSeedRef.current = false
      }
      const generation = ++runGenerationRef.current
      activeRunRef.current = generation
      currentUserTurnIdRef.current = crypto.randomUUID()
      openedSlotsRef.current.clear()
      openedPathsRef.current.clear()
      openStatesRef.current.clear()
      inFlightOpenRef.current.clear()
      clearActiveRequest()
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
        clearActiveRequest()
        setBusy(false)
        return
      }
      await refreshCorpus()
      if (generation !== runGenerationRef.current || !mountedRef.current) return
      agyContextRef.current = null
      fileTableRef.current = toolTableRef.current!
      turnStartRef.current = fileTableRef.current.peekNext()
      try {
        if (settingsRef.current?.provider === 'agy') {
          // Prefetch remembered passages for AGY; tools remain available for follow-up evidence and actions.
          let hits: Awaited<ReturnType<HomeApi['documentMemorySearch']>>['hits'] = []
          try {
            const query = buildRetrievalQuery(message, toMessages(base))
            hits = (await api.documentMemorySearch(query, 8)).hits
            if (api.testIgnorePath && hits.length > 0) {
              const testResults = await Promise.all(
                hits.map((h) => api.testIgnorePath!(h.path).catch(() => ({ ignored: false }))),
              )
              hits = hits.filter((_, idx) => !testResults[idx]?.ignored)
            }
          } catch {
            // search is best-effort; the answer then says nothing matched
          }
          if (generation !== runGenerationRef.current || !mountedRef.current) return
          const table = new FileRefTable()
          fileTableRef.current = table
          turnStartRef.current = 1
          const context = buildRetrievalContext(hits, { table })
          if (mentionsIndex(message)) {
            // Live index facts and the means to act on the index (the model cannot call tools here).
            const facts = await indexFacts(api, langFor(message, langRef.current)).catch(() => '')
            if (generation !== runGenerationRef.current || !mountedRef.current) return
            if (facts)
              context.block = `${context.block}\n\n<<<INDEX\n${facts}\nINDEX>>>\n${INDEX_DIRECTIVE_PROMPT}`
          }
          // Files recently opened, or in the folder index, that match by name: their content is
          // not part of the search above, so they are offered as candidates by name (same id table).
          let named = (await findFilesByName(api, message, 4).catch(() => [])).filter(
            (file) => table.refForPath(file.path) === undefined,
          )
          if (api.testIgnorePath && named.length > 0) {
            const testResults = await Promise.all(
              named.map((f) => api.testIgnorePath!(f.path).catch(() => ({ ignored: false }))),
            )
            named = named.filter((_, idx) => !testResults[idx]?.ignored)
          }
          if (generation !== runGenerationRef.current || !mountedRef.current) return
          const byName = namedFilesBlock(named, table)
          if (corpusRef.current.length > 0) {
            for (const file of corpusRef.current) {
              if (table.refForPath(file.path) === undefined) {
                table.addFile({
                  path: file.path,
                  name: file.name,
                  location: file.folder,
                })
              }
            }
            if (typeof api.kbSearch === 'function') {
              try {
                const kbHits = await api.kbSearch({ q: message, limit: 4 })
                for (const hit of kbHits) {
                  if (table.refForPath(hit.path) === undefined) {
                    table.addFile({
                      path: hit.path,
                      name: hit.name,
                      location: hit.folder,
                    })
                  }
                }
              } catch {
                // best effort
              }
            }
          }
          if (byName.block) context.block = `${context.block}\n\n${byName.block}`
          agyContextRef.current = context
          // not shown as chips yet: the answer decides which of these files it relies on
          updateLastAssistant((last) => ({ ...last, candidates: table.list() }))
        }
        await loop.run(message)
        if (generation !== runGenerationRef.current || !mountedRef.current) return
        if (mentionsIndex(message) && settingsRef.current?.provider === 'agy') {
          batcherRef.current?.flush()
          const reply = itemsRef.current.at(-1)
          if (reply?.role === 'assistant') {
            const { text, commands } = extractIndexDirectives(reply.text)
            if (commands.length > 0) {
              const outcomes: string[] = []
              for (const command of commands) {
                if (generation !== runGenerationRef.current || !mountedRef.current) return
                outcomes.push(
                  await runIndexCommand(api, command, langFor(message, langRef.current)),
                )
              }
              if (mountedRef.current && generation === runGenerationRef.current)
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
        clearActiveRequest()
        setBusy(false)
      }
    },
    [api, loadSettings, refreshCorpus, settingsReady],
  )
  const submitRef = useRef(submit)
  submitRef.current = submit

  const stop = () => {
    stoppedRef.current = true
    runGenerationRef.current++
    batcherRef.current?.flush()
    loopRef.current?.reset()
    clearActiveRequest()
    needsSeedRef.current = true
    setItems(stopStreamingItems)
    setBusy(false)
    busyRef.current = false
  }

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
  const dock = showDock ? (
    <AskDock lang={i18n.lang} api={api} away={open} inline={!!dockTarget}>
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
                    onOpenPath={(p) => void openDocumentPath(p)}
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
      {dockTarget && dock ? createPortal(dock, dockTarget) : null}
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
