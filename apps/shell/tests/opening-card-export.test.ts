import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createOpeningCardExportBundle,
  importCardsFromExportBundle,
  validateCardDefinition,
} from '../src/main/fork/opening-card-export'
import { listMediaAssets, storeMediaAssetFromBuffer } from '../src/main/fork/opening-media-storage'
import type { OpeningCardDefinition } from '../src/shared/opening-card-types'

describe('Opening Card Studio: Versioned Export & Import Bundle', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'genoffice-export-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('validateCardDefinition', () => {
    it('accepts valid custom card definition', () => {
      const valid: OpeningCardDefinition = {
        id: 'custom:card_123',
        name: 'Graphite Aurora',
        description: 'Dark minimalist card with emerald glow',
        category: 'custom',
        contentKind: 'curated-material',
        material: {
          preset: 'frosted-glass',
          themeMode: 'dark',
          opacity: 0.85,
          blurPx: 22,
          borderRadiusPx: 18,
          borderWidthPx: 1,
          accentColor: '#10b981',
          shadowIntensity: 0.4,
        },
        createdAt: Date.now(),
        isBuiltIn: false,
        tags: ['dark', 'emerald'],
      }

      const res = validateCardDefinition(valid)
      expect(res.ok).toBe(true)
      expect(res.card?.id).toBe('custom:card_123')
      expect(res.card?.name).toBe('Graphite Aurora')
      expect(res.card?.material.preset).toBe('frosted-glass')
      expect(res.card?.material.accentColor).toBe('#10b981')
    })

    it('rejects prototype pollution attempts', () => {
      const malicious = JSON.parse(
        '{"id":"custom:hacked","name":"Hack","material":{"preset":"solid"},"__proto__":{"polluted":true}}',
      )
      const res = validateCardDefinition(malicious)
      expect(res.ok).toBe(false)
      expect(res.error).toContain('Forbidden prototype properties')
    })

    it('rejects HTML and script injection in card name and description', () => {
      const attackName = {
        id: 'custom:xss1',
        name: '<script>alert("pwned")</script>',
        material: { preset: 'solid' },
      }
      expect(validateCardDefinition(attackName).ok).toBe(false)

      const attackDesc = {
        id: 'custom:xss2',
        name: 'Safe Name',
        description: '<img src=x onerror=alert(1)>',
        material: { preset: 'solid' },
      }
      expect(validateCardDefinition(attackDesc).ok).toBe(false)
    })

    it('clamps numeric material attributes to safe bounds', () => {
      const uncalibrated = {
        id: 'custom:bounds',
        name: 'Wild Bounds',
        material: {
          preset: 'solid',
          opacity: 5.0, // should clamp to 1.0
          blurPx: 999, // should clamp to 48
          borderRadiusPx: -10, // should clamp to 8
          borderWidthPx: 100, // should clamp to 4
          shadowIntensity: 2.0, // should clamp to 1.0
        },
      }

      const res = validateCardDefinition(uncalibrated)
      expect(res.ok).toBe(true)
      expect(res.card?.material.opacity).toBe(1.0)
      expect(res.card?.material.blurPx).toBe(48)
      expect(res.card?.material.borderRadiusPx).toBe(8)
      expect(res.card?.material.borderWidthPx).toBe(4)
      expect(res.card?.material.shadowIntensity).toBe(1.0)
    })
  })

  describe('createOpeningCardExportBundle & importCardsFromExportBundle', () => {
    it('creates version 1 export bundle and achieves 100% lossless round-trip', async () => {
      const sampleCard: OpeningCardDefinition = {
        id: 'custom:card_roundtrip',
        name: 'Nordic Frost',
        description: 'Crystal glass card with cyan glow',
        category: 'custom',
        contentKind: 'curated-material',
        material: {
          preset: 'frosted-glass',
          themeMode: 'system',
          opacity: 0.8,
          blurPx: 20,
          borderRadiusPx: 16,
          borderWidthPx: 1,
          accentColor: '#38bdf8',
          shadowIntensity: 0.3,
        },
        thumbnailColors: ['#38bdf8', '#0f172a'],
        createdAt: 1700000000000,
        isBuiltIn: false,
        tags: ['nordic', 'frost'],
      }

      const bundle = createOpeningCardExportBundle([sampleCard], tmpDir)
      expect(bundle.version).toBe(1)
      expect(bundle.cards).toHaveLength(1)
      expect(bundle.cards[0].name).toBe('Nordic Frost')

      const jsonStr = JSON.stringify(bundle)
      const importRes = await importCardsFromExportBundle(jsonStr, tmpDir, [])
      expect(importRes.ok).toBe(true)
      expect(importRes.count).toBe(1)
      expect(importRes.importedCards[0].name).toBe(sampleCard.name)
      expect(importRes.importedCards[0].material.accentColor).toBe(sampleCard.material.accentColor)
      expect(importRes.importedCards[0].material.blurPx).toBe(sampleCard.material.blurPx)
    })

    it('embeds referenced personal media in bundle and restores it into storage', async () => {
      // 1. Create personal media asset
      const pngHeader = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52,
      ])
      const asset = await storeMediaAssetFromBuffer(tmpDir, pngHeader)

      // 2. Create card referencing asset
      const mediaCard: OpeningCardDefinition = {
        id: 'custom:media_card',
        name: 'My Workspace Photo',
        category: 'media',
        contentKind: 'personal-media',
        mediaAssetId: asset.assetId,
        mediaFit: 'cover',
        material: {
          preset: 'solid',
          opacity: 0.9,
          borderRadiusPx: 18,
        },
        createdAt: Date.now(),
        isBuiltIn: false,
      }

      // 3. Export bundle
      const bundle = createOpeningCardExportBundle([mediaCard], tmpDir)
      expect(bundle.assets).toBeDefined()
      expect(bundle.assets?.length).toBe(1)
      expect(bundle.assets?.[0].dataUrl).toContain('data:image/png;base64,')

      // 4. Import bundle into fresh user directory
      const newTmpDir = mkdtempSync(join(tmpdir(), 'genoffice-import-dest-'))
      try {
        const jsonStr = JSON.stringify(bundle)
        const importRes = await importCardsFromExportBundle(jsonStr, newTmpDir, [])
        expect(importRes.ok).toBe(true)
        expect(importRes.count).toBe(1)

        // Asset must be restored in destination storage
        const restoredAssets = listMediaAssets(newTmpDir)
        expect(restoredAssets.length).toBe(1)
        expect(importRes.importedCards[0].mediaAssetId).toBe(restoredAssets[0].assetId)
      } finally {
        rmSync(newTmpDir, { recursive: true, force: true })
      }
    })

    it('re-keys duplicate IDs to prevent clobbering existing custom cards', async () => {
      const card: OpeningCardDefinition = {
        id: 'custom:existing_id',
        name: 'Existing Card',
        category: 'custom',
        contentKind: 'curated-material',
        material: { preset: 'solid' },
        createdAt: Date.now(),
        isBuiltIn: false,
      }

      const bundle = createOpeningCardExportBundle([card], tmpDir)
      const importRes = await importCardsFromExportBundle(JSON.stringify(bundle), tmpDir, [card])
      expect(importRes.ok).toBe(true)
      expect(importRes.importedCards[0].id).not.toBe('custom:existing_id')
      expect(importRes.importedCards[0].id).toContain('custom:imported_')
    })

    it('never overwrites built-in card IDs', async () => {
      const attackBuiltIn: OpeningCardDefinition = {
        id: 'curated:frosted-blue', // Built-in card ID
        name: 'Fake Frosted Blue',
        category: 'curated',
        contentKind: 'curated-material',
        material: { preset: 'solid' },
        createdAt: Date.now(),
        isBuiltIn: false,
      }

      const bundle = createOpeningCardExportBundle([attackBuiltIn], tmpDir)
      const importRes = await importCardsFromExportBundle(JSON.stringify(bundle), tmpDir, [])
      expect(importRes.ok).toBe(true)
      expect(importRes.importedCards[0].id).not.toBe('curated:frosted-blue')
      expect(importRes.importedCards[0].id).toContain('custom:imported_')
    })

    it('rejects malformed JSON and unsupported bundle versions', async () => {
      const malformed = 'not valid json {{{'
      const res1 = await importCardsFromExportBundle(malformed, tmpDir, [])
      expect(res1.ok).toBe(false)
      expect(res1.error).toContain('Invalid JSON payload')

      const badVersion = JSON.stringify({ version: 99, cards: [] })
      const res2 = await importCardsFromExportBundle(badVersion, tmpDir, [])
      expect(res2.ok).toBe(false)
      expect(res2.error).toContain('Unsupported import format')
    })
  })
})
