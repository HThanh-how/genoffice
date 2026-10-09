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
  type: 'delta' | 'reasoning' | 'tool-call' | 'done' | 'error' | 'ping' | 'usage'
  text?: string
  toolCall?: AgentToolCall
  error?: string
  /** machine-readable error cause; maps to the localized timeout/credits/network/overloaded message */
  errorCode?: 'timeout' | 'credits' | 'network' | 'overloaded'
  /** normalized stop reason on 'done' ('max_tokens' = cut off by the token limit) */
  stopReason?: string
  usage?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
    cachedContentTokenCount?: number
    totalTokenCount?: number
  }
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
    /** Restrict this route's preparation, timeouts, retries, and hooks to matching settings. */
    appliesTo?(settings: S): boolean
    prepare(settings: S, request?: AgentStreamRequest): S
    /** Deadline for the first useful model output; wire keepalives do not satisfy it. */
    firstContentTimeoutMs?: number
    /** Resume text after a transient overload; never replay an emitted tool call. */
    continuePartialTextOnOverload?: boolean
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
    onAttempt?(settings: S, requestId: string, request: AgentStreamRequest): void
    onUsage?(settings: S, requestId: string, usage: NonNullable<IpcStreamChunk['usage']>): void
    onToolCall?(settings: S, requestId: string, toolName: string): void
    onResult?(
      settings: S,
      requestId: string,
      outcome: {
        status: 'ok' | 'error' | 'cancelled'
        error?: string
        errorCode?: IpcStreamChunk['errorCode']
      },
    ): void
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
      let partialText = ''
      let toolCallEmitted = false
      let attemptRequest = request
      const baseSettings = options.getSettings()
      const route =
        options.route && (!options.route.appliesTo || options.route.appliesTo(baseSettings))
          ? options.route
          : undefined
      let settings = route?.prepare(baseSettings, request) ?? baseSettings
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
        route?.onResult?.(settings, requestId, { status: 'error', error, errorCode })
        const canAttempt = attempts < (route?.maxAttempts ?? Infinity)
        if (!canAttempt) route?.onExhausted?.(settings, 'attempt_limit')
        const continueText =
          route?.continuePartialTextOnOverload &&
          errorCode === 'overloaded' &&
          partialText.length > 0 &&
          !toolCallEmitted
        const routedEmitted = toolCallEmitted || (emitted && !continueText)
        const prepareContinuation = () => {
          if (!continueText) return
          attemptRequest = {
            ...request,
            tools: [],
            messages: [
              ...request.messages,
              { role: 'assistant', text: partialText },
              {
                role: 'user',
                text: 'The answer was interrupted by a temporary service overload. Continue exactly from the end of the preceding answer, in the same language. Do not repeat its text. Use only the evidence already in this conversation; if evidence is insufficient, say so. Do not perform any document changes.',
              },
            ],
          }
        }
        const retryDelay = canAttempt && route?.retry?.(settings, error, routedEmitted, errorCode)
        if (typeof retryDelay === 'number' && Number.isFinite(retryDelay) && retryDelay >= 0) {
          prepareContinuation()
          settle()
          retryTimer = setTimeout(() => {
            retryTimer = undefined
            if (!cancelled) attempt()
          }, retryDelay)
          return
        }
        const next = canAttempt && route?.fallback(settings, error, routedEmitted, errorCode)
        if (next) {
          prepareContinuation()
          settle()
          settings = next
          attempt()
          return
        }
        fail(errorText(error, errorCode))
      }
      if (route?.maxDurationMs) {
        deadlineTimer = setTimeout(() => {
          route?.onExhausted?.(settings, 'deadline')
          if (!settled)
            route?.onResult?.(settings, requestId, {
              status: 'error',
              error: 'AI request timed out: routing deadline',
              errorCode: 'timeout',
            })
          options.cancel(requestId)
          fail(timeoutText())
        }, route.maxDurationMs)
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
        if (route?.firstContentTimeoutMs) {
          firstContentTimer = setTimeout(() => {
            options.cancel(thisRequestId)
            handleError('AI request timed out: no model output', false, 'timeout')
          }, route.firstContentTimeoutMs)
        }
        unsubscribe = options.onStream((chunk) => {
          if (chunk.requestId !== requestId || settled) return
          if (chunk.type === 'ping') {
            armSilence()
          } else if (chunk.type === 'delta') {
            armSilence()
            if (chunk.text) {
              emitted = true
              partialText += chunk.text
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
              toolCallEmitted = true
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
              route?.onToolCall?.(settings, requestId, chunk.toolCall.name)
            }
          } else if (chunk.type === 'usage') {
            armSilence()
            if (chunk.usage) route?.onUsage?.(settings, requestId, chunk.usage)
          } else if (chunk.type === 'done') {
            route?.onResult?.(settings, requestId, { status: 'ok' })
            finish()
            if (chunk.stopReason) cb.onStopReason?.(chunk.stopReason)
            cb.onDone()
          } else if (chunk.type === 'error') {
            handleError(chunk.error ?? '', emitted, chunk.errorCode)
          } else {
            // A chunk kind this build predates must not kill the run; traffic proves it is alive.
            armSilence()
          }
        })
        armSilence()
        try {
          route?.onAttempt?.(settings, requestId, attemptRequest)
          Promise.resolve(
            options.start({
              requestId,
              sessionId,
              settings,
              system: attemptRequest.system,
              messages: attemptRequest.messages,
              tools: attemptRequest.tools,
            }),
          ).catch((err: unknown) => {
            if (requestId === thisRequestId && !settled && !finished) {
              route?.onResult?.(settings, requestId, {
                status: 'error',
                error: err instanceof Error ? err.message : '',
              })
              fail(err instanceof Error ? err.message : options.unknownErrorText())
            }
          })
        } catch (err) {
          route?.onResult?.(settings, requestId, {
            status: 'error',
            error: err instanceof Error ? err.message : '',
          })
          fail(err instanceof Error ? err.message : options.unknownErrorText())
        }
      }
      attempt()
      return {
        cancel: () => {
          if (!finished && !settled) {
            route?.onResult?.(settings, requestId, { status: 'cancelled' })
          }
          cancelled = true
          options.cancel(requestId)
          finish()
        },
      }
    },
  }
}
