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
import type { HomeApi } from '../../../shared/home-api'
import type {
  HomeChatMessage,
  HomeChatSession,
  HomeChatSessionSummary,
  HomeChatSource,
} from '../../../shared/fork/home-chat-types'
import type { ChatItem } from './ChatMessage'
import {
  FILE_CITATION_RULES_TOOLS,
  FileRefTable,
  pickSources,
  refBridge,
  type PickedSources,
} from './file-refs'
import { fileNameVariants, fileNamesIn, toSeedMessages } from './utils'
import {
  agySystemSuffix,
  buildRetrievalContext,
  buildRetrievalQuery,
  namedFilesBlock,
  type RetrievalContext,
} from './agy-retrieval'
import {
  INDEX_DIRECTIVE_PROMPT,
  extractIndexDirectives,
  indexFacts,
  langFor,
  mentionsIndex,
  parseIndexCommand,
  runIndexCommand,
} from '../fork/index-assistant'
import { findFilesByName } from '../fork/file-name-search'

export type SessionRunStatus = 'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'stopped'

export interface SessionRun {
  sessionId: string
  persistedId: string | null
  executionId: string
  title: string
  status: SessionRunStatus
  items: ChatItem[]
  pendingPrompt?: string
  runGeneration: number
  activeRun: number
  currentUserTurnId: string
  activeRequestId: string | null
  fileTable: FileRefTable
  toolTable: FileRefTable
  turnStart: number
  createdPaths: Set<string>
  openedPaths: Set<string>
  openStates: Map<string, 'opening' | 'opened' | 'failed'>
  inFlightOpen: Map<string, Promise<boolean>>
  loop: AgentLoop | null
  retrievalContext?: RetrievalContext | null
  needsSeed: boolean
  lastSavedItems: ChatItem[] | null
  dead: boolean
  saveTimer?: number
}

const MAX_CONCURRENT_RUNS = 2
const SAVE_INTERVAL_MS = 1500

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

const toMessages = (items: readonly ChatItem[]): HomeChatMessage[] =>
  items
    .filter((item) => item.text || item.error)
    .map((item) => {
      const message: HomeChatMessage = { role: item.role, text: item.text }
      if (item.sources?.length) message.sources = item.sources
      if (item.error) message.error = item.error
      return message
    })

export interface RunManagerOptions {
  api: HomeApi
  getLang: () => string
  getAiSettings: () => Promise<Awaited<ReturnType<HomeApi['getAiSettings']>>>
  translate: (key: string, params?: Record<string, string | number>) => string
  getActiveSessionId: () => string | null
  onOpenPath?: (path: string) => boolean | Promise<boolean> | void
  isOpenPath?: (path: string) => boolean | Promise<boolean>
  isMounted?: () => boolean
  onActiveRequestChange?: (sessionId: string, requestId: string | null) => void
  onStatusChange?: (sessionId: string, status: SessionRunStatus) => void
  onItemsChange?: (sessionId: string, items: ChatItem[]) => void
  onSessionUpdated?: (summary: HomeChatSessionSummary) => void
}

export class HomeChatRunManager {
  private runs = new Map<string, SessionRun>()
  private queue: string[] = []
  private corpus: KbFileInfo[] = []
  private saveChain = Promise.resolve()
  private requestToSession = new Map<string, string>()
  private destroyed = false

  constructor(private readonly opts: RunManagerOptions) {}

  destroy(): void {
    this.destroyed = true
    const uniqueRuns = new Set(this.runs.values())
    for (const run of uniqueRuns) {
      run.dead = true
      run.status = 'stopped'
      if (run.saveTimer) window.clearTimeout(run.saveTimer)
      if (run.activeRequestId) {
        void this.opts.api.aiStreamCancel(run.activeRequestId)
      }
      run.loop?.reset()
    }
    this.runs.clear()
    this.queue = []
    this.requestToSession.clear()
  }

  setCorpus(files: KbFileInfo[]): void {
    this.corpus = files
  }

