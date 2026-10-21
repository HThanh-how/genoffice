import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { AgentMessage, AgentToolCall, AgentToolDef } from '@genoffice/agent-core'
import { MAX_SSE_LINE_BYTES, type StreamCallbacks } from './protocols/shared'
import type { AiProviderConfig, AiTokenUsage } from './types'
import { AiTimeoutError } from './watchdog'
import { type AgyActivityPhase } from './agy-activity'
import { resolveAgyEffort, type AgyEffort } from './agy-effort'
import { agyGenericToolTurnSchema, readStructuredToolTurn } from './agy-structured-turn'
import { agyCallId, renderAgyToolCalls, renderAgyToolResult } from './agy-tools'
import {
  buildAgyArgs,
  buildAgyPrompt,
  buildAgyStdin,
  parseAgyStreamLine,
  shortTarget,
  resolveAgyCliPath,
  realRunDeps,
  agyUsageToTokenUsage,
  type AgyDeniedAction,
  type AgyEvent,
  type AgyRunDeps,
} from './agy-cli'
import { createAgyLimiter, type Limiter } from './agy-limiter'
import { classifyAgyFailure, hasAgyPrintTimeoutWarning } from './agy-errors'
import { AGY_CHAT_DEFAULT_MODEL } from './agy-chat'

// ---------------------------------------------------------------------------
// Constants & Limits
// ---------------------------------------------------------------------------

export const AGY_MAX_RESIDENT_WORKERS = 2
export const AGY_RESIDENT_IDLE_TTL_MS = 120_000
export const AGY_RESIDENT_TURN_TIMEOUT_MS = 240_000
const MAX_STDERR_CHARS = 8_000
const MAX_LINE_BYTES = MAX_SSE_LINE_BYTES // 4 MB cap

// ---------------------------------------------------------------------------
// Semantic Fingerprinting & Signatures
// ---------------------------------------------------------------------------

/**
 * Normalizes an AgentMessage to a stable semantic representation.
 * For assistant turns: ignores random tool-call IDs and compares names, arguments, and text.
 * For tool turns: ignores tool result IDs and compares names and output.
 */
export function semanticFingerprint(message: AgentMessage): string {
  if (message.role === 'user') {
    return createHash('sha256')
      .update(JSON.stringify({ role: 'user', text: message.text }))
      .digest('hex')
  }
  if (message.role === 'assistant') {
    const normalizedCalls = (message.toolCalls ?? []).map((call) => ({
      name: call.name,
      arguments: call.input,
    }))
    return createHash('sha256')
      .update(
        JSON.stringify({
          role: 'assistant',
          text: message.text.trim(),
          toolCalls: normalizedCalls,
        }),
      )
      .digest('hex')
  }
  const normalizedResults = (message.results ?? []).map((res) => ({
    name: res.name,
    output: res.output,
  }))
  return createHash('sha256')
    .update(JSON.stringify({ role: 'tool', results: normalizedResults }))
    .digest('hex')
}

/**
 * Signature for resident session configuration.
 * Any change in system instructions, tool definitions, model, or effort requires a reseed.
 */
export function residentSessionSignature(
  system: string,
  tools: readonly AgentToolDef[],
  model: string,
  effort?: string,
): string {
  const normalizedTools = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }))
  return createHash('sha256')
    .update(
      JSON.stringify({
        system: system.trim(),
        tools: normalizedTools,
        model: model.trim(),
        effort: effort ?? '',
      }),
    )
    .digest('hex')
}

/**
 * Render new causal messages for turn 2+ over stream-json stdin without full flattened replay.
 */
export function renderCausalMessages(messages: readonly AgentMessage[]): string {
  const parts: string[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      parts.push(`User: ${m.text}`)
    } else if (m.role === 'assistant') {
      const calls = m.toolCalls?.length ? renderAgyToolCalls(m.toolCalls) : ''
      const text = [m.text.trim(), calls].filter(Boolean).join('\n')
      if (text) parts.push(`Assistant: ${text}`)
    } else if (m.role === 'tool') {
      for (const r of m.results) {
        parts.push(renderAgyToolResult(r))
      }
    }
  }
  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// Eligibility check
// ---------------------------------------------------------------------------

