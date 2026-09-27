import { describe, expect, it, vi } from 'vitest'
import {
  createIpcTransport,
  IPC_STREAM_SILENCE_TIMEOUT_MS,
  type IpcStreamChunk,
  type IpcStreamStart,
} from '../src'

interface FakeSettings {
  provider: string
}

function setup(
  startImpl?: (request: IpcStreamStart<FakeSettings>) => void | Promise<unknown>,
  creditsErrorText?: () => string,
  networkErrorText?: () => string,
  overloadedErrorText?: () => string,
) {
  let listener: ((chunk: IpcStreamChunk) => void) | undefined
  const unsubscribe = vi.fn(() => {
    listener = undefined
  })
  const started: IpcStreamStart<FakeSettings>[] = []
  const cancelled: string[] = []
  const transport = createIpcTransport<FakeSettings>({
    onStream: (l) => {
      listener = l
      return unsubscribe
    },
    start: (request) => {
      started.push(request)
      return startImpl?.(request)
    },
    cancel: (requestId) => cancelled.push(requestId),
    getSettings: () => ({ provider: 'genspark' }),
    unknownErrorText: () => 'unknown error',
    timeoutErrorText: () => 'timed out',
    ...(creditsErrorText ? { creditsErrorText } : {}),
    ...(networkErrorText ? { networkErrorText } : {}),
    ...(overloadedErrorText ? { overloadedErrorText } : {}),
  })
  const cb = {
    onDelta: vi.fn(),
    onReasoning: vi.fn(),
    onToolCall: vi.fn(),
    onStopReason: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
  }
  const handle = transport.stream({ system: 'sys', messages: [], tools: [] }, cb)
  const emit = (chunk: Omit<IpcStreamChunk, 'requestId'> & { requestId?: string }) =>
    listener?.({ requestId: started[0]!.requestId, ...chunk })
  return { started, cancelled, cb, handle, emit, unsubscribe }
}

