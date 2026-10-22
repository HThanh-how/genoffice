import { getAllBuiltInCards } from './opening-card-families'
import type { OpeningCardDefinition } from './opening-card-types'
import {
  OPENING_APPS,
  resolveEffectiveOpeningCard,
  type OpeningApp,
  type OpeningPrefs,
  type OpeningRandomPool,
  type OpeningScope,
} from './opening-scenes-meta'

/**
 * Groups of cards. The built-in ones come from what the cards are (materials, and the scenes by
 * subject); the person can add groups of their own and move any card into one. A card is in exactly
 * one group. "Starred" is not a group but a filter, so a starred card stays in its group too.
 */
export interface BuiltInGroup {
  id: string
  en: string
  vi: string
}

export const BUILT_IN_GROUPS: readonly BuiltInGroup[] = [
  { id: 'materials', en: 'Materials', vi: 'Chất liệu' },
  { id: 'nature', en: 'Nature', vi: 'Thiên nhiên' },
  { id: 'sky', en: 'Sky & sea', vi: 'Trời & biển' },
  { id: 'night', en: 'Night & city', vi: 'Đêm & phố' },
  { id: 'space', en: 'Space & neon', vi: 'Vũ trụ & neon' },
  { id: 'abstract', en: 'Soft & abstract', vi: 'Mềm & trừu tượng' },
  { id: 'mine', en: 'My cards', vi: 'Thẻ của tôi' },
]

const SCENE_GROUP: Record<string, string> = {
  ocean: 'nature',
  lotus: 'nature',
  jungle: 'nature',
  rice: 'nature',
  bamboo: 'nature',
  butterflies: 'nature',
  leaves: 'nature',
  sakura: 'nature',
  mountains: 'nature',
  aurora: 'sky',
  moonsea: 'sky',
  sunrise: 'sky',
  cloudsea: 'sky',
  sunsetbeach: 'sky',
  desert: 'sky',
  kites: 'sky',
  snow: 'night',
  city: 'night',
  rain: 'night',
  campfire: 'night',
  lanterns: 'night',
  fireworks: 'night',
  galaxy: 'space',
  warp: 'space',
  synthwave: 'space',
  waves: 'space',
  grid: 'space',
  matrix: 'space',
  lava: 'abstract',
  bubbles: 'abstract',
  ink: 'abstract',
  pages: 'abstract',
}

/** The built-in group of a card, before any move by the person. */
export function builtInGroupOf(card: Pick<OpeningCardDefinition, 'id' | 'isBuiltIn'>): string {
  if (!card.isBuiltIn) return 'mine'
  if (card.id.startsWith('curated:')) return 'materials'
  return SCENE_GROUP[card.id] ?? 'abstract'
}

/** The group a card is shown in: one of the person's, else its built-in one. */
export function groupOf(
  card: Pick<OpeningCardDefinition, 'id' | 'isBuiltIn'>,
  prefs: Pick<OpeningPrefs, 'groups' | 'cardGroups'>,
): string {
  const own = prefs.cardGroups?.[card.id]
  if (own && prefs.groups?.some((g) => g.id === own)) return own
  return builtInGroupOf(card)
}

export function groupName(id: string, prefs: Pick<OpeningPrefs, 'groups'>, lang: string): string {
  const own = prefs.groups?.find((g) => g.id === id)
  if (own) return own.name
  const builtIn = BUILT_IN_GROUPS.find((g) => g.id === id)
  return builtIn ? (lang === 'vi' ? builtIn.vi : builtIn.en) : id
}

/** The groups worth showing, in order: built-in ones that hold a card, then the person's own (empty or not). */
export function visibleGroupIds(
  cards: readonly OpeningCardDefinition[],
  prefs: Pick<OpeningPrefs, 'groups' | 'cardGroups' | 'removedCards'>,
): string[] {
  const used = new Set(
    cards.filter((card) => !prefs.removedCards?.includes(card.id)).map((c) => groupOf(c, prefs)),
  )
  return [
    ...BUILT_IN_GROUPS.filter((g) => used.has(g.id)).map((g) => g.id),
    ...(prefs.groups ?? []).map((g) => g.id),
  ]
}

export const isRemoved = (prefs: Pick<OpeningPrefs, 'removedCards'>, id: string): boolean =>
  Boolean(prefs.removedCards?.includes(id))

/** The cards a random choice may play: not in the trash, in one of the groups (any when none are named), starred when asked. */
export function randomCandidates(
  cards: readonly OpeningCardDefinition[],
  prefs: OpeningPrefs,
  pool: OpeningRandomPool,
): OpeningCardDefinition[] {
  const favorites = new Set(prefs.favorites ?? [])
  const wanted = new Set(pool.groups)
  return cards.filter(
    (card) =>
      !isRemoved(prefs, card.id) &&
      (wanted.size === 0 || wanted.has(groupOf(card, prefs))) &&
      (!pool.starredOnly || favorites.has(card.id)),
  )
}

/**
 * One card of the pool, not the one played last time when there is another to play. `random` is a
 * number in [0, 1), the browser's or a test's.
 */
export function pickRandomCard<T extends { id: string }>(
  candidates: readonly T[],
  lastId?: string,
  random: () => number = Math.random,
): T | undefined {
  if (candidates.length === 0) return undefined
  const fresh = candidates.length > 1 ? candidates.filter((c) => c.id !== lastId) : candidates
  return fresh[Math.min(fresh.length - 1, Math.floor(random() * fresh.length))]
}

/**
 * The random pool an app plays from, or none. A setting for the app itself wins; a card chosen for
 * the app (not "inherit") wins over a random choice made for all apps.
 */
export function randomPoolFor(
  prefs: Pick<OpeningPrefs, 'random' | 'appOverrides'>,
  app: OpeningApp,
): OpeningRandomPool | undefined {
  const own = prefs.random?.[app]
  if (own) return own
  const fixed = prefs.appOverrides?.[app]
  if (fixed && fixed !== 'inherit') return undefined
  return prefs.random?.all
}

/** The apps that play from a random pool right now. */
export function appsShuffling(prefs: Pick<OpeningPrefs, 'random' | 'appOverrides'>): OpeningApp[] {
  return OPENING_APPS.filter((app) => randomPoolFor(prefs, app))
}

/**
 * The card an app plays this time. A preview always plays what it was asked to. Otherwise, an app
 * set to random draws from its pool (remembering what it drew in `lastPicks`, so the next open
 * differs while there is a choice), and anything else plays its fixed card. An empty pool plays the
 * fixed card too, so an app never opens with nothing.
 */
export function chooseOpeningCardId(
  prefs: OpeningPrefs,
  app: OpeningApp,
  previewScene: string | undefined,
  lastPicks: Map<OpeningApp, string>,
  random: () => number = Math.random,
): string {
  const fixed = resolveEffectiveOpeningCard(prefs, app, previewScene)
  if (fixed.source === 'preview') return fixed.id
  const pool = randomPoolFor(prefs, app)
  if (pool) {
    const everything = [...getAllBuiltInCards(), ...(prefs.customCards ?? [])]
    const pick = pickRandomCard(
      randomCandidates(everything, prefs, pool),
      lastPicks.get(app),
      random,
    )
    if (pick) {
      lastPicks.set(app, pick.id)
      return pick.id
    }
  }
  return fixed.id
}

/** The pool a scope is set to (for the scope itself, not the apps under it). */
export const randomSettingOf = (
  prefs: Pick<OpeningPrefs, 'random'>,
  scope: OpeningScope,
): OpeningRandomPool | undefined => prefs.random?.[scope]
