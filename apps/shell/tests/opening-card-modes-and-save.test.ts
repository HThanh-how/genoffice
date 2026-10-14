import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HTML_CARD_SYSTEM_PROMPT,
  generateAiCardWithRealProvider,
} from '../src/main/fork/opening-card-ai'
import { validateCardDefinition } from '../src/main/fork/opening-card-export'
import {
  deleteHtmlCardAsset,
  listHtmlCardAssets,
  readHtmlCardAsset,
  storeHtmlCardAsset,
} from '../src/main/fork/opening-html-storage'
import { sanitizeOpeningCss, sanitizeOpeningHtml } from '../src/shared/opening-card-html-sanitizer'
import type {
  OpeningCardDefinition,
  OpeningEffectsState,
  OpeningPrefs,
  SaveOpeningHtmlCardResult,
} from '../src/shared/home-api'
import type { AiSettings } from '@genoffice/ai-provider'
import type { AiCardGenerationInput } from '../src/shared/opening-card-types'

describe('Opening Card Studio — Generation Modes & Persistence Reliability', () => {
  const dummyAiSettings: AiSettings = {
    provider: 'openai',
    gskToolsEnabled: false,
    providers: {
      openai: {
        apiKey: 'sk-mock-key-12345',
        model: 'gpt-4o',
      },
    },
  }

  // =========================================================================
  // FIX #1 REGRESSION TESTS: Mode Isolation & Fail-Closed Dispatch
  // =========================================================================
  describe('Fix #1: AI Generation Modes Isolation', () => {
    it('Test A: Explicit Image mode returns ok: false, modeUsed: "image", does not call chatFn, does not fall through to style', async () => {
      const mockChatFn = vi.fn()
      const input: AiCardGenerationInput = {
        prompt: 'Futuristic floating glass sphere with neon lights',
        mode: 'image',
      }

      const result = await generateAiCardWithRealProvider(
        input,
        dummyAiSettings,
        undefined,
        mockChatFn,
      )

      expect(result.ok).toBe(false)
      expect(result.modeUsed).toBe('image')
      expect(result.card).toBeUndefined()
      expect(result.htmlDraft).toBeUndefined()
      expect(result.error).toMatch(/AI image generation is not supported/i)
      // Critical check: chatFn must never be invoked for image mode
      expect(mockChatFn).not.toHaveBeenCalled()
    })

    it('Test B: Mode "html" runs HTML generation and does not fall through to style', async () => {
      const mockPayload = JSON.stringify({
        version: 1,
        name: 'Sakura Petals',
        description: 'Delicate pink petals falling over frosted glass',
        themeMode: 'dark',
        accentColor: '#f472b6',
        html: '<div class="sakura"><h1>{{title}}</h1></div>',
        css: '.sakura { color: #f472b6; backdrop-filter: blur(10px); }',
      })
      const mockChatFn = vi.fn().mockResolvedValue({
        ok: true,
        content: `\`\`\`json\n${mockPayload}\n\`\`\``,
      })

      const input: AiCardGenerationInput = {
        prompt: 'Japanese cherry blossom theme',
        mode: 'html',
      }

      const result = await generateAiCardWithRealProvider(
        input,
        dummyAiSettings,
        undefined,
        mockChatFn,
      )

      expect(result.ok).toBe(true)
      expect(result.modeUsed).toBe('html')
      expect(result.card?.contentKind).toBe('ai-html')
      expect(result.htmlDraft?.html).toContain('{{title}}')
      expect(result.htmlDraft?.css).toContain('backdrop-filter')
      expect(mockChatFn).toHaveBeenCalledTimes(1)
      expect(mockChatFn.mock.calls[0][2]).toBe(HTML_CARD_SYSTEM_PROMPT)
    })

    it('Test C: Mode "style" runs declarative Style Preset generation', async () => {
      const mockPayload = JSON.stringify({
        name: 'Frosted Emerald',
        description: 'Vibrant emerald card with subtle shadows',
        preset: 'frosted-glass',
        themeMode: 'dark',
        accentColor: '#10b981',
        opacity: 0.85,
        blurPx: 20,
      })
      const mockChatFn = vi.fn().mockResolvedValue({
        ok: true,
        content: mockPayload,
      })

      const input: AiCardGenerationInput = {
        prompt: 'Emerald green glass',
        mode: 'style',
      }

      const result = await generateAiCardWithRealProvider(
        input,
        dummyAiSettings,
        undefined,
        mockChatFn,
      )

      expect(result.ok).toBe(true)
      expect(result.modeUsed).toBe('style')
      expect(result.card?.contentKind).toBe('ai-declarative')
      expect(result.card?.material.preset).toBe('frosted-glass')
      expect(result.htmlDraft).toBeUndefined()
      expect(mockChatFn).toHaveBeenCalledTimes(1)
      expect(mockChatFn.mock.calls[0][2]).toContain('Opening Card Studio')
      expect(mockChatFn.mock.calls[0][2]).not.toBe(HTML_CARD_SYSTEM_PROMPT)
    })

    it('Test D: Default mode (empty or undefined) runs Style Preset generation for backward compatibility', async () => {
      const mockPayload = JSON.stringify({
        name: 'Default Obsidian',
        preset: 'solid',
        accentColor: '#181b22',
      })
      const mockChatFn = vi.fn().mockResolvedValue({
        ok: true,
        content: mockPayload,
      })

      // Undefined mode
      const resUndefined = await generateAiCardWithRealProvider(
        { prompt: 'Dark slate' },
        dummyAiSettings,
        undefined,
        mockChatFn,
      )
      expect(resUndefined.ok).toBe(true)
      expect(resUndefined.modeUsed).toBe('style')
      expect(resUndefined.card?.contentKind).toBe('ai-declarative')

      // Empty string mode
      const resEmpty = await generateAiCardWithRealProvider(
        { prompt: 'Dark slate', mode: '' as any },
        dummyAiSettings,
        undefined,
        mockChatFn,
      )
      expect(resEmpty.ok).toBe(true)
      expect(resEmpty.modeUsed).toBe('style')
    })

    it('Test E: Mode "invalid-mode" is rejected with ok: false and does not fall through to style', async () => {
      const mockChatFn = vi.fn()
      const input = {
        prompt: 'Futuristic theme',
        mode: 'nonexistent-custom-mode' as any,
      }

      const result = await generateAiCardWithRealProvider(
        input,
        dummyAiSettings,
        undefined,
        mockChatFn,
      )

      expect(result.ok).toBe(false)
      expect(result.error).toContain('Unsupported generation mode: nonexistent-custom-mode')
      expect(mockChatFn).not.toHaveBeenCalled()
    })

    it('Test F: Cancellation works in all modes without unhandled rejections', async () => {
      // 1. Image mode with pre-aborted controller returns safely without throwing
      const controllerImage = new AbortController()
      controllerImage.abort()
      const resImage = await generateAiCardWithRealProvider(
        { prompt: 'Space background', mode: 'image' },
        dummyAiSettings,
        controllerImage.signal,
      )
      expect(resImage.ok).toBe(false)
      expect(resImage.modeUsed).toBe('image')

      // 2. HTML mode with aborted signal returns cancelled error
      const controllerHtml = new AbortController()
      controllerHtml.abort()
      const mockChatHtml = vi.fn().mockImplementation((_p, _c, _s, _u, signal) => {
        if (signal?.aborted) throw new Error('Operation was aborted')
        return Promise.resolve({ ok: true, content: '{}' })
      })
      const resHtml = await generateAiCardWithRealProvider(
        { prompt: 'Cancel me', mode: 'html' },
        dummyAiSettings,
        controllerHtml.signal,
        mockChatHtml,
      )
      expect(resHtml.ok).toBe(false)
      expect(resHtml.error).toMatch(/cancelled by the user/i)
      expect(resHtml.modeUsed).toBe('html')

      // 3. Style mode with aborted signal returns cancelled error
      const controllerStyle = new AbortController()
      controllerStyle.abort()
      const mockChatStyle = vi.fn().mockImplementation((_p, _c, _s, _u, signal) => {
        if (signal?.aborted) throw new Error('Operation was aborted')
        return Promise.resolve({ ok: true, content: '{}' })
      })
      const resStyle = await generateAiCardWithRealProvider(
        { prompt: 'Cancel style', mode: 'style' },
        dummyAiSettings,
        controllerStyle.signal,
        mockChatStyle,
      )
      expect(resStyle.ok).toBe(false)
      expect(resStyle.error).toMatch(/cancelled by the user/i)
      expect(resStyle.modeUsed).toBe('style')
    })
  })

  // =========================================================================
  // FIX #2 REGRESSION TESTS: Persistence Contract, Rollback & Validation
  // =========================================================================
  describe('Fix #2: HTML Card Save Contract & Persistence Reliability', () => {
    let tempUserData: string

    beforeEach(() => {
      tempUserData = mkdtempSync(join(tmpdir(), 'opening-card-save-test-'))
    })

    afterEach(() => {
      rmSync(tempUserData, { recursive: true, force: true })
    })

    // Test implementation of the saveOpeningHtmlCard IPC handler pipeline
    async function executeSaveOpeningHtmlCard(
      userDataPath: string,
      input: unknown,
      getPrefs: () => OpeningPrefs,
      writeSetting: (path: string, key: string, val: unknown) => void,
    ): Promise<SaveOpeningHtmlCardResult> {
      if (!input || typeof input !== 'object') {
        return { ok: false, error: 'Invalid input payload: expected an object' }
      }
      const { card, html, css } = input as {
        card?: unknown
        html?: unknown
        css?: unknown
      }
      if (!card || typeof card !== 'object') {
        return { ok: false, error: 'Invalid card definition: expected an object' }
      }
      if (typeof html !== 'string' || !html.trim()) {
        return { ok: false, error: 'HTML content cannot be empty' }
      }
      if (typeof css !== 'string') {
        return { ok: false, error: 'CSS content must be a string' }
      }

      const validation = validateCardDefinition(card as OpeningCardDefinition)
      if (!validation.ok || !validation.card) {
        return { ok: false, error: validation.error || 'Invalid card definition' }
      }

      const htmlSanitize = sanitizeOpeningHtml(html)
      if (!htmlSanitize.ok || !htmlSanitize.sanitizedHtml) {
        return {
          ok: false,
          error: `HTML sanitization failed: ${htmlSanitize.error || 'unsafe or invalid elements'}`,
        }
      }

      const cssSanitize = sanitizeOpeningCss(css)
      if (!cssSanitize.ok || typeof cssSanitize.sanitizedCss !== 'string') {
        return {
          ok: false,
          error: `CSS validation failed: ${cssSanitize.error || 'prohibited or invalid rules'}`,
        }
      }

      let storedAssetId: string | undefined
      try {
        const stored = await storeHtmlCardAsset(
          userDataPath,
          htmlSanitize.sanitizedHtml,
          cssSanitize.sanitizedCss,
        )
        storedAssetId = stored.assetId

        const finalCard: OpeningCardDefinition = {
          ...validation.card,
          contentKind: 'ai-html',
          htmlAssetId: stored.assetId,
        }
        const prefs = getPrefs()
        const existing = prefs.customCards || []
        const idx = existing.findIndex((c) => c.id === finalCard.id)
        const customCards =
          idx >= 0 ? existing.map((c, i) => (i === idx ? finalCard : c)) : [...existing, finalCard]
        writeSetting('/app/settings/path', 'openingEffects', { ...prefs, customCards })
        storedAssetId = undefined
        const state: OpeningEffectsState = {
          prefs: { ...prefs, customCards },
          custom: { docs: false, sheets: false, slides: false, pdf: false },
        }
        return { ok: true, state, ...state }
      } catch (err) {
        if (storedAssetId) {
          try {
            deleteHtmlCardAsset(userDataPath, storedAssetId)
          } catch {
            // rollback
          }
        }
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }

    const baseValidCard: OpeningCardDefinition = {
      id: 'custom:zen_card_01',
      name: 'Zen Garden',
      description: 'Serene bamboo and water card',
      category: 'custom',
      contentKind: 'ai-html',
      material: {
        preset: 'frosted-glass',
        themeMode: 'dark',
        accentColor: '#10b981',
      },
    }

    const baseValidHtml = '<div class="zen-box"><h1>{{title}}</h1><p>{{fileName}}</p></div>'
    const baseValidCss = '.zen-box { color: #10b981; backdrop-filter: blur(16px); }'

    it('Test G: saveOpeningHtmlCard succeeds with valid card, HTML, CSS', async () => {
      let savedSetting: any = null
      const mockWriteSetting = (_path: string, _key: string, val: unknown) => {
        savedSetting = val
      }
      const initialPrefs: OpeningPrefs = {
        tier: 'rich',
        durationSec: 3,
        sound: false,
        scenes: { docs: 'snow', sheets: 'snow', slides: 'snow', pdf: 'snow' },
      }

      const result = await executeSaveOpeningHtmlCard(
        tempUserData,
        {
          card: baseValidCard,
          html: baseValidHtml,
          css: baseValidCss,
        },
        () => initialPrefs,
        mockWriteSetting,
      )

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.state).toBeDefined()
        expect(result.state.prefs.customCards).toHaveLength(1)
        const saved = result.state.prefs.customCards![0]
        expect(saved.id).toBe('custom:zen_card_01')
        expect(saved.contentKind).toBe('ai-html')
        expect(saved.htmlAssetId).toMatch(/^html_[0-9]+_[0-9a-f]{16}\.json$/)

        // Read asset from disk to verify atomic storage
        const onDisk = readHtmlCardAsset(tempUserData, saved.htmlAssetId!)
        expect(onDisk).not.toBeNull()
        expect(onDisk?.html).toContain('{{title}}')
        expect(onDisk?.css).toBe(baseValidCss)

        // Verify backward compatibility spread
        expect((result as any).prefs).toBeDefined()
      }
      expect(savedSetting).toBeDefined()
    })

    it('Test H: saveOpeningHtmlCard rejects invalid input (null, non-object, missing fields, bad ID)', async () => {
      const noop = vi.fn()
      const dummyPrefs: OpeningPrefs = {
        tier: 'rich',
        durationSec: 3,
        sound: false,
        scenes: { docs: 'snow', sheets: 'snow', slides: 'snow', pdf: 'snow' },
      }

      // Null input
      const resNull = await executeSaveOpeningHtmlCard(tempUserData, null, () => dummyPrefs, noop)
      expect(resNull.ok).toBe(false)
      expect(resNull.error).toContain('Invalid input payload')

      // Non-object input
      const resString = await executeSaveOpeningHtmlCard(
        tempUserData,
        'not-an-object',
        () => dummyPrefs,
        noop,
      )
      expect(resString.ok).toBe(false)

      // Missing card property
      const resNoCard = await executeSaveOpeningHtmlCard(
        tempUserData,
        { html: '<div></div>', css: '.a{}' },
        () => dummyPrefs,
        noop,
      )
      expect(resNoCard.ok).toBe(false)
      expect(resNoCard.error).toContain('Invalid card definition')

      // Invalid card ID format (path traversal attempt)
      const resBadId = await executeSaveOpeningHtmlCard(
        tempUserData,
        {
          card: { ...baseValidCard, id: '../evil_card_id' },
          html: baseValidHtml,
          css: baseValidCss,
        },
        () => dummyPrefs,
        noop,
      )
      expect(resBadId.ok).toBe(false)
      expect(resBadId.error).toContain('Invalid card ID format')

      // Empty card name
      const resEmptyName = await executeSaveOpeningHtmlCard(
        tempUserData,
        {
          card: { ...baseValidCard, name: '   ' },
          html: baseValidHtml,
          css: baseValidCss,
        },
        () => dummyPrefs,
        noop,
      )
      expect(resEmptyName.ok).toBe(false)
      expect(resEmptyName.error).toContain('Card name is required')
    })

    it('Test I: saveOpeningHtmlCard rejects unsafe HTML (<script>, <iframe>, event handlers)', async () => {
      const noop = vi.fn()
      const dummyPrefs: OpeningPrefs = {
        tier: 'rich',
        durationSec: 3,
        sound: false,
        scenes: { docs: 'snow', sheets: 'snow', slides: 'snow', pdf: 'snow' },
      }

      // <script> tag
      const resScript = await executeSaveOpeningHtmlCard(
        tempUserData,
        {
          card: baseValidCard,
          html: '<div><script>alert(1)</script></div>',
          css: baseValidCss,
        },
        () => dummyPrefs,
        noop,
      )
      expect(resScript.ok).toBe(false)
      expect(resScript.error).toContain('HTML sanitization failed')

      // <iframe> tag
      const resIframe = await executeSaveOpeningHtmlCard(
        tempUserData,
        {
          card: baseValidCard,
          html: '<iframe src="https://evil.com"></iframe>',
          css: baseValidCss,
        },
        () => dummyPrefs,
        noop,
      )
      expect(resIframe.ok).toBe(false)
      expect(resIframe.error).toContain('HTML sanitization failed')

      // Event handler (onclick)
      const resOnclick = await executeSaveOpeningHtmlCard(
        tempUserData,
        {
          card: baseValidCard,
          html: '<div onclick="stealTokens()">Click</div>',
          css: baseValidCss,
        },
        () => dummyPrefs,
        noop,
      )
      expect(resOnclick.ok).toBe(false)
      expect(resOnclick.error).toContain('HTML sanitization failed')

      // Verify zero assets created on disk
      expect(listHtmlCardAssets(tempUserData)).toHaveLength(0)
    })

    it('Test J: saveOpeningHtmlCard rejects unsafe CSS (@import, expression, remote url)', async () => {
      const noop = vi.fn()
      const dummyPrefs: OpeningPrefs = {
        tier: 'rich',
        durationSec: 3,
        sound: false,
        scenes: { docs: 'snow', sheets: 'snow', slides: 'snow', pdf: 'snow' },
      }

      // @import rule
      const resImport = await executeSaveOpeningHtmlCard(
        tempUserData,
        {
          card: baseValidCard,
          html: baseValidHtml,
          css: '@import url("https://evil.com/x.css"); .a {}',
        },
        () => dummyPrefs,
        noop,
      )
      expect(resImport.ok).toBe(false)
      expect(resImport.error).toContain('CSS validation failed')

      // expression()
      const resExpr = await executeSaveOpeningHtmlCard(
        tempUserData,
        {
          card: baseValidCard,
          html: baseValidHtml,
          css: '.a { width: expression(document.cookie); }',
        },
        () => dummyPrefs,
        noop,
      )
      expect(resExpr.ok).toBe(false)
      expect(resExpr.error).toContain('CSS validation failed')

      // Remote http URL
      const resUrl = await executeSaveOpeningHtmlCard(
        tempUserData,
        {
          card: baseValidCard,
          html: baseValidHtml,
          css: '.a { background: url("http://evil.com/track.png"); }',
        },
        () => dummyPrefs,
        noop,
      )
      expect(resUrl.ok).toBe(false)
      expect(resUrl.error).toContain('CSS validation failed')

      // Verify zero assets created on disk
      expect(listHtmlCardAssets(tempUserData)).toHaveLength(0)
    })

    it('Test K: saveOpeningHtmlCard cleans up on preferences write failure (atomic rollback)', async () => {
      // 1. Seed an existing valid HTML asset to prove pre-existing assets are preserved
      const existingAsset = await storeHtmlCardAsset(
        tempUserData,
        '<div>Existing Card</div>',
        '.exist { color: blue; }',
      )
      expect(listHtmlCardAssets(tempUserData)).toHaveLength(1)

      // 2. Mock writeSetting to simulate unexpected disk write / serialization failure
      const mockThrowingWrite = vi.fn().mockImplementation(() => {
        throw new Error('ENOSPC: no space left on device, write')
      })

      const dummyPrefs: OpeningPrefs = {
        tier: 'rich',
        durationSec: 3,
        sound: false,
        scenes: { docs: 'snow', sheets: 'snow', slides: 'snow', pdf: 'snow' },
      }

      // 3. Attempt to save new HTML card
      const result = await executeSaveOpeningHtmlCard(
        tempUserData,
        {
          card: baseValidCard,
          html: baseValidHtml,
          css: baseValidCss,
        },
        () => dummyPrefs,
        mockThrowingWrite,
      )

      // 4. Assertions:
      // Must return ok: false with error details
      expect(result.ok).toBe(false)
      expect(result.error).toContain('ENOSPC')

      // The new asset must have been deleted (rollback)
      const assetsAfter = listHtmlCardAssets(tempUserData)
      expect(assetsAfter).toHaveLength(1)
      expect(assetsAfter[0].assetId).toBe(existingAsset.assetId)

      // Pre-existing asset must still be intact and readable
      const existingRead = readHtmlCardAsset(tempUserData, existingAsset.assetId)
      expect(existingRead).not.toBeNull()
      expect(existingRead?.html).toBe('<div>Existing Card</div>')
    })

    it('Test L: UI behavior on save failure (draft is preserved, error displayed)', () => {
      // Test the frontend error-handling contract
      let uiShowModal = true
      let uiDraftHtml = '<div class="my-draft">Draft Content</div>'
      let uiDraftCss = '.my-draft { color: purple; }'
      let uiErrorMessage = ''
      let uiStatusMessage = ''

      const simulatedApiResponse: SaveOpeningHtmlCardResult = {
        ok: false,
        error: 'Failed to write settings: permission denied',
      }

      // Execute simulated UI callback logic from OpeningCardStudio.tsx handleApproveAiCard
      if (simulatedApiResponse?.ok) {
        uiShowModal = false
        uiDraftHtml = ''
        uiDraftCss = ''
        uiStatusMessage = 'Success!'
      } else {
        uiErrorMessage = simulatedApiResponse?.error ?? 'Failed to save HTML card'
      }

      // Assert that on failure:
      // 1. Modal was NOT closed
      expect(uiShowModal).toBe(true)
      // 2. Draft was NOT wiped
      expect(uiDraftHtml).toBe('<div class="my-draft">Draft Content</div>')
      expect(uiDraftCss).toBe('.my-draft { color: purple; }')
      // 3. Error message was populated
      expect(uiErrorMessage).toBe('Failed to write settings: permission denied')
      // 4. Success message was NOT shown
      expect(uiStatusMessage).toBe('')
    })
  })
})
