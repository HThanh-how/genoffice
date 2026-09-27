import type {
  AgentStreamRequest,
  AgentToolCall,
  AgentToolDef,
  AgentTransport,
  AgentMessage,
} from './types'

/**
 * One streamed chunk pushed back over an Electron IPC bridge. Structurally
 * identical to ai-provider's AiStreamChunk; declared here so this package
 * stays dependency-free.
 */
export interface IpcStreamChunk {
  requestId: string
  /** 'ping' = wire-level keepalive; re-arms the silence watchdog and carries no payload;
   * 'reasoning' = model thinking delta (text carries it) */
  type: 'delta' | 'reasoning' | 'tool-call' | 'done' | 'error' | 'ping'
  text?: string
  toolCall?: AgentToolCall
  error?: string
  /** machine-readable error cause; maps to the localized timeout/credits/network/overloaded message */
  errorCode?: 'timeout' | 'credits' | 'network' | 'overloaded'
  /** normalized stop reason on 'done' ('max_tokens' = cut off by the token limit) */
  stopReason?: string
}

/** The request forwarded to the main process to start one streaming turn. */
export interface IpcStreamStart<S> {
  requestId: string
  /** Stable for the lifetime of one renderer-side transport. Providers with
   * native conversations can reuse it across the tool loop and follow-ups. */
  sessionId: string
  settings: S
  system: string
  messages: AgentMessage[]
  tools: AgentToolDef[]
}

/**
 * Renderer-side silence watchdog: the main process re-arms it with keepalive
 * pings on wire activity, so firing means the turn is dead (main-process stall,
 * lost chunks) and the run must fail instead of leaving the UI busy forever.
 * Longer than the main-process idle timeout (180s) so that one (localized) wins.
 */
export const IPC_STREAM_SILENCE_TIMEOUT_MS = 240_000

export interface IpcTransportOptions<S> {
  /** subscribe to stream chunks; returns the unsubscribe function */
  onStream(listener: (chunk: IpcStreamChunk) => void): () => void
  /** forward the start request to the main process; a returned promise reports handler failure */
  start(request: IpcStreamStart<S>): void | Promise<unknown>
  /** abort the in-flight turn in the main process */
  cancel(requestId: string): void
  getSettings(): S
  /** Optional per-turn routing and safe retry before any model output reaches the loop. */
  route?: {
    prepare(settings: S, request?: AgentStreamRequest): S
    /** Deadline for the first useful model output; wire keepalives do not satisfy it. */
    firstContentTimeoutMs?: number
    /** Upper bound for all retries and fallbacks in this streaming turn. */
    maxDurationMs?: number
    maxAttempts?: number
    /** Return a short delay to retry the same model before falling back. */
    retry?(
      settings: S,
      error: string,
      emitted: boolean,
      errorCode?: IpcStreamChunk['errorCode'],
    ): number | null
    fallback(
      settings: S,
      error: string,
      emitted: boolean,
      errorCode?: IpcStreamChunk['errorCode'],
    ): S | null
    onAttempt?(settings: S): void
    onExhausted?(settings: S, reason: 'deadline' | 'attempt_limit'): void
  }
  /** localized fallback when an error chunk carries no message */
  unknownErrorText(): string
  /** localized message for timeouts (errorCode 'timeout' and the silence watchdog) */
  timeoutErrorText?(): string
  /** localized message for exhausted credits (errorCode 'credits') */
  creditsErrorText?(): string
  /** localized message for network connectivity failures (errorCode 'network') */
  networkErrorText?(): string
  /** localized message for capacity/rate-limit failures (errorCode 'overloaded') */
  overloadedErrorText?(): string
}

/**
 * AgentTransport over an Electron IPC bridge: the main process talks to the
 * LLM providers (avoids renderer CORS) and streams chunks back per requestId.
 * Each app wires in its own preload bridge and i18n via the options.
 */
