// @vitest-environment jsdom
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import runGOScene from '../src/shared/opening-scenes-runner'
import * as mediaStorage from '../src/main/fork/opening-media-storage'
import {
  sniffImageSignature,
  MAX_MEDIA_ASSET_BYTES,
  listMediaAssets,
  resolveSafeAssetPath,
  storeMediaAssetFromBuffer,
} from '../src/main/fork/opening-media-storage'
import * as htmlStorage from '../src/main/fork/opening-html-storage'
import {
  listHtmlCardAssets,
  readHtmlCardAsset,
  storeHtmlCardAsset,
} from '../src/main/fork/opening-html-storage'
import { importCardsFromExportBundle } from '../src/main/fork/opening-card-export'
import { sampleFileName } from '../src/main/fork/opening-window'
import {
  buildMaterialCss,
  sanitizeHexColor,
  sanitizeBorderColor,
  hexToRgb,
} from '../src/shared/opening-card-css'
import {
  OPENING_APPS,
  type OpeningApp,
  CUSTOM_SCENE,
  DEFAULT_SCENE_FOR_APP,
  isCardOrSceneAvailable,
  normalizeOpeningPrefs,
  type OpeningPrefs,
} from '../src/shared/opening-scenes-meta'
import { getAllBuiltInCards } from '../src/shared/opening-card-families'
import type { OpeningCardDefinition } from '../src/shared/opening-card-types'

