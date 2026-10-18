/**
 * The opening scenes on offer and the person's choices about them. Plain data, shared by the main
 * process (which plays the scene) and the settings page (which lets the person pick one).
 */
export type OpeningApp = 'docs' | 'sheets' | 'slides' | 'pdf' | 'markdown' | 'html'
export const OPENING_APPS: readonly OpeningApp[] = [
  'docs',
  'sheets',
  'slides',
  'pdf',
  'markdown',
  'html',
]

export interface SceneMeta {
  id: string
  vi: string
  en: string
  /** page background behind the scene: top-left and middle */
  bg: [string, string]
}

export const SCENES: SceneMeta[] = [
  {
    id: 'ocean',
    vi: 'Đại dương: sứa, cá, tia nắng',
    en: 'Ocean: jellyfish, fish, light rays',
    bg: ['#041427', '#0a3b66'],
  },
  {
    id: 'aurora',
    vi: 'Đêm sao và cực quang',
    en: 'Starry night and aurora',
    bg: ['#050914', '#0c1d3d'],
  },
  {
    id: 'moonsea',
    vi: 'Biển đêm trăng, thuyền buồm',
    en: 'Moonlit sea and a sailboat',
    bg: ['#050b1a', '#0d2a4e'],
  },
  { id: 'lotus', vi: 'Hồ sen và cá chép', en: 'Lotus pond and koi', bg: ['#06222a', '#0c4a52'] },
  {
    id: 'mountains',
    vi: 'Núi sương lúc bình minh',
    en: 'Misty mountains at dawn',
    bg: ['#1b2a4a', '#56739c'],
  },
  { id: 'pages', vi: 'Trang giấy bay', en: 'Drifting pages', bg: ['#0a1630', '#16295a'] },
  {
    id: 'snow',
    vi: 'Tuyết rơi đêm, nhà gỗ',
    en: 'Snowy night, log cabin',
    bg: ['#0a1226', '#1d3358'],
  },
  {
    id: 'jungle',
    vi: 'Rừng đêm, đom đóm',
    en: 'Night jungle, fireflies',
    bg: ['#03130c', '#0b3a22'],
  },
  {
    id: 'rice',
    vi: 'Ruộng lúa chiều, cò bay',
    en: 'Rice field at dusk, egrets',
    bg: ['#33200e', '#8a6126'],
  },
  {
    id: 'bamboo',
    vi: 'Rừng tre trong sương',
    en: 'Bamboo grove in mist',
    bg: ['#06150f', '#1a4a36'],
  },
  { id: 'butterflies', vi: 'Vườn bướm', en: 'Butterfly garden', bg: ['#0a2418', '#2a6a3a'] },
  { id: 'grid', vi: 'Lưới ô sáng lan sóng', en: 'Rippling cell grid', bg: ['#031510', '#0a3324'] },
  { id: 'matrix', vi: 'Mưa số', en: 'Digital rain', bg: ['#020a06', '#06180f'] },
  {
    id: 'sunrise',
    vi: 'Bình minh, khinh khí cầu',
    en: 'Sunrise, hot-air balloons',
    bg: ['#2b1233', '#7d3140'],
  },
  { id: 'cloudsea', vi: 'Biển mây', en: 'Sea of clouds', bg: ['#2a1b45', '#a45a70'] },
  { id: 'kites', vi: 'Thả diều', en: 'Flying kites', bg: ['#0f3a6e', '#3c8fd0'] },
  {
    id: 'sunsetbeach',
    vi: 'Hoàng hôn trên biển, dừa',
    en: 'Beach sunset, palms',
    bg: ['#2a1238', '#c4553f'],
  },
  { id: 'leaves', vi: 'Lá thu rơi', en: 'Autumn leaves', bg: ['#220c0c', '#5a1f1b'] },
  { id: 'lanterns', vi: 'Đèn lồng bay', en: 'Floating lanterns', bg: ['#080c24', '#1c2a5e'] },
  {
    id: 'fireworks',
    vi: 'Pháo hoa bên sông',
    en: 'Fireworks by the river',
    bg: ['#050612', '#101a3a'],
  },
  { id: 'city', vi: 'Thành phố đêm', en: 'City at night', bg: ['#070912', '#17203a'] },
  {
    id: 'rain',
    vi: 'Mưa đêm bên cửa sổ',
    en: 'Rain on the window at night',
    bg: ['#0a1020', '#1b2a44'],
  },
  {
    id: 'campfire',
    vi: 'Lửa trại dưới sao',
    en: 'Campfire under the stars',
    bg: ['#050a18', '#122044'],
  },
  { id: 'desert', vi: 'Sa mạc đêm trăng', en: 'Desert under the moon', bg: ['#0b0f2a', '#5a3a52'] },
  { id: 'galaxy', vi: 'Thiên hà xoáy', en: 'Spiral galaxy', bg: ['#05040d', '#150f2e'] },
  {
    id: 'warp',
    vi: 'Du hành tốc độ ánh sáng',
    en: 'Light-speed travel',
    bg: ['#02030a', '#0a1030'],
  },
  {
    id: 'synthwave',
    vi: 'Synthwave: mặt trời và lưới đường',
    en: 'Synthwave sun and grid',
    bg: ['#12062b', '#3a0f5c'],
  },
  { id: 'waves', vi: 'Sóng neon', en: 'Neon waves', bg: ['#060a1a', '#101a40'] },
  { id: 'lava', vi: 'Đèn dung nham', en: 'Lava lamp', bg: ['#14061a', '#34102e'] },
  { id: 'bubbles', vi: 'Bong bóng xà phòng', en: 'Soap bubbles', bg: ['#0c1424', '#223a5c'] },
  { id: 'ink', vi: 'Mực loang trong nước', en: 'Ink in water', bg: ['#070b1a', '#13204a'] },
  {
    id: 'sakura',
    vi: 'Hoa anh đào rơi',
    en: 'Falling cherry blossoms',
    bg: ['#1a0f1f', '#4a2440'],
  },
]

