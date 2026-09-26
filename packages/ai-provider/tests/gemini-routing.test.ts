import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGeminiRouter, GEMINI_CHOICE_KEY, GEMINI_MODELS_KEY } from '../src/gemini-routing'
import { defaultAiSettings } from '../src/providers'

afterEach(() => vi.unstubAllGlobals())

describe('Gemini chat routing', () => {
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
})
