export type OpeningMaterialPreset =
  'solid' | 'frosted-glass' | 'liquid-glass' | 'minimal-monochrome'

export type OpeningThemeMode = 'light' | 'dark' | 'system'

export type CardContentKind =
  'canvas-scene' | 'curated-material' | 'personal-media' | 'ai-declarative' | 'custom-html'

export type CardCategory = 'canvas' | 'curated' | 'media' | 'ai' | 'custom'

export interface OpeningMaterialConfig {
  preset: OpeningMaterialPreset
  themeMode?: OpeningThemeMode
  /** Card background opacity (0.1 to 1.0) */
  opacity?: number
  /** Card blur intensity in pixels (0 to 50) */
  blurPx?: number
  /** Primary accent color in hex format (e.g. #2b7cd3) */
  accentColor?: string
  /** Card corner radius in pixels (8 to 36) */
  borderRadiusPx?: number
  /** Subtle border stroke width in pixels (0 to 4) */
  borderWidthPx?: number
  /** Optional border color override (rgba or hex) */
  borderColor?: string
  /** Drop shadow intensity factor (0.0 to 1.0) */
  shadowIntensity?: number
  /** Accessibility fallback: disables blur and enforces high-opacity solid background */
  reduceTransparency?: boolean
}

export interface OpeningCardDefinition {
  id: string
  name: string
  description?: string
  category: CardCategory
  contentKind: CardContentKind
  /** Reference to one of the 32 Canvas scenes (when contentKind === 'canvas-scene') */
  sceneId?: string
  /** ID or filename of personal media asset in app storage (when contentKind === 'personal-media' or 'ai-declarative') */
  mediaAssetId?: string
  /** How media fits within the card: cover, contain, or center */
  mediaFit?: 'cover' | 'contain' | 'center'
  /** Darkening overlay over the media to keep text readable (0.0 to 0.9) */
  mediaDim?: number
  /** Material appearance configuration */
  material: OpeningMaterialConfig
  /** Static preview gradient or color stops for lightweight gallery rendering */
  thumbnailColors?: [string, string]
  /** Creation epoch timestamp */
  createdAt?: number
  /** Built-in cards cannot be deleted by the user */
  isBuiltIn?: boolean
  /** Searchable tags */
  tags?: string[]
}

export interface OpeningStudioPrefsExtension {
  /** Optional global default card ID applied to all apps unless specifically overridden */
  globalCard?: string
  /** List of card IDs favorited by the user */
  favorites?: string[]
  /** Custom cards created or imported by the user */
  customCards?: OpeningCardDefinition[]
}

export interface StoredMediaAsset {
  assetId: string
  mime: string
  sizeBytes: number
  dataUrl?: string
}

export interface OpeningMediaAssetInfo {
  id: string
  fileName: string
  mime: string
  sizeBytes: number
  createdAt: number
}

export interface AiCardGenerationInput {
  prompt: string
  accentColor?: string
  preset?: OpeningMaterialPreset
  themeMode?: OpeningThemeMode
}

export interface AiCardGenerationResult {
  ok: boolean
  card?: OpeningCardDefinition
  error?: string
}