describe('Opening Card Studio V2 - Unit Tests', () => {
  describe('sampleFileName', () => {
    it('returns appropriate file extension and localized name for all apps', () => {
      const expectedEn: Record<OpeningApp, { name: string; ext: string }> = {
        docs: { name: 'My document.docx', ext: '.docx' },
        sheets: { name: 'My spreadsheet.xlsx', ext: '.xlsx' },
        slides: { name: 'My presentation.pptx', ext: '.pptx' },
        pdf: { name: 'Document.pdf', ext: '.pdf' },
        markdown: { name: 'Notes.md', ext: '.md' },
        html: { name: 'Page.html', ext: '.html' },
      }

      const expectedVi: Record<OpeningApp, { name: string; ext: string }> = {
        docs: { name: 'Tài liệu của tôi.docx', ext: '.docx' },
        sheets: { name: 'Bảng tính của tôi.xlsx', ext: '.xlsx' },
        slides: { name: 'Bản trình chiếu của tôi.pptx', ext: '.pptx' },
        pdf: { name: 'Tài liệu PDF.pdf', ext: '.pdf' },
        markdown: { name: 'Ghi chú.md', ext: '.md' },
        html: { name: 'Trang web.html', ext: '.html' },
      }

      for (const app of OPENING_APPS) {
        const en = sampleFileName(app, 'en')
        expect(en).toBe(expectedEn[app].name)
        expect(en.endsWith(expectedEn[app].ext)).toBe(true)

        const vi = sampleFileName(app, 'vi')
        expect(vi).toBe(expectedVi[app].name)
        expect(vi.endsWith(expectedVi[app].ext)).toBe(true)
      }
    })

    it('falls back safely for unknown apps', () => {
      // @ts-expect-error Testing runtime fallback
      expect(sampleFileName('unknown', 'en')).toBe('My document.docx')
      // @ts-expect-error Testing runtime fallback
      expect(sampleFileName('unknown', 'vi')).toBe('Tài liệu của tôi.docx')
    })
  })

  describe('buildMaterialCss in shared', () => {
    it('produces calibrated inlineCss for frosted-glass preset', () => {
      const css = buildMaterialCss({
        preset: 'frosted-glass',
        themeMode: 'dark',
        opacity: 0.85,
        blurPx: 22,
        borderRadiusPx: 18,
        shadowIntensity: 0.35,
        accentColor: '#2b7cd3',
      })

      expect(css.backdropFilter).toContain('blur(22px)')
      expect(css.borderRadius).toBe('18px')
      expect(css.accentColor).toBe('#2b7cd3')
      expect(css.inlineCss).toContain('--card-accent: #2b7cd3')
      expect(css.inlineCss).toContain('backdrop-filter:')
    })

    it('sanitizes colors and clamps bounds correctly', () => {
      expect(sanitizeHexColor('invalid')).toBe('#2b7cd3')
      expect(sanitizeHexColor('#abc')).toBe('#abc')
      expect(sanitizeHexColor('#123456')).toBe('#123456')

      expect(sanitizeBorderColor('invalid', 'fallback')).toBe('fallback')
      expect(sanitizeBorderColor('rgba(255, 255, 255, 0.5)', 'fallback')).toBe(
        'rgba(255, 255, 255, 0.5)',
      )

      const rgb = hexToRgb('#2b7cd3')
      expect(rgb).toEqual({ r: 43, g: 124, b: 211 })
    })

    it('handles reduceTransparency mode cleanly', () => {
      const css = buildMaterialCss({
        preset: 'frosted-glass',
        themeMode: 'dark',
        reduceTransparency: true,
      })
      expect(css.backdropFilter).toBe('none')
    })

    it('gracefully handles undefined or empty config without throwing', () => {
      const undefinedResult = buildMaterialCss(undefined)
      expect(undefinedResult.background).toBeDefined()
      expect(undefinedResult.border).toBeDefined()
      expect(undefinedResult.borderRadius).toBe('18px')

      const emptyResult = buildMaterialCss({} as any)
      expect(emptyResult.background).toBeDefined()
      expect(emptyResult.border).toBeDefined()
    })
  })

  describe('Built-in Card Library', () => {
    it('provides curated cards with valid categories and contentKinds', () => {
      const cards = getAllBuiltInCards()
      expect(cards.length).toBeGreaterThan(30)

      for (const card of cards) {
        expect(card.id).toBeTruthy()
        expect(card.name).toBeTruthy()
        expect(card.isBuiltIn).toBe(true)
        expect([
          'canvas-scene',
          'curated-material',
          'personal-media',
          'ai-declarative',
          'custom-html',
          'ai-html',
        ]).toContain(card.contentKind)
      }
    })
  })

  describe('runGOScene - Canvas Scene Runner', () => {
    beforeEach(() => {
      if (typeof globalThis.requestAnimationFrame === 'undefined') {
        vi.stubGlobal('requestAnimationFrame', vi.fn().mockReturnValue(1))
      }
      if (typeof globalThis.cancelAnimationFrame === 'undefined') {
        vi.stubGlobal('cancelAnimationFrame', vi.fn())
      }
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    function createMockCanvas(width = 800, height = 600) {
      const gradient = {
        addColorStop: vi.fn(),
      }
      const ctx = {
        clearRect: vi.fn(),
        fillRect: vi.fn(),
        beginPath: vi.fn(),
        closePath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        translate: vi.fn(),
        rotate: vi.fn(),
        scale: vi.fn(),
        createLinearGradient: vi.fn(() => gradient),
        createRadialGradient: vi.fn(() => gradient),
        fillStyle: '#000',
        strokeStyle: '#000',
        lineWidth: 1,
        globalAlpha: 1,
        setTransform: vi.fn(),
        resetTransform: vi.fn(),
      }
      const canvas = {
        width,
        height,
        clientWidth: width,
        clientHeight: height,
        getContext: vi.fn((type: string) => (type === '2d' ? ctx : null)),
        getBoundingClientRect: vi.fn(() => ({
          width,
          height,
          top: 0,
          left: 0,
          bottom: height,
          right: width,
        })),
      } as unknown as HTMLCanvasElement

      return { canvas, ctx, gradient }
    }

    it('initializes with a mock 2D context, starts RAF, registers visibilitychange listener, and returns a cleanup function', () => {
      const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(42)
      const cancelRafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame')
      const addDocSpy = vi.spyOn(document, 'addEventListener')
      const removeDocSpy = vi.spyOn(document, 'removeEventListener')

      const { canvas } = createMockCanvas()
      const cleanup = runGOScene(canvas, 'ocean')

      expect(canvas.getContext).toHaveBeenCalledWith('2d')
      expect(typeof cleanup).toBe('function')
      expect(rafSpy).toHaveBeenCalled()
      expect(addDocSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))

      cleanup()

      expect(cancelRafSpy).toHaveBeenCalled()
      expect(removeDocSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))

      rafSpy.mockRestore()
      cancelRafSpy.mockRestore()
      addDocSpy.mockRestore()
      removeDocSpy.mockRestore()
    })

    it('does not call Function constructor or eval (strict CSP compliance)', () => {
      const originalFunction = globalThis.Function
      let functionCalled = false
      const functionProxy = new Proxy(originalFunction, {
        apply(target, thisArg, args) {
          functionCalled = true
          return Reflect.apply(target, thisArg, args)
        },
        construct(target, args, newTarget) {
          functionCalled = true
          return Reflect.construct(target, args, newTarget)
        },
      })

      const originalEval = (globalThis as any).eval
      let evalCalled = false
      const mockEval = vi.fn((...args: any[]) => {
        evalCalled = true
        return typeof originalEval === 'function' ? originalEval(...args) : undefined
      })

      const { canvas } = createMockCanvas()
      const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(1)
      const cancelRafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame')

      let cleanup: (() => void) | undefined
      try {
        globalThis.Function = functionProxy as any
        ;(globalThis as any).eval = mockEval

        cleanup = runGOScene(canvas, 'ocean')
      } finally {
        globalThis.Function = originalFunction
        ;(globalThis as any).eval = originalEval
        rafSpy.mockRestore()
        cancelRafSpy.mockRestore()
      }

      expect(functionCalled).toBe(false)
      expect(evalCalled).toBe(false)
      expect(typeof cleanup).toBe('function')
      cleanup?.()
    })

    it('falls back safely to default ocean scene for unknown sceneId without throwing', () => {
      const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(1)
      const cancelRafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame')

      try {
        const { canvas } = createMockCanvas()
        let cleanup: (() => void) | undefined

        expect(() => {
          cleanup = runGOScene(canvas, 'non-existent-custom-scene-id-12345')
        }).not.toThrow()

        expect(typeof cleanup).toBe('function')
        expect(canvas.getContext).toHaveBeenCalledWith('2d')

        cleanup?.()
      } finally {
        rafSpy.mockRestore()
        cancelRafSpy.mockRestore()
      }
    })
  })

  describe('Media Import Constraints & Mime Type Validation', () => {
    it('enforces MAX_MEDIA_ASSET_BYTES to equal exactly 10 MB', () => {
      expect(MAX_MEDIA_ASSET_BYTES).toBe(10 * 1024 * 1024)
    })

    it('correctly identifies PNG, JPEG, WebP, and GIF magic byte buffers', () => {
      const pngBuffer = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      ])
      const png = sniffImageSignature(pngBuffer)
      expect(png).not.toBeNull()
      expect(png?.mime).toBe('image/png')
      expect(['png', '.png']).toContain(png?.ext)

      const jpegBuffer = Buffer.from([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
      ])
      const jpeg = sniffImageSignature(jpegBuffer)
      expect(jpeg).not.toBeNull()
      expect(jpeg?.mime).toBe('image/jpeg')
      expect(['jpg', 'jpeg', '.jpg', '.jpeg']).toContain(jpeg?.ext)

      const webpBuffer = Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      ])
      const webp = sniffImageSignature(webpBuffer)
      expect(webp).not.toBeNull()
      expect(webp?.mime).toBe('image/webp')
      expect(['webp', '.webp']).toContain(webp?.ext)

      const gifBuffer = Buffer.from([
        0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x0a, 0x00, 0x0a, 0x00, 0x80, 0x00,
      ])
      const gif = sniffImageSignature(gifBuffer)
      expect(gif).not.toBeNull()
      expect(gif?.mime).toBe('image/gif')
      expect(['gif', '.gif']).toContain(gif?.ext)
    })

    it('rejects SVG, MP4, short (<12 bytes), and empty buffers with null', () => {
      const svgBuffer = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>',
      )
      expect(sniffImageSignature(svgBuffer)).toBeNull()

      const mp4Buffer = Buffer.from([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
      ])
      expect(sniffImageSignature(mp4Buffer)).toBeNull()

      const shortBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47])
      expect(sniffImageSignature(shortBuffer)).toBeNull()

      const emptyBuffer = Buffer.alloc(0)
      expect(sniffImageSignature(emptyBuffer)).toBeNull()
    })
  })

  describe('importCardsFromExportBundle — Data Integrity & Asset Lifecycle', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'genoffice-import-card-test-'))
    })

    afterEach(() => {
      vi.restoreAllMocks()
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {}
    })

    const VALID_PNG_BASE64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const VALID_PNG_DATA_URL = `data:image/png;base64,${VALID_PNG_BASE64}`

    const createValidCard = (
      overrides?: Partial<OpeningCardDefinition>,
    ): OpeningCardDefinition => ({
      id: 'custom:card_default_test',
      name: 'Studio Test Card',
      category: 'custom',
      contentKind: 'curated-material',
      material: {
        preset: 'frosted-glass',
        themeMode: 'system',
        opacity: 0.85,
        blurPx: 20,
        borderRadiusPx: 16,
        accentColor: '#2b7cd3',
      },
      createdAt: 1700000000000,
      isBuiltIn: false,
      ...overrides,
    })

    it('Invariant A1: tracks newly allocated media and HTML assets and remaps them to imported cards', async () => {
      const card: OpeningCardDefinition = createValidCard({
        id: 'custom:card_with_bundle_assets',
        mediaAssetId: 'bundle_asset_media_1',
        htmlAssetId: 'bundle_asset_html_1',
        contentKind: 'custom-html',
      })

      const bundle = {
        version: 1,
        cards: [card],
        assets: [
          {
            assetId: 'bundle_asset_media_1',
            mime: 'image/png',
            dataUrl: VALID_PNG_DATA_URL,
          },
        ],
        htmlAssets: [
          {
            assetId: 'bundle_asset_html_1',
            html: '<div class="banner">Hello Asset</div>',
            css: '.banner { color: #ffffff; }',
          },
        ],
      }

      const res = await importCardsFromExportBundle(JSON.stringify(bundle), tmpDir, [])
      expect(res.ok).toBe(true)
      expect(res.count).toBe(1)
      expect(res.newlyCreatedMediaAssetIds).toHaveLength(1)
      expect(res.newlyCreatedHtmlAssetIds).toHaveLength(1)

      const newMediaId = res.newlyCreatedMediaAssetIds[0]
      const newHtmlId = res.newlyCreatedHtmlAssetIds[0]
      expect(newMediaId).not.toBe('bundle_asset_media_1')
      expect(newHtmlId).not.toBe('bundle_asset_html_1')

      const imported = res.importedCards[0]
      expect(imported.mediaAssetId).toBe(newMediaId)
      expect(imported.htmlAssetId).toBe(newHtmlId)

      expect(existsSync(resolveSafeAssetPath(tmpDir, newMediaId))).toBe(true)
      const storedHtml = readHtmlCardAsset(tmpDir, newHtmlId)
      expect(storedHtml).not.toBeNull()
      expect(storedHtml?.html).toBe('<div class="banner">Hello Asset</div>')
    })

    it('Invariant A2: rolls back newly created media and HTML assets on write failure and returns empty ID arrays', async () => {
      const card: OpeningCardDefinition = createValidCard({
        id: 'custom:rollback_card',
        mediaAssetId: 'media_rollback_1',
        htmlAssetId: 'html_rollback_1',
        contentKind: 'custom-html',
      })

      const bundle = {
        version: 1,
        cards: [card],
        assets: [
          {
            assetId: 'media_rollback_1',
            mime: 'image/png',
            dataUrl: VALID_PNG_DATA_URL,
          },
        ],
        htmlAssets: [
          {
            assetId: 'html_rollback_1',
            html: '<p>Will fail</p>',
            css: 'p { margin: 0; }',
          },
        ],
      }

      const htmlSpy = vi
        .spyOn(htmlStorage, 'storeHtmlCardAsset')
        .mockRejectedValueOnce(new Error('Simulated atomic write failure for HTML asset'))

      const res = await importCardsFromExportBundle(JSON.stringify(bundle), tmpDir, [])
      htmlSpy.mockRestore()

      expect(res.ok).toBe(false)
      expect(res.importedCards).toEqual([])
      expect(res.count).toBe(0)
      expect(res.newlyCreatedMediaAssetIds).toEqual([])
      expect(res.newlyCreatedHtmlAssetIds).toEqual([])
      expect(res.error).toContain(
        'Asset import failed: Simulated atomic write failure for HTML asset',
      )

      expect(listMediaAssets(tmpDir)).toEqual([])
      expect(listHtmlCardAssets(tmpDir)).toEqual([])
    })

    it('Invariant A2: rolls back earlier media files when a subsequent media asset write fails', async () => {
      const card1 = createValidCard({ id: 'custom:m1', mediaAssetId: 'media_first' })
      const card2 = createValidCard({ id: 'custom:m2', mediaAssetId: 'media_second' })

      const bundle = {
        version: 1,
        cards: [card1, card2],
        assets: [
          { assetId: 'media_first', mime: 'image/png', dataUrl: VALID_PNG_DATA_URL },
          { assetId: 'media_second', mime: 'image/png', dataUrl: VALID_PNG_DATA_URL },
        ],
      }

      const mediaSpy = vi
        .spyOn(mediaStorage, 'storeMediaAssetFromBuffer')
        .mockImplementationOnce((dir, buf) => mediaStorage.storeMediaAssetFromBuffer(dir, buf))
        .mockRejectedValueOnce(new Error('Disk full during second media write'))

      const res = await importCardsFromExportBundle(JSON.stringify(bundle), tmpDir, [])
      mediaSpy.mockRestore()

      expect(res.ok).toBe(false)
      expect(res.newlyCreatedMediaAssetIds).toEqual([])
      expect(res.newlyCreatedHtmlAssetIds).toEqual([])
      expect(res.error).toContain('Disk full during second media write')
      expect(listMediaAssets(tmpDir)).toEqual([])
    })

    it('Invariant A3: strips un-embedded mediaAssetId and htmlAssetId references that do not exist on disk', async () => {
      const cardWithDangling: OpeningCardDefinition = createValidCard({
        id: 'custom:dangling_assets_card',
        mediaAssetId: 'asset_1700000000000_1111222233334444.png',
        htmlAssetId: 'html_1700000000000_5555666677778888.json',
      })

      const bundle = {
        version: 1,
        cards: [cardWithDangling],
      }

      const res = await importCardsFromExportBundle(JSON.stringify(bundle), tmpDir, [])
      expect(res.ok).toBe(true)
      expect(res.count).toBe(1)
      const imported = res.importedCards[0]
      expect(imported.mediaAssetId).toBeUndefined()
      expect(imported.htmlAssetId).toBeUndefined()
    })

    it('Invariant A3: preserves un-embedded references if the referenced asset file already exists on disk', async () => {
      const validPngBuf = Buffer.from(VALID_PNG_BASE64, 'base64')
      const existingMedia = await storeMediaAssetFromBuffer(tmpDir, validPngBuf)
      const existingHtml = await storeHtmlCardAsset(
        tmpDir,
        '<div>Local</div>',
        'div { color: #000; }',
      )

      const cardWithExisting: OpeningCardDefinition = createValidCard({
        id: 'custom:existing_local_refs',
        mediaAssetId: existingMedia.assetId,
        htmlAssetId: existingHtml.assetId,
      })

      const bundle = {
        version: 1,
        cards: [cardWithExisting],
      }

      const res = await importCardsFromExportBundle(JSON.stringify(bundle), tmpDir, [])
      expect(res.ok).toBe(true)
      expect(res.count).toBe(1)
      const imported = res.importedCards[0]
      expect(imported.mediaAssetId).toBe(existingMedia.assetId)
      expect(imported.htmlAssetId).toBe(existingHtml.assetId)
    })

    it('Invariant A4: disambiguates ID collisions with existing custom cards, built-in cards, and intra-bundle duplicates', async () => {
      const existingCustom = createValidCard({
        id: 'custom:existing_user_card',
        name: 'Existing Card',
      })

      const collisionExisting = createValidCard({
        id: 'custom:existing_user_card',
        name: 'Collision With Existing',
      })
      const collisionCurated = createValidCard({
        id: 'curated:frosted-blue',
        name: 'Collision With Curated',
      })
      const collisionCanvasScene = createValidCard({
        id: 'ocean',
        name: 'Collision With Scene',
      })
      const intraDupe1 = createValidCard({
        id: 'custom:intra_bundle_dupe',
        name: 'Intra Dupe 1',
      })
      const intraDupe2 = createValidCard({
        id: 'custom:intra_bundle_dupe',
        name: 'Intra Dupe 2',
      })

      const bundle = {
        version: 1,
        cards: [collisionExisting, collisionCurated, collisionCanvasScene, intraDupe1, intraDupe2],
      }

      const res = await importCardsFromExportBundle(JSON.stringify(bundle), tmpDir, [
        existingCustom,
      ])
      expect(res.ok).toBe(true)
      expect(res.count).toBe(5)

      const ids = res.importedCards.map((c) => c.id)
      expect(new Set(ids).size).toBe(5)

      expect(ids[0]).not.toBe('custom:existing_user_card')
      expect(ids[0].startsWith('custom:imported_')).toBe(true)

      expect(ids[1]).not.toBe('curated:frosted-blue')
      expect(ids[1].startsWith('custom:imported_')).toBe(true)

      expect(ids[2]).not.toBe('ocean')
      expect(ids[2].startsWith('custom:imported_')).toBe(true)

      expect(ids[3]).toBe('custom:intra_bundle_dupe')
      expect(ids[4]).not.toBe('custom:intra_bundle_dupe')
      expect(ids[4].startsWith('custom:imported_')).toBe(true)
    })
  })

  describe('normalizeOpeningPrefs & isCardOrSceneAvailable — Data Integrity & Security Normalization', () => {
    const createValidCustomCard = (
      id: string,
      name = 'Test Custom Card',
    ): OpeningCardDefinition => ({
      id,
      name,
      category: 'custom',
      contentKind: 'curated-material',
      material: {
        preset: 'solid',
        themeMode: 'system',
        opacity: 0.9,
      },
      createdAt: 1700000000000,
      isBuiltIn: false,
    })

    it('Invariant B1: isCardOrSceneAvailable accepts built-in curated cards, built-in canvas scenes, and custom scene', () => {
      expect(isCardOrSceneAvailable('curated:frosted-blue')).toBe(true)
      expect(isCardOrSceneAvailable('curated:midnight-glass')).toBe(true)
      expect(isCardOrSceneAvailable('curated:crystal-white')).toBe(true)

      expect(isCardOrSceneAvailable('ocean')).toBe(true)
      expect(isCardOrSceneAvailable('waves')).toBe(true)
      expect(isCardOrSceneAvailable('aurora')).toBe(true)
      expect(isCardOrSceneAvailable('snow')).toBe(true)

      expect(isCardOrSceneAvailable(CUSTOM_SCENE)).toBe(true)
      expect(isCardOrSceneAvailable('custom')).toBe(true)
    })

    it('Invariant B2: isCardOrSceneAvailable rejects non-existent curated IDs, invalid types, and unlisted custom IDs', () => {
      expect(isCardOrSceneAvailable('curated:fake')).toBe(false)
      expect(isCardOrSceneAvailable('curated:non-existent')).toBe(false)

      expect(isCardOrSceneAvailable('custom:non-existent-1')).toBe(false)
      expect(
        isCardOrSceneAvailable('custom:card-123', {
          enabled: true,
          tier: 'auto',
          scenes: DEFAULT_SCENE_FOR_APP,
          customCards: [],
        }),
      ).toBe(false)

      const registeredCard = createValidCustomCard('custom:registered-card')
      const prefsWithCard: OpeningPrefs = {
        enabled: true,
        tier: 'auto',
        scenes: DEFAULT_SCENE_FOR_APP,
        customCards: [registeredCard],
      }
      expect(isCardOrSceneAvailable('custom:unregistered-card', prefsWithCard)).toBe(false)
      expect(isCardOrSceneAvailable('custom:registered-card', prefsWithCard)).toBe(true)

      expect(isCardOrSceneAvailable('')).toBe(false)
      expect(isCardOrSceneAvailable(null)).toBe(false)
      expect(isCardOrSceneAvailable(undefined)).toBe(false)
      expect(isCardOrSceneAvailable(12345)).toBe(false)
      expect(isCardOrSceneAvailable({})).toBe(false)
    })

    it('Invariant B3: parses customCards first and preserves valid globalCard, appOverrides, scenes, and favorites', () => {
      const validCard = createValidCustomCard('custom:user-palette')
      const input = {
        customCards: [validCard],
        globalCard: 'custom:user-palette',
        appOverrides: {
          docs: 'custom:user-palette',
          sheets: 'inherit',
          slides: 'curated:frosted-blue',
        },
        scenes: {
          docs: 'custom:user-palette',
          markdown: 'ocean',
        },
        favorites: ['custom:user-palette', 'curated:frosted-blue', 'snow'],
      }

      const normalized = normalizeOpeningPrefs(input)
      expect(normalized.customCards).toEqual([validCard])
      expect(normalized.globalCard).toBe('custom:user-palette')
      expect(normalized.appOverrides).toEqual({
        docs: 'custom:user-palette',
        sheets: 'inherit',
        slides: 'curated:frosted-blue',
      })
      expect(normalized.scenes.docs).toBe('custom:user-palette')
      expect(normalized.scenes.markdown).toBe('ocean')
      expect(normalized.favorites).toEqual(['custom:user-palette', 'curated:frosted-blue', 'snow'])
    })

    it('Invariant B3: strips orphaned globalCard and appOverrides, falling back scenes to defaults and pruning favorites', () => {
      const input = {
        customCards: [],
        globalCard: 'custom:orphaned-global',
        appOverrides: {
          docs: 'custom:orphaned-override',
          sheets: 'inherit',
          slides: 'curated:frosted-blue',
        },
        scenes: {
          docs: 'custom:orphaned-scene',
          sheets: 'curated:frosted-blue',
        },
        favorites: ['custom:orphaned-fav', 'curated:frosted-blue', 'waves'],
      }

      const normalized = normalizeOpeningPrefs(input)

      expect(normalized.globalCard).toBeUndefined()
      expect(normalized.appOverrides).toEqual({
        sheets: 'inherit',
        slides: 'curated:frosted-blue',
      })
      expect(normalized.scenes.docs).toBe(DEFAULT_SCENE_FOR_APP.docs)
      expect(normalized.scenes.sheets).toBe('curated:frosted-blue')
      expect(normalized.favorites).toEqual(['curated:frosted-blue', 'waves'])
    })

    it('Invariant B3: omits appOverrides entirely if all entries are orphaned', () => {
      const normalized = normalizeOpeningPrefs({
        customCards: [],
        appOverrides: {
          docs: 'custom:orphaned-1',
          sheets: 'custom:orphaned-2',
        },
      })
      expect(normalized.appOverrides).toBeUndefined()
    })

    it('Invariant B4: isSafeCardDefinition rejects cards with script tags or forbidden code patterns in card names', () => {
      const xssScriptCard = {
        id: 'custom:xss_script',
        name: '<script>alert("pwned")</script>',
        material: { preset: 'solid' },
      }
      const xssJsCard = {
        id: 'custom:xss_js',
        name: 'Cool Card javascript:steal()',
        material: { preset: 'solid' },
      }
      const xssEventCard = {
        id: 'custom:xss_event',
        name: 'Logo <img src=x onerror=alert(1)>',
        material: { preset: 'solid' },
      }
      const xssClosingCard = {
        id: 'custom:xss_close',
        name: 'Panel </div> Inject',
        material: { preset: 'solid' },
      }
      const xssEvalCard = {
        id: 'custom:xss_eval',
        name: 'Dynamic eval(bad())',
        material: { preset: 'solid' },
      }
      const xssExprCard = {
        id: 'custom:xss_expr',
        name: 'Style expression(bad())',
        material: { preset: 'solid' },
      }
      const validCard = createValidCustomCard('custom:safe_card', 'Clean Card Name')

      const normalized = normalizeOpeningPrefs({
        customCards: [
          xssScriptCard,
          xssJsCard,
          xssEventCard,
          xssClosingCard,
          xssEvalCard,
          xssExprCard,
          validCard,
        ],
        globalCard: 'custom:xss_script',
        favorites: ['custom:xss_script', 'custom:safe_card'],
      })

      expect(normalized.customCards).toHaveLength(1)
      expect(normalized.customCards?.[0].id).toBe('custom:safe_card')
      expect(normalized.globalCard).toBeUndefined()
      expect(normalized.favorites).toEqual(['custom:safe_card'])
    })

    it('Invariant B4: isSafeCardDefinition rejects structural card anomalies (empty/long name, invalid ID, missing material)', () => {
      const invalidAnomalies = [
        { id: '', name: 'Empty ID', material: { preset: 'solid' } },
        { id: 'custom:' + 'x'.repeat(101), name: 'Overlong ID', material: { preset: 'solid' } },
        { id: 'custom:empty_name', name: '', material: { preset: 'solid' } },
        { id: 'custom:long_name', name: 'N'.repeat(61), material: { preset: 'solid' } },
        { id: 'custom:null_mat', name: 'Null Material', material: null },
        { id: 'custom:array_mat', name: 'Array Material', material: [1, 2] },
        { id: 'custom:primitive_mat', name: 'Primitive Material', material: 'not-an-object' },
        null,
        'not a card object',
        12345,
      ]

      const normalized = normalizeOpeningPrefs({
        customCards: invalidAnomalies,
      })

      expect(normalized.customCards).toBeUndefined()
    })
  })
})
