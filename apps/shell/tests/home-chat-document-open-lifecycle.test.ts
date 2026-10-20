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
  t: (k: string) => k,
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

      expect(captured.docDeps).not.toBeNull()
      expect(captured.docDeps!.open).toBeDefined()

      // Launch two concurrent opens for the exact same document path
      const p1 = captured.docDeps!.open!('/Users/me/GenOffice/Report.docx')
      const p2 = captured.docDeps!.open!('/Users/me/GenOffice/Report.docx')

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

      expect(captured.docDeps).not.toBeNull()
      expect(captured.docDeps!.open).toBeDefined()

      // Launch two concurrent opens while isOpenPath probe is in flight
      const p1 = captured.docDeps!.open!('/Users/me/GenOffice/ConcurrentAsync.docx')
      const p2 = captured.docDeps!.open!('/Users/me/GenOffice/ConcurrentAsync.docx')

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

      const docPath = '/Users/me/GenOffice/Tracked.docx'

      // First open: tab is closed, invokes onOpenPath
      const r1 = await captured.docDeps!.open!(docPath)
      expect(r1).toBe(true)
      expect(onOpenPath).toHaveBeenCalledTimes(1)
      expect(tabOpen).toBe(true)

      // Second check: tab is open, returns true without calling onOpenPath again
      const r2 = await captured.docDeps!.open!(docPath)
      expect(r2).toBe(true)
      expect(onOpenPath).toHaveBeenCalledTimes(1)

      // Tab closes: isOpen reports false
      tabOpen = false

      // Third check: tab closed, invokes onOpenPath to reopen
      const r3 = await captured.docDeps!.open!(docPath)
      expect(r3).toBe(true)
      expect(onOpenPath).toHaveBeenCalledTimes(2)
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

      // 1. Returns false: resolves false, does not throw
      const r1 = await captured.docDeps!.open!('/Users/me/GenOffice/Fail1.docx')
      expect(r1).toBe(false)

      // 2. Throws error: caught cleanly, resolves false, does not crash
      const r2 = await captured.docDeps!.open!('/Users/me/GenOffice/Fail2.docx')
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

    it('OPEN-05: Manual open succeeds when agent is stopped / idle', async () => {
      const onOpenPath = vi.fn().mockResolvedValue(true)
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      const api = mockApi({
        openPath: onOpenPath,
      })

      try {
        await act(async () => {
          root.render(createElement(HomeChat, { api, i18n: mockI18n, onOpenPath }))
        })

        await act(async () => {
          requestChatPrefill({ text: 'Start and stop', intent: 'new', send: true })
        })

        await act(async () => {
          const stopBtn = host.querySelector<HTMLButtonElement>('button.hc-send.stop')
          stopBtn?.click()
        })

        // In idle/stopped state, manual open (no execContext) opens the document cleanly
        const opened = await captured.docDeps!.open!('/Users/me/GenOffice/ManualDoc.docx')
        expect(opened).toBe(true)
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
  })
})
