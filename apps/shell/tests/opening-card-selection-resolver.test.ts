import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SCENE_FOR_APP,
  normalizeOpeningPrefs,
  resolveEffectiveOpeningCard,
  type OpeningPrefs,
} from '../src/shared/opening-scenes-meta'

describe('Opening Card Studio: Selection Resolver Precedence & Global Default', () => {
  const basePrefs: OpeningPrefs = normalizeOpeningPrefs({})

  it('Tier 1: Explicit preview scene overrides all preferences', () => {
    const prefs: OpeningPrefs = {
      ...basePrefs,
      globalCard: 'aurora-glass',
      scenes: {
        ...basePrefs.scenes,
        docs: 'minimal-slate',
      },
    }

    const effective = resolveEffectiveOpeningCard(prefs, 'docs', 'matrix')
    expect(effective.id).toBe('matrix')
    expect(effective.source).toBe('preview')
    expect(effective.isOverride).toBe(false)
  })

  it('Tier 2: Explicit appOverrides[app] wins over globalCard', () => {
    const prefs: OpeningPrefs = {
      ...basePrefs,
      globalCard: 'curated:frosted-blue',
      appOverrides: {
        docs: 'custom:my_special_doc_card',
      },
    }

    const effective = resolveEffectiveOpeningCard(prefs, 'docs')
    expect(effective.id).toBe('custom:my_special_doc_card')
    expect(effective.source).toBe('override')
    expect(effective.isOverride).toBe(true)
  })

  it('Tier 3: When globalCard is configured and app has no override, globalCard applies to all apps', () => {
    const prefs: OpeningPrefs = {
      ...basePrefs,
      globalCard: 'curated:emerald-frost',
    }

    // Every app should inherit curated:emerald-frost
    for (const app of ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html'] as const) {
      const effective = resolveEffectiveOpeningCard(prefs, app)
      expect(effective.id).toBe('curated:emerald-frost')
      expect(effective.source).toBe('global')
      expect(effective.isOverride).toBe(false)
    }
  })

  it('Tier 4: Falls back to application default when neither globalCard nor override is set', () => {
    const effectiveDocs = resolveEffectiveOpeningCard(basePrefs, 'docs')
    expect(effectiveDocs.id).toBe(DEFAULT_SCENE_FOR_APP.docs)
    expect(effectiveDocs.source).toBe('default')
    expect(effectiveDocs.isOverride).toBe(false)

    const effectiveSheets = resolveEffectiveOpeningCard(basePrefs, 'sheets')
    expect(effectiveSheets.id).toBe(DEFAULT_SCENE_FOR_APP.sheets)
    expect(effectiveSheets.source).toBe('default')
  })

  it('Resetting an override seamlessly restores the Global Default', () => {
    const prefsWithOverride: OpeningPrefs = {
      ...basePrefs,
      globalCard: 'curated:frosted-blue',
      appOverrides: {
        docs: 'curated:minimal-dark',
      },
    }
    expect(resolveEffectiveOpeningCard(prefsWithOverride, 'docs').id).toBe('curated:minimal-dark')

    // Reset override:
    const prefsReset: OpeningPrefs = {
      ...prefsWithOverride,
      appOverrides: {},
    }
    const restored = resolveEffectiveOpeningCard(prefsReset, 'docs')
    expect(restored.id).toBe('curated:frosted-blue')
    expect(restored.source).toBe('global')
    expect(restored.isOverride).toBe(false)
  })

  it('Safely falls back to default scene if globalCard points to an invalid/corrupted scene ID', () => {
    const prefsWithBadGlobal: OpeningPrefs = {
      ...basePrefs,
      globalCard: 'totally-invalid-nonexistent-scene',
    }

    const effective = resolveEffectiveOpeningCard(prefsWithBadGlobal, 'docs')
    expect(effective.id).toBe(DEFAULT_SCENE_FOR_APP.docs)
    expect(effective.source).toBe('default')
  })

  it('Global A -> Docs B -> Reset Docs -> Global C -> Docs dynamically follows Global C', () => {
    // 1. Initial: Global A
    let prefs: OpeningPrefs = {
      ...basePrefs,
      globalCard: 'curated:frosted-blue',
    }
    expect(resolveEffectiveOpeningCard(prefs, 'docs').id).toBe('curated:frosted-blue')

    // 2. Set Docs override to Docs B
    prefs = {
      ...prefs,
      appOverrides: {
        docs: 'curated:graphite',
      },
    }
    const overridden = resolveEffectiveOpeningCard(prefs, 'docs')
    expect(overridden.id).toBe('curated:graphite')
    expect(overridden.isOverride).toBe(true)

    // 3. Reset Docs override (as implemented in handleResetOverride)
    const nextOverrides = { ...prefs.appOverrides }
    delete nextOverrides.docs
    prefs = {
      ...prefs,
      appOverrides: Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined,
      scenes: {
        ...prefs.scenes,
        docs: DEFAULT_SCENE_FOR_APP.docs,
      },
    }
    const reset = resolveEffectiveOpeningCard(prefs, 'docs')
    expect(reset.id).toBe('curated:frosted-blue')
    expect(reset.isOverride).toBe(false)
    expect(reset.source).toBe('global')

    // 4. Update Global Default to Global C
    prefs = {
      ...prefs,
      globalCard: 'curated:midnight-glass',
    }
    const updatedGlobal = resolveEffectiveOpeningCard(prefs, 'docs')
    expect(updatedGlobal.id).toBe('curated:midnight-glass')
    expect(updatedGlobal.source).toBe('global')
    expect(updatedGlobal.isOverride).toBe(false)
  })

  it('safely falls back to default scene when a referenced custom card is deleted', () => {
    const deletedCardId = 'custom:deleted_meeting_card'
    const prefsWithDeletedCard: OpeningPrefs = {
      ...basePrefs,
      customCards: [], // User deleted all custom cards
      globalCard: deletedCardId,
      appOverrides: {
        docs: deletedCardId,
      },
    }

    // Both override and global point to deleted card -> must safely fall back to app default
    const effectiveDocs = resolveEffectiveOpeningCard(prefsWithDeletedCard, 'docs')
    expect(effectiveDocs.id).toBe(DEFAULT_SCENE_FOR_APP.docs)
    expect(effectiveDocs.source).toBe('default')
    expect(effectiveDocs.isOverride).toBe(false)

    const effectiveSheets = resolveEffectiveOpeningCard(prefsWithDeletedCard, 'sheets')
    expect(effectiveSheets.id).toBe(DEFAULT_SCENE_FOR_APP.sheets)
    expect(effectiveSheets.source).toBe('default')
  })
})