/** The scene each app plays until the person picks another. */
export const DEFAULT_SCENE_FOR_APP: Record<OpeningApp, string> = {
  docs: 'snow',
  sheets: 'jungle',
  slides: 'sunrise',
  pdf: 'leaves',
  markdown: 'city',
  html: 'aurora',
}

/** The id that stands for the HTML page the person imported for an app. */
export const CUSTOM_SCENE = 'custom'

export type OpeningTierChoice = 'auto' | 'full' | 'lite' | 'minimal'

import type { EffectiveOpeningCard, OpeningCardDefinition } from './opening-card-types'
import { isBuiltInCard } from './opening-card-families'

export interface OpeningPrefs {
  /** the scene over a tab while its file opens; off = nothing */
  enabled: boolean
  /** how rich the animation is: by what the machine can afford, or fixed */
  tier: OpeningTierChoice
  /** per app: a scene id, card id, or `custom` for the imported page */
  scenes: Record<OpeningApp, string>
  /** optional global card ID */
  globalCard?: string
  /** explicit per-app overrides; absent/inherit means app uses globalCard (or default app scene) */
  appOverrides?: Partial<Record<OpeningApp, string>>
  /** user's favorited card IDs */
  favorites?: string[]
  /** custom user cards registered in the studio */
  customCards?: OpeningCardDefinition[]
}

export const DEFAULT_OPENING_PREFS: OpeningPrefs = {
  enabled: true,
  tier: 'auto',
  scenes: { ...DEFAULT_SCENE_FOR_APP },
}

export const sceneMeta = (id: string): SceneMeta => SCENES.find((s) => s.id === id) ?? SCENES[0]!

export const VALID_CUSTOM_CARD_ID_RE =
  /^(?:ai:[a-zA-Z0-9_-]{1,80}|custom:[a-zA-Z0-9_-]{1,80}|media_[a-zA-Z0-9_-]{1,80})$/

export const knownSceneOrCard = (id: unknown, prefs?: OpeningPrefs): id is string => {
  if (typeof id !== 'string' || !id || id.length > 100) return false
  if (id === CUSTOM_SCENE || SCENES.some((s) => s.id === id) || isBuiltInCard(id)) {
    return true
  }
  // Curated cards are strictly built-in; non-built-in curated IDs are invalid
  if (id.startsWith('curated:')) {
    return false
  }
  if (prefs && Array.isArray(prefs.customCards)) {
    return prefs.customCards.some((c) => c.id === id)
  }
  return VALID_CUSTOM_CARD_ID_RE.test(id)
}

export const isCardOrSceneAvailable = (id: unknown, prefs?: OpeningPrefs): id is string => {
  if (typeof id !== 'string' || !id || id.length > 100) return false
  if (id === CUSTOM_SCENE || SCENES.some((s) => s.id === id) || isBuiltInCard(id)) {
    return true
  }
  // Curated cards are strictly built-in; non-built-in curated IDs are invalid
  if (id.startsWith('curated:')) {
    return false
  }
  if (prefs && Array.isArray(prefs.customCards)) {
    return prefs.customCards.some((c) => c.id === id)
  }
  return false
}

/**
 * Resolves the effective opening card or scene for a given app.
 * Canonical precedence hierarchy:
 * 1. Explicit preview scene (options.scene, e.g. from preview modal)
 * 2. Explicit per-app override in appOverrides (highest precedence for configured choices)
 * 3. Global Default card (prefs.globalCard if set and valid)
 * 4. Legacy per-app scene preference (when no globalCard is set)
 * 5. Application default scene (DEFAULT_SCENE_FOR_APP[app])
 */
