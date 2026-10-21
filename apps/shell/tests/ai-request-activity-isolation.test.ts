// @vitest-environment jsdom
// @ts-expect-error global React act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act, createElement } from 'react'
import { AgyChatBar, type AgyBarApi } from '@genoffice/ui'
import { createIpcTransport, type IpcStreamChunk, type IpcStreamStart } from '@genoffice/agent-core'
import { subscribeAgyActivity, type AgyActivity } from '@genoffice/ai-provider/agy-activity'
import { streamAgy, type AgyRunDeps } from '@genoffice/ai-provider/agy-cli'
import { HomeChat } from '../src/renderer/src/HomeChat'
import type { HomeApi } from '../src/shared/home-api'
import type { I18n } from '../src/renderer/src/locale'
import { requestChatPrefill } from '../src/renderer/src/chat-events'

class FakeAgyChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  pid = 5150
  kill = vi.fn(() => true)
  emitLines(lines: string[]) {
    this.stdout.write(lines.join('\n') + '\n')
  }
  exit(code: number) {
    this.stdout.end()
    setImmediate(() => this.emit('close', code))
  }
  asChild() {
    return this as unknown as ChildProcessWithoutNullStreams
  }
}

function createAgyRunDeps(child: FakeAgyChild): AgyRunDeps {
  return {
    platform: 'win32',
    env: {},
    home: 'C:\\Users\\u',
    isFile: async (p) => p === 'C:\\agy\\agy.exe',
    isExecutable: async (p) => p === 'C:\\agy\\agy.exe',
    loginShellLookup: async () => undefined,
    spawn: () => child.asChild(),
    killTree: vi.fn(),
    makeStagingDir: async () => 'C:\\tmp\\stage-test',
    removeDir: async () => undefined,
    writeFile: async () => undefined,
  }
}

const mockI18n: I18n = {
  lang: 'en',
  setLang: () => {},
  t: ((k: string) => k) as I18n['t'],
  dateLocale: 'en-US',
}

