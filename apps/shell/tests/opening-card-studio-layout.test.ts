import { describe, expect, it } from 'vitest'
import {
  assignmentStatus,
  computeFilterCounts,
  pickPrimaryAction,
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

describe('opening card preview actions', () => {
  it('makes the global default the main action first, then the app assignment', () => {
    expect(pickPrimaryAction({ isGlobalDefault: false, hasAppOverride: false })).toBe('global')
    expect(pickPrimaryAction({ isGlobalDefault: false, hasAppOverride: true })).toBe('global')
    expect(pickPrimaryAction({ isGlobalDefault: true, hasAppOverride: false })).toBe('assign')
    expect(pickPrimaryAction({ isGlobalDefault: true, hasAppOverride: true })).toBe('none')
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
