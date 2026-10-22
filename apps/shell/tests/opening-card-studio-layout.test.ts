import { describe, expect, it } from 'vitest'
import {
  assignmentStatus,
  computeFilterCounts,
  appliesTo,
  appsUsingCard,
  effectiveCardId,
  orderInUseFirst,
  resolveActiveFilter,
  shouldShowFilterRow,
  visibleFilterKeys,
} from '../src/renderer/src/fork/opening-card/studio-logic'
import { DEFAULT_SCENE_FOR_APP } from '../src/shared/opening-scenes-meta'
import type { OpeningCardDefinition } from '../src/shared/opening-card-types'

const card = (id: string, extra: Partial<OpeningCardDefinition> = {}): OpeningCardDefinition =>
  ({
    id,
    name: id,
    isBuiltIn: true,
    contentKind: 'curated-material',
    material: { preset: 'frosted-glass' },
    ...extra,
  }) as unknown as OpeningCardDefinition

describe('opening card gallery filters', () => {
  const cards = [card('a'), card('b'), card('c', { contentKind: 'canvas-scene' })]

  it('only offers categories that hold cards, always keeping "all"', () => {
    const counts = computeFilterCounts(cards, [])
    expect(counts.all).toBe(3)
    expect(visibleFilterKeys(counts)).toEqual(['all', 'curated-material', 'canvas-scene'])
  })

  it('shows Favorites only once something is a favorite', () => {
    expect(visibleFilterKeys(computeFilterCounts(cards, []))).not.toContain('favorites')
    expect(visibleFilterKeys(computeFilterCounts(cards, ['a']))).toContain('favorites')
  })

  it('counts custom, media and html cards', () => {
    const all = [
      ...cards,
      card('custom:m', { isBuiltIn: false, contentKind: 'personal-media' }),
      card('custom:h', { isBuiltIn: false, contentKind: 'ai-html' }),
      card('custom:c', { isBuiltIn: false, contentKind: 'custom-html' }),
    ]
    const counts = computeFilterCounts(all, undefined)
    expect(counts['personal-media']).toBe(1)
    expect(counts['ai-html']).toBe(2)
    expect(counts.custom).toBe(3)
  })

  it('hides the chip row when "all" is the only choice', () => {
    expect(shouldShowFilterRow(computeFilterCounts([card('a')], []))).toBe(false)
    expect(shouldShowFilterRow(computeFilterCounts(cards, []))).toBe(true)
  })

  it('falls back to "all" when the active category empties out', () => {
    const counts = computeFilterCounts(cards, [])
    expect(resolveActiveFilter('favorites', counts)).toBe('all')
    expect(resolveActiveFilter('canvas-scene', counts)).toBe('canvas-scene')
  })
})

describe('opening card apply scope', () => {
  it('treats "Use this card" as done only when every app in the scope already plays the card', () => {
    const prefs = { globalCard: 'a', appOverrides: { docs: 'b' } as const }
    // Word has its own card, so "all apps" is not yet true of the default
    expect(appliesTo('all', prefs, 'a')).toBe(false)
    expect(appliesTo('all', { globalCard: 'a' }, 'a')).toBe(true)
    expect(appliesTo('all', prefs, 'b')).toBe(false)
    expect(appliesTo('docs', prefs, 'b')).toBe(true)
    expect(appliesTo('docs', prefs, 'a')).toBe(false)
    // Excel has no override and follows the global default
    expect(appliesTo('sheets', prefs, 'a')).toBe(true)
    expect(appliesTo('sheets', prefs, 'b')).toBe(false)
    // nothing chosen: each app plays its own stock scene
    expect(appliesTo('all', {}, 'a')).toBe(false)
    expect(appliesTo('docs', {}, DEFAULT_SCENE_FOR_APP.docs)).toBe(true)
  })

  it('says which apps play a card, following the same order as the opening window', () => {
    expect(effectiveCardId({}, 'sheets')).toBe(DEFAULT_SCENE_FOR_APP.sheets)
    expect(effectiveCardId({ globalCard: 'g' }, 'sheets')).toBe('g')
    expect(effectiveCardId({ globalCard: 'g', appOverrides: { sheets: 'x' } }, 'sheets')).toBe('x')
    expect(
      effectiveCardId({ globalCard: 'g', appOverrides: { sheets: 'inherit' } }, 'sheets'),
    ).toBe('g')
    expect(effectiveCardId({ scenes: { pdf: 'old' } }, 'pdf')).toBe('old')
    expect(appsUsingCard({ globalCard: 'g', appOverrides: { docs: 'x' } }, 'g')).toEqual([
      'sheets',
      'slides',
      'pdf',
      'markdown',
      'html',
    ])
    expect(appsUsingCard({ globalCard: 'g' }, 'nobody')).toEqual([])
  })

  it('lists the cards in use first, the busiest first, and leaves the rest in order', () => {
    const cards = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }))
    const prefs = { globalCard: 'd', appOverrides: { docs: 'c' } as const }
    expect(orderInUseFirst(cards, prefs).map((c) => c.id)).toEqual(['d', 'c', 'a', 'b', 'e'])
    // nothing chosen: the stock scenes of the apps are the ones in use
    const stock = Object.values(DEFAULT_SCENE_FOR_APP).map((id) => ({ id }))
    const rest = [{ id: 'zzz' }, ...stock]
    expect(orderInUseFirst(rest, {}).at(-1)?.id).toBe('zzz')
    // a list with nothing in use does not move
    expect(orderInUseFirst(cards, prefs).length).toBe(cards.length)
    expect(
      orderInUseFirst([{ id: 'q' }, { id: 'r' }], { globalCard: 'z' }).map((c) => c.id),
    ).toEqual(['q', 'r'])
  })

  it('describes assignment in a single status', () => {
    const base = {
      isGlobalDefault: false,
      hasAppOverride: false,
      activeAppHasOtherOverride: false,
      overrideCount: 0,
    }
    expect(assignmentStatus(base)).toEqual({ kind: 'none' })
    expect(assignmentStatus({ ...base, hasAppOverride: true })).toEqual({ kind: 'app' })
    expect(assignmentStatus({ ...base, isGlobalDefault: true, overrideCount: 2 })).toEqual({
      kind: 'global',
      overrides: 2,
    })
    expect(
      assignmentStatus({ ...base, isGlobalDefault: true, activeAppHasOtherOverride: true }),
    ).toEqual({ kind: 'global-overridden' })
  })
})
