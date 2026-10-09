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
  it('passes per-attempt usage and outcomes to the diagnostic route', () => {
    let listener: ((chunk: IpcStreamChunk) => void) | undefined
    const started: IpcStreamStart<{ model: string }>[] = []
    const onAttempt = vi.fn()
    const onUsage = vi.fn()
    const onToolCall = vi.fn()
    const onResult = vi.fn()
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
        fallback: (settings) => ({ ...settings, model: 'second' }),
        onAttempt,
        onUsage,
        onToolCall,
        onResult,
      },
    })
    transport.stream(
      { system: 'sys', messages: [], tools: [] },
      {
        onDelta: vi.fn(),
        onToolCall: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
      },
    )
    listener?.({ requestId: started[0]!.requestId, type: 'error', error: 'Gemini HTTP 503' })
    listener?.({
      requestId: started[1]!.requestId,
      type: 'usage',
      usage: { promptTokenCount: 8, candidatesTokenCount: 2, totalTokenCount: 10 },
    })
    listener?.({
      requestId: started[1]!.requestId,
      type: 'tool-call',
      toolCall: { id: 'tool-1', name: 'edit_document', input: {} },
    })
    listener?.({ requestId: started[1]!.requestId, type: 'done' })
    expect(onAttempt).toHaveBeenCalledTimes(2)
    expect(onResult).toHaveBeenNthCalledWith(1, { model: 'first' }, started[0]!.requestId, {
      status: 'error',
      error: 'Gemini HTTP 503',
      errorCode: undefined,
    })
    expect(onUsage).toHaveBeenCalledWith({ model: 'second' }, started[1]!.requestId, {
      promptTokenCount: 8,
      candidatesTokenCount: 2,
      totalTokenCount: 10,
    })
    expect(onToolCall).toHaveBeenCalledWith(
      { model: 'second' },
      started[1]!.requestId,
      'edit_document',
    )
    expect(onResult).toHaveBeenNthCalledWith(2, { model: 'second' }, started[1]!.requestId, {
      status: 'ok',
    })
  })
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

  it('does not apply Gemini route deadlines to AGY streams with keepalives', () => {
    vi.useFakeTimers()
    try {
      let listener: ((chunk: IpcStreamChunk) => void) | undefined
      const started: IpcStreamStart<FakeSettings>[] = []
      const onAttempt = vi.fn()
      const onToolCall = vi.fn()
      const onResult = vi.fn()
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
        getSettings: () => ({ provider: 'agy' }),
        unknownErrorText: () => 'unknown',
        timeoutErrorText: () => 'timed out',
        route: {
          appliesTo: (settings) => settings.provider === 'gemini',
          prepare: (settings) => settings,
          firstContentTimeoutMs: 45_000,
          maxDurationMs: 120_000,
          fallback: () => null,
          onAttempt,
          onToolCall,
          onResult,
        },
      })
      transport.stream({ system: 'sys', messages: [], tools: [] }, callbacks)

      listener?.({ requestId: started[0]!.requestId, type: 'ping' })
      vi.advanceTimersByTime(46_000)
      listener?.({ requestId: started[0]!.requestId, type: 'ping' })
      vi.advanceTimersByTime(46_000)
      listener?.({ requestId: started[0]!.requestId, type: 'ping' })
      vi.advanceTimersByTime(30_000)
      listener?.({
        requestId: started[0]!.requestId,
        type: 'tool-call',
        toolCall: { id: 'tool-1', name: 'edit_document', input: {} },
      })
      listener?.({ requestId: started[0]!.requestId, type: 'done' })

      expect(callbacks.onToolCall).toHaveBeenCalledOnce()
      expect(callbacks.onDone).toHaveBeenCalledOnce()
      expect(callbacks.onError).not.toHaveBeenCalled()
      expect(onAttempt).not.toHaveBeenCalled()
      expect(onToolCall).not.toHaveBeenCalled()
      expect(onResult).not.toHaveBeenCalled()
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

  it('ignores an unknown future chunk type instead of failing the run', () => {
    const { cb, emit, unsubscribe } = setup()
    emit({ type: 'progress' } as never)
    expect(cb.onError).not.toHaveBeenCalled()
    expect(cb.onDone).not.toHaveBeenCalled()
    expect(unsubscribe).not.toHaveBeenCalled()
    // the run survived rather than merely going quiet
    emit({ type: 'done' })
    expect(cb.onDone).toHaveBeenCalledTimes(1)
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

describe('partial answer recovery', () => {
  function recoveringTransport() {
    let listener: ((chunk: IpcStreamChunk) => void) | undefined
    const started: IpcStreamStart<{ model: string }>[] = []
    const fallback = vi.fn((settings, _error, emitted) => (emitted ? null : { model: 'backup' }))
    const transport = createIpcTransport({
      onStream: (next) => {
        listener = next
        return () => {
          listener = undefined
        }
      },
      start: (request: IpcStreamStart<{ model: string }>) => {
        started.push(request)
      },
      cancel: vi.fn(),
      getSettings: () => ({ model: 'first' }),
      unknownErrorText: () => 'unknown',
      route: { prepare: (s) => s, fallback, maxAttempts: 3, continuePartialTextOnOverload: true },
    })
    const cb = { onDelta: vi.fn(), onDone: vi.fn(), onToolCall: vi.fn(), onError: vi.fn() }
    transport.stream(
      {
        system: 'sys',
        messages: [{ role: 'user', text: 'find a document' }],
        tools: [{ name: 'edit', description: 'edit', inputSchema: {} }],
      },
      cb,
    )
    const emit = (chunk: Omit<IpcStreamChunk, 'requestId'>) =>
      listener?.({ requestId: started.at(-1)!.requestId, ...chunk })
    return { started, emit, cb, fallback }
  }

  it('continues an interrupted answer using the existing text and without edit tools', () => {
    const { started, emit, cb } = recoveringTransport()
    emit({ type: 'delta', text: 'Found the file. ' })
    emit({ type: 'error', error: 'high demand', errorCode: 'overloaded' })
    expect(started).toHaveLength(2)
    expect(started[1]!.tools).toEqual([])
    expect(started[1]!.messages[1]).toEqual({ role: 'assistant', text: 'Found the file. ' })
    emit({ type: 'delta', text: 'Its location is here.' })
    emit({ type: 'error', error: 'high demand', errorCode: 'overloaded' })
    expect(started[2]!.messages[1]).toEqual({
      role: 'assistant',
      text: 'Found the file. Its location is here.',
    })
    expect(started[2]!.messages).toHaveLength(3)
    emit({ type: 'done' })
    expect(cb.onDone).toHaveBeenCalledOnce()
    expect(cb.onError).not.toHaveBeenCalled()
  })

  it('never replays an emitted tool call after overload', () => {
    const { started, emit, cb } = recoveringTransport()
    emit({ type: 'delta', text: 'Editing. ' })
    emit({ type: 'tool-call', toolCall: { id: '1', name: 'edit', input: {} } })
    emit({ type: 'error', error: 'high demand', errorCode: 'overloaded' })
    expect(started).toHaveLength(1)
    expect(cb.onError).toHaveBeenCalledOnce()
  })

  it('does not resume partial text for a non-overload failure', () => {
    const { started, emit, cb } = recoveringTransport()
    emit({ type: 'delta', text: 'Partial' })
    emit({ type: 'error', error: 'invalid key' })
    expect(started).toHaveLength(1)
    expect(cb.onError).toHaveBeenCalledOnce()
  })
})