  getRun(id: string): SessionRun | undefined {
    const direct = this.runs.get(id)
    if (direct) return direct
    for (const run of this.runs.values()) {
      if (run.persistedId === id) return run
    }
    return undefined
  }

  ensureRun(
    sessionId: string,
    initialItems: ChatItem[] = [],
    persistedId: string | null = null,
    title = '',
  ): SessionRun {
    let run = this.getRun(sessionId)
    if (!run && persistedId) {
      run = this.getRun(persistedId)
    }
    if (!run) {
      const toolTable = new FileRefTable()
      run = {
        sessionId,
        persistedId,
        executionId: sessionId,
        title,
        status: 'idle',
        items: initialItems,
        runGeneration: 0,
        activeRun: 0,
        currentUserTurnId: '',
        activeRequestId: null,
        fileTable: toolTable,
        toolTable,
        turnStart: 1,
        createdPaths: new Set(),
        openedPaths: new Set(),
        openStates: new Map(),
        inFlightOpen: new Map(),
        loop: null,
        needsSeed: initialItems.length > 0,
        lastSavedItems: initialItems.length > 0 ? initialItems : null,
        dead: false,
      }
      this.runs.set(sessionId, run)
    }
    return run
  }

  getAllStatuses(): Map<string, SessionRunStatus> {
    const map = new Map<string, SessionRunStatus>()
    for (const [id, run] of this.runs) {
      if (!run.dead) {
        map.set(id, run.status)
        if (run.persistedId && run.persistedId !== id) {
          map.set(run.persistedId, run.status)
        }
      }
    }
    return map
  }

  private countActive(): number {
    const active = new Set<SessionRun>()
    for (const run of this.runs.values()) {
      if (!run.dead && run.status === 'running') active.add(run)
    }
    return active.size
  }

  async submit(sessionId: string, messageText: string, baseItems?: ChatItem[]): Promise<void> {
    const raw = messageText.trim()
    if (!raw) return
    const run = this.ensureRun(sessionId, baseItems ?? this.runs.get(sessionId)?.items ?? [])
    if (run.dead || run.status === 'running' || run.status === 'queued') return

    const userMsgId = run.items.length + 1
    const assistantMsgId = userMsgId + 1
    const newItems: ChatItem[] = [
      ...run.items,
      { id: userMsgId, role: 'user', text: raw },
      { id: assistantMsgId, role: 'assistant', text: '', streaming: true },
    ]
    run.items = newItems
    run.currentUserTurnId = crypto.randomUUID()
    run.createdPaths.clear()
    run.openStates.clear()
    run.inFlightOpen.clear()
    run.pendingPrompt = raw
    this.notifyItems(run)
    this.scheduleSave(run, true)
    await this.saveChain

    if (this.countActive() >= MAX_CONCURRENT_RUNS) {
      run.status = 'queued'
      this.queue.push(sessionId)
      this.notifyStatus(run)
      return
    }

    await this.startRunExecution(run)
  }

