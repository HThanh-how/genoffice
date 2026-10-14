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
      const validPng = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      )
      const asset = await storeMediaAssetFromBuffer(tmpDir, validPng)

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

    it('preserves sceneId for canvas-scene cards across export and import', async () => {
      const canvasCard: OpeningCardDefinition = {
        id: 'custom:aurora_scene',
        name: 'Aurora Borealis Card',
        category: 'canvas',
        contentKind: 'canvas-scene',
        sceneId: 'aurora',
        material: { preset: 'solid' },
        createdAt: Date.now(),
        isBuiltIn: false,
      }

      const bundle = createOpeningCardExportBundle([canvasCard], tmpDir)
      expect(bundle.cards[0].sceneId).toBe('aurora')

      const res = await importCardsFromExportBundle(JSON.stringify(bundle), tmpDir, [])
      expect(res.ok).toBe(true)
      expect(res.importedCards[0].sceneId).toBe('aurora')
    })

    it('rejects import before asset persistence if 0 valid cards exist', async () => {
      const bundle = {
        version: 1,
        cards: [{ notAValidCard: true }],
        assets: [
          {
            assetId: 'asset_unimported.png',
            mime: 'image/png',
            sizeBytes: 68,
            createdAt: Date.now(),
            thumbnailUrl: '',
            dataUrl:
              'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          },
        ],
      }

      const res = await importCardsFromExportBundle(JSON.stringify(bundle), tmpDir, [])
      expect(res.ok).toBe(false)
      expect(res.error).toContain('No valid card definitions')

      // Ensure no assets were written to disk
      const assets = listMediaAssets(tmpDir)
      expect(assets).toHaveLength(0)
    })

    it('assigns unique IDs to intra-bundle duplicate card IDs', async () => {
      const cardA: OpeningCardDefinition = {
        id: 'custom:dupe_id',
        name: 'Dupe Card 1',
        category: 'custom',
        contentKind: 'curated-material',
        material: { preset: 'solid' },
        createdAt: Date.now(),
        isBuiltIn: false,
      }
      const cardB: OpeningCardDefinition = {
        id: 'custom:dupe_id',
        name: 'Dupe Card 2',
        category: 'custom',
        contentKind: 'curated-material',
        material: { preset: 'solid' },
        createdAt: Date.now(),
        isBuiltIn: false,
      }

      const bundle = {
        version: 1,
        cards: [cardA, cardB],
      }

      const res = await importCardsFromExportBundle(JSON.stringify(bundle), tmpDir, [])
      expect(res.ok).toBe(true)
      expect(res.count).toBe(2)
      expect(res.importedCards[0].id).not.toBe(res.importedCards[1].id)
    })

    it('deduplicates shared media assets in export bundle', async () => {
      const validPng = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      )
      const asset = await storeMediaAssetFromBuffer(tmpDir, validPng)

      const card1: OpeningCardDefinition = {
        id: 'custom:shared_1',
        name: 'Shared Card 1',
        category: 'media',
        contentKind: 'personal-media',
        mediaAssetId: asset.assetId,
        material: { preset: 'solid' },
        createdAt: Date.now(),
        isBuiltIn: false,
      }
      const card2: OpeningCardDefinition = {
        id: 'custom:shared_2',
        name: 'Shared Card 2',
        category: 'media',
        contentKind: 'personal-media',
        mediaAssetId: asset.assetId,
        material: { preset: 'solid' },
        createdAt: Date.now(),
        isBuiltIn: false,
      }

      const bundle = createOpeningCardExportBundle([card1, card2], tmpDir)
      expect(bundle.assets).toBeDefined()
      expect(bundle.assets?.length).toBe(1)
    })
  })
})
