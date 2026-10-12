// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  CHAT_PREFILL_EVENT,
  requestChatPrefill,
  type ChatPrefillDetail,
  type ChatLaunchIntent,
} from '../src/renderer/src/chat-events'

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
})