  private async startRunExecution(run: SessionRun): Promise<void> {
    if (run.dead) return
    run.status = 'running'
    run.runGeneration++
    const currentGen = run.runGeneration
    run.activeRun = currentGen
    this.notifyStatus(run)

    const raw = run.pendingPrompt || ''
    run.pendingPrompt = undefined

    // Check index command
    const indexCommand = mentionsIndex(raw) ? parseIndexCommand(raw) : null
    if (indexCommand) {
      try {
        const answer = await runIndexCommand(
          this.opts.api,
          indexCommand,
          langFor(raw, this.opts.getLang()),
        )
        if (run.dead || run.runGeneration !== currentGen) return
        this.updateLastAssistant(run, (last) => ({ ...last, text: answer, streaming: false }))
        run.status = 'completed'
      } catch {
        if (run.dead || run.runGeneration !== currentGen) return
        this.updateLastAssistant(run, (last) => ({
          ...last,
          error: this.opts.translate('homeChatError'),
          streaming: false,
        }))
        run.status = 'failed'
      } finally {
        if (!run.dead && run.runGeneration === currentGen) {
          this.scheduleSave(run, true)
          this.finishRun(run)
        }
      }
      return
    }

    let settings: Awaited<ReturnType<HomeApi['getAiSettings']>>
    try {
      settings = await this.opts.getAiSettings()
    } catch {
      this.updateLastAssistant(run, (last) => ({
        ...last,
        error: this.opts.translate('homeChatSettingsFailed'),
        streaming: false,
      }))
      run.status = 'failed'
      this.finishRun(run)
      return
    }

    if (run.dead || run.runGeneration !== currentGen) return

    const loop = this.ensureLoopForRun(run, settings)
    if (run.needsSeed) {
      loop.reset()
      run.toolTable = new FileRefTable()
      loop.restore(toSeedMessages(toMessages(run.items.slice(0, -2))))
      run.needsSeed = false
    }

    run.fileTable = run.toolTable
    run.turnStart = run.fileTable.peekNext()

    try {
      if (settings?.provider === 'agy') {
        let hits: Awaited<ReturnType<HomeApi['documentMemorySearch']>>['hits'] = []
        try {
          const query = buildRetrievalQuery(raw, toMessages(run.items.slice(0, -2)))
          hits = (await this.opts.api.documentMemorySearch(query, 8)).hits
          if (this.opts.api.testIgnorePath && hits.length > 0) {
            const testResults = await Promise.all(
              hits.map((h) =>
                this.opts.api.testIgnorePath!(h.path).catch(() => ({ ignored: false })),
              ),
            )
            hits = hits.filter((_, idx) => !testResults[idx]?.ignored)
          }
        } catch {
          // best-effort
        }
        if (run.dead || run.runGeneration !== currentGen) return
        const table = new FileRefTable()
        run.fileTable = table
        run.turnStart = 1
        const context = buildRetrievalContext(hits, { table })
        if (mentionsIndex(raw)) {
          const facts = await indexFacts(this.opts.api, langFor(raw, this.opts.getLang())).catch(
            () => '',
          )
          if (facts && !run.dead && run.runGeneration === currentGen) {
            context.block = `${context.block}\n\n<<<INDEX\n${facts}\nINDEX>>>\n${INDEX_DIRECTIVE_PROMPT}`
          }
        }
        let named = (await findFilesByName(this.opts.api, raw, 4).catch(() => [])).filter(
          (file) => table.refForPath(file.path) === undefined,
        )
        if (this.opts.api.testIgnorePath && named.length > 0) {
          const testResults = await Promise.all(
            named.map((f) =>
              this.opts.api.testIgnorePath!(f.path).catch(() => ({ ignored: false })),
            ),
          )
          named = named.filter((_, idx) => !testResults[idx]?.ignored)
        }
        if (run.dead || run.runGeneration !== currentGen) return
        const byName = namedFilesBlock(named, table)
        if (this.corpus.length > 0) {
          for (const file of this.corpus) {
            if (table.refForPath(file.path) === undefined) {
              table.addFile({ path: file.path, name: file.name, location: file.folder })
            }
          }
        }
        if (byName.block) context.block = `${context.block}\n\n${byName.block}`
        run.retrievalContext = context
        this.updateLastAssistant(run, (last) => ({ ...last, candidates: table.list() }))
      }

      await loop.run(raw)
      if (run.dead || run.runGeneration !== currentGen) return

      if (mentionsIndex(raw) && settings?.provider === 'agy') {
        const reply = run.items.at(-1)
        if (reply?.role === 'assistant') {
          const { text, commands } = extractIndexDirectives(reply.text)
          if (commands.length > 0) {
            const outcomes: string[] = []
            for (const cmd of commands) {
              if (run.dead || run.runGeneration !== currentGen) return
              outcomes.push(
                await runIndexCommand(this.opts.api, cmd, langFor(raw, this.opts.getLang())),
              )
            }
            if (!run.dead && run.runGeneration === currentGen) {
              this.updateLastAssistant(run, (last) => ({
                ...last,
                text: [text, ...outcomes].filter(Boolean).join('\n\n'),
              }))
            }
          }
        }
      }
    } catch (error) {
      if (run.dead || run.runGeneration !== currentGen) return
      const detail = error instanceof Error ? error.message : this.opts.translate('homeChatError')
      this.updateLastAssistant(run, (last) => ({ ...last, error: detail, streaming: false }))
      run.status = 'failed'
      this.finishRun(run)
    }
  }