export interface ResidentEligibilityInput {
  sessionId?: string | undefined
  tools: readonly AgentToolDef[]
  protocol: 'text' | 'schema'
  messages: readonly AgentMessage[]
}

/**
 * Minimal resident support is enabled ONLY for:
 * 1. Stable sessionId present
 * 2. Tool-rich turn (tools.length > 0)
 * 3. Schema protocol
 * 4. Zero attachments (attachments stay on safe one-shot path until separately proven)
 */
export function isResidentEligible(input: ResidentEligibilityInput): boolean {
  if (!input.sessionId?.trim()) return false
  if (input.tools.length === 0) return false
  if (input.protocol !== 'schema') return false
  const hasAttachments = input.messages.some(
    (m) => m.role === 'user' && (m.images?.length ?? 0) > 0,
  )
  return !hasAttachments
}

// ---------------------------------------------------------------------------
// Worker & Session Models
// ---------------------------------------------------------------------------

interface ResidentWorker {
  id: string
  child: ChildProcessWithoutNullStreams
  cliPath: string
  model: string
  effort?: AgyEffort | undefined
  stagingDir: string
  jsonSchemaPath: string
  boundSessionKey?: string | undefined
  lastUsedAt: number
  inUse: boolean
  idleTimer?: ReturnType<typeof setTimeout> | undefined
  stderrTail: string
  spawnedAt: number
  turnCount: number
  stdinWrittenForCurrentTurn: boolean
  currentTurnSettled: boolean
  retireAfterCurrentTurn?: boolean | undefined
  retired?: boolean | undefined
  stop: () => void
}

interface ResidentSession {
  key: string
  scope: string
  sessionId: string
  workerId: string
  signature: string
  semanticFingerprints: string[]
  conversationId?: string | undefined
}

// ---------------------------------------------------------------------------
// Resident Pool & Lifecycle Manager
// ---------------------------------------------------------------------------

class AgyResidentManager {
  private readonly workers = new Map<string, ResidentWorker>()
  private readonly sessions = new Map<string, ResidentSession>()
  private _limiter?: Limiter | undefined

  private get limiter(): Limiter {
    if (!this._limiter) {
      this._limiter = createAgyLimiter(AGY_MAX_RESIDENT_WORKERS)
    }
    return this._limiter
  }

  get workerCount(): number {
    return this.workers.size
  }

  get sessionCount(): number {
    return this.sessions.size
  }

  /**
   * Shuts down all resident workers and wipes temp directories.
   */
  shutdown(deps?: AgyRunDeps): void {
    const effectiveDeps = deps ?? realRunDeps
    for (const worker of [...this.workers.values()]) {
      void this.retireWorker(worker, effectiveDeps)
    }
    this.workers.clear()
    this.sessions.clear()
    this.sessionLocks.clear()
    this._limiter = undefined
    this.spawnQueue = Promise.resolve()
  }

  retireScope(scope: string, deps?: AgyRunDeps): void {
    const effectiveDeps = deps ?? realRunDeps
    const prefix = `${scope}:`
    for (const [key, session] of [...this.sessions.entries()]) {
      if (key.startsWith(prefix) || session.scope === scope) {
        this.sessions.delete(key)
        const worker = this.workers.get(session.workerId)
        if (worker) {
          if (worker.inUse) {
            worker.retireAfterCurrentTurn = true
          } else {
            void this.retireWorker(worker, effectiveDeps)
          }
        }
      }
    }
  }

  private prewarmPromise?: Promise<void> | undefined
  private spawnQueue: Promise<void> = Promise.resolve()

  private async acquireOrSpawnWorker(
    cliPath: string,
    model: string,
    effort: AgyEffort | undefined,
    deps: AgyRunDeps,
  ): Promise<ResidentWorker> {
    const current = this.spawnQueue
    let resolveQueue!: () => void
    this.spawnQueue = new Promise((resolve) => {
      resolveQueue = resolve
    })
    await current.catch(() => undefined)
    try {
      const existing = this.findUnboundWorker(cliPath, model, effort)
      if (existing) {
        existing.inUse = true
        if (existing.idleTimer) {
          clearTimeout(existing.idleTimer)
          existing.idleTimer = undefined
        }
        return existing
      }
      if (this.workers.size >= AGY_MAX_RESIDENT_WORKERS) {
        this.evictOldestIdleWorker(deps)
      }
      const spawned = await this.spawnWorker(
        {
          cliPath,
          model,
          ...(effort !== undefined ? { effort } : {}),
        },
        deps,
      )
      spawned.inUse = true
      if (spawned.idleTimer) {
        clearTimeout(spawned.idleTimer)
        spawned.idleTimer = undefined
      }
      return spawned
    } finally {
      resolveQueue()
    }
  }

