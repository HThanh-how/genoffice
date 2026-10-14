import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OPENING_PREFS,
  DEFAULT_SCENE_FOR_APP,
  SCENES,
  knownSceneOrCard,
  normalizeOpeningPrefs,
} from '../src/shared/opening-scenes-meta'
import {
  CURATED_CARD_FAMILIES,
  getAllBuiltInCards,
  getBuiltInCard,
  getCanvasSceneCards,
  isBuiltInCard,
} from '../src/shared/opening-card-families'
import type { OpeningCardDefinition } from '../src/shared/opening-card-types'

describe('Opening Card Studio: Curated Card Families & Data Models', () => {
  it('defines exactly the 12 curated card styles required by spec Section 5', () => {
    expect(CURATED_CARD_FAMILIES).toHaveLength(12)
    const expectedNames = [
      'Frosted Blue',
      'Crystal White',
      'Graphite',
      'Midnight Glass',
      'Soft Lavender',
      'Clean Paper',
      'Floating Card',
      'Pastel Gradient',
      'Silk',
      'Minimal White',
      'Minimal Black',
      'Soft Glow',
    ]
    const actualNames = CURATED_CARD_FAMILIES.map((c) => c.name)
    expect(actualNames).toEqual(expectedNames)
    for (const card of CURATED_CARD_FAMILIES) {
      expect(card.id.startsWith('curated:')).toBe(true)
      expect(card.category).toBe('curated')
      expect(card.isBuiltIn).toBe(true)
      expect(card.material.opacity).toBeGreaterThanOrEqual(0.1)
      expect(card.material.opacity).toBeLessThanOrEqual(1.0)
      expect(card.thumbnailColors).toBeDefined()
      expect(card.thumbnailColors).toHaveLength(2)
    }
  })

  it('exposes the 32 canvas scenes as built-in canvas cards', () => {
    const canvasCards = getCanvasSceneCards()
    expect(canvasCards).toHaveLength(32)
    expect(canvasCards.map((c) => c.id)).toEqual(SCENES.map((s) => s.id))
    for (const card of canvasCards) {
      expect(card.category).toBe('canvas')
      expect(card.contentKind).toBe('canvas-scene')
      expect(card.sceneId).toBe(card.id)
    }
  })

  it('provides fast lookup via getBuiltInCard and isBuiltInCard', () => {
    expect(isBuiltInCard('curated:frosted-blue')).toBe(true)
    expect(isBuiltInCard('ocean')).toBe(true)
    expect(isBuiltInCard('non-existent-card')).toBe(false)

    const card = getBuiltInCard('curated:midnight-glass')
    expect(card).toBeDefined()
    expect(card?.name).toBe('Midnight Glass')
    expect(card?.material.preset).toBe('liquid-glass')

    const all = getAllBuiltInCards()
    expect(all).toHaveLength(12 + 32)
  })
})

describe('Opening Card Studio: Preference Normalization & Backwards Compatibility', () => {
  it('normalizes undefined or empty settings to DEFAULT_OPENING_PREFS', () => {
    expect(normalizeOpeningPrefs(undefined)).toEqual(DEFAULT_OPENING_PREFS)
    expect(normalizeOpeningPrefs({})).toEqual(DEFAULT_OPENING_PREFS)
  })

  it('preserves legacy scene IDs without alteration', () => {
    const normalized = normalizeOpeningPrefs({
      scenes: {
        docs: 'ocean',
        sheets: 'bamboo',
        slides: 'cloudsea',
        pdf: 'snow',
        markdown: 'city',
        html: 'matrix',
      },
    })
    expect(normalized.scenes.docs).toBe('ocean')
    expect(normalized.scenes.sheets).toBe('bamboo')
    expect(normalized.scenes.slides).toBe('cloudsea')
    expect(normalized.scenes.pdf).toBe('snow')
    expect(normalized.scenes.markdown).toBe('city')
    expect(normalized.scenes.html).toBe('matrix')
  })

  it('supports curated card IDs and custom card IDs in per-app scenes', () => {
    const normalized = normalizeOpeningPrefs({
      scenes: {
        docs: 'curated:frosted-blue',
        sheets: 'curated:graphite',
        slides: 'custom:my-deck-card',
      },
    })
    expect(normalized.scenes.docs).toBe('curated:frosted-blue')
    expect(normalized.scenes.sheets).toBe('curated:graphite')
    expect(normalized.scenes.slides).toBe('custom:my-deck-card')
    expect(normalized.scenes.pdf).toBe(DEFAULT_SCENE_FOR_APP.pdf)
  })

  it('handles optional globalCard, favorites, and customCards correctly', () => {
    const customCard: OpeningCardDefinition = {
      id: 'custom:zen-paper',
      name: 'Zen Paper',
      category: 'custom',
      contentKind: 'curated-material',
      material: {
        preset: 'solid',
        opacity: 0.95,
      },
    }
    const input = {
      globalCard: 'curated:minimal-black',
      favorites: ['curated:frosted-blue', 'ocean', 123], // 123 is invalid
      customCards: [customCard, { broken: true }, 'string-not-object'],
    }
    const normalized = normalizeOpeningPrefs(input)
    expect(normalized.globalCard).toBe('curated:minimal-black')
    expect(normalized.favorites).toEqual(['curated:frosted-blue', 'ocean'])
    expect(normalized.customCards).toEqual([customCard])
  })

  it('drops invalid globalCard and sanitizes corrupted customCards', () => {
    const normalized = normalizeOpeningPrefs({
      globalCard: 'invalid-card-id-12345',
      favorites: 'not-an-array',
      customCards: null,
    })
    expect(normalized.globalCard).toBeUndefined()
    expect(normalized.favorites).toBeUndefined()
    expect(normalized.customCards).toBeUndefined()
  })

  it('validates knownSceneOrCard predicate', () => {
    expect(knownSceneOrCard('custom')).toBe(true)
    expect(knownSceneOrCard('snow')).toBe(true)
    expect(knownSceneOrCard('curated:soft-lavender')).toBe(true)
    expect(knownSceneOrCard('custom:uploaded-card')).toBe(true)
    expect(knownSceneOrCard('malicious-or-unknown-id')).toBe(false)
    expect(knownSceneOrCard(null)).toBe(false)
  })
})