  private handleText(run: SessionRun, text: string): void {
    const last = run.items.at(-1)
    if (!last || last.role !== 'assistant') return
    this.updateLastAssistant(run, (l) => ({ ...l, text }))
    this.scheduleSave(run, false)
  }

  private handleDone(run: SessionRun, finalText: string): void {
    const text = finalText || run.items.at(-1)?.text || ''
    const names = fileNamesIn(text)
    const known = new Set(run.fileTable.list().map((s) => s.name.normalize('NFC').toLowerCase()))
    const unlisted = names.some((n) => !known.has(n.normalize('NFC').toLowerCase()))
    const picked = this.settleFiles(run, text, !unlisted)

    this.updateLastAssistant(run, (last) => {
      const { candidates: _candidates, ...rest } = last
      return {
        ...rest,
        text: text || last.text,
        streaming: false,
        ...(picked.sources.length > 0 ? { sources: picked.sources } : {}),
        error: text || last.text ? undefined : this.opts.translate('homeChatNoReply'),
      }
    })

    if (run.activeRequestId) {
      this.requestToSession.delete(run.activeRequestId)
      run.activeRequestId = null
      this.opts.onActiveRequestChange?.(run.sessionId, null)
    }

    run.status = 'completed'
    this.scheduleSave(run, true)
    this.finishRun(run)

    if (unlisted && text) {
      void this.resolveUnlistedNames(run, text)
    }
  }

  private handleError(run: SessionRun, error: string): void {
    this.updateLastAssistant(run, (last) => ({
      ...last,
      error,
      streaming: false,
    }))
    if (run.activeRequestId) {
      this.requestToSession.delete(run.activeRequestId)
      run.activeRequestId = null
      this.opts.onActiveRequestChange?.(run.sessionId, null)
    }
    run.status = 'failed'
    this.scheduleSave(run, true)
    this.finishRun(run)
  }

  private finishRun(run: SessionRun): void {
    if (run.activeRequestId) {
      this.requestToSession.delete(run.activeRequestId)
      run.activeRequestId = null
      this.opts.onActiveRequestChange?.(run.sessionId, null)
    }
    this.notifyStatus(run)
    // Promote next in queue
    if (this.queue.length > 0 && this.countActive() < MAX_CONCURRENT_RUNS) {
      const nextId = this.queue.shift()!
      const nextRun = this.runs.get(nextId)
      if (nextRun && !nextRun.dead && nextRun.status === 'queued') {
        void this.startRunExecution(nextRun)
      }
    }
  }

  stop(id: string): void {
    const run = this.getRun(id)
    if (!run || run.dead) return

    // If queued, remove from queue
    const qIdx = this.queue.indexOf(run.sessionId)
    if (qIdx >= 0) {
      this.queue.splice(qIdx, 1)
    }

    if (run.activeRequestId) {
      void this.opts.api.aiStreamCancel(run.activeRequestId)
      this.requestToSession.delete(run.activeRequestId)
      run.activeRequestId = null
      this.opts.onActiveRequestChange?.(run.sessionId, null)
    }

    run.runGeneration++
    run.activeRun = 0
    run.currentUserTurnId = ''
    run.inFlightOpen.clear()
    run.loop?.reset()
    run.needsSeed = true

    this.updateLastAssistant(run, (last) => {
      const { candidates: _candidates, ...rest } = last
      const picked = last.text ? this.settleFiles(run, last.text, false) : null
      return {
        ...rest,
        streaming: false,
        ...(picked && picked.sources.length > 0 ? { sources: picked.sources } : {}),
        error: last.text ? undefined : this.opts.translate('homeChatStopped'),
      }
    })

    run.status = 'stopped'
    this.scheduleSave(run, true)
    this.finishRun(run)
  }