export function resolveEffectiveOpeningCard(
  prefs: OpeningPrefs,
  app: OpeningApp,
  previewScene?: string,
): EffectiveOpeningCard {
  // 1. Explicit preview scene
  if (previewScene && isCardOrSceneAvailable(previewScene, prefs)) {
    return { id: previewScene, source: 'preview', isOverride: false }
  }

  // 2. Explicit per-app override in appOverrides
  const override = prefs.appOverrides?.[app]
  if (override && override !== 'inherit' && isCardOrSceneAvailable(override, prefs)) {
    return { id: override, source: 'override', isOverride: true }
  }

  // 3. Global Default card (applies to all apps without explicit override)
  if (prefs.globalCard && isCardOrSceneAvailable(prefs.globalCard, prefs)) {
    return { id: prefs.globalCard, source: 'global', isOverride: false }
  }

  // 4. Legacy per-app scene preference (when no globalCard is configured)
  const legacyScene = prefs.scenes?.[app]
  if (
    legacyScene &&
    legacyScene !== 'inherit' &&
    legacyScene !== DEFAULT_SCENE_FOR_APP[app] &&
    isCardOrSceneAvailable(legacyScene, prefs)
  ) {
    return { id: legacyScene, source: 'override', isOverride: true }
  }

  // 5. Default application scene
  return {
    id: DEFAULT_SCENE_FOR_APP[app],
    source: 'default',
    isOverride: false,
  }
}

const FORBIDDEN_PATTERN = /<script|javascript:|on\w+=|<\/|<[a-z]|expression\(|eval\(/i

const isSafeCardDefinition = (c: unknown): c is OpeningCardDefinition => {
  if (!c || typeof c !== 'object') return false
  const card = c as Record<string, unknown>
  return (
    typeof card.id === 'string' &&
    card.id.length > 0 &&
    card.id.length <= 100 &&
    typeof card.name === 'string' &&
    card.name.length > 0 &&
    card.name.length <= 60 &&
    !FORBIDDEN_PATTERN.test(card.name) &&
    card.material !== null &&
    typeof card.material === 'object' &&
    !Array.isArray(card.material)
  )
}

/** Whatever was stored (possibly old, partial or hand-edited) as safe preferences. */
export function normalizeOpeningPrefs(stored: unknown): OpeningPrefs {
  const value = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>
  const customCards = Array.isArray(value.customCards)
    ? value.customCards.filter(isSafeCardDefinition)
    : undefined

  const validationPrefs: OpeningPrefs = {
    enabled: value.enabled !== false,
    tier: 'auto',
    scenes: { ...DEFAULT_SCENE_FOR_APP },
    ...(customCards !== undefined ? { customCards } : {}),
  }

  const isAcceptableStoredCard = (id: unknown): id is string => {
    if (typeof id !== 'string' || !id || id.length > 100) return false
    if (isCardOrSceneAvailable(id, validationPrefs)) return true
    if (customCards === undefined && VALID_CUSTOM_CARD_ID_RE.test(id)) return true
    return false
  }

  const scenes = (value.scenes && typeof value.scenes === 'object' ? value.scenes : {}) as Record<
    string,
    unknown
  >
  const tier = value.tier
  const res: OpeningPrefs = {
    enabled: value.enabled !== false,
    tier: tier === 'full' || tier === 'lite' || tier === 'minimal' ? tier : 'auto',
    scenes: Object.fromEntries(
      OPENING_APPS.map((app) => [
        app,
        isAcceptableStoredCard(scenes[app]) ? (scenes[app] as string) : DEFAULT_SCENE_FOR_APP[app],
      ]),
    ) as Record<OpeningApp, string>,
    ...(customCards !== undefined && customCards.length > 0 ? { customCards } : {}),
  }
  if (typeof value.globalCard === 'string' && isAcceptableStoredCard(value.globalCard)) {
    res.globalCard = value.globalCard
  }
  if (value.appOverrides && typeof value.appOverrides === 'object') {
    const rawOverrides = value.appOverrides as Record<string, unknown>
    const appOverrides: Partial<Record<OpeningApp, string>> = {}
    for (const app of OPENING_APPS) {
      const val = rawOverrides[app]
      if (typeof val === 'string' && (val === 'inherit' || isAcceptableStoredCard(val))) {
        appOverrides[app] = val
      }
    }
    if (Object.keys(appOverrides).length > 0) {
      res.appOverrides = appOverrides
    }
  }
  if (Array.isArray(value.favorites)) {
    res.favorites = Array.from(
      new Set(
        value.favorites.filter(
          (f): f is string => typeof f === 'string' && isAcceptableStoredCard(f),
        ),
      ),
    )
  }
  return res
}
