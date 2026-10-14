import { SCENES } from './opening-scenes-meta'
import type { OpeningCardDefinition } from './opening-card-types'

/**
 * 12 Curated Card Styles (Section 5 of spec):
 * Clean, serene, monochromatic, calm and premium materials without excessive saturation.
 */
export const CURATED_CARD_FAMILIES: readonly OpeningCardDefinition[] = [
  {
    id: 'curated:frosted-blue',
    name: 'Frosted Blue',
    description: 'Subtle translucent glass with icy blue undertones and ambient refraction',
    category: 'curated',
    contentKind: 'curated-material',
    material: {
      preset: 'frosted-glass',
      themeMode: 'system',
      opacity: 0.82,
      blurPx: 22,
      accentColor: '#3a82ee',
      borderRadiusPx: 18,
      borderWidthPx: 1,
      borderColor: 'rgba(255, 255, 255, 0.16)',
      shadowIntensity: 0.35,
    },
    thumbnailColors: ['#12243d', '#204675'],
    isBuiltIn: true,
    tags: ['glass', 'blue', 'frosted', 'calm'],
  },
  {
    id: 'curated:crystal-white',
    name: 'Crystal White',
    description: 'Pure translucent crystalline panel with bright frosted edges and airy sheen',
    category: 'curated',
    contentKind: 'curated-material',
    material: {
      preset: 'frosted-glass',
      themeMode: 'light',
      opacity: 0.88,
      blurPx: 26,
      accentColor: '#2b7cd3',
      borderRadiusPx: 18,
      borderWidthPx: 1,
      borderColor: 'rgba(255, 255, 255, 0.65)',
      shadowIntensity: 0.22,
    },
    thumbnailColors: ['#ebf2fa', '#dce7f5'],
    isBuiltIn: true,
    tags: ['light', 'white', 'crystal', 'pure'],
  },
  {
    id: 'curated:graphite',
    name: 'Graphite',
    description: 'Deep neutral charcoal finish with fine edge highlights and understated presence',
    category: 'curated',
    contentKind: 'curated-material',
    material: {
      preset: 'minimal-monochrome',
      themeMode: 'dark',
      opacity: 0.94,
      blurPx: 16,
      accentColor: '#8a94a6',
      borderRadiusPx: 16,
      borderWidthPx: 1,
      borderColor: 'rgba(255, 255, 255, 0.08)',
      shadowIntensity: 0.5,
    },
    thumbnailColors: ['#181a1f', '#2a2e36'],
    isBuiltIn: true,
    tags: ['dark', 'graphite', 'neutral', 'monochrome'],
  },
  {
    id: 'curated:midnight-glass',
    name: 'Midnight Glass',
    description: 'Deep celestial obsidian glass with deep-space depth and subtle perimeter luster',
    category: 'curated',
    contentKind: 'curated-material',
    material: {
      preset: 'liquid-glass',
      themeMode: 'dark',
      opacity: 0.85,
      blurPx: 28,
      accentColor: '#5374a8',
      borderRadiusPx: 20,
      borderWidthPx: 1,
      borderColor: 'rgba(160, 190, 240, 0.18)',
      shadowIntensity: 0.6,
    },
    thumbnailColors: ['#0a0e17', '#131e33'],
    isBuiltIn: true,
    tags: ['dark', 'midnight', 'liquid', 'glass'],
  },
  {
    id: 'curated:soft-lavender',
    name: 'Soft Lavender',
    description: 'Muted botanical lavender tone balanced with gentle frosted diffusion',
    category: 'curated',
    contentKind: 'curated-material',
    material: {
      preset: 'frosted-glass',
      themeMode: 'system',
      opacity: 0.86,
      blurPx: 24,
      accentColor: '#8b7ec8',
      borderRadiusPx: 18,
      borderWidthPx: 1,
      borderColor: 'rgba(255, 255, 255, 0.22)',
      shadowIntensity: 0.3,
    },
    thumbnailColors: ['#1a162b', '#2c2242'],
    isBuiltIn: true,
    tags: ['lavender', 'soft', 'purple', 'frosted'],
  },
  {
    id: 'curated:clean-paper',
    name: 'Clean Paper',
    description: 'Editorial tactile card inspired by heavy archival parchment and bookcraft',
    category: 'curated',
    contentKind: 'curated-material',
    material: {
      preset: 'solid',
      themeMode: 'light',
      opacity: 0.98,
      blurPx: 0,
      accentColor: '#344054',
      borderRadiusPx: 14,
      borderWidthPx: 1,
      borderColor: 'rgba(0, 0, 0, 0.09)',
      shadowIntensity: 0.18,
    },
    thumbnailColors: ['#faf8f5', '#efece6'],
    isBuiltIn: true,
    tags: ['paper', 'editorial', 'solid', 'minimal'],
  },
  {
    id: 'curated:floating-card',
    name: 'Floating Card',
    description: 'High-elevation surface hovering weightlessly with diffused atmospheric shadow',
    category: 'curated',
    contentKind: 'curated-material',
    material: {
      preset: 'solid',
      themeMode: 'system',
      opacity: 0.96,
      blurPx: 12,
      accentColor: '#2b7cd3',
      borderRadiusPx: 22,
      borderWidthPx: 1,
      borderColor: 'rgba(255, 255, 255, 0.12)',
      shadowIntensity: 0.7,
    },
    thumbnailColors: ['#1f242d', '#2d3542'],
    isBuiltIn: true,
    tags: ['elevation', 'floating', 'shadow', 'modern'],
  },
  {
    id: 'curated:pastel-gradient',
    name: 'Pastel Gradient',
    description: 'Ultra-gentle monochromatic pastel gradient transitioning between mist and dusk',
    category: 'curated',
    contentKind: 'curated-material',
    material: {
      preset: 'frosted-glass',
      themeMode: 'system',
      opacity: 0.88,
      blurPx: 20,
      accentColor: '#4f8ec9',
      borderRadiusPx: 18,
      borderWidthPx: 1,
      borderColor: 'rgba(255, 255, 255, 0.2)',
      shadowIntensity: 0.28,
    },
    thumbnailColors: ['#1a2333', '#2b394e'],
    isBuiltIn: true,
    tags: ['pastel', 'gradient', 'serene', 'subtle'],
  },
  {
    id: 'curated:silk',
    name: 'Silk',
    description: 'Smooth liquid surface reflecting light with fluid sheen and organic luster',
    category: 'curated',
    contentKind: 'curated-material',
    material: {
      preset: 'liquid-glass',
      themeMode: 'system',
      opacity: 0.84,
      blurPx: 25,
      accentColor: '#6395ee',
      borderRadiusPx: 20,
      borderWidthPx: 1,
      borderColor: 'rgba(255, 255, 255, 0.25)',
      shadowIntensity: 0.4,
    },
    thumbnailColors: ['#152030', '#25354d'],
    isBuiltIn: true,
    tags: ['silk', 'liquid', 'organic', 'sheen'],
  },
  {
    id: 'curated:minimal-white',
    name: 'Minimal White',
    description: 'Disciplined architectural white plane with hairline border and zero noise',
    category: 'curated',
    contentKind: 'curated-material',
    material: {
      preset: 'minimal-monochrome',
      themeMode: 'light',
      opacity: 1.0,
      blurPx: 0,
      accentColor: '#1d2939',
      borderRadiusPx: 12,
      borderWidthPx: 1,
      borderColor: 'rgba(0, 0, 0, 0.1)',
      shadowIntensity: 0.15,
    },
    thumbnailColors: ['#ffffff', '#f4f5f7'],
    isBuiltIn: true,
    tags: ['white', 'minimal', 'monochrome', 'clean'],
  },
  {
    id: 'curated:minimal-black',
    name: 'Minimal Black',
    description: 'Pure monochromatic pitch card designed for OLED contrast and high focus',
    category: 'curated',
    contentKind: 'curated-material',
    material: {
      preset: 'minimal-monochrome',
      themeMode: 'dark',
      opacity: 1.0,
      blurPx: 0,
      accentColor: '#98a2b3',
      borderRadiusPx: 12,
      borderWidthPx: 1,
      borderColor: 'rgba(255, 255, 255, 0.12)',
      shadowIntensity: 0.4,
    },
    thumbnailColors: ['#000000', '#101216'],
    isBuiltIn: true,
    tags: ['black', 'minimal', 'monochrome', 'oled'],
  },
  {
    id: 'curated:soft-glow',
    name: 'Soft Glow',
    description: 'Atmospheric breathing aura gently pulsating behind fine frosted acrylic',
    category: 'curated',
    contentKind: 'curated-material',
    material: {
      preset: 'frosted-glass',
      themeMode: 'dark',
      opacity: 0.86,
      blurPx: 24,
      accentColor: '#4a85f6',
      borderRadiusPx: 18,
      borderWidthPx: 1,
      borderColor: 'rgba(120, 170, 255, 0.25)',
      shadowIntensity: 0.5,
    },
    thumbnailColors: ['#0d1728', '#1c2d47'],
    isBuiltIn: true,
    tags: ['glow', 'aura', 'frosted', 'ambient'],
  },
]