  delete(id: string): void {
    const run = this.getRun(id)
    if (!run) return
    this.stop(run.sessionId)
    run.dead = true
    this.runs.delete(run.sessionId)
    if (run.persistedId) this.runs.delete(run.persistedId)
  }

  private ensureLoopForRun(
    run: SessionRun,
    settings: Awaited<ReturnType<HomeApi['getAiSettings']>>,
  ): AgentLoop {
    if (run.loop) return run.loop

    const transport = createIpcTransport({
      route: createGeminiRouter(),
      sessionId: () => run.executionId,
      onAttemptStarted: ({ requestId }) => {
        run.activeRequestId = requestId
        this.requestToSession.set(requestId, run.sessionId)
        this.opts.onActiveRequestChange?.(run.sessionId, requestId)
      },
      onStream: (listener) => {
        if (typeof this.opts.api.onAiStream === 'function') {
          return this.opts.api.onAiStream(listener)
        }
        return () => {}
      },
      start: (request) => this.opts.api.aiStream(request),
      cancel: (requestId) => void this.opts.api.aiStreamCancel(requestId),
      getSettings: () => settings,
      unknownErrorText: () => this.opts.translate('homeChatError'),
      timeoutErrorText: () => this.opts.translate('homeChatError'),
      creditsErrorText: () => this.opts.translate('homeChatCredits'),
      networkErrorText: () => this.opts.translate('homeChatNetwork'),
      overloadedErrorText: () => this.opts.translate('homeChatBusy'),
      quotaErrorText: (resetAt) => agyErrorText(this.opts.getLang(), 'quota', { resetAt }),
      authErrorText: () => agyErrorText(this.opts.getLang(), 'auth'),
    })

    const isCurrent = () =>
      !run.dead && run.status === 'running' && run.activeRun === run.runGeneration

    const docSkill = createDocumentSkill({
      getSessionId: () => run.executionId,
      getExecutionId: () => run.executionId,
      getUserTurnId: () => run.currentUserTurnId,
      fileExists: async (path: string) => {
        try {
          if (typeof this.opts.api.statPaths === 'function') {
            const entries = await this.opts.api.statPaths([path])
            return Boolean(entries[0] && !entries[0].missing)
          }
          return true
        } catch {
          return true
        }
      },
      create: async (request) => {
        const result = await this.opts.api.kbCreateDocument({
          title: request.title,
          format: request.format,
          content: request.content,
          sessionId: run.executionId,
          userTurnId: run.currentUserTurnId,
          documentSlot: request.documentSlot || request.callId,
          callId: request.callId,
          documentType: request.documentType,
        })
        if (isCurrent()) {
          run.createdPaths.add(result.path)
          run.fileTable.addFile({
            path: result.path,
            name: result.path.split(/[\\/]/).pop() ?? result.path,
          })
        }
        return { path: result.path }
      },
      open: (path, context) => {
        if (!isCurrent()) return false
        // Never steal focus if another conversation is currently active/selected
        if (this.opts.getActiveSessionId() !== run.sessionId) return false
        return this.openDocumentPath(run, path, context)
      },
      isOpen: (path) => {
        if (this.opts.isOpenPath) return this.opts.isOpenPath(path)
        return false
      },
    })

    const loop = new AgentLoop({
      transport,
      skill: composeSkills('home+remembered-documents+kb', '', [
        createDocumentMemorySkill(refBridge(this.opts.api, () => run.fileTable)),
        createKnowledgeBaseSkill({
          listFiles: () => {
            const list = this.corpus
            for (const f of list) {
              run.fileTable.addFile({ path: f.path, name: f.name, location: f.folder })
            }
            return list
          },
          search: async (query, limit) => {
            const hits = await this.opts.api.kbSearch({ q: query, limit })
            if (!isCurrent()) return hits
            for (const hit of hits) {
              run.fileTable.addFile({ path: hit.path, name: hit.name, location: hit.folder })
            }
            return hits
          },
          read: async (path, offset) => {
            const f = this.corpus.find((file) => file.path === path)
            const page = await this.opts.api.kbRead(path, offset)
            if (!isCurrent()) return page
            run.fileTable.addFile({
              path,
              name: f?.name ?? path.split(/[\\/]/).pop() ?? 'Document',
              location: f?.folder ?? '',
            })
            return page
          },
          alsoCitable: () => [...run.createdPaths],
        }),
        docSkill,
      ]),
      maxTurns: 12,
      formatUserMessage: (instruction, context) =>
        [instruction, context, run.retrievalContext?.block].filter(Boolean).join('\n\n'),
      systemSuffix: () =>
        run.retrievalContext
          ? agySystemSuffix(LANGUAGE_NAMES[this.opts.getLang()] ?? 'English', {
              ...run.retrievalContext,
              block: '',
            })
          : `Reply in ${LANGUAGE_NAMES[this.opts.getLang()] ?? 'English'}. This is a home assistant: answer questions, search knowledge base and help find files the user has opened or starred. Use remembered-document and knowledge-base tools when relevant. Never guess document contents or source identifiers. ${FILE_CITATION_RULES_TOOLS}`,
      events: {
        onText: (text) => {
          if (isCurrent()) {
            this.handleText(run, text)
          }
        },
        onToolExecuted: ({ call }) => {
          if (
            !isCurrent() ||
            ![
              'search_remembered_documents',
              'search_knowledge_base',
              'read_knowledge_file',
              'create_document',
            ].includes(call.name)
          )
            return
          this.updateLastAssistant(run, (last) => ({ ...last, candidates: run.fileTable.list() }))
        },
        onDone: ({ text, cancelled }) => {
          if (cancelled) {
            this.stop(run.sessionId)
          } else {
            this.handleDone(run, text)
          }
        },
        onError: (err) => {
          this.handleError(run, err)
        },
      },
    })

    run.loop = loop
    return loop
  }