  /**
   * Prewarms a resident worker idempotently if capacity permits.
   * Does NOT write to stdin, preserving 0 model token consumption.
   */
  async prewarm(config: AiProviderConfig, deps: AgyRunDeps): Promise<void> {
    if (this.prewarmPromise) return this.prewarmPromise
    this.prewarmPromise = this.prewarmInternal(config, deps).finally(() => {
      this.prewarmPromise = undefined
    })
    return this.prewarmPromise
  }

  private async prewarmInternal(config: AiProviderConfig, deps: AgyRunDeps): Promise<void> {
    const cliPath = await resolveAgyCliPath(config.cliPath, deps)
    const model = config.model?.trim() || AGY_CHAT_DEFAULT_MODEL
    const capabilities = deps.capabilities ? await deps.capabilities(cliPath) : undefined
    if (!capabilities?.jsonSchema) return // only schema protocol benefits from resident generic schema

    const effort = capabilities?.effort
      ? resolveAgyEffort({
          task: 'chat',
          effort: undefined,
          model,
          env: deps.env.GENOFFICE_AGY_EFFORT,
        })
      : undefined

    const current = this.spawnQueue
    let resolveQueue!: () => void
    this.spawnQueue = new Promise((resolve) => {
      resolveQueue = resolve
    })
    await current.catch(() => undefined)
    try {
      for (const worker of this.workers.values()) {
        if (
          !worker.boundSessionKey &&
          !worker.inUse &&
          worker.cliPath === cliPath &&
          worker.model === model &&
          worker.effort === effort
        ) {
          return
        }
      }
      if (this.workers.size >= AGY_MAX_RESIDENT_WORKERS) {
        this.evictOldestIdleWorker(deps)
      }
      if (this.workers.size >= AGY_MAX_RESIDENT_WORKERS) return
      await this.spawnWorker(
        {
          cliPath,
          model,
          ...(effort !== undefined ? { effort } : {}),
        },
        deps,
      )
    } finally {
      resolveQueue()
    }
  }

  /**
   * Executes a turn on a resident worker.
   */
  private readonly sessionLocks = new Map<string, Promise<unknown>>()

  async executeTurn(input: {
    config: AiProviderConfig
    system: string
    messages: AgentMessage[]
    tools: AgentToolDef[]
    cb: StreamCallbacks
    deps: AgyRunDeps
    say?: (activity: { phase: AgyActivityPhase; [key: string]: unknown }) => void
  }): Promise<{ text: string; calls: AgentToolCall[]; usage?: AiTokenUsage }> {
    const scope = String(input.cb.sessionScope ?? 'global')
    const sessionId = input.cb.sessionId!
    const sessionKey = `${scope}:${sessionId}`

    const prevLock = this.sessionLocks.get(sessionKey) ?? Promise.resolve()
    let resolveLock!: () => void
    const currentLock = new Promise<void>((r) => {
      resolveLock = r
    })
    this.sessionLocks.set(sessionKey, currentLock)
    try {
      await prevLock.catch(() => undefined)
      if (input.cb.signal.aborted) {
        const err = new Error('Request aborted')
        err.name = 'AbortError'
        throw err
      }
      return await this.executeTurnInternal(input, sessionKey, scope, sessionId)
    } finally {
      resolveLock()
      if (this.sessionLocks.get(sessionKey) === currentLock) {
        this.sessionLocks.delete(sessionKey)
      }
    }
  }

