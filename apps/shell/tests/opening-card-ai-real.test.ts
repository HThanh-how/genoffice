import { describe, expect, it, vi } from 'vitest'
import { generateAiCardWithRealProvider } from '../src/main/fork/opening-card-ai'
import type { AiSettings } from '@genoffice/ai-provider'
import type { AiCardGenerationInput } from '../src/shared/opening-card-types'

describe('Opening Card Studio: Real AI Provider Integration', () => {
  const dummyAiSettings: AiSettings = {
    provider: 'gemini',
    providers: {
      gemini: {
        model: 'gemini-2.5-flash',
        apiKey: 'test-fake-key-12345',
      },
    },
  }

  it('invokes configured AI provider boundary and parses validated card configuration', async () => {
    const input: AiCardGenerationInput = {
      prompt: 'Minimalist frosted glass with soft cyan edge',
      preset: 'frosted-glass',
      themeMode: 'dark',
      accentColor: '#38bdf8',
    }

    const mockAiResponse = JSON.stringify({
      name: 'Cyan Frost',
      description: 'A serene frosted glass opening style with soft cyan borders',
      preset: 'frosted-glass',
      themeMode: 'dark',
      opacity: 0.85,
      blurPx: 24,
      accentColor: '#38bdf8',
      borderRadiusPx: 18,
      borderWidthPx: 1,
      shadowIntensity: 0.35,
    })

    const mockChat = vi.fn().mockResolvedValue({
      ok: true,
      content: mockAiResponse,
    })

    const result = await generateAiCardWithRealProvider(input, dummyAiSettings, undefined, mockChat)

    expect(result.ok).toBe(true)
    expect(result.card).toBeDefined()
    expect(result.card?.name).toBe('Cyan Frost')
    expect(result.card?.category).toBe('ai')
    expect(result.card?.contentKind).toBe('ai-declarative')
    expect(result.card?.material.preset).toBe('frosted-glass')
    expect(result.card?.material.accentColor).toBe('#38bdf8')
    expect(result.modelUsed).toBe('gemini-2.5-flash')

    // Confirm chatFn was called with system prompt and user brief
    expect(mockChat).toHaveBeenCalledTimes(1)
    const [providerArg, configArg, sysPromptArg, userPromptArg] = mockChat.mock.calls[0]
    expect(providerArg).toBe('gemini')
    expect(configArg.model).toBe('gemini-2.5-flash')
    expect(sysPromptArg).toContain('Opening Card Studio')
    expect(userPromptArg).toContain('Minimalist frosted glass with soft cyan edge')
  })

  it('respects explicit model override in generation input', async () => {
    const input: AiCardGenerationInput = {
      prompt: 'Solid dark obsidian card',
      model: 'gemini-1.5-pro-custom',
    }

    const mockChat = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        name: 'Obsidian',
        preset: 'solid',
        accentColor: '#1e293b',
      }),
    })

    const result = await generateAiCardWithRealProvider(input, dummyAiSettings, undefined, mockChat)

    expect(result.ok).toBe(true)
    expect(result.modelUsed).toBe('gemini-1.5-pro-custom')
    expect(mockChat.mock.calls[0][1].model).toBe('gemini-1.5-pro-custom')
  })

  it('fails gracefully when provider is not configured or missing API key', async () => {
    const emptySettings: AiSettings = {
      provider: 'openai',
      providers: {
        openai: {
          model: 'gpt-4o',
          apiKey: '', // missing API key
        },
      },
    }

    const result = await generateAiCardWithRealProvider({ prompt: 'Nordic slate' }, emptySettings)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('No API key found for "openai"')
  })

  it('rejects invalid JSON response from AI provider', async () => {
    const mockChat = vi.fn().mockResolvedValue({
      ok: true,
      content: 'I cannot generate JSON right now.',
    })

    const result = await generateAiCardWithRealProvider(
      { prompt: 'Anything' },
      dummyAiSettings,
      undefined,
      mockChat,
    )

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Failed to parse AI response into valid JSON')
    expect(result.rawResponse).toBe('I cannot generate JSON right now.')
  })

  it('rejects model responses containing unknown injected properties', async () => {
    const mockChat = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        name: 'Injected Card',
        preset: 'solid',
        evalCode: 'process.exit(1)', // forbidden unauthorized property
      }),
    })

    const result = await generateAiCardWithRealProvider(
      { prompt: 'Attack test' },
      dummyAiSettings,
      undefined,
      mockChat,
    )

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Unauthorized field in AI output')
  })

  it('handles user cancellation via AbortSignal', async () => {
    const controller = new AbortController()
    controller.abort()

    const mockChat = vi.fn().mockImplementation((_p, _c, _s, _u, signal) => {
      if (signal?.aborted) {
        const err = new Error('The operation was aborted')
        err.name = 'AbortError'
        throw err
      }
      return Promise.resolve({ ok: true, content: '{}' })
    })

    const result = await generateAiCardWithRealProvider(
      { prompt: 'Nordic glow' },
      dummyAiSettings,
      controller.signal,
      mockChat,
    )

    expect(result.ok).toBe(false)
    expect(result.error).toContain('cancelled by the user')
  })

  it('produces a transient preview card without auto-saving to preferences', async () => {
    const mockChat = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        name: 'Ephemeral Card',
        preset: 'frosted-glass',
        accentColor: '#6366f1',
      }),
    })

    const result = await generateAiCardWithRealProvider(
      { prompt: 'Violet dusk' },
      dummyAiSettings,
      undefined,
      mockChat,
    )

    expect(result.ok).toBe(true)
    expect(result.card).toBeDefined()
    // Card has unique ID and metadata for UI preview
    expect(result.card?.id).toContain('ai:card_')
    expect(result.card?.isBuiltIn).toBe(false)
  })
})