  private settleFiles(run: SessionRun, text: string, fallback: boolean): PickedSources {
    const all = run.fileTable.list()
    return pickSources(text, all, {
      fallback,
      pool: all.filter((source) => (source.ref ?? 0) >= run.turnStart),
    })
  }

  private async resolveUnlistedNames(run: SessionRun, answer: string): Promise<void> {
    const known = new Set(run.fileTable.list().map((s) => s.name.normalize('NFC').toLowerCase()))
    const unlisted = fileNamesIn(answer).filter(
      (name) => !known.has(name.normalize('NFC').toLowerCase()),
    )
    for (const name of unlisted.slice(0, 6)) {
      for (const variant of fileNameVariants(name)) {
        const wanted = variant.normalize('NFC').toLowerCase()
        const matches = await findFilesByName(this.opts.api, variant, 12, 60).catch(() => [])
        const file = matches.find((m) => m.name.normalize('NFC').toLowerCase() === wanted)
        if (!file) continue
        run.fileTable.addFile(file)
        break
      }
      if (run.dead) return
    }
    const picked = this.settleFiles(run, answer, true)
    this.updateLastAssistant(run, (last) => ({
      ...last,
      ...(picked.sources.length > 0 ? { sources: picked.sources } : {}),
    }))
    this.scheduleSave(run, true)
  }

