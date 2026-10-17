// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import runGOScene from '../src/shared/opening-scenes-runner'
import { sniffImageSignature, MAX_MEDIA_ASSET_BYTES } from '../src/main/fork/opening-media-storage'
import { sampleFileName } from '../src/main/fork/opening-window'
import {
  buildMaterialCss,
  sanitizeHexColor,
  sanitizeBorderColor,
  hexToRgb,
} from '../src/shared/opening-card-css'
import { OPENING_APPS, type OpeningApp } from '../src/shared/opening-scenes-meta'
import { getAllBuiltInCards } from '../src/shared/opening-card-families'

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
})
