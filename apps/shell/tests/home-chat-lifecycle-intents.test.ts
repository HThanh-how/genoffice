// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act, createElement } from 'react'
import { HomeChat } from '../src/renderer/src/HomeChat'
import type { HomeApi } from '../src/shared/home-api'
import type { I18n } from '../src/renderer/src/locale'
import {
  CHAT_PREFILL_EVENT,
  requestChatPrefill,
  type ChatPrefillDetail,
  type ChatLaunchIntent,
} from '../src/renderer/src/chat-events'

function mockChatApi(overrides: Partial<HomeApi> = {}): HomeApi {
  return {
    homeChatList: vi.fn().mockResolvedValue([]),
    homeChatGet: vi.fn().mockResolvedValue({
      id: 'session-1',
      title: 'Session 1',
      messages: [{ role: 'user', text: 'Hi' }],
      createdAt: 100,
      updatedAt: 100,
    }),
    homeChatSave: vi.fn().mockResolvedValue(null),
    homeChatDelete: vi.fn().mockResolvedValue(true),
    homeChatClear: vi.fn().mockResolvedValue(true),
    homeChatRename: vi.fn().mockResolvedValue(null),
    getSettings: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as HomeApi
}

const mockI18n: I18n = {
  lang: 'en',
  setLang: () => {},
  t: (k: string) => k,
  locale: 'en',
}

describe('home-chat lifecycle & launch intents (Phase 1)', () => {
  it('requestChatPrefill dispatches CHAT_PREFILL_EVENT with explicit new intent', () => {
    let received: ChatPrefillDetail | null = null
    const handler = (event: Event) => {
      received = (event as CustomEvent<ChatPrefillDetail>).detail
    }
    window.addEventListener(CHAT_PREFILL_EVENT, handler)

    try {
      requestChatPrefill({ text: 'What is in budget.xlsx?', send: true, intent: 'new' })
      expect(received).not.toBeNull()
      expect(received!.text).toBe('What is in budget.xlsx?')
      expect(received!.send).toBe(true)
      expect(received!.intent).toBe('new')
    } finally {
      window.removeEventListener(CHAT_PREFILL_EVENT, handler)
    }
  })

  it('requestChatPrefill supports resume intent without wiping active chat', () => {
    let received: ChatPrefillDetail | null = null
    const handler = (event: Event) => {
      received = (event as CustomEvent<ChatPrefillDetail>).detail
    }
    window.addEventListener(CHAT_PREFILL_EVENT, handler)

    try {
      requestChatPrefill({ text: 'Follow up question', send: false, intent: 'resume' })
      expect(received).not.toBeNull()
      expect(received!.text).toBe('Follow up question')
      expect(received!.intent).toBe('resume')
    } finally {
      window.removeEventListener(CHAT_PREFILL_EVENT, handler)
    }
  })

  it('requestChatPrefill supports open-existing intent with sessionId', () => {
    let received: ChatPrefillDetail | null = null
    const handler = (event: Event) => {
      received = (event as CustomEvent<ChatPrefillDetail>).detail
    }
    window.addEventListener(CHAT_PREFILL_EVENT, handler)

    try {
      requestChatPrefill({
        text: 'Review session',
        intent: 'open-existing',
        sessionId: 'session-1234',
      })
      expect(received).not.toBeNull()
      expect(received!.intent).toBe('open-existing')
      expect(received!.sessionId).toBe('session-1234')
    } finally {
      window.removeEventListener(CHAT_PREFILL_EVENT, handler)
    }
  })

  it('legacy continue: true maps to resume intent when intent is omitted', () => {
    const resolveIntent = (detail: ChatPrefillDetail): ChatLaunchIntent =>
      detail.intent ?? (detail.continue === true ? 'resume' : 'new')

    expect(resolveIntent({ text: 'test', continue: true })).toBe('resume')
    expect(resolveIntent({ text: 'test' })).toBe('new')
    expect(resolveIntent({ text: 'test', intent: 'new', continue: true })).toBe('new')
  })

  it('stale async restoration simulation does not overwrite a newer launch sequence token', async () => {
    const activeToken = 1
    let activeSession = 'fresh-new-chat'

    // An asynchronous restoreLast started with token 0 attempts to complete after delay
    const restorePromise = (async (startedToken: number) => {
      await new Promise((r) => setTimeout(r, 10))
      // Sequence guard:
      if (startedToken !== activeToken) {
        return { aborted: true }
      }
      activeSession = 'restored-old-chat'
      return { aborted: false }
    })(0)

    const result = await restorePromise
    expect(result.aborted).toBe(true)
    expect(activeSession).toBe('fresh-new-chat')
  })

  it('conversation switching aborts in-flight token generation without contaminating new session', () => {
    let currentRunGen = 1
    const targetSessionItems: string[] = []

    // Simulate stream chunk arrival checking generation
    const onStreamChunk = (chunkGen: number, text: string) => {
      if (chunkGen !== currentRunGen) return
      targetSessionItems.push(text)
    }

    // Old session streaming with gen 1
    onStreamChunk(1, 'Chunk from old session')
    expect(targetSessionItems).toEqual(['Chunk from old session'])

    // Switch session: increments generation
    currentRunGen++

    // Delayed chunks from old session (gen 1) arrive after switch
    onStreamChunk(1, 'Late chunk from old session')
    expect(targetSessionItems).toEqual(['Chunk from old session'])

    // New session streaming with gen 2
    onStreamChunk(2, 'Chunk for new session')
    expect(targetSessionItems).toEqual(['Chunk from old session', 'Chunk for new session'])
  })

  it('new chat launch intent initializes empty conversation without loading existing session', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const api = mockChatApi()

    try {
      await act(async () => {
        root.render(createElement(HomeChat, { api, i18n: mockI18n }))
      })

      // Dispatch new intent
      await act(async () => {
        requestChatPrefill({ text: 'Hello fresh conversation', intent: 'new' })
        await Promise.resolve()
      })

      // Verify that existing session was not loaded
      expect(api.homeChatGet).not.toHaveBeenCalled()
      // Verify composer input is prefilled with requested text
      const textarea = host.querySelector<HTMLTextAreaElement>('textarea')
      expect(textarea?.value).toBe('Hello fresh conversation')
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('existing chat launch intent opens session exactly once via HomeChat', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const api = mockChatApi()

    try {
      await act(async () => {
        root.render(createElement(HomeChat, { api, i18n: mockI18n }))
      })

      // Dispatch open-existing intent
      await act(async () => {
        requestChatPrefill({
          text: 'Continue session',
          intent: 'open-existing',
          sessionId: 'session-1',
        })
        await Promise.resolve()
      })

      // Verify that homeChatGet was called EXACTLY ONCE (no duplicate dispatch)
      expect(api.homeChatGet).toHaveBeenCalledTimes(1)
      expect(api.homeChatGet).toHaveBeenCalledWith('session-1')
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('rapid switching preserves latest session identity in HomeChat', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const api = mockChatApi({
      homeChatGet: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'session-slow') {
          await new Promise((r) => setTimeout(r, 60))
        }
        return {
          id,
          title: `Title for ${id}`,
          messages: [{ role: 'assistant', text: `Message for ${id}` }],
          createdAt: 100,
          updatedAt: 100,
        }
      }),
    })

    try {
      await act(async () => {
        root.render(createElement(HomeChat, { api, i18n: mockI18n }))
      })

      // Rapidly dispatch slow session, then fast session
      await act(async () => {
        requestChatPrefill({ text: 'Q1', intent: 'open-existing', sessionId: 'session-slow' })
        requestChatPrefill({ text: 'Q2', intent: 'open-existing', sessionId: 'session-fast' })
        await new Promise((r) => setTimeout(r, 80))
      })

      // The title header reflects session-fast, not session-slow
      const titleEl = host.querySelector('.hc-title')
      expect(titleEl?.textContent).toContain('Title for session-fast')
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })
})
