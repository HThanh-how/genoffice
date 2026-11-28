import { afterEach, describe, expect, it, vi } from 'vitest'
import { LANGS } from '@genoffice/i18n'
import { LocalLlmError, type HostEvent } from '@genoffice/local-llm/protocol'
import {
  streamLocal,
  chatLocal,
  setLocalChatTransport,
  type LocalChatTransport,
} from '../src/local'
import { localChatCopy, setLocalChatLanguage } from '../src/local-copy'
import { defaultAiSettings } from '../src/providers'

const config = defaultAiSettings().providers.local
const tools = [{ name: 'search', description: 'Find files', inputSchema: { type: 'object' } }]
const messages = [{ role: 'user' as const, text: 'chào bạn' }]
const callbacks = () => ({
  signal: new AbortController().signal,
  onDelta: vi.fn(),
  onToolCall: vi.fn(),
  onUsage: vi.fn(),
  onStopReason: vi.fn(),
})
const done: HostEvent = { id: 'test', type: 'done', stopReason: 'eogToken' }
const usage: HostEvent = {
  id: 'test',
  type: 'usage',
  usage: {
    inputTokens: 20,
    outputTokens: 7,
    thoughtTokens: 1,
    evaluatedPromptTokens: 20,
    elapsedMs: 10,
    ttftMs: null,
    rssBytes: 0,
  },
}

afterEach(() => {
  setLocalChatTransport(undefined)
  setLocalChatLanguage(() => 'en')
})

describe('local reply recovery', () => {
  it.each(['', '  ', '[file:0]', '[[file:1]]', '[[3]]'])(
    'retries %j once without tools, keeps history and streams only the answer',
    async (first) => {
      const cb = callbacks()
      let attempts = 0
      setLocalChatTransport(async (_config, request, emit) => {
        expect(request.messages).toBe(messages)
        expect(request.maxTokens).toBe(64)
        attempts++
        if (attempts === 1) {
          expect(request.tools).toEqual(tools)
          for (const text of first) emit({ id: 'test', type: 'text', text })
          expect(cb.onDelta).not.toHaveBeenCalled()
        } else {
          expect(request.tools).toEqual([])
          expect(request.system).toContain('plain sentences')
          emit({ id: 'test', type: 'text', text: 'Chào bạn!' })
          // Text must already be delivered before the transport finishes.
          expect(cb.onDelta).toHaveBeenCalledWith('Chào bạn!')
        }
        emit(usage)
        emit(done)
      })
      await streamLocal(config, 'Reply in Vietnamese.', messages, tools, 64, cb)
      expect(attempts).toBe(2)
      expect(cb.onDelta.mock.calls.flat().join('')).toBe('Chào bạn!')
      expect(cb.onUsage).toHaveBeenCalledExactlyOnceWith({
        inputTokens: 40,
        outputTokens: 14,
        thoughtsTokenCount: 2,
      })
      expect(cb.onStopReason).toHaveBeenCalledExactlyOnceWith('eogToken')
    },
  )

  it('recovers an invalid empty tool-call without dispatching it', async () => {
    const cb = callbacks()
    let attempts = 0
    setLocalChatTransport(async (_config, _request, emit) => {
      if (++attempts === 1)
        emit({ id: 'test', type: 'toolcall', call: { id: 'empty', name: '', input: {} } })
      else emit({ id: 'test', type: 'text', text: 'Chào bạn!' })
    })
    await streamLocal(config, '', messages, tools, 64, cb)
    expect(attempts).toBe(2)
    expect(cb.onToolCall).not.toHaveBeenCalled()
    expect(cb.onDelta).toHaveBeenCalledWith('Chào bạn!')
  })

  it('preserves valid tool-only turns and the grant without retrying', async () => {
    const cb = callbacks()
    const call = { id: 'search-1', name: 'search', input: {} }
    const transport = vi.fn<LocalChatTransport>(async (_config, _request, emit) => {
      emit({ id: 'test', type: 'text', text: '[file:0]' })
      emit({ id: 'test', type: 'toolcall', call })
      emit({ id: 'test', type: 'done', stopReason: 'functionCalls' })
    })
    setLocalChatTransport(transport)
    await streamLocal(config, '', messages, tools, 64, cb)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(cb.onToolCall).toHaveBeenCalledExactlyOnceWith(call)
    expect(cb.onDelta).not.toHaveBeenCalled()
    expect(cb.onStopReason).toHaveBeenCalledExactlyOnceWith('functionCalls')
  })

  it('reports a localized error after two empty completions, including one-shot calls', async () => {
    setLocalChatLanguage(() => 'vi')
    const transport = vi.fn<LocalChatTransport>(async (_config, _request, emit) => {
      emit(done)
    })
    setLocalChatTransport(transport)
    const cb = callbacks()
    await expect(streamLocal(config, '', messages, tools, 64, cb)).rejects.toThrow(
      localChatCopy('vi').noReply,
    )
    expect(transport).toHaveBeenCalledTimes(2)
    expect(cb.onDelta).not.toHaveBeenCalled()
    expect(await chatLocal(config, '', 'hello')).toEqual({
      ok: false,
      error: localChatCopy('vi').noReply,
    })
    expect(transport).toHaveBeenCalledTimes(4)
  })

  it('does not retry after cancellation, a runtime failure or partially streamed text', async () => {
    for (const failure of [
      new Error('native failure'),
      new LocalLlmError('INVALID_TOOL', 'invalid'),
    ]) {
      const cb = callbacks()
      const transport = vi.fn<LocalChatTransport>(async (_config, _request, emit) => {
        emit({ id: 'test', type: 'text', text: 'partial answer' })
        throw failure
      })
      setLocalChatTransport(transport)
      await expect(streamLocal(config, '', messages, tools, 64, cb)).rejects.toThrow(failure)
      expect(transport).toHaveBeenCalledTimes(1)
    }
    const controller = new AbortController()
    const transport = vi.fn(async () => {
      controller.abort()
    })
    setLocalChatTransport(transport)
    await expect(
      streamLocal(config, '', messages, tools, 64, { ...callbacks(), signal: controller.signal }),
    ).rejects.toThrow()
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('streams normal text immediately and preserves Markdown links', async () => {
    for (const answer of ['Chào bạn!', '[Example](https://example.com)']) {
      const cb = callbacks()
      const transport = vi.fn<LocalChatTransport>(async (_config, _request, emit) => {
        for (const text of answer) emit({ id: 'test', type: 'text', text })
        expect(cb.onDelta.mock.calls.flat().join('')).toBe(answer)
      })
      setLocalChatTransport(transport)
      await streamLocal(config, '', messages, tools, 64, cb)
      expect(transport).toHaveBeenCalledTimes(1)
    }
  })

  it('has recovery copy in every supported language', () => {
    for (const lang of LANGS) expect(localChatCopy(lang).noReply.trim()).not.toBe('')
  })
})
