import { describe, expect, it, vi } from 'vitest'
import {
  HTML_CARD_SYSTEM_PROMPT,
  generateAiCardWithRealProvider,
  validateAiHtmlCardSchema,
} from '../src/main/fork/opening-card-ai'
import type { AiSettings } from '@genoffice/ai-provider'

describe('Opening Card Studio: AI HTML Generation & Multi-mode', () => {
  const dummyAiSettings: AiSettings = {
    provider: 'openai',
    gskToolsEnabled: false,
    providers: {
      openai: {
        apiKey: 'sk-mock-key',
        model: 'gpt-4o',
      },
    },
  }

  describe('validateAiHtmlCardSchema', () => {
    it('accepts valid HTML/CSS card payload', () => {
      const payload = {
        version: 1,
        name: 'Liquid Emerald',
        description: 'Translucent floating emerald card with glowing reflections',
        themeMode: 'dark',
        accentColor: '#10b981',
        html: '<div class="emerald-card"><h1>{{title}}</h1><p>{{fileName}}</p></div>',
        css: '.emerald-card { background: rgba(16, 185, 129, 0.2); backdrop-filter: blur(24px); }',
      }

      const res = validateAiHtmlCardSchema(payload)
      expect(res.ok).toBe(true)
      expect(res.card).toBeDefined()
      expect(res.card?.name).toBe('Liquid Emerald')
      expect(res.card?.contentKind).toBe('ai-html')
      expect(res.card?.material.accentColor).toBe('#10b981')
      expect(res.draft).toBeDefined()
      expect(res.draft?.html).toContain('{{fileName}}')
      expect(res.draft?.css).toContain('backdrop-filter: blur(24px)')
    })

    it('rejects payload with script or malicious event handlers', () => {
      const attack = {
        version: 1,
        name: 'Malicious Card',
        html: '<div class="box"><script>alert(1)</script><h1>{{title}}</h1></div>',
        css: '.box {}',
      }
      const res = validateAiHtmlCardSchema(attack)
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/prohibited/i)
    })

    it('rejects payload with unsafe CSS (@import)', () => {
      const attack = {
        version: 1,
        name: 'Evil CSS Card',
        html: '<div class="box"><h1>{{title}}</h1></div>',
        css: '@import url("https://evil.com/x.css"); .box {}',
      }
      const res = validateAiHtmlCardSchema(attack)
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/prohibited or unsafe/i)
    })

    it('rejects empty HTML or empty CSS', () => {
      expect(validateAiHtmlCardSchema({ name: 'Empty', html: '', css: '.a{}' }).ok).toBe(false)
      expect(validateAiHtmlCardSchema({ name: 'Empty', html: '<div></div>', css: '' }).ok).toBe(
        false,
      )
    })
  })

  describe('generateAiCardWithRealProvider (HTML mode)', () => {
    it('calls model with HTML_CARD_SYSTEM_PROMPT and returns validated draft', async () => {
      const mockHtmlPayload = JSON.stringify({
        version: 1,
        name: 'Cherry Blossom Mist',
        description: 'Soft pink sakura petals floating over frost glass',
        themeMode: 'dark',
        accentColor: '#f472b6',
        html: '<div class="sakura-card"><div class="badge">{{appName}}</div><h1>{{title}}</h1><p>{{fileName}}</p></div>',
        css: '.sakura-card { width: 440px; height: 240px; background: rgba(244,114,182,0.15); }',
      })

      const mockChatFn = vi.fn().mockResolvedValue({
        ok: true,
        content: `\`\`\`json\n${mockHtmlPayload}\n\`\`\``,
      })

      const result = await generateAiCardWithRealProvider(
        { prompt: 'Japanese cherry blossom opening scene', mode: 'html' },
        dummyAiSettings,
        undefined,
        mockChatFn,
      )

      expect(result.ok).toBe(true)
      expect(result.modeUsed).toBe('html')
      expect(result.card?.name).toBe('Cherry Blossom Mist')
      expect(result.card?.contentKind).toBe('ai-html')
      expect(result.htmlDraft?.html).toContain('{{fileName}}')
      expect(mockChatFn).toHaveBeenCalledWith(
        'openai',
        expect.anything(),
        HTML_CARD_SYSTEM_PROMPT,
        expect.stringContaining('Japanese cherry blossom opening scene'),
        undefined,
      )
    })

    it('supports cancellation via AbortSignal', async () => {
      const controller = new AbortController()
      controller.abort()

      const mockChatFn = vi.fn().mockImplementation((_p, _c, _s, _u, signal) => {
        if (signal?.aborted) throw new Error('Aborted')
        return Promise.resolve({ ok: true, content: '{}' })
      })

      const result = await generateAiCardWithRealProvider(
        { prompt: 'Cancel me', mode: 'html' },
        dummyAiSettings,
        controller.signal,
        mockChatFn,
      )

      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/cancelled/i)
    })
  })

  describe('generateAiCardWithRealProvider (Image mode)', () => {
    it('returns unsupported error when image generation is unavailable', async () => {
      const result = await generateAiCardWithRealProvider(
        { prompt: 'Futuristic sci-fi background', mode: 'image' },
        dummyAiSettings,
      )

      expect(result.ok).toBe(false)
      expect(result.modeUsed).toBe('image')
      expect(result.error).toMatch(/Image generation is not supported/i)
    })
  })

  describe('generateAiCardWithRealProvider (Style mode backward compatibility)', () => {
    it('maintains full declarative style mode compatibility', async () => {
      const mockStylePayload = JSON.stringify({
        name: 'Obsidian Night',
        description: 'Deep black glass with violet accents',
        preset: 'frosted-glass',
        themeMode: 'dark',
        accentColor: '#8b5cf6',
        opacity: 0.9,
        blurPx: 26,
      })

      const mockChatFn = vi.fn().mockResolvedValue({
        ok: true,
        content: mockStylePayload,
      })

      const result = await generateAiCardWithRealProvider(
        { prompt: 'Dark obsidian card', mode: 'style' },
        dummyAiSettings,
        undefined,
        mockChatFn,
      )

      expect(result.ok).toBe(true)
      expect(result.modeUsed).toBe('style')
      expect(result.card?.name).toBe('Obsidian Night')
      expect(result.card?.contentKind).toBe('ai-declarative')
      expect(result.card?.material.preset).toBe('frosted-glass')
    })
  })
})
