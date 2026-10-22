import type { OpeningCardDefinition } from '../../../../shared/opening-card-types'
import {
  DEFAULT_SCENE_FOR_APP,
  OPENING_APPS,
  type OpeningApp,
} from '../../../../shared/opening-scenes-meta'

export type GalleryFilterCategory =
  | 'all'
  | 'curated-material'
  | 'canvas-scene'
  | 'personal-media'
  | 'ai-html'
  | 'favorites'
  | 'custom'

export type FilterCounts = Record<GalleryFilterCategory, number>

export const FILTER_ORDER: GalleryFilterCategory[] = [
  'all',
  'curated-material',
  'canvas-scene',
  'personal-media',
  'ai-html',
  'favorites',
  'custom',
]

export function isCustomCard(card: OpeningCardDefinition): boolean {
  return !card.isBuiltIn || card.category === 'custom'
}

export function matchesFilter(
  card: OpeningCardDefinition,
  filter: GalleryFilterCategory,
  favorites: ReadonlySet<string>,
): boolean {
  switch (filter) {
    case 'curated-material':
    case 'canvas-scene':
    case 'personal-media':
      return card.contentKind === filter
    case 'ai-html':
      return card.contentKind === 'ai-html' || card.contentKind === 'custom-html'
    case 'favorites':
      return favorites.has(card.id)
    case 'custom':
      return isCustomCard(card)
    default:
      return true
  }
}

export function computeFilterCounts(
  cards: readonly OpeningCardDefinition[],
  favorites: readonly string[] | undefined,
): FilterCounts {
  const favSet = new Set(favorites || [])
  const counts: FilterCounts = {
    all: cards.length,
    'curated-material': 0,
    'canvas-scene': 0,
    'personal-media': 0,
    'ai-html': 0,
    favorites: 0,
    custom: 0,
  }
  for (const key of FILTER_ORDER) {
    if (key === 'all') continue
    counts[key] = cards.filter((c) => matchesFilter(c, key, favSet)).length
  }
  return counts
}

/** Filters worth showing as chips: "all" always, every other one only when it holds cards. */
export function visibleFilterKeys(counts: FilterCounts): GalleryFilterCategory[] {
  return FILTER_ORDER.filter((key) => key === 'all' || counts[key] > 0)
}

/** The chip row is pointless when no chip would narrow the list ("all" alone, or one category equal to it). */
export function shouldShowFilterRow(counts: FilterCounts): boolean {
  const others = visibleFilterKeys(counts).filter((key) => key !== 'all')
  return others.length > 1 || others.some((key) => counts[key] < counts.all)
}

/** A filter whose category emptied out (e.g. last favorite removed) falls back to "all". */
export function resolveActiveFilter(
  wanted: GalleryFilterCategory,
  counts: FilterCounts,
): GalleryFilterCategory {
  return wanted === 'all' || counts[wanted] > 0 ? wanted : 'all'
}

export type ApplyScope = 'all' | OpeningApp

type PrefsLike = {
  globalCard?: string
  appOverrides?: Partial<Record<OpeningApp, string>>
  scenes?: Partial<Record<OpeningApp, string>>
}

/**
 * The card an app plays: its own choice, else the one for all apps, else (older settings) the
 * scene saved for it, else the app's stock scene. The same order the opening window uses.
 */
export function effectiveCardId(prefs: PrefsLike, app: OpeningApp): string {
  const own = prefs.appOverrides?.[app]
  if (own && own !== 'inherit') return own
  if (prefs.globalCard) return prefs.globalCard
  const saved = prefs.scenes?.[app]
  if (saved && saved !== 'inherit' && saved !== DEFAULT_SCENE_FOR_APP[app]) return saved
  return DEFAULT_SCENE_FOR_APP[app]
}

/** The apps that play this card right now, in the usual app order. */
export function appsUsingCard(prefs: PrefsLike, cardId: string): OpeningApp[] {
  return OPENING_APPS.filter((app) => effectiveCardId(prefs, app) === cardId)
}

/**
 * Cards that some app plays come first (the one used by the most apps, then the usual app order),
 * the rest keep their order. Stable, so a list that is already in order does not move.
 */
export function orderInUseFirst<T extends { id: string }>(
  cards: readonly T[],
  prefs: PrefsLike,
): T[] {
  const rank = new Map<string, number>()
  OPENING_APPS.forEach((app, index) => {
    const id = effectiveCardId(prefs, app)
    if (!rank.has(id)) rank.set(id, index)
  })
  const used = (card: T) => appsUsingCard(prefs, card.id).length
  const inUse = cards
    .filter((card) => rank.has(card.id))
    .sort((a, b) => used(b) - used(a) || (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
  return [...inUse, ...cards.filter((card) => !rank.has(card.id))]
}

/** Whether "Use this card" would change nothing: every app in that scope already plays the card. */
export function appliesTo(scope: ApplyScope, prefs: PrefsLike, cardId: string): boolean {
  if (scope === 'all') return OPENING_APPS.every((app) => effectiveCardId(prefs, app) === cardId)
  return effectiveCardId(prefs, scope) === cardId
}

export type AssignmentStatus =
  | { kind: 'global-overridden' }
  | { kind: 'global'; overrides: number }
  | { kind: 'app' }
  | { kind: 'none' }

export function assignmentStatus(state: {
  isGlobalDefault: boolean
  hasAppOverride: boolean
  activeAppHasOtherOverride: boolean
  overrideCount: number
}): AssignmentStatus {
  if (state.isGlobalDefault) {
    if (state.activeAppHasOtherOverride) return { kind: 'global-overridden' }
    return { kind: 'global', overrides: state.overrideCount }
  }
  return state.hasAppOverride ? { kind: 'app' } : { kind: 'none' }
}
