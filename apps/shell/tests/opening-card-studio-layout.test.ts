import { describe, expect, it } from 'vitest'
import {
  assignmentStatus,
  computeFilterCounts,
  appliesTo,
  resolveActiveFilter,
  shouldShowFilterRow,
  visibleFilterKeys,
} from '../src/renderer/src/fork/opening-card/studio-logic'
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
  it('treats "Use this card" as done only when the chosen scope already plays the card', () => {
    const prefs = { globalCard: 'a', appOverrides: { docs: 'b' } as const }
    expect(appliesTo('all', prefs, 'a')).toBe(true)
    expect(appliesTo('all', prefs, 'b')).toBe(false)
    expect(appliesTo('docs', prefs, 'b')).toBe(true)
    // Word has its own card, so the global default does not reach it
    expect(appliesTo('docs', prefs, 'a')).toBe(false)
    // Excel has no override and follows the global default
    expect(appliesTo('sheets', prefs, 'a')).toBe(true)
    expect(appliesTo('sheets', prefs, 'b')).toBe(false)
    expect(appliesTo('all', {}, 'a')).toBe(false)
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
