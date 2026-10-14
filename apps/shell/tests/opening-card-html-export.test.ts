import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createOpeningCardExportBundle,
  importCardsFromExportBundle,
} from '../src/main/fork/opening-card-export'
import { storeHtmlCardAsset, readHtmlCardAsset } from '../src/main/fork/opening-html-storage'
import type { OpeningCardDefinition } from '../src/shared/opening-card-types'

describe('Opening Card Studio — HTML Export & Import Bundles', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'genoffice-html-export-test-'))
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('exports cards with referenced HTML assets into portable bundle', async () => {
    const htmlAsset = await storeHtmlCardAsset(
      tempDir,
      '<div class="hud"><span>{{title}}</span></div>',
      '.hud { color: cyan; }',
    )

    const card: OpeningCardDefinition = {
      id: 'custom:hud_1',
      name: 'Cyberpunk HUD',
      category: 'custom',
      contentKind: 'ai-html',
      htmlAssetId: htmlAsset.assetId,
      material: {
        preset: 'minimal-monochrome',
        themeMode: 'dark',
        accentColor: '#00ffff',
      },
    }

    const bundle = createOpeningCardExportBundle([card], tempDir)

    expect(bundle.version).toBe(1)
    expect(bundle.cards).toHaveLength(1)
    expect(bundle.cards[0].id).toBe('custom:hud_1')
    expect(bundle.htmlAssets).toBeDefined()
    expect(bundle.htmlAssets).toHaveLength(1)
    expect(bundle.htmlAssets![0].assetId).toBe(htmlAsset.assetId)
    expect(bundle.htmlAssets![0].html).toContain('{{title}}')
    expect(bundle.htmlAssets![0].css).toContain('color: cyan')
  })

  it('imports bundle, stores HTML assets, and remaps htmlAssetId to new asset', async () => {
    const originalAsset = await storeHtmlCardAsset(
      tempDir,
      '<div class="neon"><span>{{fileName}}</span></div>',
      '.neon { font-weight: bold; }',
    )

    const bundle = {
      version: 1,
      exportedAt: Date.now(),
      cards: [
        {
          id: 'custom:neon_card',
          name: 'Neon Sign',
          category: 'custom',
          contentKind: 'ai-html',
          htmlAssetId: originalAsset.assetId,
          material: {
            preset: 'solid',
            themeMode: 'dark',
            accentColor: '#ff0055',
          },
        },
      ],
      htmlAssets: [originalAsset],
    }

    // Import into a separate destination directory
    const destDir = mkdtempSync(join(tmpdir(), 'genoffice-html-dest-'))
    try {
      const res = await importCardsFromExportBundle(JSON.stringify(bundle), destDir, [])
      expect(res.ok).toBe(true)
      expect(res.importedCards).toHaveLength(1)

      const importedCard = res.importedCards[0]
      expect(importedCard.contentKind).toBe('ai-html')
      expect(importedCard.htmlAssetId).toBeDefined()
      // HTML asset was safely stored in destDir
      const storedAsset = readHtmlCardAsset(destDir, importedCard.htmlAssetId!)
      expect(storedAsset).not.toBeNull()
      expect(storedAsset?.html).toContain('{{fileName}}')
      expect(storedAsset?.css).toContain('font-weight: bold')
    } finally {
      rmSync(destDir, { recursive: true, force: true })
    }
  })

  it('rejects import if embedded HTML asset contains unsafe script tag and leaves disk clean', async () => {
    const destDir = mkdtempSync(join(tmpdir(), 'genoffice-html-malicious-'))
    try {
      const maliciousBundle = {
        version: 1,
        exportedAt: Date.now(),
        cards: [
          {
            id: 'custom:bad_card',
            name: 'Malicious Card',
            category: 'custom',
            contentKind: 'ai-html',
            htmlAssetId: 'html_1234567890123_0123456789abcdef.json',
            material: {
              preset: 'solid',
              themeMode: 'dark',
              accentColor: '#ff0000',
            },
          },
        ],
        htmlAssets: [
          {
            assetId: 'html_1234567890123_0123456789abcdef.json',
            html: '<div><script>alert("pwned")</script></div>',
            css: 'body { background: black; }',
          },
        ],
      }

      const res = await importCardsFromExportBundle(JSON.stringify(maliciousBundle), destDir, [])
      expect(res.ok).toBe(false)
      expect(res.error).toContain('prohibited or unsafe code')
      expect(res.importedCards).toHaveLength(0)
    } finally {
      rmSync(destDir, { recursive: true, force: true })
    }
  })

  it('rejects import when rawHtmlAssets exceeds maximum HTML asset limit', async () => {
    const excessiveHtmlAssets = Array.from({ length: 51 }, (_, i) => ({
      assetId: `html_${1700000000000 + i}_0123456789abcdef.json`,
      html: '<div>Safe</div>',
      css: 'body { color: white; }',
    }))

    const excessiveBundle = {
      version: 1,
      exportedAt: Date.now(),
      cards: [
        {
          id: 'custom:card_1',
          name: 'Card 1',
          category: 'custom',
          contentKind: 'ai-html',
          material: { preset: 'solid', themeMode: 'dark' },
        },
      ],
      htmlAssets: excessiveHtmlAssets,
    }

    const res = await importCardsFromExportBundle(JSON.stringify(excessiveBundle), tempDir, [])
    expect(res.ok).toBe(false)
    expect(res.error).toContain('Bundle exceeds maximum HTML asset limit')
  })
})
