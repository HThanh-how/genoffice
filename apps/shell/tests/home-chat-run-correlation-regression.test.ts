// @vitest-environment jsdom
// @ts-expect-error global React act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act, createElement } from 'react'
import { AgyChatBar, type AgyBarApi } from '@genoffice/ui'
import { createIpcTransport } from '@genoffice/agent-core'
import {
  publishAgyActivity,
  subscribeAgyActivity,
  type AgyActivity,
} from '@genoffice/ai-provider/agy-activity'

describe('Home Chat Run Correlation Regression Tests (Phase C)', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let listeners: Set<(event: AgyActivity) => void>

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    listeners = new Set()
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    listeners.clear()
  })

  function createMockApi(overrides: Partial<AgyBarApi> = {}): AgyBarApi {
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
        listeners.add(fn)
        return () => {
          listeners.delete(fn)
        }
      },
      ...overrides,
    }
  }

  function emitActivity(activity: AgyActivity): void {
    for (const listener of [...listeners]) {
      listener(activity)
    }
  }

  it('1. Current request receives its own activity', async () => {
    // Verify direct pub/sub broadcasts sessionId correctly
    let directActivity: AgyActivity | null = null
    const offDirect = subscribeAgyActivity((actItem) => {
      directActivity = actItem
    })
    publishAgyActivity({
      runId: 'direct-run',
      sessionId: 'direct-session',
      phase: 'start',
      at: Date.now(),
    })
    expect(directActivity).not.toBeNull()
    expect((directActivity as unknown as AgyActivity)?.sessionId).toBe('direct-session')
    offDirect()

    const api = createMockApi()
    const targetSessionId = 'session-alpha-123'

    await act(async () => {
      root.render(
        createElement(AgyChatBar, {
          lang: 'en',
          part: 'steps',
          mode: 'home-chat',
          busy: true,
          sessionId: targetSessionId,
          api,
        }),
      )
    })

    await act(async () => {
      emitActivity({
        runId: 'run-1',
        sessionId: targetSessionId,
        phase: 'thinking',
        at: Date.now(),
      })
    })

    const title = host.querySelector('.agy-think-title')
    expect(title).not.toBeNull()
    expect(title?.textContent).toContain('Reading your request…')
  })

  it("2. Another window's request is ignored", async () => {
    const api = createMockApi()
    const targetSessionId = 'session-window-1'

    await act(async () => {
      root.render(
        createElement(AgyChatBar, {
          lang: 'en',
          part: 'steps',
          mode: 'home-chat',
          busy: true,
          sessionId: targetSessionId,
          api,
        }),
      )
    })

    // Activity from window 2 with different sessionId
    await act(async () => {
      emitActivity({
        runId: 'run-other-window',
        sessionId: 'session-window-2',
        phase: 'tool',
        tool: 'search_files',
        target: 'secret.docx',
        at: Date.now(),
      })
    })

    // Should NOT show window 2's tool activity ("Searching…")
    const title = host.querySelector('.agy-think-title')
    expect(title?.textContent).not.toContain('Searching…')
    expect(host.querySelector('.agy-think.is-tool')).toBeNull()
  })

  it('3. Old activity arriving first is rejected', async () => {
    const api = createMockApi()
    const targetSessionId = 'session-active'

    // Component not busy yet
    await act(async () => {
      root.render(
        createElement(AgyChatBar, {
          lang: 'en',
          part: 'steps',
          mode: 'home-chat',
          busy: false,
          sessionId: targetSessionId,
          api,
        }),
      )
    })

    // Activity arrives when busy is false
    await act(async () => {
      emitActivity({
        runId: 'stale-run-99',
        sessionId: targetSessionId,
        phase: 'thinking',
        at: Date.now(),
      })
    })

    expect(host.querySelector('.agy-think')).toBeNull()
  })

  it('4. Rapid new-chat transitions do not cross-contaminate', async () => {
    const api = createMockApi()

    // Render session A
    await act(async () => {
      root.render(
        createElement(AgyChatBar, {
          lang: 'en',
          part: 'steps',
          mode: 'home-chat',
          busy: true,
          sessionId: 'session-A',
          api,
        }),
      )
    })

    await act(async () => {
      emitActivity({
        runId: 'run-A',
        sessionId: 'session-A',
        phase: 'tool',
        tool: 'read_document',
        target: 'docA.docx',
        at: Date.now(),
      })
    })

    expect(host.querySelector('.agy-think-title')?.textContent).toContain('Reading docA.docx…')

    // Switch rapidly to session B (new chat)
    await act(async () => {
      root.render(
        createElement(AgyChatBar, {
          lang: 'en',
          part: 'steps',
          mode: 'home-chat',
          busy: true,
          sessionId: 'session-B',
          api,
        }),
      )
    })

    // Late event arrives for old session A
    await act(async () => {
      emitActivity({
        runId: 'run-A',
        sessionId: 'session-A',
        phase: 'writing',
        at: Date.now(),
      })
    })

    // Session B should not display session A's writing phase
    expect(host.querySelector('.agy-think-title')?.textContent).not.toContain('Writing answer…')

    // Event arrives for session B
    await act(async () => {
      emitActivity({
        runId: 'run-B',
        sessionId: 'session-B',
        phase: 'thinking',
        at: Date.now(),
      })
    })

    expect(host.querySelector('.agy-think-title')?.textContent).toContain('Reading your request…')
  })

  it('5. Cancellation invalidates old activity', async () => {
    const api = createMockApi()
    const targetSessionId = 'session-cancel-test'

    // Active busy run
    await act(async () => {
      root.render(
        createElement(AgyChatBar, {
          lang: 'en',
          part: 'steps',
          mode: 'home-chat',
          busy: true,
          sessionId: targetSessionId,
          api,
        }),
      )
    })

    await act(async () => {
      emitActivity({
        runId: 'run-to-cancel',
        sessionId: targetSessionId,
        phase: 'thinking',
        at: Date.now(),
      })
    })

    expect(host.querySelector('.agy-think-title')).not.toBeNull()

    // Stop / cancel: busy becomes false
    await act(async () => {
      root.render(
        createElement(AgyChatBar, {
          lang: 'en',
          part: 'steps',
          mode: 'home-chat',
          busy: false,
          sessionId: targetSessionId,
          api,
        }),
      )
    })

    expect(host.querySelector('.agy-think')).toBeNull()

    // Late event from cancelled run arrives
    await act(async () => {
      emitActivity({
        runId: 'run-to-cancel',
        sessionId: targetSessionId,
        phase: 'tool',
        tool: 'search_files',
        at: Date.now(),
      })
    })

    // Should remain clean, not displaying late cancelled tool activity
    expect(host.querySelector('.agy-think')).toBeNull()
  })

  it('6. Provider retries preserve proper correlation', async () => {
    const api = createMockApi()
    const targetSessionId = 'session-retry-test'

    await act(async () => {
      root.render(
        createElement(AgyChatBar, {
          lang: 'en',
          part: 'steps',
          mode: 'home-chat',
          busy: true,
          sessionId: targetSessionId,
          api,
        }),
      )
    })

    // Attempt 1 fails
    await act(async () => {
      emitActivity({
        runId: 'attempt-1',
        sessionId: targetSessionId,
        phase: 'thinking',
        at: Date.now(),
      })
    })

    await act(async () => {
      emitActivity({
        runId: 'attempt-1',
        sessionId: targetSessionId,
        phase: 'error',
        message: 'model rate limit',
        at: Date.now(),
      })
    })

    // Attempt 2 starts under the same session
    await act(async () => {
      emitActivity({
        runId: 'attempt-2',
        sessionId: targetSessionId,
        phase: 'start',
        at: Date.now(),
      })
    })

    await act(async () => {
      emitActivity({
        runId: 'attempt-2',
        sessionId: targetSessionId,
        phase: 'thinking',
        at: Date.now(),
      })
    })

    const title = host.querySelector('.agy-think-title')
    expect(title?.textContent).toContain('Thinking…')
    expect(title?.textContent).not.toContain('model rate limit')
  })

  it('7. Non-Antigravity Thinking fallback works', async () => {
    const nonAgyApi = createMockApi({
      getAgyChatState: async () => ({
        active: false,
        selected: '',
        models: [],
      }),
    })

    await act(async () => {
      root.render(
        createElement(AgyChatBar, {
          lang: 'vi',
          part: 'steps',
          mode: 'home-chat',
          busy: true,
          sessionId: 'session-gemini',
          api: nonAgyApi,
        }),
      )
    })

    const title = host.querySelector('.agy-think-title')
    expect(title).not.toBeNull()
    expect(title?.textContent).toContain('Đang suy nghĩ…')
  })

  it('8. A completed request leaves no running indicator', async () => {
    const api = createMockApi()
    const targetSessionId = 'session-done-test'

    await act(async () => {
      root.render(
        createElement(AgyChatBar, {
          lang: 'en',
          part: 'steps',
          mode: 'home-chat',
          busy: true,
          sessionId: targetSessionId,
          api,
        }),
      )
    })

    await act(async () => {
      emitActivity({
        runId: 'run-complete',
        sessionId: targetSessionId,
        phase: 'done',
        at: Date.now(),
      })
    })

    // Once turn is done, busy becomes false
    await act(async () => {
      root.render(
        createElement(AgyChatBar, {
          lang: 'en',
          part: 'steps',
          mode: 'home-chat',
          busy: false,
          sessionId: targetSessionId,
          api,
        }),
      )
    })

    expect(host.querySelector('.agy-think')).toBeNull()
  })

  it('9. Listener cleanup occurs', async () => {
    const api = createMockApi()
    expect(listeners.size).toBe(0)

    await act(async () => {
      root.render(
        createElement(AgyChatBar, {
          lang: 'en',
          part: 'steps',
          mode: 'home-chat',
          busy: true,
          sessionId: 'session-cleanup-test',
          api,
        }),
      )
    })

    expect(listeners.size).toBe(1)

    // Unmount component
    await act(async () => {
      root.unmount()
    })

    // Listener must be removed
    expect(listeners.size).toBe(0)
  })

  it('10. Multiple concurrent AI streams remain isolated', async () => {
    const host1 = document.createElement('div')
    const host2 = document.createElement('div')
    document.body.appendChild(host1)
    document.body.appendChild(host2)

    const root1 = createRoot(host1)
    const root2 = createRoot(host2)

    const api1 = createMockApi()
    const api2 = createMockApi()

    try {
      await act(async () => {
        root1.render(
          createElement(AgyChatBar, {
            lang: 'en',
            part: 'steps',
            mode: 'home-chat',
            busy: true,
            sessionId: 'stream-alpha',
            api: api1,
          }),
        )
        root2.render(
          createElement(AgyChatBar, {
            lang: 'en',
            part: 'steps',
            mode: 'home-chat',
            busy: true,
            sessionId: 'stream-beta',
            api: api2,
          }),
        )
      })

      // Emit event for stream alpha: tool search_files
      await act(async () => {
        emitActivity({
          runId: 'run-alpha',
          sessionId: 'stream-alpha',
          phase: 'tool',
          tool: 'search_files',
          target: 'finance.xlsx',
          at: Date.now(),
        })
      })

      // Emit event for stream beta: tool read_document
      await act(async () => {
        emitActivity({
          runId: 'run-beta',
          sessionId: 'stream-beta',
          phase: 'tool',
          tool: 'read_document',
          target: 'notes.md',
          at: Date.now(),
        })
      })

      const title1 = host1.querySelector('.agy-think-title')?.textContent
      const title2 = host2.querySelector('.agy-think-title')?.textContent

      expect(title1).toContain('Searching finance.xlsx…')
      expect(title1).not.toContain('Reading notes.md…')

      expect(title2).toContain('Reading notes.md…')
      expect(title2).not.toContain('Searching finance.xlsx…')

      // Also verify createIpcTransport dynamically resolves sessionId per attempt
      let sentSessionId = ''
      const transport = createIpcTransport({
        sessionId: () => 'dynamic-session-42',
        onStream: () => () => {},
        start: (req) => {
          sentSessionId = req.sessionId
        },
        cancel: () => {},
        getSettings: () => ({}),
        unknownErrorText: () => 'err',
      })

      transport.stream(
        {
          system: 'sys',
          messages: [],
          tools: [],
        },
        {
          onDelta: () => {},
          onError: () => {},
          onDone: () => {},
        },
      )

      expect(sentSessionId).toBe('dynamic-session-42')
    } finally {
      await act(async () => {
        root1.unmount()
        root2.unmount()
      })
      host1.remove()
      host2.remove()
    }
  })
})