export function createIpcTransport<S>(options: IpcTransportOptions<S>): AgentTransport {
  const timeoutText = () => options.timeoutErrorText?.() ?? options.unknownErrorText()
  const sessionId = crypto.randomUUID()
  return {
    compactionBudget() {
      const settings = options.getSettings() as { provider?: string } | null
      return settings?.provider === 'gemini'
        ? { maxBytes: 128 * 1024, keepRecentBytes: 48 * 1024 }
        : undefined
    },
    stream(request: AgentStreamRequest, cb) {
      let requestId = ''
      let cancelled = false
      let silenceTimer: ReturnType<typeof setTimeout> | undefined
      let firstContentTimer: ReturnType<typeof setTimeout> | undefined
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined
      let retryTimer: ReturnType<typeof setTimeout> | undefined
      let unsubscribe = () => {}
      let settled = false
      let finished = false
      let attempts = 0
      const baseSettings = options.getSettings()
      let settings = options.route?.prepare(baseSettings, request) ?? baseSettings
      const settle = () => {
        settled = true
        clearTimeout(silenceTimer)
        clearTimeout(firstContentTimer)
        unsubscribe()
      }
      const finish = () => {
        finished = true
        clearTimeout(deadlineTimer)
        clearTimeout(retryTimer)
        settle()
      }
      const fail = (error: string) => {
        if (finished) return
        finish()
        cb.onError(error)
      }
      const errorText = (error: string, errorCode?: IpcStreamChunk['errorCode']) =>
        errorCode === 'timeout'
          ? timeoutText()
          : errorCode === 'credits'
            ? (options.creditsErrorText?.() ?? (error || options.unknownErrorText()))
            : errorCode === 'network'
              ? (options.networkErrorText?.() ?? (error || options.unknownErrorText()))
              : errorCode === 'overloaded'
                ? (options.overloadedErrorText?.() ?? (error || options.unknownErrorText()))
                : error || options.unknownErrorText()
      const handleError = (
        error: string,
        emitted: boolean,
        errorCode?: IpcStreamChunk['errorCode'],
      ) => {
        if (cancelled || settled || finished) return
        const canAttempt = attempts < (options.route?.maxAttempts ?? Infinity)
        if (!canAttempt) options.route?.onExhausted?.(settings, 'attempt_limit')
        const retryDelay = canAttempt && options.route?.retry?.(settings, error, emitted, errorCode)
        if (typeof retryDelay === 'number' && Number.isFinite(retryDelay) && retryDelay >= 0) {
          settle()
          retryTimer = setTimeout(() => {
            retryTimer = undefined
            if (!cancelled) attempt()
          }, retryDelay)
          return
        }
        const next = canAttempt && options.route?.fallback(settings, error, emitted, errorCode)
        if (next) {
          settle()
          settings = next
          attempt()
          return
        }
        fail(errorText(error, errorCode))
      }
      if (options.route?.maxDurationMs) {
        deadlineTimer = setTimeout(() => {
          options.route?.onExhausted?.(settings, 'deadline')
          options.cancel(requestId)
          fail(timeoutText())
        }, options.route.maxDurationMs)
      }
      const attempt = (): void => {
        if (cancelled || finished) return
        requestId = crypto.randomUUID()
        const thisRequestId = requestId
        attempts++
        settled = false
        let emitted = false
        const armSilence = () => {
          clearTimeout(silenceTimer)
          silenceTimer = setTimeout(() => {
            options.cancel(requestId)
            handleError('AI request timed out: no stream activity', emitted, 'timeout')
          }, IPC_STREAM_SILENCE_TIMEOUT_MS)
        }
        if (options.route?.firstContentTimeoutMs) {
          firstContentTimer = setTimeout(() => {
            options.cancel(thisRequestId)
            handleError('AI request timed out: no model output', false, 'timeout')
          }, options.route.firstContentTimeoutMs)
        }
        unsubscribe = options.onStream((chunk) => {
          if (chunk.requestId !== requestId || settled) return
          if (chunk.type === 'ping') {
            armSilence()
          } else if (chunk.type === 'delta') {
            armSilence()
            if (chunk.text) {
              emitted = true
              clearTimeout(firstContentTimer)
            }
            cb.onDelta(chunk.text ?? '')
          } else if (chunk.type === 'reasoning') {
            armSilence()
            if (chunk.text) {
              emitted = true
              clearTimeout(firstContentTimer)
            }
            if (chunk.text) cb.onReasoning?.(chunk.text)
          } else if (chunk.type === 'tool-call') {
            armSilence()
            if (chunk.toolCall) {
              emitted = true
              clearTimeout(firstContentTimer)
              const routeSettings = settings as {
                provider?: string
                providers?: { gemini?: { model?: string } }
              }
              const model =
                routeSettings.provider === 'gemini'
                  ? routeSettings.providers?.gemini?.model
                  : undefined
              cb.onToolCall(model ? { ...chunk.toolCall, sourceModel: model } : chunk.toolCall)
            }
          } else if (chunk.type === 'done') {
            finish()
            if (chunk.stopReason) cb.onStopReason?.(chunk.stopReason)
            cb.onDone()
          } else {
            handleError(chunk.error ?? '', emitted, chunk.errorCode)
          }
        })
        armSilence()
        try {
          options.route?.onAttempt?.(settings)
          Promise.resolve(
            options.start({
              requestId,
              sessionId,
              settings,
              system: request.system,
              messages: request.messages,
              tools: request.tools,
            }),
          ).catch((err: unknown) => {
            if (requestId === thisRequestId && !settled && !finished) {
              fail(err instanceof Error ? err.message : options.unknownErrorText())
            }
          })
        } catch (err) {
          fail(err instanceof Error ? err.message : options.unknownErrorText())
        }
      }
      attempt()
      return {
        cancel: () => {
          cancelled = true
          options.cancel(requestId)
          finish()
        },
      }
    },
  }
}