  private async executeTurnInternal(
    input: {
      config: AiProviderConfig
      system: string
      messages: AgentMessage[]
      tools: AgentToolDef[]
      cb: StreamCallbacks
      deps: AgyRunDeps
      say?: (activity: { phase: AgyActivityPhase; [key: string]: unknown }) => void
    },
    sessionKey: string,
    scope: string,
    sessionId: string,
  ): Promise<{ text: string; calls: AgentToolCall[]; usage?: AiTokenUsage }> {
    const { config, system, messages, tools, cb, deps, say } = input

    let worker: ResidentWorker | undefined
    let releaseLimiter: (() => void) | undefined
    let releaseMachine: (() => Promise<void>) | undefined

    try {
      // Acquire permits ONLY for the duration of the turn. Idle residents hold 0 permits.
      // Acquiring BEFORE worker acquisition bounds total active workers to AGY_MAX_RESIDENT_WORKERS.
      releaseLimiter = await this.limiter.acquire(cb.signal)
      if (deps.machineSemaphore) {
        releaseMachine = await deps.machineSemaphore.acquire(
          AGY_RESIDENT_TURN_TIMEOUT_MS,
          cb.signal,
        )
      }

      const cliPath = await resolveAgyCliPath(config.cliPath, deps)
      const model = config.model?.trim() || AGY_CHAT_DEFAULT_MODEL
      const capabilities = deps.capabilities ? await deps.capabilities(cliPath) : undefined
      const effort = capabilities?.effort
        ? resolveAgyEffort({
            task: 'chat',
            effort: undefined,
            model,
            env: deps.env.GENOFFICE_AGY_EFFORT,
          })
        : undefined

      const currentSignature = residentSessionSignature(system, tools, model, effort)
      let session = this.sessions.get(sessionKey)

      // Check if existing session can be reused incrementally
      let canReuseSession = false
      let isIncremental = false
      if (session && session.signature === currentSignature) {
        if (messages.length >= session.semanticFingerprints.length) {
          let prefixMatches = true
          for (let i = 0; i < session.semanticFingerprints.length; i++) {
            if (semanticFingerprint(messages[i]!) !== session.semanticFingerprints[i]) {
              prefixMatches = false
              break
            }
          }
          if (prefixMatches) {
            canReuseSession = true
            isIncremental = messages.length > session.semanticFingerprints.length
          }
        }
      }

      if (canReuseSession && session) {
        worker = this.workers.get(session.workerId)
        if (!worker || worker.inUse || worker.cliPath !== cliPath) {
          // Worker was terminated, is busy, or belongs to a different executable; reseed
          canReuseSession = false
        }
      }

      if (!canReuseSession) {
        // Reseed: clear prior session and retire old worker if bound
        if (session) {
          const oldWorker = this.workers.get(session.workerId)
          if (oldWorker) await this.retireWorker(oldWorker, deps)
          this.sessions.delete(sessionKey)
        }

        // Acquire an unbound warm worker or spawn a new one (serialized against concurrent spawns)
        worker = await this.acquireOrSpawnWorker(cliPath, model, effort, deps)

        worker.boundSessionKey = sessionKey
        session = {
          key: sessionKey,
          scope,
          sessionId,
          workerId: worker.id,
          signature: currentSignature,
          semanticFingerprints: [],
        }
        this.sessions.set(sessionKey, session)
        isIncremental = false
      } else {
        worker!.inUse = true
        if (worker!.idleTimer) {
          clearTimeout(worker!.idleTimer)
          worker!.idleTimer = undefined
        }
      }

      if (!worker || !session) {
        throw new Error('Failed to acquire resident AGY worker')
      }

      // Determine prompt to write to stdin
      let promptToSend: string
      if (isIncremental) {
        const newMessages = messages.slice(session.semanticFingerprints.length)
        promptToSend = renderCausalMessages(newMessages)
      } else {
        const plan = buildAgyPrompt(system, messages, tools, 'schema')
        promptToSend = plan.prompt
      }

      worker.stdinWrittenForCurrentTurn = false
      worker.currentTurnSettled = false

      const deadline = Date.now() + AGY_RESIDENT_TURN_TIMEOUT_MS
      let result = await this.runTurnOnWorker({
        worker,
        prompt: promptToSend,
        signal: cb.signal,
        timeoutMs: AGY_RESIDENT_TURN_TIMEOUT_MS,
        deps,
        cb,
        ...(say ? { say } : {}),
      })

      // Turn succeeded! Validate structured output
      const known = new Set(tools.map((t) => t.name))
      let structured = readStructuredToolTurn(result.structured, known)
      if (!structured) {
        const initial = result
        // Correct formatting once on this same conversation. Do not replay the request,
        // spawn a fallback process, or execute tool-looking text from an invalid response.
        worker.currentTurnSettled = false
        result = await this.runTurnOnWorker({
          worker,
          prompt:
            'Your previous response could not be read as the required GenOffice response schema. ' +
            'Correct only its formatting: put intended host calls in top-level tool_calls and visible prose in text. ' +
            'Do not put a serialized response envelope in text. If the user requested a JSON example, ' +
            'explain that example as prose; do not execute its contents. ' +
            'Do not repeat any action already confirmed by a Tool result. Do not invoke CLI tools.',
          signal: cb.signal,
          timeoutMs: Math.max(1, deadline - Date.now()),
          deps,
          cb,
          ...(say ? { say } : {}),
        })
        if (!result.conversationId && initial.conversationId)
          result.conversationId = initial.conversationId
        if (initial.usage) {
          const usage = { ...result.usage }
          for (const key of Object.keys(initial.usage) as (keyof AiTokenUsage)[]) {
            usage[key] = (usage[key] ?? 0) + (initial.usage[key] ?? 0)
          }
          result.usage = usage
        }
        structured = readStructuredToolTurn(result.structured, known)
      }
      if (!structured) {
        throw new Error('Antigravity resident returned invalid structured turn')
      }

      const returnedCalls: AgentToolCall[] = structured.calls.map((call, index) => ({
        id: agyCallId(index),
        name: call.name,
        input: call.input,
      }))

      // Update session semantic history including returned assistant turn
      const assistantMessage: AgentMessage = {
        role: 'assistant',
        text: structured.text,
        toolCalls: returnedCalls,
      }
      session.semanticFingerprints = [...messages, assistantMessage].map(semanticFingerprint)
      if (result.conversationId) session.conversationId = result.conversationId

      worker.lastUsedAt = Date.now()
      return {
        text: structured.text,
        calls: returnedCalls,
        ...(result.usage ? { usage: result.usage } : {}),
      }
    } catch (error) {
      // "After any stdin write, timeout/cancel/error retires worker and surfaces error."
      if (worker) {
        await this.retireWorker(worker, deps)
        this.sessions.delete(sessionKey)
      }
      throw error
    } finally {
      if (worker) {
        worker.inUse = false
      }
      await releaseMachine?.().catch(() => undefined)
      releaseLimiter?.()

      if (worker) {
        if (worker.retireAfterCurrentTurn || !this.workers.has(worker.id)) {
          await this.retireWorker(worker, deps)
        } else if (!worker.idleTimer) {
          worker.idleTimer = setTimeout(() => {
            void this.retireWorker(worker!, deps)
          }, AGY_RESIDENT_IDLE_TTL_MS)
          worker.idleTimer.unref?.()
        }
      }
    }
  }