/**
 * The 32 Canvas Scene Cards:
 * Preserves every existing scene and encapsulates it into an OpeningCardDefinition.
 */
let cachedCanvasCards: OpeningCardDefinition[] | null = null

export function getCanvasSceneCards(): readonly OpeningCardDefinition[] {
  if (!cachedCanvasCards) {
    cachedCanvasCards = SCENES.map((scene) => ({
      id: scene.id,
      name: scene.en.split(':')[0] ?? scene.id,
      description: scene.en,
      category: 'canvas',
      contentKind: 'canvas-scene',
      sceneId: scene.id,
      material: {
        preset: 'solid',
        themeMode: 'dark',
        opacity: 1.0,
        blurPx: 0,
        borderRadiusPx: 18,
        borderWidthPx: 1,
        borderColor: 'rgba(255, 255, 255, 0.1)',
        shadowIntensity: 0.4,
      },
      thumbnailColors: scene.bg,
      isBuiltIn: true,
      tags: ['animated', 'canvas', scene.id],
    }))
  }
  return cachedCanvasCards
}

export function getAllBuiltInCards(): readonly OpeningCardDefinition[] {
  return [...CURATED_CARD_FAMILIES, ...getCanvasSceneCards()]
}

export function getBuiltInCard(id: string): OpeningCardDefinition | undefined {
  const curated = CURATED_CARD_FAMILIES.find((c) => c.id === id)
  if (curated) return curated
  return getCanvasSceneCards().find((c) => c.id === id)
}

export function isBuiltInCard(id: string): boolean {
  return CURATED_CARD_FAMILIES.some((c) => c.id === id) || SCENES.some((s) => s.id === id)
}
