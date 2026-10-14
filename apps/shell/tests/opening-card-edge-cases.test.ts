import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OPENING_PREFS,
  DEFAULT_SCENE_FOR_APP,
  knownSceneOrCard,
  normalizeOpeningPrefs,
} from '../src/shared/opening-scenes-meta'
import { buildMaterialCss, sanitizeBorderColor } from '../src/main/fork/opening-card-css'
import {
  isSafeAssetId,
  resolveSafeAssetPath,
  sniffImageSignature,
  storeMediaAssetFromBuffer,
  deleteMediaAsset,
  MAX_MEDIA_ASSET_BYTES,
} from '../src/main/fork/opening-media-storage'
import { parseAiJsonPayload, validateAiCardSchema } from '../src/main/fork/opening-card-ai'
import { customPageHtml, openingPageHtml } from '../src/main/fork/opening-window'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('Opening Card Studio — Exotic Edge Cases & Security', () => {
  describe('Preferences Normalization Edge Cases', () => {
    it('handles primitive, null, undefined, or array inputs safely', () => {
      expect(normalizeOpeningPrefs(null)).toEqual(DEFAULT_OPENING_PREFS)
      expect(normalizeOpeningPrefs(undefined)).toEqual(DEFAULT_OPENING_PREFS)
      expect(normalizeOpeningPrefs('string')).toEqual(DEFAULT_OPENING_PREFS)
      expect(normalizeOpeningPrefs(42)).toEqual(DEFAULT_OPENING_PREFS)
      expect(normalizeOpeningPrefs([])).toEqual(DEFAULT_OPENING_PREFS)
      expect(normalizeOpeningPrefs(true)).toEqual(DEFAULT_OPENING_PREFS)
    })

    it('neutralizes prototype pollution attempts and malformed scene objects', () => {
      const maliciousJson =
        '{"__proto__": {"polluted": true}, "scenes": {"docs": "polluted", "sheets": "<script>alert(1)</script>"}}'
      const parsed = JSON.parse(maliciousJson)
      const normalized = normalizeOpeningPrefs(parsed)

      // Object prototype must not be polluted
      expect((Object.prototype as unknown as { polluted?: boolean }).polluted).toBeUndefined()
      // Invalid scene IDs must fall back to default app scenes
      expect(normalized.scenes.docs).toBe(DEFAULT_SCENE_FOR_APP.docs)
      expect(normalized.scenes.sheets).toBe(DEFAULT_SCENE_FOR_APP.sheets)
    })

    it('recognizes ai: and custom: card IDs but drops unauthorized or empty strings', () => {
      expect(knownSceneOrCard('ai:card_123_abc')).toBe(true)
      expect(knownSceneOrCard('custom:user_card_1')).toBe(true)
      expect(knownSceneOrCard('custom')).toBe(true)
      expect(knownSceneOrCard('snow')).toBe(true)
      expect(knownSceneOrCard('curated:frosted-blue')).toBe(true)

      expect(knownSceneOrCard('')).toBe(false)
      expect(knownSceneOrCard(null)).toBe(false)
      expect(knownSceneOrCard(123)).toBe(false)
      expect(knownSceneOrCard('unknown-random-scene-xyz')).toBe(false)

      const prefWithAi = normalizeOpeningPrefs({
        globalCard: 'ai:card_999_xyz',
      })
      expect(prefWithAi.globalCard).toBe('ai:card_999_xyz')

      const prefWithInvalid = normalizeOpeningPrefs({
        globalCard: 'malicious-card-id',
      })
      expect(prefWithInvalid.globalCard).toBeUndefined()
    })

    it('deduplicates and cleans favorites array', () => {
      const raw = {
        favorites: ['snow', 'snow', '', null, 123, 'curated:frosted-blue', 'snow', 'ai:card_1'],
      }
      const normalized = normalizeOpeningPrefs(raw)
      expect(normalized.favorites).toEqual(['snow', 'curated:frosted-blue', 'ai:card_1'])
    })

    it('sanitizes customCards array and filters out corrupt definitions', () => {
      const raw = {
        customCards: [
          null,
          undefined,
          'not-an-object',
          { id: '', name: 'Empty ID', material: {} },
          { id: 'too-long-id'.repeat(20), name: 'Long ID', material: {} },
          { id: 'valid_id', name: '', material: {} },
          { id: 'valid_id_2', name: 'Valid', material: null },
          {
            id: 'valid_id_3',
            name: 'Good Card',
            material: { preset: 'frosted-glass' },
          },
        ],
      }
      const normalized = normalizeOpeningPrefs(raw)
      expect(normalized.customCards).toHaveLength(1)
      expect(normalized.customCards![0]!.id).toBe('valid_id_3')
      expect(normalized.customCards![0]!.name).toBe('Good Card')
    })
  })

  describe('Media Storage & Magic Bytes Exotic Scenarios', () => {
    it('rejects 0-byte buffer and partial buffers shorter than 12 bytes', () => {
      expect(sniffImageSignature(Buffer.alloc(0))).toBeNull()
      expect(sniffImageSignature(Buffer.from([0x89, 0x50]))).toBeNull()
      expect(sniffImageSignature(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull() // < 12 bytes
      expect(sniffImageSignature(Buffer.from('GIF89a'))).toBeNull() // < 12 bytes
    })

    it('identifies exact signatures with trailing arbitrary payload', () => {
      // PNG header (8 bytes) + 8 arbitrary bytes
      const pngBuffer = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('<script>evil</script>'),
      ])
      const sniffedPng = sniffImageSignature(pngBuffer)
      expect(sniffedPng).toEqual({ mime: 'image/png', ext: '.png' })

      // JPEG header (3 bytes) + padding to 12+ bytes
      const jpegBuffer = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        Buffer.alloc(10, 0x00),
      ])
      expect(sniffImageSignature(jpegBuffer)).toEqual({ mime: 'image/jpeg', ext: '.jpg' })

      // WebP header (RIFF ... WEBP)
      const webpBuffer = Buffer.alloc(16)
      webpBuffer.set([0x52, 0x49, 0x46, 0x46], 0) // 'RIFF'
      webpBuffer.set([0x57, 0x45, 0x42, 0x50], 8) // 'WEBP'
      expect(sniffImageSignature(webpBuffer)).toEqual({ mime: 'image/webp', ext: '.webp' })

      // Invalid WebP: RIFF ... AVIF
      const fakeWebp = Buffer.alloc(16)
      fakeWebp.set([0x52, 0x49, 0x46, 0x46], 0)
      fakeWebp.set([0x41, 0x56, 0x49, 0x46], 8)
      expect(sniffImageSignature(fakeWebp)).toBeNull()

      // GIF87a and GIF89a
      const gif87 = Buffer.concat([Buffer.from('GIF87a'), Buffer.alloc(8)])
      const gif89 = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(8)])
      const fakeGif = Buffer.concat([Buffer.from('GIF90a'), Buffer.alloc(8)])
      expect(sniffImageSignature(gif87)).toEqual({ mime: 'image/gif', ext: '.gif' })
      expect(sniffImageSignature(gif89)).toEqual({ mime: 'image/gif', ext: '.gif' })
      expect(sniffImageSignature(fakeGif)).toBeNull()
    })

    it('enforces exact 10MB quota boundary and rejects 10MB + 1 byte', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'genoffice-ocs-quota-'))
      try {
        const overLimitBuffer = Buffer.alloc(MAX_MEDIA_ASSET_BYTES + 1)
        await expect(storeMediaAssetFromBuffer(tempDir, overLimitBuffer)).rejects.toThrow(
          /exceeds maximum limit/i,
        )

        const emptyBuffer = Buffer.alloc(0)
        await expect(storeMediaAssetFromBuffer(tempDir, emptyBuffer)).rejects.toThrow(
          /file is empty/i,
        )
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    it('rejects path traversal, null bytes, backslashes, and invalid asset extensions', () => {
      const attacks = [
        '../asset_123_0123456789abcdef.png',
        '..\\asset_123_0123456789abcdef.png',
        'asset_123_0123456789abcdef.png/..',
        'asset_123_0123456789abcdef.png\0.jpg',
        'asset_123_0123456789abcdef.png%00',
        '/etc/passwd',
        'C:\\Windows\\system32\\cmd.exe',
        'asset_123_0123456789abcdef.exe',
        'asset_123_0123456789abcdef.svg',
        'asset_123_0123456789abcdef.sh',
        '',
        '   ',
      ]
      for (const attack of attacks) {
        expect(isSafeAssetId(attack)).toBe(false)
        expect(() => resolveSafeAssetPath('/tmp', attack)).toThrow()
      }
    })

    it('deleteMediaAsset gracefully returns false on missing or invalid asset IDs', () => {
      expect(deleteMediaAsset('/tmp', 'asset_invalid_id')).toBe(false)
      expect(deleteMediaAsset('/tmp', 'asset_999999999999_0123456789abcdef.png')).toBe(false)
    })
  })

  describe('Material CSS Engine Security & Sanitization', () => {
    it('sanitizes border color against CSS injection, url expressions, and semicolons', () => {
      const fallback = 'rgba(255, 255, 255, 0.1)'
      expect(sanitizeBorderColor('red; background: url(evil) !important;', fallback)).toBe(fallback)
      expect(sanitizeBorderColor('rgba(0, 0, 0, 0.5); } body { display: none; }', fallback)).toBe(
        fallback,
      )
      expect(sanitizeBorderColor('javascript:alert(1)', fallback)).toBe(fallback)
      expect(sanitizeBorderColor('expression(alert(1))', fallback)).toBe(fallback)

      // Valid values
      expect(sanitizeBorderColor('#fff', fallback)).toBe('#fff')
      expect(sanitizeBorderColor('#1a2b3c', fallback)).toBe('#1a2b3c')
      expect(sanitizeBorderColor('#1a2b3c4d', fallback)).toBe('#1a2b3c4d')
      expect(sanitizeBorderColor('rgba(255, 255, 255, 0.25)', fallback)).toBe(
        'rgba(255, 255, 255, 0.25)',
      )
      expect(sanitizeBorderColor('rgb(20, 30, 40)', fallback)).toBe('rgb(20, 30, 40)')
    })

    it('clamps extreme numeric values to calibrated, stable ranges', () => {
      const extreme = buildMaterialCss({
        preset: 'frosted-glass',
        opacity: 999, // max 1.0
        blurPx: -100, // min 0
        borderRadiusPx: 1000, // max 36
        borderWidthPx: -50, // min 0
        shadowIntensity: 999, // max 1.0
        accentColor: '#invalid-color',
      })

      expect(extreme.inlineCss).toContain('--card-radius: 36px')
      expect(extreme.inlineCss).toContain('--card-accent: #2b7cd3')
      expect(extreme.inlineCss).toContain('border: 0px solid')
    })

    it('generates valid styles for all combinations of presets and themeModes', () => {
      const presets = ['solid', 'frosted-glass', 'liquid-glass', 'minimal-monochrome'] as const
      const modes = ['light', 'dark', 'system'] as const

      for (const preset of presets) {
        for (const mode of modes) {
          const res = buildMaterialCss({ preset, themeMode: mode, reduceTransparency: true })
          expect(res.inlineCss).toContain('.stage {')
          expect(res.inlineCss).toContain('@media (prefers-reduced-transparency: reduce)')
          expect(res.borderRadius).toBeDefined()
        }
      }
    })
  })

  describe('AI Schema Validation & Payload Extraction Edge Cases', () => {
    it('extracts JSON from code fences, raw text, and conversational wrappers', () => {
      const fenceJson = '```json\n{"name": "Fence Card", "preset": "solid"}\n```'
      expect(parseAiJsonPayload(fenceJson)).toEqual({ name: 'Fence Card', preset: 'solid' })

      const bareFence = '```\n{"name": "Bare Fence"}\n```'
      expect(parseAiJsonPayload(bareFence)).toEqual({ name: 'Bare Fence' })

      const conversational =
        'Here is the card configuration you requested:\n\n{"name": "Ocean Deep", "opacity": 0.9}\n\nHope this works!'
      expect(parseAiJsonPayload(conversational)).toEqual({ name: 'Ocean Deep', opacity: 0.9 })
    })

    it('rejects malicious XSS payloads and script injection in AI output', () => {
      const scriptName = {
        name: 'Card <script>alert(1)</script>',
        preset: 'solid',
      }
      expect(validateAiCardSchema(scriptName).ok).toBe(false)
      expect(validateAiCardSchema(scriptName).error).toContain('prohibited')

      const jsUrlDesc = {
        name: 'Safe Name',
        description: 'Check this: javascript:alert(document.cookie)',
      }
      expect(validateAiCardSchema(jsUrlDesc).ok).toBe(false)

      const onloadDesc = {
        name: 'Safe Name',
        description: '<img src=x onerror=alert(1)>',
      }
      expect(validateAiCardSchema(onloadDesc).ok).toBe(false)

      const protoInjection = {
        name: 'Proto Attack',
        __proto__: { injected: true },
        evilKey: 'unauthorized',
      }
      expect(validateAiCardSchema(protoInjection).ok).toBe(false)
      expect(validateAiCardSchema(protoInjection).error).toContain('Unauthorized field')
    })

    it('enforces character length limits on name and description', () => {
      const longName = { name: 'A'.repeat(61) }
      expect(validateAiCardSchema(longName).ok).toBe(false)
      expect(validateAiCardSchema(longName).error).toContain('60 characters')

      const longDesc = { name: 'Valid Name', description: 'B'.repeat(201) }
      expect(validateAiCardSchema(longDesc).ok).toBe(false)
      expect(validateAiCardSchema(longDesc).error).toContain('200 characters')
    })
  })

  describe('HTML Generation & Rendering Security Edge Cases', () => {
    it('escapes dangerous HTML, script tags, quotes, and ampersands in file names', () => {
      const html = openingPageHtml(
        { title: 'Opening…', hint: 'Please wait…' },
        '<script>alert("xss")</script> & "special" \'file\'.docx',
        'docs',
        'lite',
      )

      expect(html).not.toContain('<script>alert("xss")</script>')
      expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;')
      expect(html).toContain('&amp;')
      expect(html).toContain('&#39;file&#39;')
    })

    it('safely handles Unicode and emoji file names without corruption', () => {
      const unicodeName = 'Báo cáo tài chính quý 4 📊 & kế hoạch phát triển 🚀.xlsx'
      const html = openingPageHtml(
        { title: 'Đang mở…', hint: 'Vui lòng chờ…' },
        unicodeName,
        'sheets',
        'full',
      )
      expect(html).toContain('Báo cáo tài chính quý 4 📊 &amp; kế hoạch phát triển 🚀.xlsx')
    })

    it('rejects quote-breakout attempts in mediaDataUrl', () => {
      const maliciousDataUrl = "data:image/png;base64,abc'); } body { display:none } /*"
      const html = openingPageHtml(
        { title: 'Opening…', hint: 'hint' },
        'doc.docx',
        'docs',
        'lite',
        undefined,
        'window',
        {
          id: 'test-card',
          name: 'Test',
          category: 'media',
          contentKind: 'media',
          material: { preset: 'frosted-glass' },
          createdAt: Date.now(),
        },
        maliciousDataUrl,
      )

      // Malicious dataUrl must be rejected by regex validator
      expect(html).not.toContain('body { display:none }')
      expect(html).not.toContain(maliciousDataUrl)
    })

    it('customPageHtml sanitizes template placeholders and escapes script breakouts', () => {
      const template =
        '<div>{{fileName}}</div><h1>{{title}}</h1><p>{{hint}}</p><span>{{color}}</span>'
      const html = customPageHtml(template, {
        fileName: '<img src=x onerror=alert(1)>',
        title: 'Title <script>',
        hint: 'Hint & More',
        app: 'docs',
        color: '#2b7cd3',
      })

      expect(html).not.toContain('<img src=x onerror=alert(1)>')
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
      expect(html).toContain('Title &lt;script&gt;')
      expect(html).toContain('Hint &amp; More')
      // window.GENOFFICE_OPEN must escape < as \u003c
      expect(html).toContain('\\u003cimg')
    })
  })
})