  private findUnboundWorker(
    cliPath: string,
    model: string,
    effort?: AgyEffort,
  ): ResidentWorker | undefined {
    for (const worker of this.workers.values()) {
      if (
        !worker.boundSessionKey &&
        !worker.inUse &&
        worker.cliPath === cliPath &&
        worker.model === model &&
        worker.effort === effort
      ) {
        return worker
      }
    }
    return undefined
  }

  private evictOldestIdleWorker(deps: AgyRunDeps): void {
    let oldest: ResidentWorker | undefined
    for (const worker of this.workers.values()) {
      if (worker.inUse) continue
      if (!oldest || worker.lastUsedAt < oldest.lastUsedAt) {
        oldest = worker
      }
    }
    if (oldest) {
      void this.retireWorker(oldest, deps)
    }
  }

  private async retireWorker(worker: ResidentWorker, deps?: AgyRunDeps): Promise<void> {
    if (worker.retired) return
    worker.retired = true
    if (worker.idleTimer) {
      clearTimeout(worker.idleTimer)
      worker.idleTimer = undefined
    }
    this.workers.delete(worker.id)
    if (worker.boundSessionKey) {
      this.sessions.delete(worker.boundSessionKey)
    }
    try {
      worker.stop()
    } catch {
      /* already stopped */
    }
    if (deps) {
      try {
        await deps.removeDir(worker.stagingDir)
      } catch {
        /* already removed */
      }
    }
  }