describe('AI Request Activity Isolation Regression Suite (Phase C)', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let activityListeners: Set<(event: AgyActivity) => void>

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    activityListeners = new Set()
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    activityListeners.clear()
    delete (window as unknown as { agyChat?: AgyBarApi }).agyChat
  })

  function createBarApi(overrides: Partial<AgyBarApi> = {}): AgyBarApi {
    return {
      getAgyChatState: async () => ({
        active: true,
        selected: 'fast',
        models: [{ id: 'fast', label: 'Fast', group: 'fast', relativeCost: 1, speed: 'fast' }],
      }),
      getAgyChatUsage: async () => ({
        groups: null,
        readAt: Date.now(),
        refreshing: false,
        failed: false,
      }),
      refreshAgyChatUsage: async () => ({
        groups: null,
        readAt: Date.now(),
        refreshing: false,
        failed: false,
      }),
      selectAgyChatModel: async () => true,
      onAgyChatUsage: () => () => {},
      onAgyChatActivity: (fn) => {
        activityListeners.add(fn)
        return () => {
          activityListeners.delete(fn)
        }
      },
      ...overrides,
    }
  }

  function emitActivity(activity: AgyActivity): void {
    for (const listener of [...activityListeners]) {
      listener(activity)
    }
  }

  function createTestHomeApi(
    startedRequests: Array<IpcStreamStart<unknown>>,
    cancelledRequestIds: string[],
    onListenerChange?: (listener: ((chunk: IpcStreamChunk) => void) | null) => void,
  ): HomeApi {
    return {
      homeChatList: vi.fn().mockResolvedValue([]),
      homeChatGet: vi.fn().mockResolvedValue(null),
      homeChatSave: vi.fn().mockResolvedValue(null),
      homeChatDelete: vi.fn().mockResolvedValue(true),
      homeChatClear: vi.fn().mockResolvedValue(true),
      homeChatRename: vi.fn().mockResolvedValue(null),
      getAiSettings: vi.fn().mockResolvedValue({
        provider: 'gemini',
        providers: { gemini: { apiKey: 'test-key', model: 'gemini-2.5-flash' } },
      }),
      onAiStream: (fn) => {
        onListenerChange?.(fn as (chunk: IpcStreamChunk) => void)
        return () => {
          onListenerChange?.(null)
        }
      },
      aiStream: vi.fn().mockImplementation(async (req: IpcStreamStart<unknown>) => {
        startedRequests.push(req)
      }),
      aiStreamCancel: vi.fn().mockImplementation(async (reqId: string) => {
        cancelledRequestIds.push(reqId)
      }),
      documentMemorySearch: vi.fn().mockResolvedValue({ hits: [] }),
      documentMemoryStatus: vi.fn().mockResolvedValue({ state: 'idle', indexed: 0, total: 0 }),
    } as unknown as HomeApi
  }

  it('1. One requestId is created per transport attempt', () => {
    const reportedAttempts: Array<{ requestId: string; sessionId: string }> = []
    const transport = createIpcTransport<{ provider: string }>({
      sessionId: () => 'conv-session-1',
      onAttemptStarted: (ctx) => {
        reportedAttempts.push(ctx)
      },
      onStream: () => () => {},
      start: () => {},
      cancel: () => {},
      getSettings: () => ({ provider: 'agy' }),
      unknownErrorText: () => 'error',
    })

    transport.stream(
      { system: 'sys', messages: [{ role: 'user', text: 'turn 1' }], tools: [] },
      { onDelta: () => {}, onToolCall: () => {}, onError: () => {}, onDone: () => {} },
    )
    transport.stream(
      { system: 'sys', messages: [{ role: 'user', text: 'turn 2' }], tools: [] },
      { onDelta: () => {}, onToolCall: () => {}, onError: () => {}, onDone: () => {} },
    )

    expect(reportedAttempts).toHaveLength(2)
    expect(reportedAttempts[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(reportedAttempts[1]!.requestId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(reportedAttempts[0]!.requestId).not.toBe(reportedAttempts[1]!.requestId)
  })

  it('2. requestId is reported before IPC start and forwarded to main IPC unchanged', () => {
    const callOrder: string[] = []
    const startedRequests: Array<IpcStreamStart<{ provider: string }>> = []

    const transport = createIpcTransport<{ provider: string }>({
      sessionId: () => 'conv-session-2',
      onAttemptStarted: ({ requestId }) => {
        callOrder.push(`onAttemptStarted:${requestId}`)
      },
      onStream: () => () => {},
      start: (req) => {
        callOrder.push(`start:${req.requestId}`)
        startedRequests.push(req)
      },
      cancel: () => {},
      getSettings: () => ({ provider: 'agy' }),
      unknownErrorText: () => 'error',
    })

    transport.stream(
      { system: 'sys', messages: [{ role: 'user', text: 'hello' }], tools: [] },
      { onDelta: () => {}, onToolCall: () => {}, onError: () => {}, onDone: () => {} },
    )

    expect(startedRequests).toHaveLength(1)
    const reqId = startedRequests[0]!.requestId
    expect(callOrder).toEqual([`onAttemptStarted:${reqId}`, `start:${reqId}`])
    expect(startedRequests[0]!.sessionId).toBe('conv-session-2')
  })

  it('3. requestId reaches the provider callback via docs-main ai:stream', () => {
    const docsMainSource = readFileSync(
      resolve(__dirname, '../../../apps/docs/src/main/docs-main.ts'),
      'utf8',
    )
    expect(docsMainSource).toContain('...(requestId ? { requestId } : {}),')
    expect(docsMainSource).toContain(
      '...(request.sessionId ? { sessionId: request.sessionId } : {}),',
    )
  })

  it('4. Antigravity activity carries both authoritative requestId and distinct runId', async () => {
    const captured: AgyActivity[] = []
    const unsubscribe = subscribeAgyActivity((event) => {
      captured.push(event)
    })

    try {
      const child = new FakeAgyChild()
      const deps = createAgyRunDeps(child)
      const streamPromise = streamAgy(
        { apiKey: '', model: 'gemini-3.7-flash-low', cliPath: 'C:\\agy\\agy.exe' },
        'system prompt',
        [{ role: 'user', text: 'summarize report' }],
        [],
        1024,
        {
          requestId: 'req-authoritative-777',
          sessionId: 'session-conv-777',
          signal: new AbortController().signal,
          onDelta: () => {},
          onToolCall: () => {},
        },
        deps,
      )

      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))

      child.emitLines([
        JSON.stringify({
          event: 'step_update',
          step_update: {
            step_type: 'tool_call',
            state: 'ACTIVE',
            tool_name: 'view_file',
            tool_input: { path: 'Q4-report.docx' },
          },
        }),
        JSON.stringify({
          event: 'step_update',
          step_update: {
            step_type: 'agent_response',
            state: 'DONE',
            text_delta: 'Summary complete.',
            duration_seconds: 1.5,
            usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 45 },
          },
        }),
        JSON.stringify({
          event: 'result',
          result: {
            status: 'SUCCESS',
            response: 'Summary complete.',
          },
        }),
      ])
      child.exit(0)
      await streamPromise

      expect(captured.length).toBeGreaterThanOrEqual(3)
      const distinctRunIds = new Set(captured.map((e) => e.runId))
      expect(distinctRunIds.size).toBe(1)
      const runId = captured[0]!.runId
      expect(runId).not.toBe('req-authoritative-777')

      for (const activity of captured) {
        expect(activity.runId).toBe(runId)
        expect(activity.requestId).toBe('req-authoritative-777')
        expect(activity.sessionId).toBe('session-conv-777')
      }
      expect(captured[0]!.phase).toBe('start')
      expect(captured.at(-1)!.phase).toBe('done')
    } finally {
      unsubscribe()
    }
  })

  it('5. HomeChat receives the current requestId and passes it to AgyChatBar', async () => {
    const barApi = createBarApi()
    ;(window as unknown as { agyChat?: AgyBarApi }).agyChat = barApi
    const startedRequests: Array<IpcStreamStart<unknown>> = []
    const homeApi = createTestHomeApi(startedRequests, [])

    await act(async () => {
      root.render(createElement(HomeChat, { api: homeApi, i18n: mockI18n }))
    })

    await act(async () => {
      requestChatPrefill({ text: 'Check budget', intent: 'new', send: true })
      await new Promise((r) => setTimeout(r, 20))
    })

    expect(startedRequests).toHaveLength(1)
    const activeReq = startedRequests[0]!

    await act(async () => {
      emitActivity({
        runId: 'run-live',
        requestId: activeReq.requestId,
        sessionId: activeReq.sessionId,
        phase: 'tool',
        tool: 'search_files',
        at: Date.now(),
      })
    })
    expect(host.querySelector('.agy-think-title')?.textContent).toContain('Searching files…')
  })

  it('6. AgyChatBar rejects unrelated request activity and activity missing requestId', async () => {
    const api = createBarApi()
    await act(async () => {
      root.render(
        createElement(AgyChatBar, {
          lang: 'en',
          part: 'steps',
          mode: 'home-chat',
          busy: true,
          sessionId: 'conv-6',
          activeRequestId: 'req-expected-6',
          api,
        }),
      )
    })

    await act(async () => {
      emitActivity({
        runId: 'run-other-req',
        requestId: 'req-unrelated-999',
        sessionId: 'conv-6',
        phase: 'tool',
        tool: 'search_files',
        at: Date.now(),
      })
      emitActivity({
        runId: 'run-missing-req',
        sessionId: 'conv-6',
        phase: 'writing',
        at: Date.now(),
      })
    })

    expect(host.querySelector('.agy-think-title')?.textContent).not.toContain('Searching files…')
    expect(host.querySelector('.agy-think-title')?.textContent).not.toContain('Writing answer…')
  })

  it('7. Old START arriving before new START in the SAME conversation is rejected immediately', async () => {
    const api = createBarApi()
    const conversationX = 'conv-same-session-X'

    // 1. Conversation X exists; 2. Request A starts
    await act(async () => {
      root.render(
        createElement(AgyChatBar, {
          lang: 'en',
          part: 'steps',
          mode: 'home-chat',
          busy: true,
          sessionId: conversationX,
          activeRequestId: 'req-A',
          api,
        }),
      )
    })

    // 3. A is cancelled; 4. HomeChat resets its active request identity
    await act(async () => {
      root.render(
        createElement(AgyChatBar, {
          lang: 'en',
          part: 'steps',
          mode: 'home-chat',
          busy: false,
          sessionId: conversationX,
          activeRequestId: null,
          api,
        }),
      )
    })

    // 5. Request B starts in the SAME conversation; 6. HomeChat receives B's authoritative requestId
    await act(async () => {
      root.render(
        createElement(AgyChatBar, {
          lang: 'en',
          part: 'steps',
          mode: 'home-chat',
          busy: true,
          sessionId: conversationX,
          activeRequestId: 'req-B',
          api,
        }),
      )
    })

    // 7. Delayed START event from A arrives first (along with a thinking step from A)
    await act(async () => {
      emitActivity({
        runId: 'run-A',
        requestId: 'req-A',
        sessionId: conversationX,
        phase: 'start',
        at: Date.now() + 100,
      })
      emitActivity({
        runId: 'run-A',
        requestId: 'req-A',
        sessionId: conversationX,
        phase: 'thinking',
        thinkingTokens: 320,
        at: Date.now() + 150,
      })
    })
    // A's thinking tokens must not appear
    expect(host.querySelector('.agy-think-meta')).toBeNull()

    // 8. B's real START event arrives second
    await act(async () => {
      emitActivity({
        runId: 'run-B',
        requestId: 'req-B',
        sessionId: conversationX,
        phase: 'start',
        at: Date.now() + 200,
      })
      emitActivity({
        runId: 'run-B',
        requestId: 'req-B',
        sessionId: conversationX,
        phase: 'tool',
        tool: 'view_file',
        target: 'actual-B.docx',
        at: Date.now() + 250,
      })
    })
    expect(host.querySelector('.agy-think-title')?.textContent).toContain('Reading documents…')
  })

  it('8. Old TOOL and WRITING activity from previous request in same conversation is rejected', async () => {
    const api = createBarApi()
    await act(async () => {
      root.render(
        createElement(AgyChatBar, {
          lang: 'en',
          part: 'steps',
          mode: 'home-chat',
          busy: true,
          sessionId: 'conv-8',
          activeRequestId: 'req-B',
          api,
        }),
      )
    })

    await act(async () => {
      emitActivity({
        runId: 'run-A',
        requestId: 'req-A',
        sessionId: 'conv-8',
        phase: 'tool',
        tool: 'search_files',
        at: Date.now(),
      })
      emitActivity({
        runId: 'run-A',
        requestId: 'req-A',
        sessionId: 'conv-8',
        phase: 'writing',
        at: Date.now(),
      })
    })

    expect(host.querySelector('.agy-think-title')?.textContent).not.toContain('Searching files…')
    expect(host.querySelector('.agy-think-title')?.textContent).not.toContain('Writing answer…')
  })

  it('9. Old DONE activity from previous request is rejected while new request is active', async () => {
    const api = createBarApi()
    await act(async () => {
      root.render(
        createElement(AgyChatBar, {
          lang: 'en',
          part: 'steps',
          mode: 'home-chat',
          busy: true,
          sessionId: 'conv-9',
          activeRequestId: 'req-B',
          api,
        }),
      )
    })

    await act(async () => {
      emitActivity({
        runId: 'run-B',
        requestId: 'req-B',
        sessionId: 'conv-9',
        phase: 'tool',
        tool: 'view_file',
        at: Date.now(),
      })
      emitActivity({
        runId: 'run-A',
        requestId: 'req-A',
        sessionId: 'conv-9',
        phase: 'done',
        at: Date.now() + 50,
      })
    })

    expect(host.querySelector('.agy-think-title')?.textContent).toContain('Reading documents…')
    expect(host.querySelector('.agy-think-title')?.textContent).not.toContain('Done in')
  })

  it('10. Two concurrent conversations in separate windows remain strictly isolated', async () => {
    const host2 = document.createElement('div')
    document.body.appendChild(host2)
    const root2 = createRoot(host2)
    const api1 = createBarApi()
    const api2 = createBarApi()

    try {
      await act(async () => {
        root.render(
          createElement(AgyChatBar, {
            lang: 'en',
            part: 'steps',
            mode: 'home-chat',
            busy: true,
            sessionId: 'conv-win-1',
            activeRequestId: 'req-win-1',
            api: api1,
          }),
        )
        root2.render(
          createElement(AgyChatBar, {
            lang: 'en',
            part: 'steps',
            mode: 'home-chat',
            busy: true,
            sessionId: 'conv-win-2',
            activeRequestId: 'req-win-2',
            api: api2,
          }),
        )
      })

      await act(async () => {
        emitActivity({
          runId: 'run-1',
          requestId: 'req-win-1',
          sessionId: 'conv-win-1',
          phase: 'tool',
          tool: 'search_files',
          at: Date.now(),
        })
        emitActivity({
          runId: 'run-2',
          requestId: 'req-win-2',
          sessionId: 'conv-win-2',
          phase: 'writing',
          at: Date.now(),
        })
      })

      expect(host.querySelector('.agy-think-title')?.textContent).toContain('Searching files…')
      expect(host2.querySelector('.agy-think-title')?.textContent).toContain('Writing answer…')
    } finally {
      await act(async () => {
        root2.unmount()
      })
      host2.remove()
    }
  })

  it('11. Two sequential attempts in the same conversation remain isolated', async () => {
    const api = createBarApi()
    const sameSession = 'conv-sequential'

    await act(async () => {
      root.render(
        createElement(AgyChatBar, {
          lang: 'en',
          part: 'steps',
          mode: 'home-chat',
          busy: true,
          sessionId: sameSession,
          activeRequestId: 'req-turn-1',
          api,
        }),
      )
    })

    await act(async () => {
      emitActivity({
        runId: 'run-turn-1',
        requestId: 'req-turn-1',
        sessionId: sameSession,
        phase: 'tool',
        tool: 'search_files',
        at: Date.now(),
      })
    })
    expect(host.querySelector('.agy-think-title')?.textContent).toContain('Searching files…')

    // Turn 2 starts in same conversation -> activeRequestId updates to req-turn-2
    await act(async () => {
      root.render(
        createElement(AgyChatBar, {
          lang: 'en',
          part: 'steps',
          mode: 'home-chat',
          busy: true,
          sessionId: sameSession,
          activeRequestId: 'req-turn-2',
          api,
        }),
      )
    })

    // Turn 1's tool state is immediately cleared
    expect(host.querySelector('.agy-think-title')?.textContent).not.toContain('Searching files…')

    // Late event from Turn 1 is rejected even with matching sessionId
    await act(async () => {
      emitActivity({
        runId: 'run-turn-1',
        requestId: 'req-turn-1',
        sessionId: sameSession,
        phase: 'writing',
        at: Date.now(),
      })
    })
    expect(host.querySelector('.agy-think-title')?.textContent).not.toContain('Writing answer…')
  })

  it('12. Stop invalidates the current request identity in HomeChat', async () => {
    const barApi = createBarApi()
    ;(window as unknown as { agyChat?: AgyBarApi }).agyChat = barApi
    const startedRequests: Array<IpcStreamStart<unknown>> = []
    const cancelledRequestIds: string[] = []
    const homeApi = createTestHomeApi(startedRequests, cancelledRequestIds)

    await act(async () => {
      root.render(createElement(HomeChat, { api: homeApi, i18n: mockI18n }))
    })

    await act(async () => {
      requestChatPrefill({ text: 'Stop test query', intent: 'new', send: true })
      await new Promise((r) => setTimeout(r, 20))
    })

    expect(startedRequests).toHaveLength(1)
    const req = startedRequests[0]!

    await act(async () => {
      emitActivity({
        runId: 'run-stop',
        requestId: req.requestId,
        sessionId: req.sessionId,
        phase: 'tool',
        tool: 'view_file',
        at: Date.now(),
      })
    })
    expect(host.querySelector('.agy-think-title')?.textContent).toContain('Reading documents…')

    const stopBtn = host.querySelector<HTMLButtonElement>('button.hc-send.stop')
    expect(stopBtn).not.toBeNull()
    await act(async () => {
      stopBtn!.click()
    })

    expect(cancelledRequestIds).toContain(req.requestId)
    expect(host.querySelector('.agy-think')).toBeNull()

    // Late event from stopped request is rejected
    await act(async () => {
      emitActivity({
        runId: 'run-stop',
        requestId: req.requestId,
        sessionId: req.sessionId,
        phase: 'writing',
        at: Date.now(),
      })
    })
    expect(host.querySelector('.agy-think')).toBeNull()
  })

  it('13. New Chat invalidates the previous request identity in HomeChat', async () => {
    const barApi = createBarApi()
    ;(window as unknown as { agyChat?: AgyBarApi }).agyChat = barApi
    const startedRequests: Array<IpcStreamStart<unknown>> = []
    const cancelledRequestIds: string[] = []
    const homeApi = createTestHomeApi(startedRequests, cancelledRequestIds)

    await act(async () => {
      root.render(createElement(HomeChat, { api: homeApi, i18n: mockI18n }))
    })

    await act(async () => {
      requestChatPrefill({ text: 'Initial chat', intent: 'new', send: true })
      await new Promise((r) => setTimeout(r, 20))
    })

    expect(startedRequests).toHaveLength(1)
    const reqOld = startedRequests[0]!

    // Switch to New Chat while request is in flight
    await act(async () => {
      requestChatPrefill({ text: 'Brand new chat', intent: 'new', send: true })
      await new Promise((r) => setTimeout(r, 20))
    })

    expect(startedRequests).toHaveLength(2)
    const reqNew = startedRequests[1]!
    expect(reqNew.requestId).not.toBe(reqOld.requestId)
    expect(reqNew.sessionId).not.toBe(reqOld.sessionId)
    // Under PR #24, New Chat preserves background runs and does not cancel the older in-flight request.
    // Safety invariant preserved: Late events from reqOld are still rejected by the new session's view below.
    expect(cancelledRequestIds).not.toContain(reqOld.requestId)

    // Late event from old chat is rejected
    await act(async () => {
      emitActivity({
        runId: 'run-old',
        requestId: reqOld.requestId,
        sessionId: reqOld.sessionId,
        phase: 'tool',
        tool: 'search_files',
        at: Date.now(),
      })
    })
    expect(host.querySelector('.agy-think-title')?.textContent).not.toContain('Searching files…')
  })

  it('14. Provider fallback preserves the correct new attempt requestId', async () => {
    const attemptRequestIds: string[] = []
    let currentListener: ((chunk: IpcStreamChunk) => void) | null = null
    const api = createBarApi()

    const transport = createIpcTransport<{ provider: string; model: string }>({
      sessionId: () => 'conv-fallback',
      onAttemptStarted: ({ requestId }) => {
        attemptRequestIds.push(requestId)
      },
      onStream: (listener) => {
        currentListener = listener
        return () => {
          currentListener = null
        }
      },
      start: () => {},
      cancel: () => {},
      getSettings: () => ({ provider: 'agy', model: 'primary-model' }),
      route: {
        prepare: (s) => s,
        fallback: (s) =>
          s.model === 'primary-model' ? { provider: 'agy', model: 'fallback-model' } : null,
      },
      unknownErrorText: () => 'error',
    })

    transport.stream(
      { system: 'sys', messages: [{ role: 'user', text: 'test' }], tools: [] },
      { onDelta: () => {}, onToolCall: () => {}, onError: () => {}, onDone: () => {} },
    )

    const reqAttempt1 = attemptRequestIds[0]!
    currentListener?.({
      requestId: reqAttempt1,
      type: 'error',
      error: 'overloaded',
      errorCode: 'overloaded',
    })

    expect(attemptRequestIds).toHaveLength(2)
    const reqAttempt2 = attemptRequestIds[1]!
    expect(reqAttempt2).not.toBe(reqAttempt1)

    await act(async () => {
      root.render(
        createElement(AgyChatBar, {
          lang: 'en',
          part: 'steps',
          mode: 'home-chat',
          busy: true,
          sessionId: 'conv-fallback',
          activeRequestId: reqAttempt2,
          api,
        }),
      )
    })

    await act(async () => {
      emitActivity({
        runId: 'run-attempt-1',
        requestId: reqAttempt1,
        sessionId: 'conv-fallback',
        phase: 'tool',
        tool: 'search_files',
        at: Date.now(),
      })
      emitActivity({
        runId: 'run-attempt-2',
        requestId: reqAttempt2,
        sessionId: 'conv-fallback',
        phase: 'tool',
        tool: 'view_file',
        at: Date.now(),
      })
    })

    expect(host.querySelector('.agy-think-title')?.textContent).toContain('Reading documents…')
  })

  it('15. Non-Antigravity Thinking fallback and Editor mode continue to work', async () => {
    const nonAgyApi = createBarApi({
      getAgyChatState: async () => ({ active: false, selected: '', models: [] }),
    })

    await act(async () => {
      root.render(
        createElement(AgyChatBar, {
          lang: 'en',
          part: 'steps',
          mode: 'home-chat',
          busy: true,
          sessionId: 'conv-non-agy',
          activeRequestId: 'req-non-agy',
          api: nonAgyApi,
        }),
      )
    })
    expect(host.querySelector('.agy-think-title')?.textContent).toContain('Thinking…')

    // Editor mode without activeRequestId or busy props
    const editorApi = createBarApi()
    await act(async () => {
      root.render(
        createElement(AgyChatBar, {
          lang: 'en',
          api: editorApi,
        }),
      )
    })
    await act(async () => {
      emitActivity({
        runId: 'editor-run-1',
        phase: 'start',
        at: Date.now(),
      })
    })
    expect(host.querySelector('.agy-think-title')?.textContent).toContain('Starting Antigravity')
  })

  it('16. Component listeners are removed on unmount', async () => {
    const api = createBarApi()
    await act(async () => {
      root.render(
        createElement(AgyChatBar, {
          lang: 'en',
          part: 'steps',
          mode: 'home-chat',
          busy: true,
          sessionId: 'conv-unmount',
          activeRequestId: 'req-unmount',
          api,
        }),
      )
    })
    expect(activityListeners.size).toBe(1)

    await act(async () => {
      root.unmount()
    })
    expect(activityListeners.size).toBe(0)
  })

  it('17. No stale timer continues after completion', async () => {
    vi.useFakeTimers()
    try {
      const api = createBarApi()
      await act(async () => {
        root.render(
          createElement(AgyChatBar, {
            lang: 'en',
            part: 'steps',
            mode: 'home-chat',
            busy: true,
            sessionId: 'conv-timer',
            activeRequestId: 'req-timer',
            api,
          }),
        )
      })

      await act(async () => {
        emitActivity({
          runId: 'run-timer',
          requestId: 'req-timer',
          sessionId: 'conv-timer',
          phase: 'thinking',
          at: Date.now(),
        })
      })

      // Complete request -> busy becomes false, activeRequestId becomes null
      await act(async () => {
        root.render(
          createElement(AgyChatBar, {
            lang: 'en',
            part: 'steps',
            mode: 'home-chat',
            busy: false,
            sessionId: 'conv-timer',
            activeRequestId: null,
            api,
          }),
        )
      })
      expect(host.querySelector('.agy-think')).toBeNull()

      await act(async () => {
        root.unmount()
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
