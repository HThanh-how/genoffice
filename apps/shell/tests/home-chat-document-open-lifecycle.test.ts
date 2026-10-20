// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { CreateDocumentDeps } from '@genoffice/agent-core'
import { HomeChat } from '../src/renderer/src/HomeChat'
import { requestChatPrefill } from '../src/renderer/src/chat-events'
import type { HomeApi } from '../src/shared/home-api'
import type { I18n } from '../src/renderer/src/locale'

const captured = vi.hoisted(() => ({
  docDeps: null as CreateDocumentDeps | null,
  runs: 0,
}))

vi.mock('@genoffice/agent-core', async (original) => {
  const actual = await original<typeof import('@genoffice/agent-core')>()
  return {
    ...actual,
    createDocumentSkill: (deps: CreateDocumentDeps) => {
      captured.docDeps = deps
      return actual.createDocumentSkill(deps)
    },
    AgentLoop: class {
      reset() {}
      restore() {}
      run() {
        captured.runs++
        return new Promise(() => {})
      }
    },
  }
})

const mockI18n: I18n = {
  lang: 'en',
  setLang: () => {},
  t: (k: string) => {
    if (k === 'askSaveDocx') return 'Save as Word (.docx)'
    if (k === 'askSaveMd') return 'Save as Markdown'
    return k
  },
  locale: 'en',
}

