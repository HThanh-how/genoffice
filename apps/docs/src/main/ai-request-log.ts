import type { DiagSink } from '@genoffice/ai-provider/diag-hook'

/**
 * The life of one AI request in the diagnostic log: when it started, when the first answer text
 * came, how long it was silent, how it ended. Numbers and fixed words only, never the text.
 *
 * Two clocks tell a slow answer from a dead one, because they answer different questions:
 *  - the CONTENT clock moves when the model actually produced something (text, reasoning, a tool call);
 *  - the WIRE clock also moves on a heartbeat (the one-shot Antigravity CLI sends one every 5 s while
 *    it says nothing) or on any network chunk.
 * A long content silence with a recent wire signal is "alive but quiet" (a tool's arguments being
 * written, a CLI that thinks): `request.quiet`, at info level, at 30 s, 60 s, 120 s, 240 s ... A long
 * content silence with NO wire signal either is "nothing is arriving at all": `request.silent`, a
 * warning every 30 s. Both carry both numbers.
 *
 * Nothing here may throw: the log must not decide whether a request works.
 */
export interface AiRequestLogStart {
  reqId: string
  provider: string
  model: string | undefined
  /** whatever the renderer sent: it is not trusted to be an array */
  messages: unknown
  tools: unknown
  maxTokens: number | undefined
}

export interface AiRequestLogDeps {
  readonly sink: DiagSink
  readonly now?: () => number
  readonly setInterval?: typeof setInterval
  readonly clearInterval?: typeof clearInterval
}

/** A report after each this many ms without content (then 2x, 3x ...). */
export const SILENT_STEP_MS = 30_000
const CHECK_EVERY_MS = 15_000

/** How many messages there are and how many characters they hold, whatever shape they have. */
export function messageStats(messages: unknown): { messages: number; chars: number } {
  try {
    if (!Array.isArray(messages)) return { messages: 0, chars: 0 }
    let chars = 0
    for (const message of messages) {
      if (message && typeof message === 'object') {
        const text = (message as { text?: unknown }).text
        if (typeof text === 'string') chars += text.length
      }
    }
    return { messages: messages.length, chars }
  } catch {
    return { messages: 0, chars: 0 }
  }
}

export class AiRequestLog {
  private readonly now: () => number
  private readonly startedAt: number
  private lastContentAt: number
  private lastWireAt: number
  private silentLogged = 0
  private quietAt = SILENT_STEP_MS
  private firstTextMs: number | undefined
  private deltas = 0
  private toolCalls = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly clear: typeof clearInterval

  /** what the lines carry: the request itself (its messages and tools) is not kept for the life of the request */
  private readonly info: { readonly reqId: string; readonly provider: string }

  constructor(
    start: AiRequestLogStart,
    private readonly deps: AiRequestLogDeps,
  ) {
    const info = start
    this.info = { reqId: info.reqId, provider: info.provider }
    this.now = deps.now ?? Date.now
    this.clear = deps.clearInterval ?? clearInterval
    this.startedAt = this.lastContentAt = this.lastWireAt = this.now()
    this.safely(() => {
      const tools = Array.isArray(info.tools) ? info.tools.length : 0
      this.deps.sink.info('ai', 'request.start', {
        reqId: info.reqId,
        provider: info.provider,
        model: info.model,
        ...messageStats(info.messages),
        tools,
        maxTokens: info.maxTokens,
      })
    })
    this.safely(() => {
      this.timer = (deps.setInterval ?? setInterval)(() => this.checkSilence(), CHECK_EVERY_MS)
      ;(this.timer as { unref?: () => void }).unref?.()
    })
  }

  private safely(fn: () => void): void {
    try {
      fn()
    } catch {
      // a broken sink or a strange value: the request goes on
    }
  }

  private checkSilence(): void {
    this.safely(() => {
      const at = this.now()
      const silentContentMs = at - this.lastContentAt
      const silentWireMs = at - this.lastWireAt
      const data = {
        reqId: this.info.reqId,
        silentContentMs,
        silentWireMs,
        ms: at - this.startedAt,
        stage: this.firstTextMs === undefined ? 'before-first-text' : 'streaming',
        provider: this.info.provider,
      }
      if (silentWireMs >= SILENT_STEP_MS) {
        if (silentContentMs < SILENT_STEP_MS * (this.silentLogged + 1)) return
        this.silentLogged++
        this.deps.sink.warn('ai', 'request.silent', data)
      } else if (silentContentMs >= this.quietAt) {
        this.quietAt *= 2
        this.deps.sink.info('ai', 'request.quiet', data)
      }
    })
  }

  /** Something arrived on the wire (a network chunk, a heartbeat) that is not yet an answer. */
  wire(): void {
    this.lastWireAt = this.now()
  }

  /** The model produced something: text, reasoning, a tool call. */
  content(): void {
    this.lastWireAt = this.lastContentAt = this.now()
    this.silentLogged = 0
    this.quietAt = SILENT_STEP_MS
  }

  text(): void {
    this.content()
    this.deltas++
    if (this.firstTextMs !== undefined) return
    this.firstTextMs = this.now() - this.startedAt
    const ms = this.firstTextMs
    this.safely(() =>
      this.deps.sink.info('ai', 'request.first-text', { reqId: this.info.reqId, ms }),
    )
  }

  toolCall(): void {
    this.content()
    this.toolCalls++
  }

  end(stopReason: string | undefined): void {
    this.safely(() =>
      this.deps.sink.info('ai', 'request.end', {
        reqId: this.info.reqId,
        ms: this.now() - this.startedAt,
        firstTextMs: this.firstTextMs,
        deltas: this.deltas,
        toolCalls: this.toolCalls,
        stopReason,
      }),
    )
  }

  aborted(): void {
    this.safely(() =>
      this.deps.sink.info('ai', 'request.aborted', {
        reqId: this.info.reqId,
        ms: this.now() - this.startedAt,
        firstTextMs: this.firstTextMs,
      }),
    )
  }

  failed(err: unknown): void {
    this.safely(() =>
      this.deps.sink.error('ai', 'request.failed', {
        reqId: this.info.reqId,
        ms: this.now() - this.startedAt,
        firstTextMs: this.firstTextMs,
        provider: this.info.provider,
        err,
      }),
    )
  }

  /** Stops the silence timer. Call it when the request is over, however it ended. */
  dispose(): void {
    if (this.timer !== undefined) this.safely(() => this.clear(this.timer!))
  }
}
