import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createGeminiRouter,
  GEMINI_CHOICE_KEY,
  GEMINI_MODELS_KEY,
  GEMINI_ROUTING_LOG_KEY,
  GEMINI_CALL_LOG_KEY,
  readGeminiCallLog,
} from '../src/gemini-routing'
import { defaultAiSettings } from '../src/providers'

afterEach(() => vi.unstubAllGlobals())

describe('Gemini chat routing', () => {
  it('records each call without prompt or key and keeps provider token counts distinct from errors', () => {
    const saved = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => {
        saved.set(key, value)
      },
    })
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
    const settings = defaultAiSettings()
    settings.provider = 'gemini'
    settings.providers.gemini.apiKey = 'secret-api-key'
    const router = createGeminiRouter()
    const request = {
      system: 'system confidential',
      messages: [{ role: 'user' as const, text: 'private document content' }],
      tools: [{ name: 'edit_document', description: 'edit', inputSchema: {} }],
    }
    router.onAttempt(settings, 'call-1', request)
    router.onToolCall(settings, 'call-1', 'edit_document')
    router.onUsage(settings, 'call-1', {
      promptTokenCount: 200,
      candidatesTokenCount: 30,
      thoughtsTokenCount: 10,
      totalTokenCount: 240,
    })
    router.onResult(settings, 'call-1', { status: 'ok' })
    router.onAttempt(settings, 'call-2', request)
    router.onResult(settings, 'call-2', {
      status: 'error',
      error:
        'Gemini HTTP 429: quota_exceeded private document content quotaId="RequestsPerDay" quotaMetric="generativelanguage.googleapis.com/generate_content_requests" retryDelay="33s"',
    })
    const calls = readGeminiCallLog()
    expect(calls[0]).toMatchObject({
      id: 'call-2',
      status: 'error',
      httpStatus: 429,
      reason: 'daily_quota',
      quotaId: 'RequestsPerDay',
      retryAfterSeconds: 33,
    })
    expect(calls[0]?.usage).toBeUndefined()
    expect(calls[1]).toMatchObject({
      id: 'call-1',
      status: 'ok',
      toolNames: ['edit_document'],
      usage: { totalTokenCount: 240 },
    })
    const stored = saved.get(GEMINI_CALL_LOG_KEY) || ''
    expect(stored).not.toContain('secret-api-key')
    expect(stored).not.toContain('private document content')
    expect(stored).not.toContain('system confidential')
  })

  it('expires call diagnostics after seven days and caps the retained calls', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-27T12:00:00Z'))
    try {
      const saved = new Map<string, string>()
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => {
          saved.set(key, value)
        },
      })
      vi.stubGlobal('window', { dispatchEvent: vi.fn() })
      const settings = defaultAiSettings()
      settings.provider = 'gemini'
      const router = createGeminiRouter()
      const request = { system: 'sys', messages: [], tools: [] }
      for (let index = 0; index < 205; index++) router.onAttempt(settings, `call-${index}`, request)
      expect(readGeminiCallLog()).toHaveLength(200)
      expect(
        new TextEncoder().encode(saved.get(GEMINI_CALL_LOG_KEY) || '').byteLength,
      ).toBeLessThanOrEqual(128 * 1024)
      const oversized = { ...readGeminiCallLog()[0]!, toolNames: ['x'.repeat(200_000)] }
      saved.set(GEMINI_CALL_LOG_KEY, JSON.stringify([oversized]))
      expect(readGeminiCallLog()).toEqual([])
      router.onAttempt(settings, 'fresh-call', request)
      vi.advanceTimersByTime(8 * 24 * 60 * 60_000)
      expect(readGeminiCallLog()).toEqual([])
      expect(saved.get(GEMINI_CALL_LOG_KEY)).toBe('[]')
    } finally {
      vi.useRealTimers()
    }
  })
  it('keeps the no-output wait and whole turn within a short user-facing budget', () => {
    const router = createGeminiRouter()
    expect(router.firstContentTimeoutMs).toBe(45_000)
    expect(router.maxDurationMs).toBe(120_000)
  })

  it('retries temporary overload twice, then switches models', () => {
    const saved = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => {
        saved.set(key, value)
      },
    })
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
    vi.stubGlobal(
      'CustomEvent',
      class {
        constructor(_name: string, _init: unknown) {}
      },
    )
    saved.set(
      GEMINI_MODELS_KEY,
      JSON.stringify([
        { id: 'gemini-3.8-flash', displayName: 'Flash', usableForChat: true },
        { id: 'gemini-3.7-flash', displayName: 'Backup', usableForChat: true },
      ]),
    )
    const settings = defaultAiSettings()
    settings.provider = 'gemini'
    const router = createGeminiRouter()
    const first = router.prepare(settings)
    expect(router.retry(first, 'Gemini HTTP 503: overloaded', false)).toBe(400)
    expect(router.retry(first, 'Gemini HTTP 503: overloaded', false)).toBe(1_000)
    expect(router.retry(first, 'Gemini HTTP 503: overloaded', false)).toBeNull()
    expect(
      router.fallback(first, 'Gemini HTTP 503: overloaded', false)?.providers.gemini.model,
    ).toBe('gemini-3.7-flash')
    expect(router.retry(first, 'Gemini HTTP 503: overloaded', true)).toBeNull()
  })

  it('jumps from a busy Flash to Lite, then Gemma when both are listed', () => {
    const saved = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => {
        saved.set(key, value)
      },
    })
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
    vi.stubGlobal(
      'CustomEvent',
      class {
        constructor(_name: string, _init: unknown) {}
      },
    )
    saved.set(
      GEMINI_MODELS_KEY,
      JSON.stringify([
        { id: 'gemini-3.8-flash', displayName: 'Flash', usableForChat: true },
        { id: 'gemini-3.7-flash', displayName: 'Older Flash', usableForChat: true },
        { id: 'gemini-3.5-flash-lite', displayName: 'Lite', usableForChat: true },
        { id: 'gemma-4-26b-a4b-it', displayName: 'Gemma', usableForChat: true },
      ]),
    )
    const settings = defaultAiSettings()
    settings.provider = 'gemini'
    const router = createGeminiRouter()
    const first = router.prepare(settings)
    const lite = router.fallback(first, 'Gemini HTTP 503: overloaded', false)
    expect(lite?.providers.gemini.model).toBe('gemini-3.5-flash-lite')
    const gemma = router.fallback(lite!, 'Gemini HTTP 429: quota_exceeded', false)
    expect(gemma?.providers.gemini.model).toBe('gemma-4-26b-a4b-it')
  })

  it('switches immediately for daily quota or a long RetryInfo delay', () => {
    const saved = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => {
        saved.set(key, value)
      },
    })
    const settings = defaultAiSettings()
    settings.provider = 'gemini'
    const router = createGeminiRouter()
    const first = router.prepare(settings)
    expect(router.retry(first, 'Gemini HTTP 429: quota_exceeded', false)).toBeNull()
    expect(router.retry(first, 'Gemini HTTP 429: retryDelay="37s"', false)).toBeNull()
    expect(router.retry(first, 'Gemini HTTP 503: retryDelay="2s"', false)).toBe(2_000)
  })

  it('includes newly listed chat models in automatic fallback', () => {
    const saved = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => {
        saved.set(key, value)
      },
    })
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
    saved.set(
      GEMINI_MODELS_KEY,
      JSON.stringify([
        { id: 'gemini-3.8-flash', displayName: 'Flash', usableForChat: true },
        { id: 'gemini-4-flash', displayName: 'New Flash', usableForChat: true },
      ]),
    )
    const settings = defaultAiSettings()
    settings.provider = 'gemini'
    const router = createGeminiRouter()
    const first = router.prepare(settings)
    expect(first.providers.gemini.model).toBe('gemini-3.8-flash')
    expect(router.fallback(first, 'Gemini HTTP 429', false)?.providers.gemini.model).toBe(
      'gemini-4-flash',
    )
  })

  it('uses live chat-capable models, keeps a fallback through tool turns, and honors a manual choice', () => {
    const saved = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => {
        saved.set(key, value)
      },
    })
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
    vi.stubGlobal(
      'CustomEvent',
      class {
        constructor(_name: string, _init: unknown) {}
      },
    )
    saved.set(
      GEMINI_MODELS_KEY,
      JSON.stringify([
        { id: 'gemini-3.8-flash', displayName: '3.8 Flash', usableForChat: true },
        { id: 'gemini-3.7-flash', displayName: '3.7 Flash', usableForChat: true },
        { id: 'gemini-3.1-flash-image', displayName: 'Image', usableForChat: false },
      ]),
    )
    const settings = defaultAiSettings()
    settings.provider = 'gemini'
    const router = createGeminiRouter()
    const first = router.prepare(settings)
    expect(first.providers.gemini.model).toBe('gemini-3.8-flash')
    const second = router.fallback(first, 'Gemini HTTP 429: rate_limit_exceeded', false)
    expect(second?.providers.gemini.model).toBe('gemini-3.7-flash')
    expect(router.prepare(settings).providers.gemini.model).toBe('gemini-3.7-flash')
    expect(router.fallback(second!, 'Gemini HTTP 503', true)).toBeNull()
    saved.set(GEMINI_CHOICE_KEY, 'model:gemini-3.7-flash')
    const manual = router.prepare(settings)
    expect(manual.providers.gemini.model).toBe('gemini-3.7-flash')
    expect(router.fallback(manual, 'Gemini HTTP 429', false)).toBeNull()
  })

  it('records safe fallback diagnostics and retries a preferred model on a later run', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-27T12:00:00Z'))
    try {
      const saved = new Map<string, string>()
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => {
          saved.set(key, value)
        },
      })
      vi.stubGlobal('window', { dispatchEvent: vi.fn() })
      vi.stubGlobal(
        'CustomEvent',
        class {
          constructor(_name: string, _init: unknown) {}
        },
      )
      saved.set(
        GEMINI_MODELS_KEY,
        JSON.stringify([
          { id: 'gemini-3.8-flash', displayName: 'Primary', usableForChat: true },
          { id: 'gemini-3.5-flash', displayName: 'Backup', usableForChat: true },
        ]),
      )
      const settings = defaultAiSettings()
      settings.provider = 'gemini'
      const router = createGeminiRouter()
      const first = router.prepare(settings, { system: '', runId: 'first' } as Parameters<
        typeof router.prepare
      >[1])
      expect(first.providers.gemini.model).toBe('gemini-3.8-flash')
      const second = router.fallback(
        first,
        'Gemini HTTP 429: rate_limit_exceeded private prompt',
        false,
      )
      expect(second?.providers.gemini.model).toBe('gemini-3.5-flash')
      const log = saved.get(GEMINI_ROUTING_LOG_KEY) || ''
      expect(log).toContain('rate_limit')
      expect(log).toContain('gemini-3.8-flash')
      expect(log).not.toContain('private prompt')
      vi.advanceTimersByTime(61_000)
      expect(
        router.prepare(settings, { system: '', runId: 'second' } as Parameters<
          typeof router.prepare
        >[1]).providers.gemini.model,
      ).toBe('gemini-3.8-flash')
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a daily-limited model after the Pacific calendar day changes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-27T06:59:00Z'))
    try {
      const saved = new Map<string, string>()
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => {
          saved.set(key, value)
        },
      })
      vi.stubGlobal('window', { dispatchEvent: vi.fn() })
      vi.stubGlobal(
        'CustomEvent',
        class {
          constructor(_name: string, _init: unknown) {}
        },
      )
      saved.set(
        GEMINI_MODELS_KEY,
        JSON.stringify([
          { id: 'gemini-3.8-flash', displayName: 'Primary', usableForChat: true },
          { id: 'gemini-3.5-flash', displayName: 'Backup', usableForChat: true },
        ]),
      )
      const settings = defaultAiSettings()
      settings.provider = 'gemini'
      const router = createGeminiRouter()
      const first = router.prepare(settings, { system: '', runId: 'first' } as Parameters<
        typeof router.prepare
      >[1])
      expect(
        router.fallback(first, 'Gemini HTTP 429: quota_exceeded', false)?.providers.gemini.model,
      ).toBe('gemini-3.5-flash')
      vi.advanceTimersByTime(30_000)
      expect(
        router.prepare(settings, { system: '', runId: 'second' } as Parameters<
          typeof router.prepare
        >[1]).providers.gemini.model,
      ).toBe('gemini-3.5-flash')
      vi.advanceTimersByTime(31_000)
      expect(
        router.prepare(settings, { system: '', runId: 'third' } as Parameters<
          typeof router.prepare
        >[1]).providers.gemini.model,
      ).toBe('gemini-3.8-flash')
    } finally {
      vi.useRealTimers()
    }
  })

  it('switches immediately for a timeout or 429, but not for a local network failure', () => {
    const saved = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => {
        saved.set(key, value)
      },
    })
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
    vi.stubGlobal(
      'CustomEvent',
      class {
        constructor(_name: string, _init: unknown) {}
      },
    )
    saved.set(
      GEMINI_MODELS_KEY,
      JSON.stringify([
        { id: 'gemini-3.8-flash', displayName: 'Primary', usableForChat: true },
        { id: 'gemini-3.7-flash', displayName: 'Backup', usableForChat: true },
      ]),
    )
    const settings = defaultAiSettings()
    settings.provider = 'gemini'
    const router = createGeminiRouter()
    const first = router.prepare(settings)
    expect(router.retry(first, 'Gemini HTTP 429: rate_limit_exceeded', false)).toBeNull()
    expect(router.retry(first, 'AI request timed out', false, 'timeout')).toBeNull()
    expect(router.fallback(first, 'fetch failed', false, 'network')).toBeNull()
    expect(
      router.fallback(first, 'AI request timed out', false, 'timeout')?.providers.gemini.model,
    ).toBe('gemini-3.7-flash')
    expect(saved.get(GEMINI_ROUTING_LOG_KEY)).toContain('timeout')
  })

  it('reconsiders the preferred model for a fresh standalone request', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-27T12:00:00Z'))
    try {
      const saved = new Map<string, string>()
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => {
          saved.set(key, value)
        },
      })
      vi.stubGlobal('window', { dispatchEvent: vi.fn() })
      vi.stubGlobal(
        'CustomEvent',
        class {
          constructor(_name: string, _init: unknown) {}
        },
      )
      saved.set(
        GEMINI_MODELS_KEY,
        JSON.stringify([
          { id: 'gemini-3.8-flash', displayName: 'Primary', usableForChat: true },
          { id: 'gemini-3.7-flash', displayName: 'Backup', usableForChat: true },
        ]),
      )
      const settings = defaultAiSettings()
      settings.provider = 'gemini'
      const router = createGeminiRouter()
      const first = router.prepare(settings)
      expect(router.fallback(first, 'Gemini HTTP 503', false)?.providers.gemini.model).toBe(
        'gemini-3.7-flash',
      )
      vi.advanceTimersByTime(61_000)
      expect(router.prepare(settings).providers.gemini.model).toBe('gemini-3.8-flash')
    } finally {
      vi.useRealTimers()
    }
  })
})

it('retries high-demand failures with or without a structured overload code', () => {
  const settings = defaultAiSettings()
  settings.provider = 'gemini'
  const router = createGeminiRouter()
  expect(router.continuePartialTextOnOverload).toBe(true)
  expect(router.retry(settings, 'This model is currently experiencing high demand.', false)).toBe(
    400,
  )
  expect(router.retry(settings, 'temporary failure', false, 'overloaded')).toBe(1000)
  expect(router.retry(settings, 'high demand', false, 'overloaded')).toBeNull()
})
