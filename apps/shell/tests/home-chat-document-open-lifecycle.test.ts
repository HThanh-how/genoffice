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
})
