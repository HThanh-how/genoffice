// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act, createElement } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
import { HomeChat } from '../src/renderer/src/HomeChat'
import type { HomeApi } from '../src/shared/home-api'
import type { I18n } from '../src/renderer/src/locale'
import type { HomeChatSession, HomeChatSessionSummary } from '../src/shared/fork/home-chat-types'
import {
  requestChatPrefill,
} from '../src/renderer/src/chat-events'

interface StreamSubscriber {
  handler: (chunk: unknown) => void
}

function createMockChatApi() {
  const streamSubscribers: StreamSubscriber[] = []
  const savedSessions = new Map<string, HomeChatSession>()
  const sessionList: HomeChatSessionSummary[] = []

  const api = {
    homeChatList: vi.fn().mockImplementation(async () => [...sessionList]),
    homeChatGet: vi.fn().mockImplementation(async (id: string) => savedSessions.get(id) || null),
    homeChatSave: vi.fn().mockImplementation(async (input: { id?: string; messages: unknown[]; title?: string }) => {
      const id = input.id || `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const summary: HomeChatSessionSummary = {
        id,
        title: input.title || (input.messages[0] as { text?: string })?.text?.slice(0, 30) || 'New Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: input.messages.length,
      }
      const full: HomeChatSession = {
        ...summary,
        messages: input.messages as any,
      }
      savedSessions.set(id, full)
      const existingIdx = sessionList.findIndex((s) => s.id === id)
      if (existingIdx >= 0) {
        sessionList[existingIdx] = summary
      } else {
        sessionList.unshift(summary)
      }
      return summary
    }),
    homeChatDelete: vi.fn().mockImplementation(async (id: string) => {
      savedSessions.delete(id)
      const idx = sessionList.findIndex((s) => s.id === id)
      if (idx >= 0) sessionList.splice(idx, 1)
      return true
    }),
    homeChatClear: vi.fn().mockImplementation(async () => {
      savedSessions.clear()
      sessionList.length = 0
      return 1
    }),
    homeChatRename: vi.fn().mockImplementation(async (id: string, title: string) => {
      const s = sessionList.find((entry) => entry.id === id)
      if (s) s.title = title
      return s || null
    }),
    getAiSettings: vi.fn().mockResolvedValue({
      provider: 'openai',
      providers: {
        openai: {
          apiKey: 'test-key',
          model: 'test-model',
          baseUrl: 'http://localhost/v1',
        },
      },
    }),
    onAiSettingsChanged: vi.fn().mockReturnValue(() => {}),
    setAiSettings: vi.fn().mockResolvedValue(true),
    aiStream: vi.fn().mockImplementation(async (_req) => {
      // streaming handled by test harness emitting on streamSubscribers
    }),
    aiStreamCancel: vi.fn().mockImplementation(async (_reqId) => {
      // cancellation recorded
    }),
    onAiStream: vi.fn().mockImplementation((handler) => {
      const sub = { handler }
      streamSubscribers.push(sub)
      return () => {
        const idx = streamSubscribers.indexOf(sub)
        if (idx >= 0) streamSubscribers.splice(idx, 1)
      }
    }),
    statPaths: vi.fn().mockResolvedValue([]),
    openPath: vi.fn().mockResolvedValue(true),
    testIgnorePath: vi.fn().mockResolvedValue({ ignored: false }),
    folderRoots: vi.fn().mockResolvedValue([]),
    documentMemorySearch: vi.fn().mockResolvedValue({ hits: [], total: 0 }),
    kbCreateDocument: vi.fn().mockImplementation(async (req: any) => ({ path: `/mock/${req.title}.${req.format}` })),
    kbSearch: vi.fn().mockResolvedValue([]),
    kbRead: vi.fn().mockResolvedValue(''),
    kbList: vi.fn().mockResolvedValue([]),
  } as unknown as HomeApi

  return {
    api,
    streamSubscribers,
    savedSessions,
    sessionList,
    emitChunk(chunk: any) {
      for (const sub of [...streamSubscribers]) {
        sub.handler(chunk)
      }
    },
  }
}

const mockI18n: I18n = {
  lang: 'en',
  setLang: () => {},
  t: (k: string) => k,
  locale: 'en',
}

describe('Home Chat Multi-Execution Regression Suite (C01 - C25)', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 1024,
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    if (originalClientWidth) {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
    } else {
      delete (HTMLElement.prototype as any).clientWidth
    }
  })

  it('C01: New Chat during streaming must NOT cancel Chat A; Chat A must complete and save', async () => {
    const harness = createMockChatApi()
    let lastRequestId = ''
    vi.mocked(harness.api.aiStream).mockImplementation(async (req: any) => {
      lastRequestId = req.requestId
    })

    await act(async () => {
      root.render(createElement(HomeChat, { api: harness.api, i18n: mockI18n, workspaceActive: true }))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })

    // Start Chat A
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      textarea.value = 'Prepare annual report'
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const form = host.querySelector<HTMLFormElement>('form.hc-composer')!
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(harness.api.aiStream).toHaveBeenCalled()
    const chatARequestId = lastRequestId

    // Emit delta chunk for Chat A
    await act(async () => {
      harness.emitChunk({ requestId: chatARequestId, type: 'delta', text: 'Section 1: Executive Summary' })
    })

    // User clicks "New Chat" while Chat A is streaming
    const newChatBtn = host.querySelector<HTMLButtonElement>('.hc-new')!
    await act(async () => {
      newChatBtn.click()
    })

    // Chat B composer should be blank
    expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('')

    // Emit more chunks and completion for Chat A while Chat B is selected
    await act(async () => {
      harness.emitChunk({ requestId: chatARequestId, type: 'delta', text: '\nSection 2: Financial Results' })
      harness.emitChunk({ requestId: chatARequestId, type: 'done', text: '' })
    })

    // Chat A must have completed and been saved to the store
    const chatASaved = Array.from(harness.savedSessions.values()).find((s) =>
      s.messages.some((m) => m.text.includes('Prepare annual report')),
    )
    expect(chatASaved).toBeDefined()
    const assistantMsg = chatASaved?.messages.find((m) => m.role === 'assistant')
    expect(assistantMsg?.text).toContain('Section 1: Executive Summary')
    expect(assistantMsg?.text).toContain('Section 2: Financial Results')
    expect(assistantMsg?.error).toBeUndefined()
  })

  it('C02: Running spinner follows Chat A in HistoryRail while Chat B is active', async () => {
    const harness = createMockChatApi()
    let lastRequestId = ''
    vi.mocked(harness.api.aiStream).mockImplementation(async (req: any) => {
      lastRequestId = req.requestId
    })

    await act(async () => {
      root.render(createElement(HomeChat, { api: harness.api, i18n: mockI18n, workspaceActive: true }))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })

    // Submit Chat A
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      textarea.value = 'Generate slides'
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const form = host.querySelector<HTMLFormElement>('form.hc-composer')!
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    // Switch to New Chat (Chat B)
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.hc-new')!.click()
    })

    // In the left rail, Chat A must display a running spinner
    const railItems = host.querySelectorAll('.hc-group li')
    expect(railItems.length).toBeGreaterThan(0)
    const chatARow = Array.from(railItems).find((el) => el.textContent?.includes('Generate slides'))
    expect(chatARow).toBeDefined()
    const spinner = chatARow?.querySelector('.hc-row-spinner, [aria-label*="running" i], [aria-label*="Running" i], .is-running')
    expect(spinner).not.toBeNull()

    // When Chat A completes, its spinner should disappear
    await act(async () => {
      harness.emitChunk({ requestId: lastRequestId, type: 'delta', text: 'Done slides' })
      harness.emitChunk({ requestId: lastRequestId, type: 'done', text: '' })
    })
    const spinnerAfter = chatARow?.querySelector('.hc-row-spinner, .is-running')
    expect(spinnerAfter).toBeNull()
  })

  it('C03, C04, C05: Two active chats execute concurrently; Stop A does not stop Chat B', async () => {
    const harness = createMockChatApi()
    const requestIds: string[] = []
    vi.mocked(harness.api.aiStream).mockImplementation(async (req: any) => {
      requestIds.push(req.requestId)
    })

    await act(async () => {
      root.render(createElement(HomeChat, { api: harness.api, i18n: mockI18n, workspaceActive: true }))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })

    // Start Chat A
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      textarea.value = 'Task A'
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      host.querySelector<HTMLFormElement>('form.hc-composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    const idA = requestIds[0]

    // Create and start Chat B
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.hc-new')!.click()
    })
    await act(async () => {
      textarea.value = 'Task B'
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      host.querySelector<HTMLFormElement>('form.hc-composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    const idB = requestIds[1]

    expect(idA).toBeDefined()
    expect(idB).toBeDefined()
    expect(idA).not.toBe(idB)

    // Stop Chat A via its rail action (or per-session stop)
    const chatARow = Array.from(host.querySelectorAll('.hc-group li')).find((el) => el.textContent?.includes('Task A'))
    expect(chatARow).toBeDefined()
    const stopABtn = chatARow?.querySelector<HTMLButtonElement>('.hc-row-stop, [aria-label*="Stop" i]')
    expect(stopABtn).toBeDefined()
    expect(stopABtn).not.toBeNull()
    await act(async () => {
      stopABtn!.click()
    })

    // Chat B must still be running
    expect(harness.api.aiStreamCancel).toHaveBeenCalledWith(idA)
    expect(harness.api.aiStreamCancel).not.toHaveBeenCalledWith(idB)

    // Chunks for B still process
    await act(async () => {
      harness.emitChunk({ requestId: idB, type: 'delta', text: 'Result B' })
      harness.emitChunk({ requestId: idB, type: 'done', text: '' })
    })

    const chatBSaved = Array.from(harness.savedSessions.values()).find((s) =>
      s.messages.some((m) => m.text.includes('Task B')),
    )
    expect(chatBSaved?.messages.find((m) => m.role === 'assistant')?.text).toContain('Result B')
  })

  it('C06 & C07: Switching between running chats reconnects live state without restarting model', async () => {
    const harness = createMockChatApi()
    const requestIds: string[] = []
    vi.mocked(harness.api.aiStream).mockImplementation(async (req: any) => {
      requestIds.push(req.requestId)
    })

    await act(async () => {
      root.render(createElement(HomeChat, { api: harness.api, i18n: mockI18n, workspaceActive: true }))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })

    // Start Chat A
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      textarea.value = 'Topic A'
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      host.querySelector<HTMLFormElement>('form.hc-composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    const idA = requestIds[0]

    // New Chat B
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.hc-new')!.click()
    })
    await act(async () => {
      textarea.value = 'Topic B'
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      host.querySelector<HTMLFormElement>('form.hc-composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    // Stream text to A in background
    await act(async () => {
      harness.emitChunk({ requestId: idA, type: 'delta', text: 'Content for A' })
    })

    // Re-select Chat A from rail
    const chatARow = Array.from(host.querySelectorAll('.hc-group li')).find((el) => el.textContent?.includes('Topic A'))
    const openABtn = chatARow?.querySelector<HTMLButtonElement>('.hc-row-main')!
    await act(async () => {
      openABtn.click()
    })

    // Chat A live content must be displayed and no new provider call sent
    expect(host.querySelector('.hc-thread')?.textContent).toContain('Content for A')
    expect(requestIds.length).toBe(2) // No 3rd call
  })

  it('C10: Background text accumulates and commits even when requestAnimationFrame is suspended', async () => {
    const harness = createMockChatApi()
    let lastRequestId = ''
    vi.mocked(harness.api.aiStream).mockImplementation(async (req: any) => {
      lastRequestId = req.requestId
    })

    // Spy on rAF and cancel frame scheduling to simulate suspended background tab
    const originalRaf = window.requestAnimationFrame
    window.requestAnimationFrame = vi.fn().mockReturnValue(12345)

    try {
      await act(async () => {
        root.render(createElement(HomeChat, { api: harness.api, i18n: mockI18n, workspaceActive: true }))
      })
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30))
      })

      const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!
      await act(async () => {
        textarea.value = 'Background processing'
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => {
        host.querySelector<HTMLFormElement>('form.hc-composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })

      // Send delta and done
      await act(async () => {
        harness.emitChunk({ requestId: lastRequestId, type: 'delta', text: 'Important background content' })
        harness.emitChunk({ requestId: lastRequestId, type: 'done', text: '' })
      })

      // Even without rAF firing, the background buffer must have committed the text to saveConversation
      const saved = Array.from(harness.savedSessions.values()).find((s) =>
        s.messages.some((m) => m.text.includes('Background processing')),
      )
      expect(saved).toBeDefined()
      expect(saved?.messages.find((m) => m.role === 'assistant')?.text).toContain('Important background content')
    } finally {
      window.requestAnimationFrame = originalRaf
    }
  })

  it('C18 & C19: Deleting a running session stops its execution cleanly without resurrecting', async () => {
    const harness = createMockChatApi()
    let lastRequestId = ''
    vi.mocked(harness.api.aiStream).mockImplementation(async (req: any) => {
      lastRequestId = req.requestId
    })

    await act(async () => {
      root.render(createElement(HomeChat, { api: harness.api, i18n: mockI18n, workspaceActive: true }))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })

    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      textarea.value = 'Doomed session'
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      host.querySelector<HTMLFormElement>('form.hc-composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    // Click delete on the running session
    const row = Array.from(host.querySelectorAll('.hc-group li')).find((el) => el.textContent?.includes('Doomed session'))
    const deleteBtn = row?.querySelector<HTMLButtonElement>('[aria-label*="Delete" i], [aria-label*="remove" i]')
    await act(async () => {
      deleteBtn?.click()
    })

    expect(harness.api.aiStreamCancel).toHaveBeenCalledWith(lastRequestId)

    // Late chunks arriving for the deleted session must not re-create the session in storage
    await act(async () => {
      harness.emitChunk({ requestId: lastRequestId, type: 'delta', text: 'Late zombie chunk' })
      harness.emitChunk({ requestId: lastRequestId, type: 'done', text: '' })
    })

    const resurrected = Array.from(harness.savedSessions.values()).find((s) =>
      s.messages.some((m) => m.text.includes('Doomed session')),
    )
    expect(resurrected).toBeUndefined()
  })

  it('C22: Bounded concurrency scheduler queues 3rd conversation and processes when a run completes', async () => {
    const harness = createMockChatApi()
    const activeStreams: string[] = []
    vi.mocked(harness.api.aiStream).mockImplementation(async (req: any) => {
      activeStreams.push(req.requestId)
    })

    await act(async () => {
      root.render(createElement(HomeChat, { api: harness.api, i18n: mockI18n, workspaceActive: true }))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })

    const submitMsg = async (text: string) => {
      const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!
      await act(async () => {
        textarea.value = text
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => {
        host.querySelector<HTMLFormElement>('form.hc-composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })
    }

    // Submit Chat 1
    await submitMsg('Job 1')
    expect(activeStreams.length).toBe(1)

    // Submit Chat 2
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.hc-new')!.click()
    })
    await submitMsg('Job 2')
    expect(activeStreams.length).toBe(2)

    // Submit Chat 3 (should be queued)
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.hc-new')!.click()
    })
    await submitMsg('Job 3')

    // At this moment, only 2 should have started provider streams
    expect(activeStreams.length).toBe(2)

    // History rail should show Chat 3 with a queued indicator
    const chat3Row = Array.from(host.querySelectorAll('.hc-group li')).find((el) => el.textContent?.includes('Job 3'))
    expect(chat3Row?.querySelector('.hc-row-queued, [aria-label*="queued" i], .is-queued')).not.toBeNull()

    // Complete Job 1
    await act(async () => {
      harness.emitChunk({ requestId: activeStreams[0], type: 'done', text: 'Job 1 finished' })
    })

    // Job 3 should now be promoted and started
    expect(activeStreams.length).toBe(3)
  })
})
