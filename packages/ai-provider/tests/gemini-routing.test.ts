import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createGeminiRouter,
  GEMINI_CHOICE_KEY,
  GEMINI_MODELS_KEY,
  GEMINI_ROUTING_LOG_KEY,
} from '../src/gemini-routing'
import { defaultAiSettings } from '../src/providers'

afterEach(() => vi.unstubAllGlobals())

describe('Gemini chat routing', () => {
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
})
