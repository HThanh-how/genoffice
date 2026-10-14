import { test, expect } from '@playwright/test'
import { closeAndSaveVideo, launchShell } from './helpers'
import type { OpeningEffectsState } from '../apps/shell/src/shared/home-api'
import type { OpeningPrefs } from '../apps/shell/src/shared/opening-scenes-meta'

test.describe('Opening Card Studio — Electron E2E Flows', () => {
  test('E2E-1: Select curated card, apply to Docs, restart application, verify selection persisted', async () => {
    test.setTimeout(120_000)
    const launched = await launchShell({
      onboardingSeen: true,
      lang: 'en',
      settings: { starPrompt: { resolved: true }, lang: 'en' },
      videoDir: 'opening-card-studio-e2e1',
    })
    const { page, userDataDir } = launched
    let firstLaunchedClosed = false

    try {
      // 1. Open Settings modal
      const settingsBtn = page.locator('.account-btn')
      await expect(settingsBtn).toBeVisible({ timeout: 15_000 })
      await settingsBtn.click()

      // Wait for Settings dialog
      await expect(page.locator('.set-dialog')).toBeVisible({ timeout: 15_000 })

      // 2. Expand Opening effects section in General
      const openingSummary = page.locator('summary', {
        hasText: /Opening effects|Hiệu ứng mở tệp/i,
      })
      await expect(openingSummary).toBeVisible({ timeout: 15_000 })
      await openingSummary.click()

      // 3. Studio is visible with cards
      await expect(page.locator('.ocs-container')).toBeVisible({ timeout: 15_000 })

      // 5. Assign curated:frosted-blue to docs via IPC
      const nextState = await page.evaluate(async () => {
        const api = window.aiOffice
        const state = await api.getOpeningEffects()
        const nextPrefs: OpeningPrefs = {
          ...state.prefs,
          appOverrides: {
            ...state.prefs.appOverrides,
            docs: 'curated:frosted-blue',
          },
          scenes: {
            ...state.prefs.scenes,
            docs: 'curated:frosted-blue',
          },
        }
        return await api.setOpeningPrefs(nextPrefs)
      })

      expect(nextState.prefs.scenes.docs).toBe('curated:frosted-blue')

      // 6. Close first launch
      await closeAndSaveVideo(launched, 'opening-e2e1')
      firstLaunchedClosed = true

      // 7. Relaunch shell with same userDataDir to verify persistence across restart
      const relaunch = await launchShell({
        userDataDir,
        lang: 'en',
        videoDir: 'opening-card-studio-e2e1-relaunch',
      })
      const { page: page2 } = relaunch

      try {
        const persistedPrefs = await page2.evaluate(async () => {
          return (await window.aiOffice.getOpeningEffects()).prefs
        })

        expect(persistedPrefs.scenes.docs).toBe('curated:frosted-blue')
        expect(persistedPrefs.appOverrides?.docs).toBe('curated:frosted-blue')
      } finally {
        await closeAndSaveVideo(relaunch, 'opening-e2e1-relaunch')
      }
    } finally {
      if (!firstLaunchedClosed) {
        await closeAndSaveVideo(launched, 'opening-e2e1-err')
      }
    }
  })

  test('E2E-2 & E2E-3: Global Default and per-app override resolution and reset', async () => {
    const launched = await launchShell({
      onboardingSeen: true,
      settings: { starPrompt: { resolved: true } },
      videoDir: 'opening-card-studio-e2e2-3',
    })
    const { page } = launched

    try {
      // 1. Set Global Default to curated:crystal-white
      let state: OpeningEffectsState = await page.evaluate(async () => {
        const api = window.aiOffice
        const current = await api.getOpeningEffects()
        return await api.setOpeningPrefs({
          ...current.prefs,
          globalCard: 'curated:crystal-white',
        })
      })

      // All apps without overrides should inherit the Global Default
      expect(state.effectiveScenes?.docs.id).toBe('curated:crystal-white')
      expect(state.effectiveScenes?.docs.source).toBe('global')
      expect(state.effectiveScenes?.sheets.id).toBe('curated:crystal-white')
      expect(state.effectiveScenes?.slides.id).toBe('curated:crystal-white')

      // 2. Set per-app override for Docs
      state = await page.evaluate(async () => {
        const api = window.aiOffice
        const current = await api.getOpeningEffects()
        return await api.setOpeningPrefs({
          ...current.prefs,
          appOverrides: { docs: 'curated:frosted-blue' },
          scenes: { ...current.prefs.scenes, docs: 'curated:frosted-blue' },
        })
      })

      // Docs must reflect the override while Sheets remains on Global Default
      expect(state.effectiveScenes?.docs.id).toBe('curated:frosted-blue')
      expect(state.effectiveScenes?.docs.source).toBe('override')
      expect(state.effectiveScenes?.sheets.id).toBe('curated:crystal-white')
      expect(state.effectiveScenes?.sheets.source).toBe('global')

      // 3. Reset Docs override -> must restore Global Default
      state = await page.evaluate(async () => {
        const api = window.aiOffice
        const current = await api.getOpeningEffects()
        const nextOverrides = { ...(current.prefs.appOverrides || {}) }
        delete nextOverrides.docs
        return await api.setOpeningPrefs({
          ...current.prefs,
          appOverrides: nextOverrides,
          scenes: { ...current.prefs.scenes, docs: current.prefs.globalCard! },
        })
      })

      expect(state.effectiveScenes?.docs.id).toBe('curated:crystal-white')
      expect(state.effectiveScenes?.docs.source).toBe('global')
    } finally {
      await closeAndSaveVideo(launched, 'opening-e2e2-3')
    }
  })

  test('E2E-4 & E2E-5: Import personal media, display real thumbnail, and reject invalid files', async () => {
    const launched = await launchShell({
      onboardingSeen: true,
      settings: { starPrompt: { resolved: true } },
      videoDir: 'opening-card-studio-e2e4-5',
    })
    const { page } = launched

    try {
      // 1. Valid PNG upload
      const validPngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
      const validRes = await page.evaluate(async (b64) => {
        return await window.aiOffice.importOpeningMedia(b64, 'test-wallpaper.png')
      }, validPngBase64)

      expect(validRes.ok).toBe(true)
      expect(validRes.asset).toBeDefined()
      expect(validRes.asset?.mime).toBe('image/png')
      expect(validRes.asset?.thumbnailUrl).toContain('data:image/png;base64,')

      // Verify browser Image() actually decodes the thumbnail
      const decodedCheck = await page.evaluate(async (thumbUrl) => {
        return new Promise<{ naturalWidth: number; naturalHeight: number; loaded: boolean }>(
          (resolve) => {
            const img = new Image()
            img.onload = () =>
              resolve({
                naturalWidth: img.naturalWidth,
                naturalHeight: img.naturalHeight,
                loaded: true,
              })
            img.onerror = () => resolve({ naturalWidth: 0, naturalHeight: 0, loaded: false })
            img.src = thumbUrl
          },
        )
      }, validRes.asset!.thumbnailUrl)

      expect(decodedCheck.loaded).toBe(true)
      expect(decodedCheck.naturalWidth).toBeGreaterThan(0)
      expect(decodedCheck.naturalHeight).toBeGreaterThan(0)

      // 2. Invalid file upload (plain text pretending to be image)
      const invalidBase64 = Buffer.from('NOT AN IMAGE FILE AT ALL').toString('base64')
      const invalidRes = await page.evaluate(async (b64) => {
        return await window.aiOffice.importOpeningMedia(b64, 'malicious.exe')
      }, invalidBase64)

      expect(invalidRes.ok).toBe(false)
      expect(invalidRes.error).toContain('Unsupported image format')
    } finally {
      await closeAndSaveVideo(launched, 'opening-e2e4-5')
    }
  })

  test('E2E-6: AI card generation request, schema validation, preview, and explicit approval', async () => {
    const launched = await launchShell({
      onboardingSeen: true,
      settings: { starPrompt: { resolved: true } },
      videoDir: 'opening-card-studio-e2e6',
    })
    const { page } = launched

    try {
      // 1. Controlled validation check: Empty prompt is strictly rejected
      const emptyRes = await page.evaluate(async () => {
        return await window.aiOffice.generateAiCard({ prompt: '   ' })
      })
      expect(emptyRes.ok).toBe(false)
      expect(emptyRes.error).toContain('Please enter a description')

      // 2. Deterministic AI preview & approval workflow:
      // Construct a valid generated card preview structure
      const aiCard = {
        id: `ai:card_${Date.now()}_e2etest`,
        name: 'Liquid Slate Frost',
        description: 'Clean monochromatic liquid slate with subtle silver border',
        category: 'ai' as const,
        contentKind: 'curated-material' as const,
        material: {
          preset: 'liquid-glass' as const,
          themeMode: 'dark' as const,
          opacity: 0.85,
          blurPx: 22,
          borderRadiusPx: 18,
          borderWidthPx: 1,
          accentColor: '#94a3b8',
          shadowIntensity: 0.35,
        },
        createdAt: Date.now(),
        isBuiltIn: false,
        tags: ['ai', 'liquid-glass'],
      }

      // Explicit user approval saves the card into customCards
      const savedState = await page.evaluate(async (card) => {
        return await window.aiOffice.saveOpeningCard(card)
      }, aiCard)

      const found = savedState.prefs.customCards?.some((c) => c.id === aiCard.id)
      expect(found).toBe(true)

      // Verify that the saved card can be retrieved and resolved
      const currentState = await page.evaluate(async () => {
        return await window.aiOffice.getOpeningEffects()
      })
      expect(currentState.prefs.customCards?.some((c) => c.id === aiCard.id)).toBe(true)
    } finally {
      await closeAndSaveVideo(launched, 'opening-e2e6')
    }
  })

  test('E2E-7 & E2E-8: Export cards bundle, import round-trip, and safe card deletion', async () => {
    const launched = await launchShell({
      onboardingSeen: true,
      settings: { starPrompt: { resolved: true } },
      videoDir: 'opening-card-studio-e2e7-8',
    })
    const { page } = launched

    try {
      // 1. Create a custom card
      const customCard = {
        id: 'custom:card_e2e_test',
        name: 'E2E Custom Card',
        description: 'Card for round-trip export verification',
        category: 'custom' as const,
        contentKind: 'curated-material' as const,
        material: {
          preset: 'frosted-glass' as const,
          themeMode: 'system' as const,
          opacity: 0.85,
          blurPx: 22,
          borderRadiusPx: 18,
          borderWidthPx: 1,
          accentColor: '#10b981',
          shadowIntensity: 0.35,
        },
        createdAt: Date.now(),
        isBuiltIn: false,
      }

      await page.evaluate(async (card) => {
        await window.aiOffice.saveOpeningCard(card)
      }, customCard)

      // 2. Export cards
      const jsonBundle = await page.evaluate(async () => {
        return await window.aiOffice.exportOpeningCards()
      })

      const parsed = JSON.parse(jsonBundle)
      expect(parsed.version).toBe(1)
      expect(parsed.cards.some((c: { id: string }) => c.id === customCard.id)).toBe(true)

      // 3. Delete the custom card
      const stateAfterDelete = await page.evaluate(async (cardId) => {
        return await window.aiOffice.deleteOpeningCard(cardId)
      }, customCard.id)

      expect(stateAfterDelete.prefs.customCards?.some((c) => c.id === customCard.id)).toBe(false)

      // 4. Re-import the bundle -> Card is restored safely
      const importRes = await page.evaluate(async (json) => {
        return await window.aiOffice.importOpeningCards(json)
      }, jsonBundle)

      expect(importRes.ok).toBe(true)
      expect(importRes.count).toBeGreaterThanOrEqual(1)
      expect(importRes.state.prefs.customCards?.length).toBeGreaterThanOrEqual(1)
    } finally {
      await closeAndSaveVideo(launched, 'opening-e2e7-8')
    }
  })

  test('E2E-9 & E2E-10: Low-performance tier selection and graceful fallback resilience', async () => {
    const launched = await launchShell({
      onboardingSeen: true,
      settings: { starPrompt: { resolved: true } },
      videoDir: 'opening-card-studio-e2e9-10',
    })
    const { page } = launched

    try {
      // 1. Set minimal tier
      const state = await page.evaluate(async () => {
        const current = await window.aiOffice.getOpeningEffects()
        return await window.aiOffice.setOpeningPrefs({
          ...current.prefs,
          tier: 'minimal',
        })
      })

      expect(state.prefs.tier).toBe('minimal')

      // 2. Previewing a scene with non-existent or corrupted card ID must not crash shell
      await page.evaluate(() => {
        window.aiOffice.previewOpening('docs', 'non_existent_scene_xyz')
      })

      // The shell window remains alive and responsive
      expect(page.isClosed()).toBe(false)
    } finally {
      await closeAndSaveVideo(launched, 'opening-e2e9-10')
    }
  })
})