  private async spawnWorker(
    input: { cliPath: string; model: string; effort?: AgyEffort | undefined },
    deps: AgyRunDeps,
  ): Promise<ResidentWorker> {
    const id = randomUUID()
    const stagingDir = await deps.makeStagingDir()
    const pathJoin = deps.platform === 'win32' ? win32.join : posix.join
    const jsonSchemaPath = pathJoin(stagingDir, 'agy-response-schema.json')

    // Fixed generic schema without enum
    const genericSchema = agyGenericToolTurnSchema()
    await deps.writeFile(jsonSchemaPath, new TextEncoder().encode(JSON.stringify(genericSchema)))

    const args = buildAgyArgs({
      model: input.model,
      stagingDir,
      timeoutMs: AGY_RESIDENT_TURN_TIMEOUT_MS,
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      jsonSchemaPath,
    })

    const child = deps.spawn(input.cliPath, args, {
      cwd: stagingDir,
      env: { ...deps.env },
    })

    const worker: ResidentWorker = {
      id,
      child,
      cliPath: input.cliPath,
      model: input.model,
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      stagingDir,
      jsonSchemaPath,
      lastUsedAt: Date.now(),
      inUse: false,
      stderrTail: '',
      spawnedAt: Date.now(),
      turnCount: 0,
      stdinWrittenForCurrentTurn: false,
      currentTurnSettled: false,
      stop: () => deps.killTree(child),
    }

    // Drain stderr continuously to bounded tail
    child.stderr.on('data', (chunk: Buffer) => {
      worker.stderrTail = (worker.stderrTail + chunk.toString('utf8')).slice(-MAX_STDERR_CHARS)
    })
    child.stdin.on('error', () => undefined)

    child.on('error', () => {
      void this.retireWorker(worker, deps)
    })
    child.on('close', () => {
      void this.retireWorker(worker, deps)
    })

    // Set idle TTL
    worker.idleTimer = setTimeout(() => {
      void this.retireWorker(worker, deps)
    }, AGY_RESIDENT_IDLE_TTL_MS)
    worker.idleTimer.unref?.()

    this.workers.set(id, worker)
    return worker
  }