describe('createIpcTransport', () => {
  it('retries the same model after overload, then falls back', async () => {
    vi.useFakeTimers()
    try {
      let listener: ((chunk: IpcStreamChunk) => void) | undefined
      const started: IpcStreamStart<{ provider: string; model: string }>[] = []
      let retries = 0
      const callbacks = { onDelta: vi.fn(), onToolCall: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
      const transport = createIpcTransport({
        onStream: (next) => {
          listener = next
          return () => {
            listener = undefined
          }
        },
        start: (request) => {
          started.push(request)
        },
        cancel: vi.fn(),
        getSettings: () => ({ provider: 'gemini', model: 'first' }),
        unknownErrorText: () => 'unknown',
        route: {
          prepare: (settings) => settings,
          retry: () => (retries++ < 2 ? 400 : null),
          fallback: (settings) => ({ ...settings, model: 'second' }),
        },
      })
      transport.stream({ system: 'sys', messages: [], tools: [] }, callbacks)
      listener?.({ requestId: started[0]!.requestId, type: 'error', error: 'Gemini HTTP 503' })
      expect(started).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(400)
      expect(started.map((request) => request.settings.model)).toEqual(['first', 'first'])
      listener?.({ requestId: started[1]!.requestId, type: 'error', error: 'Gemini HTTP 503' })
      await vi.advanceTimersByTimeAsync(400)
      listener?.({ requestId: started[2]!.requestId, type: 'error', error: 'Gemini HTTP 503' })
      expect(started.map((request) => request.settings.model)).toEqual([
        'first',
        'first',
        'first',
        'second',
      ])
      listener?.({ requestId: started[3]!.requestId, type: 'done' })
      expect(started).toHaveLength(4)
      expect(callbacks.onError).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not restart a model after cancellation during an overload wait', async () => {
    vi.useFakeTimers()
    try {
      let listener: ((chunk: IpcStreamChunk) => void) | undefined
      const started: IpcStreamStart<{ provider: string }>[] = []
      const transport = createIpcTransport({
        onStream: (next) => {
          listener = next
          return () => {
            listener = undefined
          }
        },
        start: (request) => {
          started.push(request)
        },
        cancel: vi.fn(),
        getSettings: () => ({ provider: 'gemini' }),
        unknownErrorText: () => 'unknown',
        route: {
          prepare: (settings) => settings,
          retry: () => 400,
          fallback: () => null,
        },
      })
      const handle = transport.stream(
        { system: 'sys', messages: [], tools: [] },
        {
          onDelta: vi.fn(),
          onToolCall: vi.fn(),
          onDone: vi.fn(),
          onError: vi.fn(),
        },
      )
      listener?.({ requestId: started[0]!.requestId, type: 'error', error: 'Gemini HTTP 503' })
      handle.cancel()
      await vi.advanceTimersByTimeAsync(500)
      expect(started).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a 429 with another model only when the failed turn emitted nothing', () => {
    let listener: ((chunk: IpcStreamChunk) => void) | undefined
    const started: IpcStreamStart<{ provider: string; model: string }>[] = []
    const callbacks = { onDelta: vi.fn(), onToolCall: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
    const transport = createIpcTransport({
      onStream: (next) => {
        listener = next
        return () => {
          listener = undefined
        }
      },
      start: (request) => {
        started.push(request)
      },
      cancel: vi.fn(),
      getSettings: () => ({ provider: 'gemini', model: 'first' }),
      unknownErrorText: () => 'unknown',
      route: {
        prepare: (settings) => settings,
        fallback: (settings, error, emitted) =>
          error.includes('429') && !emitted ? { ...settings, model: 'second' } : null,
      },
    })
    transport.stream({ system: 'sys', messages: [], tools: [] }, callbacks)
    listener?.({ requestId: started[0]!.requestId, type: 'error', error: 'Gemini HTTP 429' })
    expect(started.map((request) => request.settings.model)).toEqual(['first', 'second'])
    listener?.({ requestId: started[1]!.requestId, type: 'delta', text: 'partial' })
    listener?.({ requestId: started[1]!.requestId, type: 'error', error: 'Gemini HTTP 429' })
    expect(started).toHaveLength(2)
    expect(callbacks.onDelta).toHaveBeenCalledWith('partial')
    expect(callbacks.onError).toHaveBeenCalledWith('Gemini HTTP 429')
  })
  it('falls back when keepalives arrive but the model produces no content', () => {
    vi.useFakeTimers()
    try {
      let listener: ((chunk: IpcStreamChunk) => void) | undefined
      const started: IpcStreamStart<{ model: string }>[] = []
      const cancelled: string[] = []
      const callbacks = { onDelta: vi.fn(), onToolCall: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
      const transport = createIpcTransport({
        onStream: (next) => {
          listener = next
          return () => {
            listener = undefined
          }
        },
        start: (request) => {
          started.push(request)
        },
        cancel: (id) => {
          cancelled.push(id)
        },
        getSettings: () => ({ model: 'first' }),
        unknownErrorText: () => 'unknown',
        timeoutErrorText: () => 'timed out',
        route: {
          prepare: (settings) => settings,
          firstContentTimeoutMs: 1_000,
          fallback: (settings, _error, emitted, code) =>
            !emitted && code === 'timeout' ? { ...settings, model: 'second' } : null,
        },
      })
      transport.stream({ system: 'sys', messages: [], tools: [] }, callbacks)
      listener?.({ requestId: started[0]!.requestId, type: 'ping' })
      vi.advanceTimersByTime(1_000)
      expect(cancelled).toEqual([started[0]!.requestId])
      expect(started.map((request) => request.settings.model)).toEqual(['first', 'second'])
      listener?.({ requestId: started[1]!.requestId, type: 'delta', text: 'answer' })
      vi.advanceTimersByTime(1_000)
      expect(started).toHaveLength(2)
      expect(callbacks.onError).not.toHaveBeenCalled()
      listener?.({ requestId: started[1]!.requestId, type: 'done' })
      expect(callbacks.onDone).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends a retry chain at its deadline even while waiting for a retry', () => {
    vi.useFakeTimers()
    try {
      let listener: ((chunk: IpcStreamChunk) => void) | undefined
      const started: IpcStreamStart<{ model: string }>[] = []
      const callbacks = { onDelta: vi.fn(), onToolCall: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
      const transport = createIpcTransport({
        onStream: (next) => {
          listener = next
          return () => {
            listener = undefined
          }
        },
        start: (request) => {
          started.push(request)
        },
        cancel: vi.fn(),
        getSettings: () => ({ model: 'first' }),
        unknownErrorText: () => 'unknown',
        timeoutErrorText: () => 'timed out',
        route: {
          prepare: (settings) => settings,
          maxDurationMs: 1_000,
          retry: () => 2_000,
          fallback: () => null,
        },
      })
      transport.stream({ system: 'sys', messages: [], tools: [] }, callbacks)
      listener?.({ requestId: started[0]!.requestId, type: 'error', error: 'busy' })
      vi.advanceTimersByTime(3_000)
      expect(started).toHaveLength(1)
      expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith('timed out')
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps repeated attempts', () => {
    let listener: ((chunk: IpcStreamChunk) => void) | undefined
    const started: IpcStreamStart<{ model: string }>[] = []
    const callbacks = { onDelta: vi.fn(), onToolCall: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
    const onExhausted = vi.fn()
    const transport = createIpcTransport({
      onStream: (next) => {
        listener = next
        return () => {
          listener = undefined
        }
      },
      start: (request) => {
        started.push(request)
      },
      cancel: vi.fn(),
      getSettings: () => ({ model: 'first' }),
      unknownErrorText: () => 'unknown',
      route: {
        prepare: (settings) => settings,
        maxAttempts: 2,
        fallback: (settings) => ({ ...settings, model: 'next' }),
        onExhausted,
      },
    })
    transport.stream({ system: 'sys', messages: [], tools: [] }, callbacks)
    listener?.({ requestId: started[0]!.requestId, type: 'error', error: 'busy' })
    listener?.({ requestId: started[1]!.requestId, type: 'error', error: 'busy' })
    expect(started).toHaveLength(2)
    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith('busy')
    expect(onExhausted).toHaveBeenCalledExactlyOnceWith({ model: 'next' }, 'attempt_limit')
  })

  it('ignores a late start rejection from an attempt already replaced by fallback', async () => {
    let listener: ((chunk: IpcStreamChunk) => void) | undefined
    const started: IpcStreamStart<{ model: string }>[] = []
    let rejectFirst: (error: Error) => void = () => undefined
    const callbacks = { onDelta: vi.fn(), onToolCall: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
    const transport = createIpcTransport({
      onStream: (next) => {
        listener = next
        return () => {
          listener = undefined
        }
      },
      start: (request) => {
        started.push(request)
        if (started.length === 1)
          return new Promise((_resolve, reject) => {
            rejectFirst = reject
          })
      },
      cancel: vi.fn(),
      getSettings: () => ({ model: 'first' }),
      unknownErrorText: () => 'unknown',
      route: {
        prepare: (settings) => settings,
        fallback: (settings) => ({ ...settings, model: 'second' }),
      },
    })
    transport.stream({ system: 'sys', messages: [], tools: [] }, callbacks)
    listener?.({ requestId: started[0]!.requestId, type: 'error', error: 'busy' })
    rejectFirst(new Error('late failure'))
    await Promise.resolve()
    expect(callbacks.onError).not.toHaveBeenCalled()
    listener?.({ requestId: started[1]!.requestId, type: 'done' })
    expect(callbacks.onDone).toHaveBeenCalledOnce()
  })
  it('starts one request with settings and forwards deltas and tool calls', () => {
    const { started, cb, emit } = setup()
    expect(started).toHaveLength(1)
    expect(started[0]!.settings).toEqual({ provider: 'genspark' })
    expect(started[0]!.system).toBe('sys')

    emit({ type: 'delta', text: 'hi' })
    emit({ type: 'delta' })
    emit({ type: 'tool-call', toolCall: { id: 'c1', name: 'read', input: {} } })
    expect(cb.onDelta).toHaveBeenNthCalledWith(1, 'hi')
    expect(cb.onDelta).toHaveBeenNthCalledWith(2, '')
    expect(cb.onToolCall).toHaveBeenCalledWith({ id: 'c1', name: 'read', input: {} })
  })

  it('forwards reasoning chunks separately from text deltas', () => {
    const { cb, emit } = setup()
    emit({ type: 'reasoning', text: 'thinking…' })
    emit({ type: 'reasoning' }) // payload-less chunk carries nothing
    expect(cb.onReasoning).toHaveBeenCalledTimes(1)
    expect(cb.onReasoning).toHaveBeenCalledWith('thinking…')
    expect(cb.onDelta).not.toHaveBeenCalled()
  })

  it('ignores chunks for other requestIds', () => {
    const { cb, emit } = setup()
    emit({ requestId: 'someone-else', type: 'delta', text: 'nope' })
    expect(cb.onDelta).not.toHaveBeenCalled()
  })

  it('unsubscribes on done', () => {
    const { cb, emit, unsubscribe } = setup()
    emit({ type: 'done' })
    expect(cb.onDone).toHaveBeenCalledTimes(1)
    expect(cb.onStopReason).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('forwards a stopReason carried on the done chunk before onDone', () => {
    const { cb, emit } = setup()
    emit({ type: 'done', stopReason: 'max_tokens' })
    expect(cb.onStopReason).toHaveBeenCalledWith('max_tokens')
    expect(cb.onDone).toHaveBeenCalledTimes(1)
  })

  it('maps error chunks to onError with the localized fallback', () => {
    const { cb, emit, unsubscribe } = setup()
    emit({ type: 'error' })
    expect(cb.onError).toHaveBeenCalledWith('unknown error')
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('cancel forwards the requestId to the bridge', () => {
    const { started, cancelled, handle } = setup()
    handle.cancel()
    expect(cancelled).toEqual([started[0]!.requestId])
  })

  it('maps a timeout error code to the localized timeout message', () => {
    const { cb, emit } = setup()
    emit({ type: 'error', error: 'AI request timed out: no data received', errorCode: 'timeout' })
    expect(cb.onError).toHaveBeenCalledWith('timed out')
  })

  it('maps a credits error code to the localized credits message', () => {
    const { cb, emit } = setup(undefined, () => 'credits used up')
    emit({
      type: 'error',
      error: 'Your Genspark credits have been exhausted.',
      errorCode: 'credits',
    })
    expect(cb.onError).toHaveBeenCalledWith('credits used up')
  })

  it('maps a network error code to the localized network message', () => {
    const { cb, emit } = setup(undefined, undefined, () => 'network problem')
    emit({
      type: 'error',
      error: 'Claude fetch failed: fetch failed cause=ECONNRESET',
      errorCode: 'network',
    })
    expect(cb.onError).toHaveBeenCalledWith('network problem')
  })

  it('a network error code without networkErrorText falls back to the carried text', () => {
    const { cb, emit } = setup()
    emit({
      type: 'error',
      error: 'Claude fetch failed: fetch failed cause=ECONNRESET',
      errorCode: 'network',
    })
    expect(cb.onError).toHaveBeenCalledWith('Claude fetch failed: fetch failed cause=ECONNRESET')
  })

  it('a credits error code without creditsErrorText falls back to the carried text', () => {
    const { cb, emit } = setup()
    emit({
      type: 'error',
      error: 'Your Genspark credits have been exhausted.',
      errorCode: 'credits',
    })
    expect(cb.onError).toHaveBeenCalledWith('Your Genspark credits have been exhausted.')
  })

  it('maps an overloaded error code to the localized busy message', () => {
    const { cb, emit } = setup(undefined, undefined, undefined, () => 'service busy')
    emit({
      type: 'error',
      error: 'HTTP 429: {"error":{"type":"engine_overloaded_error"}}',
      errorCode: 'overloaded',
    })
    expect(cb.onError).toHaveBeenCalledWith('service busy')
  })

  it('an overloaded error code without overloadedErrorText falls back to the carried text', () => {
    const { cb, emit } = setup()
    emit({
      type: 'error',
      error: 'HTTP 429: engine overloaded',
      errorCode: 'overloaded',
    })
    expect(cb.onError).toHaveBeenCalledWith('HTTP 429: engine overloaded')
  })

  it('fails the run after prolonged silence; pings re-arm the watchdog', () => {
    vi.useFakeTimers()
    try {
      const { cb, emit, started, cancelled } = setup()
      emit({ type: 'delta', text: 'x' })
      vi.advanceTimersByTime(IPC_STREAM_SILENCE_TIMEOUT_MS - 1)
      emit({ type: 'ping' })
      vi.advanceTimersByTime(IPC_STREAM_SILENCE_TIMEOUT_MS - 1)
      expect(cb.onError).not.toHaveBeenCalled()
      vi.advanceTimersByTime(IPC_STREAM_SILENCE_TIMEOUT_MS)
      expect(cb.onError).toHaveBeenCalledWith('timed out')
      expect(cancelled).toEqual([started[0]!.requestId])
    } finally {
      vi.useRealTimers()
    }
  })

  it('done disarms the silence watchdog', () => {
    vi.useFakeTimers()
    try {
      const { cb, emit } = setup()
      emit({ type: 'done' })
      vi.advanceTimersByTime(IPC_STREAM_SILENCE_TIMEOUT_MS * 2)
      expect(cb.onError).not.toHaveBeenCalled()
      expect(cb.onDone).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a rejected start fails the run instead of leaving it pending', async () => {
    const { cb } = setup(() => Promise.reject(new Error('no handler registered')))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cb.onError).toHaveBeenCalledWith('no handler registered')
    expect(cb.onDone).not.toHaveBeenCalled()
  })
})