  private openDocumentPath(
    run: SessionRun,
    path: string,
    context?: CreateDocumentExecutionContext,
  ): Promise<boolean> {
    const existing = run.inFlightOpen.get(path)
    if (existing) return existing

    const startGen = run.runGeneration
    const startRun = run.activeRun
    const startTurnId = run.currentUserTurnId

    const isAuthorized = () => {
      if (this.destroyed || run.dead) return false
      if (run.status === 'stopped' || run.status === 'failed') return false
      if (startRun === 0 || run.activeRun !== startRun || run.runGeneration !== startGen)
        return false
      if (this.opts.getActiveSessionId() !== run.sessionId) return false
      if (
        context?.sessionId &&
        context.sessionId !== run.executionId &&
        context.sessionId !== run.sessionId
      ) {
        return false
      }
      if (context?.userTurnId && context.userTurnId !== startTurnId) {
        return false
      }
      if (this.opts.isMounted && !this.opts.isMounted()) return false
      return true
    }

    if (!isAuthorized()) return Promise.resolve(false)

    let openPromise: Promise<boolean> | undefined
    const task = (async () => {
      try {
        if (!isAuthorized()) return false

        if (this.opts.isOpenPath) {
          try {
            await this.opts.isOpenPath(path)
          } catch {
            // ignore error and proceed with opening
          }
        }
        if (!isAuthorized()) return false

        run.openStates.set(path, 'opening')
        let success = false
        if (this.opts.onOpenPath) {
          const res = await this.opts.onOpenPath(path)
          success = typeof res === 'boolean' ? res : true
        } else if (typeof this.opts.api.openPath === 'function') {
          success = await this.opts.api.openPath(path)
        }
        if (!isAuthorized()) return false

        if (success) {
          run.openStates.set(path, 'opened')
          run.openedPaths.add(path)
        } else {
          run.openStates.set(path, 'failed')
        }
        return success
      } catch (err) {
        console.error('Failed to open document:', err)
        if (isAuthorized()) {
          run.openStates.set(path, 'failed')
        }
        return false
      } finally {
        if (openPromise && run.inFlightOpen.get(path) === openPromise) {
          run.inFlightOpen.delete(path)
        }
      }
    })()

    openPromise = task
    run.inFlightOpen.set(path, task)
    return task
  }

  private updateLastAssistant(run: SessionRun, patch: (last: ChatItem) => ChatItem): void {
    const last = run.items.at(-1)
    if (last?.role !== 'assistant') return
    const updated = patch(last)
    run.items = [...run.items.slice(0, -1), updated]
    this.notifyItems(run)
  }

  private notifyItems(run: SessionRun): void {
    if (this.opts.onItemsChange) {
      this.opts.onItemsChange(run.sessionId, [...run.items])
    }
  }

  private notifyStatus(run: SessionRun): void {
    if (this.opts.onStatusChange) {
      this.opts.onStatusChange(run.sessionId, run.status)
      if (run.persistedId && run.persistedId !== run.sessionId) {
        this.opts.onStatusChange(run.persistedId, run.status)
      }
    }
  }

  private scheduleSave(run: SessionRun, immediate = false): void {
    if (run.dead || run.items.length === 0 || run.items === run.lastSavedItems) return
    if (run.saveTimer) {
      window.clearTimeout(run.saveTimer)
      run.saveTimer = undefined
    }
    const save = () => {
      run.saveTimer = undefined
      run.lastSavedItems = run.items
      this.performSave(run, run.items)
    }
    if (immediate) {
      save()
    } else {
      run.saveTimer = window.setTimeout(save, SAVE_INTERVAL_MS)
    }
  }

  private performSave(run: SessionRun, snapshot: readonly ChatItem[]): void {
    const messages = toMessages(snapshot)
    if (messages.length === 0) return
    const idToSave = run.persistedId || run.sessionId
    this.saveChain = this.saveChain.then(async () => {
      if (run.dead) return
      try {
        const summary = await this.opts.api.homeChatSave({
          id: idToSave,
          messages,
        })
        if (!summary || run.dead) return
        run.persistedId = summary.id
        run.title = summary.title
        if (summary.id !== run.sessionId) {
          this.runs.set(summary.id, run)
        }
        if (this.opts.onSessionUpdated) {
          this.opts.onSessionUpdated(summary)
        }
      } catch {
        // history save failure is best-effort
      }
    })
  }
}