  private async runTurnOnWorker(input: {
    worker: ResidentWorker
    prompt: string
    signal: AbortSignal
    timeoutMs: number
    deps: AgyRunDeps
    cb: StreamCallbacks
    say?: ((activity: { phase: AgyActivityPhase; [key: string]: unknown }) => void) | undefined
  }): Promise<{
    structured?: unknown
    conversationId?: string
    usage?: AiTokenUsage
    deniedActions?: AgyDeniedAction[]
  }> {
    const { worker, prompt, signal, timeoutMs, cb, say } = input

    return new Promise((resolve, reject) => {
      worker.stderrTail = '' // Clear prior turn stderr so past warnings do not contaminate
      worker.turnCount += 1
      const turnSentAt = Date.now()
      let text = ''
      let usage: AiTokenUsage | undefined
      let conversationId: string | undefined
      let resultSeen: Extract<AgyEvent, { kind: 'result' }> | undefined
      const decoder = new StringDecoder('utf8')
      let pending = ''

      const onClose = (code: number | null) => {
        fail(
          classifyAgyFailure({
            resultError: resultSeen?.error,
            stderr: worker.stderrTail,
            exitCode: code,
            partialText: text || resultSeen?.response || '',
          }),
        )
      }
      worker.child.once('close', onClose)

      const cleanup = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        worker.child.stdout.removeListener('data', onStdout)
        worker.child.removeListener('close', onClose)
        try {
          worker.child.stdout.resume()
        } catch {
          /* already closed or ended */
        }
      }

      const finish = (action: () => void) => {
        if (worker.currentTurnSettled) return
        worker.currentTurnSettled = true
        cleanup()
        action()
      }

      const fail = (error: Error) =>
        finish(() => {
          reject(error)
        })

      const onAbort = () => {
        const err = new Error('Request aborted')
        err.name = 'AbortError'
        fail(err)
      }

      const timer = setTimeout(() => {
        fail(new AiTimeoutError(timeoutMs))
      }, timeoutMs)

      const handleLine = (line: string) => {
        const event = parseAgyStreamLine(line)
        if (!event) return
        if (event.kind === 'init' && event.conversationId) {
          conversationId = event.conversationId
        }
        if (event.kind === 'step') {
          if (event.stepType === 'tool' && event.toolName) {
            say?.({
              phase: 'tool',
              tool: event.toolName,
              ...(event.toolTarget
                ? { target: shortTarget(event.toolTarget, event.toolTargetKind) }
                : {}),
              ...(event.durationSeconds !== undefined
                ? { stepSeconds: event.durationSeconds }
                : {}),
            })
          } else if (event.stepType === 'agent_response' && event.thinkingTokens) {
            say?.({
              phase: 'thinking',
              thinkingTokens: event.thinkingTokens,
              ...(event.durationSeconds !== undefined
                ? { stepSeconds: event.durationSeconds }
                : {}),
            })
          }
        }
        if (event.kind === 'text') {
          text += event.text
        } else if (event.kind === 'result') {
          resultSeen = event
          if (event.conversationId) conversationId = event.conversationId
          if (event.usage) {
            usage = agyUsageToTokenUsage(event.usage)
            cb.onUsage?.(usage)
          }
          finish(() => {
            const truncated = hasAgyPrintTimeoutWarning(worker.stderrTail)
            if (truncated) {
              const tail = worker.stderrTail.trim().slice(-300)
              const now = Date.now()
              const spawnAge = Math.round((now - worker.spawnedAt) / 1000)
              const turnAge = Math.round((now - turnSentAt) / 1000)
              reject(
                new Error(
                  `Antigravity CLI turn timed out partially (worker=${worker.id} spawnAge=${spawnAge}s turnAge=${turnAge}s turns=${worker.turnCount}${tail ? ` agy stderr: ${tail}` : ''})`,
                ),
              )
              return
            }
            if (resultSeen?.ok) {
              resolve({
                structured: resultSeen.structured,
                ...(conversationId ? { conversationId } : {}),
                ...(usage ? { usage } : {}),
                ...(resultSeen.deniedActions ? { deniedActions: resultSeen.deniedActions } : {}),
              })
            } else {
              reject(
                classifyAgyFailure({
                  resultError: resultSeen?.error,
                  stderr: worker.stderrTail,
                  exitCode: null,
                  partialText: text || resultSeen?.response || '',
                }),
              )
            }
          })
        }
      }

      const onStdout = (chunk: Buffer) => {
        cb.onActivity?.()
        pending += decoder.write(chunk)
        let nl = pending.indexOf('\n')
        while (nl >= 0) {
          handleLine(pending.slice(0, nl))
          pending = pending.slice(nl + 1)
          nl = pending.indexOf('\n')
        }
        if (pending.length > MAX_LINE_BYTES) {
          pending = ''
          fail(new Error(`Stdout line exceeded limit of ${MAX_LINE_BYTES} bytes`))
        }
      }

      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
      worker.child.stdout.on('data', onStdout)

      // Send prompt on stdin
      worker.stdinWrittenForCurrentTurn = true
      worker.child.stdin.write(buildAgyStdin(prompt), (err) => {
        if (err) {
          fail(new Error(`Failed to write to Antigravity resident stdin: ${err.message}`))
        }
      })
    })
  }
}

// ---------------------------------------------------------------------------
// Global Manager Instance & Public API
// ---------------------------------------------------------------------------

export const agyResidentManager = new AgyResidentManager()

export async function prewarmAgy(config: AiProviderConfig, deps?: AgyRunDeps): Promise<void> {
  const effectiveDeps = deps ?? realRunDeps
  return agyResidentManager.prewarm(config, effectiveDeps)
}

export function shutdownAgyResidentServers(deps?: AgyRunDeps): void {
  const effectiveDeps = deps ?? realRunDeps
  agyResidentManager.shutdown(effectiveDeps)
}

export function retireAgyResidentScope(scope: string, deps?: AgyRunDeps): void {
  const effectiveDeps = deps ?? realRunDeps
  agyResidentManager.retireScope(scope, effectiveDeps)
}