function mockApi(overrides: Partial<HomeApi> = {}): HomeApi {
  return {
    getAiSettings: async () => ({ provider: 'openai', providers: {} }),
    homeChatList: async () => [],
    homeChatSave: async () => null,
    homeChatGet: async (id: string) => ({
      id,
      title: id,
      messages: [],
      createdAt: 100,
      updatedAt: 100,
    }),
    getSettings: async () => ({}),
    kbList: async () => [],
    kbCreateDocument: vi.fn().mockImplementation(async (r) => ({
      path: `/Users/me/GenOffice/${r.title}.${r.format}`,
    })),
    statPaths: async () => [],
    openPath: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as HomeApi
}

describe('HomeChat document open lifecycle & concurrency isolation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    captured.docDeps = null
    captured.runs = 0
  })

  it('Two concurrent open requests deduplicate to single onOpenPath invocation', async () => {
    let resolveOpen!: (value: boolean) => void
    const openBarrier = new Promise<boolean>((res) => {
      resolveOpen = res
    })
    const onOpenPath = vi.fn().mockImplementation(() => openBarrier)

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const api = mockApi()

    try {
      await act(async () => {
        root.render(
          createElement(HomeChat, {
            api,
            i18n: mockI18n,
            onOpenPath,
          }),
        )
      })

      await act(async () => {
        requestChatPrefill({ text: 'Active Run', intent: 'new', send: true })
      })

      const session = captured.docDeps?.getSessionId?.()
      const turnId = captured.docDeps?.getUserTurnId?.()
      const ctx = { sessionId: session, userTurnId: turnId }

      expect(captured.docDeps).not.toBeNull()
      expect(captured.docDeps!.open).toBeDefined()

      // Launch two concurrent opens for the exact same document path
      const p1 = captured.docDeps!.open!('/Users/me/GenOffice/Report.docx', ctx)
      const p2 = captured.docDeps!.open!('/Users/me/GenOffice/Report.docx', ctx)

      expect(onOpenPath).toHaveBeenCalledTimes(1)

      resolveOpen(true)
      const [r1, r2] = await Promise.all([p1, p2])

      expect(r1).toBe(true)
      expect(r2).toBe(true)
      expect(onOpenPath).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('Two concurrent open requests with async isOpenPath deduplicate to single onOpenPath invocation', async () => {
    let resolveOpen!: (value: boolean) => void
    const openBarrier = new Promise<boolean>((res) => {
      resolveOpen = res
    })
    const onOpenPath = vi.fn().mockImplementation(() => openBarrier)
    const isOpenPath = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5))
      return false
    })

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const api = mockApi()

    try {
      await act(async () => {
        root.render(
          createElement(HomeChat, {
            api,
            i18n: mockI18n,
            onOpenPath,
            isOpenPath,
          }),
        )
      })

      await act(async () => {
        requestChatPrefill({ text: 'Active Async', intent: 'new', send: true })
      })

      const session = captured.docDeps?.getSessionId?.()
      const turnId = captured.docDeps?.getUserTurnId?.()
      const ctx = { sessionId: session, userTurnId: turnId }

      expect(captured.docDeps).not.toBeNull()
      expect(captured.docDeps!.open).toBeDefined()

      // Launch two concurrent opens while isOpenPath probe is in flight
      const p1 = captured.docDeps!.open!('/Users/me/GenOffice/ConcurrentAsync.docx', ctx)
      const p2 = captured.docDeps!.open!('/Users/me/GenOffice/ConcurrentAsync.docx', ctx)

      expect(isOpenPath).toHaveBeenCalledTimes(1)

      resolveOpen(true)
      const [r1, r2] = await Promise.all([p1, p2])

      expect(r1).toBe(true)
      expect(r2).toBe(true)
      expect(onOpenPath).toHaveBeenCalledTimes(1)
      expect(isOpenPath).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('Late document open attempt after conversation switch returns false with zero UI side effects', async () => {
    const onOpenPath = vi.fn().mockResolvedValue(true)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const api = mockApi()

    try {
      await act(async () => {
        root.render(
          createElement(HomeChat, {
            api,
            i18n: mockI18n,
            onOpenPath,
          }),
        )
      })

      // Initiate Conversation A
      await act(async () => {
        requestChatPrefill({ text: 'Draft A', intent: 'new', send: true })
      })

      const sessionA = captured.docDeps?.getSessionId?.()
      expect(sessionA).toBeDefined()

      // Switch to Conversation B
      await act(async () => {
        requestChatPrefill({ text: 'Draft B', intent: 'new', send: true })
      })

      const sessionB = captured.docDeps?.getSessionId?.()
      expect(sessionB).not.toBe(sessionA)

      // Late open call targeting session A must be rejected without opening
      const result = await captured.docDeps!.open!('/Users/me/GenOffice/LateDoc.docx', {
        sessionId: sessionA,
      })

      expect(result).toBe(false)
      expect(onOpenPath).not.toHaveBeenCalled()
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('Late asynchronous open completion does not corrupt state after conversation switch', async () => {
    let resolveOpen!: (value: boolean) => void
    const pendingOpen = new Promise<boolean>((res) => {
      resolveOpen = res
    })
    const onOpenPath = vi.fn().mockImplementation(() => pendingOpen)

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const api = mockApi()

    try {
      await act(async () => {
        root.render(
          createElement(HomeChat, {
            api,
            i18n: mockI18n,
            onOpenPath,
          }),
        )
      })

      // Initiate Conversation A
      await act(async () => {
        requestChatPrefill({ text: 'Draft A', intent: 'new', send: true })
      })

      // Start opening a document in Conversation A
      const oldDocPath = '/Users/me/GenOffice/DocA.docx'
      const openA = captured.docDeps!.open!(oldDocPath)

      // Switch to Conversation B before open completes
      await act(async () => {
        requestChatPrefill({ text: 'Draft B', intent: 'new', send: true })
      })

      // Now complete the pending open from Conversation A
      await act(async () => {
        resolveOpen(true)
        await openA
      })

      // In Conversation B, oldDocPath must not be marked as open
      const isOpenInB = captured.docDeps!.isOpen
        ? await captured.docDeps!.isOpen(oldDocPath)
        : false
      expect(isOpenInB).toBe(false)
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('Open succeeds, tab closes, reopen succeeds via isOpenPath', async () => {
    let tabOpen = false
    const onOpenPath = vi.fn().mockImplementation(async () => {
      tabOpen = true
      return true
    })
    const isOpenPath = vi.fn().mockImplementation(async () => tabOpen)

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const api = mockApi()

    try {
      await act(async () => {
        root.render(
          createElement(HomeChat, {
            api,
            i18n: mockI18n,
            onOpenPath,
            isOpenPath,
          }),
        )
      })

      await act(async () => {
        requestChatPrefill({ text: 'Tracked Run', intent: 'new', send: true })
      })

      const session = captured.docDeps?.getSessionId?.()
      const turnId = captured.docDeps?.getUserTurnId?.()
      const ctx = { sessionId: session, userTurnId: turnId }
      const docPath = '/Users/me/GenOffice/Tracked.docx'

      // First open: tab is closed, invokes onOpenPath
      const r1 = await captured.docDeps!.open!(docPath, ctx)
      expect(r1).toBe(true)
      expect(onOpenPath).toHaveBeenCalledTimes(1)
      expect(tabOpen).toBe(true)

      // Second check: tab is open, invokes onOpenPath to focus tab
      const r2 = await captured.docDeps!.open!(docPath, ctx)
      expect(r2).toBe(true)
      expect(onOpenPath).toHaveBeenCalledTimes(2)

      // Tab closes: isOpen reports false
      tabOpen = false

      // Third check: tab closed, invokes onOpenPath to reopen
      const r3 = await captured.docDeps!.open!(docPath, ctx)
      expect(r3).toBe(true)
      expect(onOpenPath).toHaveBeenCalledTimes(3)
      expect(tabOpen).toBe(true)
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('Open returns false and open throws are handled gracefully', async () => {
    const onOpenPath = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('Process disconnected'))

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const api = mockApi()

    try {
      await act(async () => {
        root.render(
          createElement(HomeChat, {
            api,
            i18n: mockI18n,
            onOpenPath,
          }),
        )
      })

      await act(async () => {
        requestChatPrefill({ text: 'Fail Run', intent: 'new', send: true })
      })

      const session = captured.docDeps?.getSessionId?.()
      const turnId = captured.docDeps?.getUserTurnId?.()
      const ctx = { sessionId: session, userTurnId: turnId }

      // 1. Returns false: resolves false, does not throw
      const r1 = await captured.docDeps!.open!('/Users/me/GenOffice/Fail1.docx', ctx)
      expect(r1).toBe(false)

      // 2. Throws error: caught cleanly, resolves false, does not crash
      const r2 = await captured.docDeps!.open!('/Users/me/GenOffice/Fail2.docx', ctx)
      expect(r2).toBe(false)
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  describe('P1-B: Stop & stale auto-open lifecycle (OPEN-01 through OPEN-12)', () => {
    afterEach(() => {
      vi.restoreAllMocks()
      localStorage.clear()
      captured.docDeps = null
      captured.runs = 0
    })

    it('OPEN-01: Stop pressed before auto-open rejects open with zero onOpenPath invocation', async () => {
      const onOpenPath = vi.fn().mockResolvedValue(true)
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      const api = mockApi()

      try {
        await act(async () => {
          root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath }))
        })

        await act(async () => {
          requestChatPrefill({ text: 'Draft Doc', intent: 'new', send: true })
        })

        const session = captured.docDeps?.getSessionId?.()
        const turnId = captured.docDeps?.getUserTurnId?.()
        expect(session).toBeDefined()
        expect(turnId).toBeDefined()

        // Press Stop button
        await act(async () => {
          const stopBtn = host.querySelector<HTMLButtonElement>('button.hc-send.stop')
          stopBtn?.click()
        })

        // Attempt delayed auto-open from the stopped turn
        const opened = await act(async () => {
          return await captured.docDeps!.open!('/Users/me/GenOffice/StoppedDoc.docx', {
            sessionId: session,
            userTurnId: turnId,
          })
        })

        expect(opened).toBe(false)
        expect(onOpenPath).not.toHaveBeenCalled()
      } finally {
        await act(async () => {
          root.unmount()
        })
        host.remove()
      }
    })

    it('OPEN-02: Delay isOpenPath, press Stop, resolve isOpenPath(false) -> onOpenPath is never invoked', async () => {
      let resolveIsOpen!: (v: boolean) => void
      const isOpenBarrier = new Promise<boolean>((res) => {
        resolveIsOpen = res
      })
      const isOpenPath = vi.fn().mockImplementation(() => isOpenBarrier)
      const onOpenPath = vi.fn().mockResolvedValue(true)

      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      const api = mockApi()

      try {
        await act(async () => {
          root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath, isOpenPath }))
        })

        await act(async () => {
          requestChatPrefill({ text: 'Draft Doc', intent: 'new', send: true })
        })

        const session = captured.docDeps?.getSessionId?.()
        const turnId = captured.docDeps?.getUserTurnId?.()

        // Launch auto-open while isOpenPath is pending
        const openPromise = captured.docDeps!.open!('/Users/me/GenOffice/DelayedOpen.docx', {
          sessionId: session,
          userTurnId: turnId,
        })

        expect(isOpenPath).toHaveBeenCalled()

        // Press Stop while isOpenPath is in flight
        await act(async () => {
          const stopBtn = host.querySelector<HTMLButtonElement>('button.hc-send.stop')
          stopBtn?.click()
        })

        // Resolve isOpenPath to false
        await act(async () => {
          resolveIsOpen(false)
        })

        const opened = await openPromise
        expect(opened).toBe(false)
        expect(onOpenPath).not.toHaveBeenCalled()
      } finally {
        await act(async () => {
          root.unmount()
        })
        host.remove()
      }
    })

    it('OPEN-03: Starting turn B in the same conversation invalidates pending auto-open from turn A', async () => {
      const onOpenPath = vi.fn().mockResolvedValue(true)
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      const api = mockApi()

      try {
        await act(async () => {
          root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath }))
        })

        // Turn A
        await act(async () => {
          requestChatPrefill({ text: 'Turn A', intent: 'new', send: true })
        })

        const session = captured.docDeps?.getSessionId?.()
        const turnA = captured.docDeps?.getUserTurnId?.()

        // Stop Turn A so that Turn B can start
        await act(async () => {
          const stopBtn = host.querySelector<HTMLButtonElement>('button.hc-send.stop')
          stopBtn?.click()
        })

        // Turn B in the same conversation
        await act(async () => {
          requestChatPrefill({ text: 'Turn B', intent: 'ask', send: true })
        })

        const turnB = captured.docDeps?.getUserTurnId?.()
        expect(turnB).not.toBe(turnA)

        // Turn A tries to late auto-open
        const openedA = await captured.docDeps!.open!('/Users/me/GenOffice/TurnADoc.docx', {
          sessionId: session,
          userTurnId: turnA,
        })

        expect(openedA).toBe(false)
        expect(onOpenPath).not.toHaveBeenCalled()
      } finally {
        await act(async () => {
          root.unmount()
        })
        host.remove()
      }
    })

    it('OPEN-04: Conversation switch invalidates pending auto-open from previous conversation', async () => {
      const onOpenPath = vi.fn().mockResolvedValue(true)
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      const api = mockApi()

      try {
        await act(async () => {
          root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath }))
        })

        await act(async () => {
          requestChatPrefill({ text: 'Draft A', intent: 'new', send: true })
        })

        const sessionA = captured.docDeps?.getSessionId?.()
        const turnA = captured.docDeps?.getUserTurnId?.()

        await act(async () => {
          requestChatPrefill({ text: 'Draft B', intent: 'new', send: true })
        })

        const sessionB = captured.docDeps?.getSessionId?.()
        expect(sessionB).not.toBe(sessionA)

        const opened = await captured.docDeps!.open!('/Users/me/GenOffice/LateSwitch.docx', {
          sessionId: sessionA,
          userTurnId: turnA,
        })

        expect(opened).toBe(false)
        expect(onOpenPath).not.toHaveBeenCalled()
      } finally {
        await act(async () => {
          root.unmount()
        })
        host.remove()
      }
    })

    it('OPEN-05: Manual open succeeds when agent is stopped / idle via UI click', async () => {
      localStorage.setItem('home-chat-last-session', 'sess-manual')
      const onOpenPath = vi.fn().mockResolvedValue(true)
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      const api = mockApi({
        openPath: onOpenPath,
        homeChatList: async () => [
          { id: 'sess-manual', title: 'Manual', updatedAt: 100, messageCount: 2 },
        ],
        homeChatGet: async (id: string) => ({
          id,
          title: id,
          messages: [
            {
              id: 1,
              role: 'user',
              text: 'Please create document',
            },
            {
              id: 2,
              role: 'assistant',
              text: 'Document created',
            },
          ],
          createdAt: 100,
          updatedAt: 100,
        }),
        kbCreateDocument: vi.fn().mockResolvedValue({
          path: '/Users/me/GenOffice/ManualDoc.docx',
        }),
      })

      try {
        await act(async () => {
          root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath }))
        })

        await act(async () => {
          requestChatPrefill({ text: 'open', intent: 'open-existing', sessionId: 'sess-manual' })
        })

        // Agent is stopped / idle; click Save as Word button on the rendered assistant message
        const saveWordBtn = host.querySelector<HTMLButtonElement>(
          'button[title="Save as Word (.docx)"]',
        )
        expect(saveWordBtn).not.toBeNull()

        await act(async () => {
          saveWordBtn?.click()
        })

        const saveBtn = host.querySelector<HTMLButtonElement>('button.hc-save-btn-saved')
        expect(saveBtn).not.toBeNull()

        await act(async () => {
          saveBtn?.click()
        })

        expect(onOpenPath).toHaveBeenCalledWith('/Users/me/GenOffice/ManualDoc.docx')
      } finally {
        await act(async () => {
          root.unmount()
        })
        host.remove()
      }
    })

    it('OPEN-06: Two concurrent automatic opens for the same path deduplicate to one tab dispatch', async () => {
      let resolveOpen!: (v: boolean) => void
      const openBarrier = new Promise<boolean>((res) => {
        resolveOpen = res
      })
      const onOpenPath = vi.fn().mockImplementation(() => openBarrier)

      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      const api = mockApi()

      try {
        await act(async () => {
          root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath }))
        })

        await act(async () => {
          requestChatPrefill({ text: 'Run Concurrent', intent: 'new', send: true })
        })

        const session = captured.docDeps?.getSessionId?.()
        const turnId = captured.docDeps?.getUserTurnId?.()
        const path = '/Users/me/GenOffice/ConcurrentReport.docx'

        const p1 = captured.docDeps!.open!(path, { sessionId: session, userTurnId: turnId })
        const p2 = captured.docDeps!.open!(path, { sessionId: session, userTurnId: turnId })

        expect(onOpenPath).toHaveBeenCalledTimes(1)

        resolveOpen(true)
        const [r1, r2] = await Promise.all([p1, p2])
        expect(r1).toBe(true)
        expect(r2).toBe(true)
        expect(onOpenPath).toHaveBeenCalledTimes(1)
      } finally {
        await act(async () => {
          root.unmount()
        })
        host.remove()
      }
    })

    it('OPEN-07: Legitimate retry after open failure succeeds on second attempt', async () => {
      const onOpenPath = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)

      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      const api = mockApi()

      try {
        await act(async () => {
          root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath }))
        })

        await act(async () => {
          requestChatPrefill({ text: 'Run Retry', intent: 'new', send: true })
        })

        const session = captured.docDeps?.getSessionId?.()
        const turnId = captured.docDeps?.getUserTurnId?.()
        const path = '/Users/me/GenOffice/RetryOpenDoc.docx'

        const r1 = await captured.docDeps!.open!(path, { sessionId: session, userTurnId: turnId })
        expect(r1).toBe(false)
        expect(onOpenPath).toHaveBeenCalledTimes(1)

        const r2 = await captured.docDeps!.open!(path, { sessionId: session, userTurnId: turnId })
        expect(r2).toBe(true)
        expect(onOpenPath).toHaveBeenCalledTimes(2)
      } finally {
        await act(async () => {
          root.unmount()
        })
        host.remove()
      }
    })

    it('OPEN-08: Closed tab allows subsequent intentional reopen', async () => {
      let tabOpen = false
      const onOpenPath = vi.fn().mockImplementation(async () => {
        tabOpen = true
        return true
      })
      const isOpenPath = vi.fn().mockImplementation(async () => tabOpen)

      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      const api = mockApi()

      try {
        await act(async () => {
          root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath, isOpenPath }))
        })

        await act(async () => {
          requestChatPrefill({ text: 'Run Tab Close', intent: 'new', send: true })
        })

        const session = captured.docDeps?.getSessionId?.()
        const turnId = captured.docDeps?.getUserTurnId?.()
        const docPath = '/Users/me/GenOffice/Reopenable.docx'

        // First open
        const r1 = await captured.docDeps!.open!(docPath, {
          sessionId: session,
          userTurnId: turnId,
        })
        expect(r1).toBe(true)
        expect(onOpenPath).toHaveBeenCalledTimes(1)
        expect(tabOpen).toBe(true)

        // Tab closes in editor
        tabOpen = false

        // Second intentional open
        const r2 = await captured.docDeps!.open!(docPath, {
          sessionId: session,
          userTurnId: turnId,
        })
        expect(r2).toBe(true)
        expect(onOpenPath).toHaveBeenCalledTimes(2)
      } finally {
        await act(async () => {
          root.unmount()
        })
        host.remove()
      }
    })

    it('OPEN-09: Old open resolving during new active turn does not corrupt new turn state', async () => {
      let resolveOpenA!: (v: boolean) => void
      const pendingOpenA = new Promise<boolean>((res) => {
        resolveOpenA = res
      })
      const onOpenPath = vi.fn().mockImplementation(() => pendingOpenA)

      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      const api = mockApi()

      try {
        await act(async () => {
          root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath }))
        })

        // Turn A starts
        await act(async () => {
          requestChatPrefill({ text: 'Turn A', intent: 'new', send: true })
        })

        const session = captured.docDeps?.getSessionId?.()
        const turnA = captured.docDeps?.getUserTurnId?.()
        const pathA = '/Users/me/GenOffice/DocA.docx'

        const openPromiseA = captured.docDeps!.open!(pathA, {
          sessionId: session,
          userTurnId: turnA,
        })

        // Stop Turn A so Turn B can start
        await act(async () => {
          const stopBtn = host.querySelector<HTMLButtonElement>('button.hc-send.stop')
          stopBtn?.click()
        })

        // Turn B starts in the same conversation
        await act(async () => {
          requestChatPrefill({ text: 'Turn B', intent: 'ask', send: true })
        })

        // Turn A resolves late
        await act(async () => {
          resolveOpenA(true)
          await openPromiseA
        })

        // Under turn B, pathA is not marked as active open state
        expect(onOpenPath).toHaveBeenCalledTimes(1)
      } finally {
        await act(async () => {
          root.unmount()
        })
        host.remove()
      }
    })

    it('OPEN-10: One valid run creating two distinct files allows both to open', async () => {
      const onOpenPath = vi.fn().mockResolvedValue(true)
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      const api = mockApi()

      try {
        await act(async () => {
          root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath }))
        })

        await act(async () => {
          requestChatPrefill({ text: 'Two files', intent: 'new', send: true })
        })

        const session = captured.docDeps?.getSessionId?.()
        const turnId = captured.docDeps?.getUserTurnId?.()

        const r1 = await captured.docDeps!.open!('/Users/me/GenOffice/File1.docx', {
          sessionId: session,
          userTurnId: turnId,
        })
        const r2 = await captured.docDeps!.open!('/Users/me/GenOffice/File2.docx', {
          sessionId: session,
          userTurnId: turnId,
        })

        expect(r1).toBe(true)
        expect(r2).toBe(true)
        expect(onOpenPath).toHaveBeenCalledTimes(2)
        expect(onOpenPath).toHaveBeenCalledWith('/Users/me/GenOffice/File1.docx')
        expect(onOpenPath).toHaveBeenCalledWith('/Users/me/GenOffice/File2.docx')
      } finally {
        await act(async () => {
          root.unmount()
        })
        host.remove()
      }
    })

    it('OPEN-11: Old and new runs referring to same path do not cross-suppress new operation', async () => {
      const onOpenPath = vi.fn().mockResolvedValue(true)
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      const api = mockApi()

      try {
        await act(async () => {
          root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath }))
        })

        // Turn 1
        await act(async () => {
          requestChatPrefill({ text: 'Run 1', intent: 'new', send: true })
        })

        const session = captured.docDeps?.getSessionId?.()
        const turn1 = captured.docDeps?.getUserTurnId?.()
        const sharedPath = '/Users/me/GenOffice/SharedDoc.docx'

        const r1 = await captured.docDeps!.open!(sharedPath, {
          sessionId: session,
          userTurnId: turn1,
        })
        expect(r1).toBe(true)

        // Stop run 1
        await act(async () => {
          const stopBtn = host.querySelector<HTMLButtonElement>('button.hc-send.stop')
          stopBtn?.click()
        })

        // Turn 2 in same conversation requesting same file path
        await act(async () => {
          requestChatPrefill({ text: 'Run 2', intent: 'ask', send: true })
        })

        const turn2 = captured.docDeps?.getUserTurnId?.()
        const r2 = await captured.docDeps!.open!(sharedPath, {
          sessionId: session,
          userTurnId: turn2,
        })
        expect(r2).toBe(true)
        expect(onOpenPath).toHaveBeenCalledTimes(2)
      } finally {
        await act(async () => {
          root.unmount()
        })
        host.remove()
      }
    })

    it('OPEN-12: Unmounting HomeChat while async open is in flight suppresses side effects', async () => {
      let resolveOpen!: (v: boolean) => void
      const openBarrier = new Promise<boolean>((res) => {
        resolveOpen = res
      })
      const onOpenPath = vi.fn().mockImplementation(() => openBarrier)

      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      const api = mockApi()

      await act(async () => {
        root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath }))
      })

      await act(async () => {
        requestChatPrefill({ text: 'Run Unmount', intent: 'new', send: true })
      })

      const session = captured.docDeps?.getSessionId?.()
      const turnId = captured.docDeps?.getUserTurnId?.()

      const openPromise = captured.docDeps!.open!('/Users/me/GenOffice/UnmountDoc.docx', {
        sessionId: session,
        userTurnId: turnId,
      })

      // Unmount before open resolves
      await act(async () => {
        root.unmount()
      })
      host.remove()

      // Now resolve the open
      resolveOpen(true)
      const result = await openPromise
      expect(result).toBe(false)
    })

    describe('Super Prompt V8: Auto-open authorization & lifecycle (OPEN-V8-01 through OPEN-V8-16)', () => {
      it('OPEN-V8-01: Stop before automatic open dispatch; zero tab-opening calls', async () => {
        const onOpenPath = vi.fn().mockResolvedValue(true)
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        const api = mockApi()
        try {
          await act(async () => {
            root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath }))
          })
          await act(async () => {
            requestChatPrefill({ text: 'Run Stop', intent: 'new', send: true })
          })
          const session = captured.docDeps?.getSessionId?.()
          const turnId = captured.docDeps?.getUserTurnId?.()
          await act(async () => {
            host.querySelector<HTMLButtonElement>('button.hc-send.stop')?.click()
          })
          const opened = await captured.docDeps!.open!('/Users/me/GenOffice/Doc1.docx', {
            sessionId: session,
            userTurnId: turnId,
          })
          expect(opened).toBe(false)
          expect(onOpenPath).not.toHaveBeenCalled()
        } finally {
          await act(async () => {
            root.unmount()
          })
          host.remove()
        }
      })

      it('OPEN-V8-02: Automatic open invoked after Stop with missing userTurnId; rejected', async () => {
        const onOpenPath = vi.fn().mockResolvedValue(true)
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        const api = mockApi()
        try {
          await act(async () => {
            root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath }))
          })
          await act(async () => {
            requestChatPrefill({ text: 'Run Stop', intent: 'new', send: true })
          })
          const session = captured.docDeps?.getSessionId?.()
          await act(async () => {
            host.querySelector<HTMLButtonElement>('button.hc-send.stop')?.click()
          })
          const opened = await captured.docDeps!.open!('/Users/me/GenOffice/Doc2.docx', {
            sessionId: session,
          })
          expect(opened).toBe(false)
          expect(onOpenPath).not.toHaveBeenCalled()
        } finally {
          await act(async () => {
            root.unmount()
          })
          host.remove()
        }
      })

      it('OPEN-V8-03: Automatic open invoked after Stop with missing entire execution context; rejected', async () => {
        const onOpenPath = vi.fn().mockResolvedValue(true)
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        const api = mockApi()
        try {
          await act(async () => {
            root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath }))
          })
          await act(async () => {
            requestChatPrefill({ text: 'Run Stop', intent: 'new', send: true })
          })
          await act(async () => {
            host.querySelector<HTMLButtonElement>('button.hc-send.stop')?.click()
          })
          const opened = await captured.docDeps!.open!('/Users/me/GenOffice/Doc3.docx')
          expect(opened).toBe(false)
          expect(onOpenPath).not.toHaveBeenCalled()
        } finally {
          await act(async () => {
            root.unmount()
          })
          host.remove()
        }
      })

      it('OPEN-V8-04: isOpenPath is pending when Stop occurs; resolving false afterward must not dispatch open', async () => {
        let resolveIsOpen!: (v: boolean) => void
        const isOpenBarrier = new Promise<boolean>((res) => {
          resolveIsOpen = res
        })
        const isOpenPath = vi.fn().mockImplementation(() => isOpenBarrier)
        const onOpenPath = vi.fn().mockResolvedValue(true)
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        const api = mockApi()
        try {
          await act(async () => {
            root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath, isOpenPath }))
          })
          await act(async () => {
            requestChatPrefill({ text: 'Run Probe', intent: 'new', send: true })
          })
          const session = captured.docDeps?.getSessionId?.()
          const turnId = captured.docDeps?.getUserTurnId?.()
          const openPromise = captured.docDeps!.open!('/Users/me/GenOffice/Doc4.docx', {
            sessionId: session,
            userTurnId: turnId,
          })
          expect(isOpenPath).toHaveBeenCalled()
          await act(async () => {
            host.querySelector<HTMLButtonElement>('button.hc-send.stop')?.click()
          })
          await act(async () => {
            resolveIsOpen(false)
          })
          const opened = await openPromise
          expect(opened).toBe(false)
          expect(onOpenPath).not.toHaveBeenCalled()
        } finally {
          await act(async () => {
            root.unmount()
          })
          host.remove()
        }
      })

      it('OPEN-V8-05: isOpenPath is pending when user switches conversation; no stale open', async () => {
        let resolveIsOpen!: (v: boolean) => void
        const isOpenBarrier = new Promise<boolean>((res) => {
          resolveIsOpen = res
        })
        const isOpenPath = vi.fn().mockImplementation(() => isOpenBarrier)
        const onOpenPath = vi.fn().mockResolvedValue(true)
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        const api = mockApi()
        try {
          await act(async () => {
            root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath, isOpenPath }))
          })
          await act(async () => {
            requestChatPrefill({ text: 'Draft A', intent: 'new', send: true })
          })
          const sessionA = captured.docDeps?.getSessionId?.()
          const turnA = captured.docDeps?.getUserTurnId?.()
          const openPromise = captured.docDeps!.open!('/Users/me/GenOffice/Doc5.docx', {
            sessionId: sessionA,
            userTurnId: turnA,
          })
          expect(isOpenPath).toHaveBeenCalled()
          await act(async () => {
            requestChatPrefill({ text: 'Draft B', intent: 'new', send: true })
          })
          await act(async () => {
            resolveIsOpen(false)
          })
          const opened = await openPromise
          expect(opened).toBe(false)
          expect(onOpenPath).not.toHaveBeenCalled()
        } finally {
          await act(async () => {
            root.unmount()
          })
          host.remove()
        }
      })

      it('OPEN-V8-06: Same-conversation new turn invalidates old-turn automatic opening', async () => {
        const onOpenPath = vi.fn().mockResolvedValue(true)
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        const api = mockApi()
        try {
          await act(async () => {
            root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath }))
          })
          await act(async () => {
            requestChatPrefill({ text: 'Turn A', intent: 'new', send: true })
          })
          const session = captured.docDeps?.getSessionId?.()
          const turnA = captured.docDeps?.getUserTurnId?.()
          await act(async () => {
            host.querySelector<HTMLButtonElement>('button.hc-send.stop')?.click()
          })
          await act(async () => {
            requestChatPrefill({ text: 'Turn B', intent: 'ask', send: true })
          })
          const opened = await captured.docDeps!.open!('/Users/me/GenOffice/Doc6.docx', {
            sessionId: session,
            userTurnId: turnA,
          })
          expect(opened).toBe(false)
          expect(onOpenPath).not.toHaveBeenCalled()
        } finally {
          await act(async () => {
            root.unmount()
          })
          host.remove()
        }
      })

      it('OPEN-V8-07: Unmount invalidates pending operations', async () => {
        let resolveOpen!: (v: boolean) => void
        const barrier = new Promise<boolean>((res) => {
          resolveOpen = res
        })
        const onOpenPath = vi.fn().mockImplementation(() => barrier)
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        const api = mockApi()
        await act(async () => {
          root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath }))
        })
        await act(async () => {
          requestChatPrefill({ text: 'Unmount Run', intent: 'new', send: true })
        })
        const session = captured.docDeps?.getSessionId?.()
        const turnId = captured.docDeps?.getUserTurnId?.()
        const openPromise = captured.docDeps!.open!('/Users/me/GenOffice/Doc7.docx', {
          sessionId: session,
          userTurnId: turnId,
        })
        await act(async () => {
          root.unmount()
        })
        host.remove()
        resolveOpen(true)
        const res = await openPromise
        expect(res).toBe(false)
      })

      it('OPEN-V8-08: Manual click while stopped opens the correct document', async () => {
        localStorage.setItem('home-chat-last-session', 's8')
        const onOpenPath = vi.fn().mockResolvedValue(true)
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        const api = mockApi({
          openPath: onOpenPath,
          homeChatList: async () => [{ id: 's8', title: 'S8', updatedAt: 100, messageCount: 2 }],
          homeChatGet: async (id: string) => ({
            id,
            title: id,
            messages: [
              {
                id: 1,
                role: 'user',
                text: 'Create',
              },
              {
                id: 2,
                role: 'assistant',
                text: 'File ready',
              },
            ],
            createdAt: 100,
            updatedAt: 100,
          }),
          kbCreateDocument: vi.fn().mockResolvedValue({
            path: '/Users/me/GenOffice/Doc8.docx',
          }),
        })
        try {
          await act(async () => {
            root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath }))
          })
          await act(async () => {
            requestChatPrefill({ text: 'open', intent: 'open-existing', sessionId: 's8' })
          })
          await act(async () => {
            requestChatPrefill({ text: 'Start and stop', intent: 'ask', send: true })
          })
          await act(async () => {
            host.querySelector<HTMLButtonElement>('button.hc-send.stop')?.click()
          })
          const saveWordBtn = host.querySelector<HTMLButtonElement>(
            'button[title="Save as Word (.docx)"]',
          )
          expect(saveWordBtn).not.toBeNull()
          await act(async () => {
            saveWordBtn?.click()
          })
          const saveBtn = host.querySelector<HTMLButtonElement>('button.hc-save-btn-saved')
          expect(saveBtn).not.toBeNull()
          await act(async () => {
            saveBtn?.click()
          })
          expect(onOpenPath).toHaveBeenCalledWith('/Users/me/GenOffice/Doc8.docx')
        } finally {
          await act(async () => {
            root.unmount()
          })
          host.remove()
        }
      })

      it('OPEN-V8-09: Manual click while idle opens the correct document', async () => {
        localStorage.setItem('home-chat-last-session', 's9')
        const onOpenPath = vi.fn().mockResolvedValue(true)
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        const api = mockApi({
          openPath: onOpenPath,
          homeChatList: async () => [{ id: 's9', title: 'S9', updatedAt: 100, messageCount: 2 }],
          homeChatGet: async (id: string) => ({
            id,
            title: id,
            messages: [
              {
                id: 1,
                role: 'user',
                text: 'Create',
              },
              {
                id: 2,
                role: 'assistant',
                text: 'Idle test file',
              },
            ],
            createdAt: 100,
            updatedAt: 100,
          }),
          kbCreateDocument: vi.fn().mockResolvedValue({
            path: '/Users/me/GenOffice/Doc9.docx',
          }),
        })
        try {
          await act(async () => {
            root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath }))
          })
          await act(async () => {
            requestChatPrefill({ text: 'open', intent: 'open-existing', sessionId: 's9' })
          })
          const saveWordBtn = host.querySelector<HTMLButtonElement>(
            'button[title="Save as Word (.docx)"]',
          )
          expect(saveWordBtn).not.toBeNull()
          await act(async () => {
            saveWordBtn?.click()
          })
          const saveBtn = host.querySelector<HTMLButtonElement>('button.hc-save-btn-saved')
          expect(saveBtn).not.toBeNull()
          await act(async () => {
            saveBtn?.click()
          })
          expect(onOpenPath).toHaveBeenCalledWith('/Users/me/GenOffice/Doc9.docx')
        } finally {
          await act(async () => {
            root.unmount()
          })
          host.remove()
        }
      })

      it('OPEN-V8-10: Auto-open failure does not permanently block a later manual open', async () => {
        localStorage.setItem('home-chat-last-session', 's10')
        const onOpenPath = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        const api = mockApi({
          openPath: onOpenPath,
          homeChatList: async () => [{ id: 's10', title: 'S10', updatedAt: 100, messageCount: 2 }],
          homeChatGet: async (id: string) => ({
            id,
            title: id,
            messages: [
              {
                id: 1,
                role: 'user',
                text: 'Create',
              },
              {
                id: 2,
                role: 'assistant',
                text: 'Doc',
              },
            ],
            createdAt: 100,
            updatedAt: 100,
          }),
          kbCreateDocument: vi.fn().mockResolvedValue({
            path: '/Users/me/GenOffice/Doc10.docx',
          }),
        })
        try {
          await act(async () => {
            root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath }))
          })
          await act(async () => {
            requestChatPrefill({ text: 'open', intent: 'open-existing', sessionId: 's10' })
          })
          await act(async () => {
            requestChatPrefill({ text: 'Run 10', intent: 'ask', send: true })
          })
          const session = captured.docDeps?.getSessionId?.()
          const turnId = captured.docDeps?.getUserTurnId?.()
          const autoRes = await captured.docDeps!.open!('/Users/me/GenOffice/Doc10.docx', {
            sessionId: session,
            userTurnId: turnId,
          })
          expect(autoRes).toBe(false)

          const saveWordBtn = host.querySelector<HTMLButtonElement>(
            'button[title="Save as Word (.docx)"]',
          )
          expect(saveWordBtn).not.toBeNull()
          await act(async () => {
            saveWordBtn?.click()
          })
          const saveBtn = host.querySelector<HTMLButtonElement>('button.hc-save-btn-saved')
          expect(saveBtn).not.toBeNull()
          await act(async () => {
            saveBtn?.click()
          })
          expect(onOpenPath).toHaveBeenCalledTimes(2)
          expect(onOpenPath).toHaveBeenLastCalledWith('/Users/me/GenOffice/Doc10.docx')
        } finally {
          await act(async () => {
            root.unmount()
          })
          host.remove()
        }
      })

      it('OPEN-V8-11: Two concurrent automatic open requests for the same file produce one tab dispatch', async () => {
        let resolveOpen!: (v: boolean) => void
        const barrier = new Promise<boolean>((res) => {
          resolveOpen = res
        })
        const onOpenPath = vi.fn().mockImplementation(() => barrier)
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        const api = mockApi()
        try {
          await act(async () => {
            root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath }))
          })
          await act(async () => {
            requestChatPrefill({ text: 'Run 11', intent: 'new', send: true })
          })
          const session = captured.docDeps?.getSessionId?.()
          const turnId = captured.docDeps?.getUserTurnId?.()
          const ctx = { sessionId: session, userTurnId: turnId }
          const p1 = captured.docDeps!.open!('/Users/me/GenOffice/Doc11.docx', ctx)
          const p2 = captured.docDeps!.open!('/Users/me/GenOffice/Doc11.docx', ctx)
          expect(onOpenPath).toHaveBeenCalledTimes(1)
          resolveOpen(true)
          const [r1, r2] = await Promise.all([p1, p2])
          expect(r1).toBe(true)
          expect(r2).toBe(true)
          expect(onOpenPath).toHaveBeenCalledTimes(1)
        } finally {
          await act(async () => {
            root.unmount()
          })
          host.remove()
        }
      })

      it('OPEN-V8-12: Two distinct documents explicitly requested in one turn can both open successfully', async () => {
        const onOpenPath = vi.fn().mockResolvedValue(true)
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        const api = mockApi()
        try {
          await act(async () => {
            root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath }))
          })
          await act(async () => {
            requestChatPrefill({ text: 'Run 12', intent: 'new', send: true })
          })
          const session = captured.docDeps?.getSessionId?.()
          const turnId = captured.docDeps?.getUserTurnId?.()
          const ctx = { sessionId: session, userTurnId: turnId }
          const r1 = await captured.docDeps!.open!('/Users/me/GenOffice/Doc12A.docx', ctx)
          const r2 = await captured.docDeps!.open!('/Users/me/GenOffice/Doc12B.docx', ctx)
          expect(r1).toBe(true)
          expect(r2).toBe(true)
          expect(onOpenPath).toHaveBeenCalledTimes(2)
          expect(onOpenPath).toHaveBeenCalledWith('/Users/me/GenOffice/Doc12A.docx')
          expect(onOpenPath).toHaveBeenCalledWith('/Users/me/GenOffice/Doc12B.docx')
        } finally {
          await act(async () => {
            root.unmount()
          })
          host.remove()
        }
      })

      it('OPEN-V8-13: Old and new runs requesting the same path do not share incorrectly authorized in-flight result', async () => {
        let resolveOpen1!: (v: boolean) => void
        const barrier1 = new Promise<boolean>((res) => {
          resolveOpen1 = res
        })
        const onOpenPath = vi
          .fn()
          .mockImplementationOnce(() => barrier1)
          .mockResolvedValue(true)
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        const api = mockApi()
        try {
          await act(async () => {
            root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath }))
          })
          await act(async () => {
            requestChatPrefill({ text: 'Run 13-A', intent: 'new', send: true })
          })
          const sessionA = captured.docDeps?.getSessionId?.()
          const turnA = captured.docDeps?.getUserTurnId?.()
          const p1 = captured.docDeps!.open!('/Users/me/GenOffice/Doc13.docx', {
            sessionId: sessionA,
            userTurnId: turnA,
          })
          await act(async () => {
            host.querySelector<HTMLButtonElement>('button.hc-send.stop')?.click()
          })
          await act(async () => {
            requestChatPrefill({ text: 'Run 13-B', intent: 'ask', send: true })
          })
          const turnB = captured.docDeps?.getUserTurnId?.()
          const p2 = captured.docDeps!.open!('/Users/me/GenOffice/Doc13.docx', {
            sessionId: sessionA,
            userTurnId: turnB,
          })
          resolveOpen1(true)
          const [r1, r2] = await Promise.all([p1, p2])
          expect(r1).toBe(false)
          expect(r2).toBe(true)
        } finally {
          await act(async () => {
            root.unmount()
          })
          host.remove()
        }
      })

      it('OPEN-V8-14: Delayed successful completion after Stop cannot mark cancelled run as successful', async () => {
        let resolveOpen!: (v: boolean) => void
        const barrier = new Promise<boolean>((res) => {
          resolveOpen = res
        })
        const onOpenPath = vi.fn().mockImplementation(() => barrier)
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        const api = mockApi()
        try {
          await act(async () => {
            root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath }))
          })
          await act(async () => {
            requestChatPrefill({ text: 'Run 14', intent: 'new', send: true })
          })
          const session = captured.docDeps?.getSessionId?.()
          const turnId = captured.docDeps?.getUserTurnId?.()
          const p = captured.docDeps!.open!('/Users/me/GenOffice/Doc14.docx', {
            sessionId: session,
            userTurnId: turnId,
          })
          await act(async () => {
            host.querySelector<HTMLButtonElement>('button.hc-send.stop')?.click()
          })
          resolveOpen(true)
          const r = await p
          expect(r).toBe(false)
        } finally {
          await act(async () => {
            root.unmount()
          })
          host.remove()
        }
      })

      it('OPEN-V8-15: Retry after a genuine open failure works', async () => {
        const onOpenPath = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        const api = mockApi()
        try {
          await act(async () => {
            root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath }))
          })
          await act(async () => {
            requestChatPrefill({ text: 'Run 15', intent: 'new', send: true })
          })
          const session = captured.docDeps?.getSessionId?.()
          const turnId = captured.docDeps?.getUserTurnId?.()
          const ctx = { sessionId: session, userTurnId: turnId }
          const r1 = await captured.docDeps!.open!('/Users/me/GenOffice/Doc15.docx', ctx)
          expect(r1).toBe(false)
          const r2 = await captured.docDeps!.open!('/Users/me/GenOffice/Doc15.docx', ctx)
          expect(r2).toBe(true)
          expect(onOpenPath).toHaveBeenCalledTimes(2)
        } finally {
          await act(async () => {
            root.unmount()
          })
          host.remove()
        }
      })

      it('OPEN-V8-16: Closing a tab allows legitimate reopening', async () => {
        let isTabOpen = true
        const onOpenPath = vi.fn().mockResolvedValue(true)
        const isOpenPath = vi.fn().mockImplementation(async () => isTabOpen)
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        const api = mockApi()
        try {
          await act(async () => {
            root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath, isOpenPath }))
          })
          await act(async () => {
            requestChatPrefill({ text: 'Run 16', intent: 'new', send: true })
          })
          const session = captured.docDeps?.getSessionId?.()
          const turnId = captured.docDeps?.getUserTurnId?.()
          const ctx = { sessionId: session, userTurnId: turnId }
          const r1 = await captured.docDeps!.open!('/Users/me/GenOffice/Doc16.docx', ctx)
          expect(r1).toBe(true)
          expect(onOpenPath).toHaveBeenCalledTimes(1)
          isTabOpen = false
          const r2 = await captured.docDeps!.open!('/Users/me/GenOffice/Doc16.docx', ctx)
          expect(r2).toBe(true)
          expect(onOpenPath).toHaveBeenCalledTimes(2)
        } finally {
          await act(async () => {
            root.unmount()
          })
          host.remove()
        }
      })
    })

    describe('Super Prompt V8: Editor tab focus restoration (FOCUS-V8-01 through FOCUS-V8-06)', () => {
      it('FOCUS-V8-01: Existing Word tab is in background; opening it invokes onOpenPath to activate that tab', async () => {
        const onOpenPath = vi.fn().mockResolvedValue(true)
        const isOpenPath = vi.fn().mockResolvedValue(true)
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        const api = mockApi()
        try {
          await act(async () => {
            root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath, isOpenPath }))
          })
          await act(async () => {
            requestChatPrefill({ text: 'Focus Run', intent: 'new', send: true })
          })
          const session = captured.docDeps?.getSessionId?.()
          const turnId = captured.docDeps?.getUserTurnId?.()
          const r = await captured.docDeps!.open!('/Users/me/GenOffice/Background.docx', {
            sessionId: session,
            userTurnId: turnId,
          })
          expect(r).toBe(true)
          expect(onOpenPath).toHaveBeenCalledWith('/Users/me/GenOffice/Background.docx')
        } finally {
          await act(async () => {
            root.unmount()
          })
          host.remove()
        }
      })

      it('FOCUS-V8-02: Repeated open does not create duplicate tab dispatch', async () => {
        let resolveOpen!: (v: boolean) => void
        const barrier = new Promise<boolean>((res) => {
          resolveOpen = res
        })
        const onOpenPath = vi.fn().mockImplementation(() => barrier)
        let resolveIsOpen!: (v: boolean) => void
        const isOpenBarrier = new Promise<boolean>((res) => {
          resolveIsOpen = res
        })
        const isOpenPath = vi.fn().mockImplementation(() => isOpenBarrier)
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        const api = mockApi()
        try {
          await act(async () => {
            root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath, isOpenPath }))
          })
          await act(async () => {
            requestChatPrefill({ text: 'Dup Focus Run', intent: 'new', send: true })
          })
          const session = captured.docDeps?.getSessionId?.()
          const turnId = captured.docDeps?.getUserTurnId?.()
          const ctx = { sessionId: session, userTurnId: turnId }
          const p1 = captured.docDeps!.open!('/Users/me/GenOffice/Dup.docx', ctx)
          const p2 = captured.docDeps!.open!('/Users/me/GenOffice/Dup.docx', ctx)

          resolveIsOpen(true)
          await Promise.resolve()
          await Promise.resolve()

          expect(onOpenPath).toHaveBeenCalledTimes(1)
          resolveOpen(true)
          const [r1, r2] = await Promise.all([p1, p2])
          expect(r1).toBe(true)
          expect(r2).toBe(true)
          expect(onOpenPath).toHaveBeenCalledTimes(1)
        } finally {
          await act(async () => {
            root.unmount()
          })
          host.remove()
        }
      })

      it('FOCUS-V8-03: Closed tab can be reopened', async () => {
        let isTabOpen = false
        const onOpenPath = vi.fn().mockImplementation(async () => {
          isTabOpen = true
          return true
        })
        const isOpenPath = vi.fn().mockImplementation(async () => isTabOpen)
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        const api = mockApi()
        try {
          await act(async () => {
            root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath, isOpenPath }))
          })
          await act(async () => {
            requestChatPrefill({ text: 'Reopen Run', intent: 'new', send: true })
          })
          const session = captured.docDeps?.getSessionId?.()
          const turnId = captured.docDeps?.getUserTurnId?.()
          const ctx = { sessionId: session, userTurnId: turnId }
          const r1 = await captured.docDeps!.open!('/Users/me/GenOffice/Reopen.docx', ctx)
          expect(r1).toBe(true)
          expect(onOpenPath).toHaveBeenCalledTimes(1)
          isTabOpen = false
          const r2 = await captured.docDeps!.open!('/Users/me/GenOffice/Reopen.docx', ctx)
          expect(r2).toBe(true)
          expect(onOpenPath).toHaveBeenCalledTimes(2)
        } finally {
          await act(async () => {
            root.unmount()
          })
          host.remove()
        }
      })

      it('FOCUS-V8-04: Detached Word window is focused rather than duplicated', async () => {
        const onOpenPath = vi.fn().mockResolvedValue(true)
        const isOpenPath = vi.fn().mockResolvedValue(true)
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        const api = mockApi()
        try {
          await act(async () => {
            root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath, isOpenPath }))
          })
          await act(async () => {
            requestChatPrefill({ text: 'Detached Run', intent: 'new', send: true })
          })
          const session = captured.docDeps?.getSessionId?.()
          const turnId = captured.docDeps?.getUserTurnId?.()
          const r = await captured.docDeps!.open!('/Users/me/GenOffice/Detached.docx', {
            sessionId: session,
            userTurnId: turnId,
          })
          expect(r).toBe(true)
          expect(onOpenPath).toHaveBeenCalledWith('/Users/me/GenOffice/Detached.docx')
        } finally {
          await act(async () => {
            root.unmount()
          })
          host.remove()
        }
      })

      it('FOCUS-V8-05: A stale automatic request cannot use the focus path to bypass Stop', async () => {
        const onOpenPath = vi.fn().mockResolvedValue(true)
        const isOpenPath = vi.fn().mockResolvedValue(true)
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        const api = mockApi()
        try {
          await act(async () => {
            root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath, isOpenPath }))
          })
          await act(async () => {
            requestChatPrefill({ text: 'Stop Run', intent: 'new', send: true })
          })
          const session = captured.docDeps?.getSessionId?.()
          const turnId = captured.docDeps?.getUserTurnId?.()
          await act(async () => {
            host.querySelector<HTMLButtonElement>('button.hc-send.stop')?.click()
          })
          const r = await captured.docDeps!.open!('/Users/me/GenOffice/Background.docx', {
            sessionId: session,
            userTurnId: turnId,
          })
          expect(r).toBe(false)
          expect(onOpenPath).not.toHaveBeenCalled()
        } finally {
          await act(async () => {
            root.unmount()
          })
          host.remove()
        }
      })

      it('FOCUS-V8-06: A legitimate manual request can focus the existing tab after Stop', async () => {
        localStorage.setItem('home-chat-last-session', 's-focus')
        const onOpenPath = vi.fn().mockResolvedValue(true)
        const isOpenPath = vi.fn().mockResolvedValue(true)
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        const api = mockApi({
          openPath: onOpenPath,
          homeChatList: async () => [
            { id: 's-focus', title: 'Focus', updatedAt: 100, messageCount: 2 },
          ],
          homeChatGet: async (id: string) => ({
            id,
            title: id,
            messages: [
              {
                id: 1,
                role: 'user',
                text: 'Create',
              },
              {
                id: 2,
                role: 'assistant',
                text: 'Background file ready',
              },
            ],
            createdAt: 100,
            updatedAt: 100,
          }),
          kbCreateDocument: vi.fn().mockResolvedValue({
            path: '/Users/me/GenOffice/Background.docx',
          }),
        })
        try {
          await act(async () => {
            root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath, isOpenPath }))
          })
          await act(async () => {
            requestChatPrefill({ text: 'open', intent: 'open-existing', sessionId: 's-focus' })
          })
          await act(async () => {
            requestChatPrefill({ text: 'Start and stop', intent: 'ask', send: true })
          })
          await act(async () => {
            host.querySelector<HTMLButtonElement>('button.hc-send.stop')?.click()
          })
          const saveWordBtn = host.querySelector<HTMLButtonElement>(
            'button[title="Save as Word (.docx)"]',
          )
          expect(saveWordBtn).not.toBeNull()
          await act(async () => {
            saveWordBtn?.click()
          })
          const saveBtn = host.querySelector<HTMLButtonElement>('button.hc-save-btn-saved')
          expect(saveBtn).not.toBeNull()
          await act(async () => {
            saveBtn?.click()
          })
          expect(onOpenPath).toHaveBeenCalledWith('/Users/me/GenOffice/Background.docx')
        } finally {
          await act(async () => {
            root.unmount()
          })
          host.remove()
        }
      })
    })
  })
})
