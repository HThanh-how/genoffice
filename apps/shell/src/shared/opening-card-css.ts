import type {
  OpeningMaterialConfig,
  OpeningMaterialPreset,
  OpeningShadowStyle,
  OpeningThemeMode,
} from './opening-card-types'

function clamp(val: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof val !== 'number' || Number.isNaN(val)) return fallback
  return Math.max(min, Math.min(max, val))
}

export function sanitizeHexColor(hex: string | undefined, fallback = '#2b7cd3'): string {
  if (!hex || typeof hex !== 'string') return fallback
  const clean = hex.trim()
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(clean)) return clean
  return fallback
}

export function sanitizeBorderColor(color: string | undefined, fallback: string): string {
  if (!color || typeof color !== 'string') return fallback
  const clean = color.trim()
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(clean)) return clean
  if (
    /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+)\s*)?\)$/i.test(clean)
  ) {
    return clean
  }
  return fallback
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let c = hex.replace('#', '')
  if (c.length === 3) {
    c = c
      .split('')
      .map((char) => char + char)
      .join('')
  }
  const num = parseInt(c, 16)
  if (Number.isNaN(num)) return { r: 43, g: 124, b: 211 }
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  }
}

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i
const SHADOW_STYLES: readonly OpeningShadowStyle[] = ['default', 'diffuse', 'flat']
const EXTRA_KEYS = [
  'tint',
  'tintStrength',
  'gradient',
  'sheen',
  'grain',
  'edgeHighlight',
  'glow',
  'shadowStyle',
] as const

/** The optional look refinements an untrusted source may set; anything invalid is dropped. */
export const MATERIAL_EXTRA_KEYS: readonly string[] = EXTRA_KEYS

/**
 * Validates the optional look refinements of a material (tint, gradient, sheen, grain, edge, glow, shadow
 * style) from untrusted input (import files, AI output). Returns only the fields that are valid.
 */
export function sanitizeMaterialExtras(
  raw: Record<string, unknown>,
): Partial<OpeningMaterialConfig> {
  const out: Partial<OpeningMaterialConfig> = {}
  const unit = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : undefined
  if (typeof raw.tint === 'string' && HEX_RE.test(raw.tint.trim())) out.tint = raw.tint.trim()
  const tintStrength = unit(raw.tintStrength)
  if (tintStrength !== undefined) out.tintStrength = tintStrength
  const g = raw.gradient
  if (g && typeof g === 'object' && !Array.isArray(g)) {
    const { from, to, angle } = g as Record<string, unknown>
    if (
      typeof from === 'string' &&
      typeof to === 'string' &&
      HEX_RE.test(from.trim()) &&
      HEX_RE.test(to.trim())
    ) {
      out.gradient = {
        from: from.trim(),
        to: to.trim(),
        ...(typeof angle === 'number' && Number.isFinite(angle)
          ? { angle: Math.round(Math.max(0, Math.min(360, angle))) }
          : {}),
      }
    }
  }
  for (const key of ['sheen', 'grain', 'edgeHighlight', 'glow'] as const) {
    const v = unit(raw[key])
    if (v !== undefined) out[key] = v
  }
  if (
    typeof raw.shadowStyle === 'string' &&
    (SHADOW_STYLES as readonly string[]).includes(raw.shadowStyle)
  ) {
    out.shadowStyle = raw.shadowStyle as OpeningShadowStyle
  }
  return out
}

function rgbaOf(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 1000) / 1000})`
}

export interface MaterialCssOutput {
  background: string
  backdropFilter: string
  boxShadow: string
  border: string
  borderRadius: string
  accentColor: string
  color: string
  inlineCss: string
  /** `@keyframes` the card's own animation needs (the breathing glow); empty when it has none */
  keyframesCss: string
  /** CSS `animation` value to put on the card, or '' (callers skip it when motion is reduced) */
  animation: string
}

/**
 * Generates calibrated, sandboxed CSS styles for card materials.
 * Produces clean, calm, neutral, monochromatic styles with zero GPL code.
 */
export function buildMaterialCss(
  rawConfig: OpeningMaterialConfig | undefined | null,
  options?: { appColor?: string; systemTheme?: 'light' | 'dark' },
): MaterialCssOutput {
  const cfg = rawConfig || { preset: 'frosted-glass' }
  const preset: OpeningMaterialPreset = cfg.preset || 'frosted-glass'
  const themeMode: OpeningThemeMode = cfg.themeMode || 'system'
  const opacity = clamp(cfg.opacity, 0.1, 1.0, preset === 'solid' ? 0.98 : 0.85)
  const blurPx = clamp(cfg.blurPx, 0, 48, preset === 'solid' ? 0 : 22)
  const accentHex = sanitizeHexColor(cfg.accentColor || options?.appColor, '#2b7cd3')
  const borderRadius = `${clamp(cfg.borderRadiusPx, 8, 36, 18)}px`
  const borderWidth = clamp(cfg.borderWidthPx, 0, 4, 1)
  const shadowIntensity = clamp(cfg.shadowIntensity, 0.0, 1.0, 0.35)
  const reduceTransparency = cfg.reduceTransparency === true

  const rgb = hexToRgb(accentHex)
  const accentRgbStr = `${rgb.r}, ${rgb.g}, ${rgb.b}`

  let bgDark: string
  let bgLight: string
  let borderDark: string
  let borderLight: string
  let filterDark: string
  let filterLight: string
  let shadowDark: string
  let shadowLight: string
  const textDark = '#f3f5fa'
  const textLight = '#181a1f'

  switch (preset) {
    case 'solid': {
      bgDark = `rgba(24, 27, 34, ${opacity})`
      bgLight = `rgba(255, 255, 255, ${opacity})`
      filterDark = blurPx > 0 && !reduceTransparency ? `blur(${blurPx}px)` : 'none'
      filterLight = blurPx > 0 && !reduceTransparency ? `blur(${blurPx}px)` : 'none'
      borderDark = `${borderWidth}px solid ${sanitizeBorderColor(cfg.borderColor, 'rgba(255, 255, 255, 0.09)')}`
      borderLight = `${borderWidth}px solid ${sanitizeBorderColor(cfg.borderColor, 'rgba(0, 0, 0, 0.08)')}`
      shadowDark = `0 ${Math.round(18 * shadowIntensity)}px ${Math.round(48 * shadowIntensity)}px rgba(0, 0, 0, ${0.45 * shadowIntensity})`
      shadowLight = `0 ${Math.round(14 * shadowIntensity)}px ${Math.round(36 * shadowIntensity)}px rgba(0, 0, 0, ${0.12 * shadowIntensity})`
      break
    }
    case 'frosted-glass': {
      bgDark = `rgba(20, 25, 36, ${reduceTransparency ? 0.96 : opacity})`
      bgLight = `rgba(255, 255, 255, ${reduceTransparency ? 0.96 : opacity})`
      filterDark = reduceTransparency || blurPx === 0 ? 'none' : `blur(${blurPx}px) saturate(140%)`
      filterLight = reduceTransparency || blurPx === 0 ? 'none' : `blur(${blurPx}px) saturate(130%)`
      borderDark = `${borderWidth}px solid ${sanitizeBorderColor(cfg.borderColor, 'rgba(255, 255, 255, 0.14)')}`
      borderLight = `${borderWidth}px solid ${sanitizeBorderColor(cfg.borderColor, 'rgba(255, 255, 255, 0.65)')}`
      shadowDark = `0 ${Math.round(22 * shadowIntensity)}px ${Math.round(60 * shadowIntensity)}px rgba(0, 0, 0, ${0.5 * shadowIntensity}), inset 0 1px 0 rgba(255, 255, 255, 0.1)`
      shadowLight = `0 ${Math.round(16 * shadowIntensity)}px ${Math.round(44 * shadowIntensity)}px rgba(0, 0, 0, ${0.14 * shadowIntensity}), inset 0 1px 0 rgba(255, 255, 255, 0.8)`
      break
    }
    case 'liquid-glass': {
      bgDark = `linear-gradient(135deg, rgba(22, 30, 48, ${reduceTransparency ? 0.97 : opacity * 0.92}) 0%, rgba(14, 18, 28, ${reduceTransparency ? 0.97 : opacity}) 100%)`
      bgLight = `linear-gradient(135deg, rgba(255, 255, 255, ${reduceTransparency ? 0.97 : opacity}) 0%, rgba(240, 245, 255, ${reduceTransparency ? 0.97 : opacity * 0.9}) 100%)`
      filterDark = reduceTransparency || blurPx === 0 ? 'none' : `blur(${blurPx}px) saturate(160%)`
      filterLight = reduceTransparency || blurPx === 0 ? 'none' : `blur(${blurPx}px) saturate(145%)`
      borderDark = `${borderWidth}px solid ${sanitizeBorderColor(cfg.borderColor, 'rgba(180, 210, 255, 0.22)')}`
      borderLight = `${borderWidth}px solid ${sanitizeBorderColor(cfg.borderColor, 'rgba(255, 255, 255, 0.75)')}`
      shadowDark = `0 ${Math.round(26 * shadowIntensity)}px ${Math.round(72 * shadowIntensity)}px rgba(0, 0, 0, ${0.6 * shadowIntensity}), inset 0 1px 1px rgba(255, 255, 255, 0.22)`
      shadowLight = `0 ${Math.round(18 * shadowIntensity)}px ${Math.round(50 * shadowIntensity)}px rgba(28, 48, 80, ${0.18 * shadowIntensity}), inset 0 1px 1px rgba(255, 255, 255, 0.9)`
      break
    }
    case 'minimal-monochrome':
    default: {
      bgDark = `rgba(16, 18, 22, ${reduceTransparency ? 1.0 : opacity})`
      bgLight = `rgba(250, 251, 253, ${reduceTransparency ? 1.0 : opacity})`
      filterDark = blurPx > 0 && !reduceTransparency ? `blur(${blurPx}px)` : 'none'
      filterLight = blurPx > 0 && !reduceTransparency ? `blur(${blurPx}px)` : 'none'
      borderDark = `${borderWidth}px solid ${sanitizeBorderColor(cfg.borderColor, 'rgba(255, 255, 255, 0.1)')}`
      borderLight = `${borderWidth}px solid ${sanitizeBorderColor(cfg.borderColor, 'rgba(0, 0, 0, 0.1)')}`
      shadowDark = `0 ${Math.round(20 * shadowIntensity)}px ${Math.round(50 * shadowIntensity)}px rgba(0, 0, 0, ${0.5 * shadowIntensity})`
      shadowLight = `0 ${Math.round(14 * shadowIntensity)}px ${Math.round(32 * shadowIntensity)}px rgba(0, 0, 0, ${0.08 * shadowIntensity})`
      break
    }
  }

  // Optional look refinements (all CSS). A card that sets none of them keeps the preset's output untouched.
  const tint = cfg.tint && HEX_RE.test(cfg.tint) ? cfg.tint : undefined
  const tintStrength = clamp(cfg.tintStrength, 0, 1, 0.3)
  const grad =
    cfg.gradient && HEX_RE.test(cfg.gradient.from) && HEX_RE.test(cfg.gradient.to)
      ? cfg.gradient
      : undefined
  const gradAngle = Math.round(clamp(grad?.angle, 0, 360, 145))
  const sheen = clamp(cfg.sheen, 0, 1, 0)
  const grain = clamp(cfg.grain, 0, 1, 0)
  const edge = clamp(cfg.edgeHighlight, 0, 1, 0)
  const glow = clamp(cfg.glow, 0, 1, 0)
  const shadowStyle: OpeningShadowStyle = (SHADOW_STYLES as readonly string[]).includes(
    cfg.shadowStyle as string,
  )
    ? (cfg.shadowStyle as OpeningShadowStyle)
    : 'default'
  const round = (n: number): number => Math.round(n)
  const alpha = (n: number): number => Math.round(n * 1000) / 1000

  const decorateBg = (base: string, light: boolean): string => {
    const layers: string[] = []
    if (grain > 0) {
      // fine woven fibres plus speckle, warm on light surfaces and pale on dark ones
      const ink = light ? '110, 88, 56' : '255, 255, 255'
      const k = light ? 1 : 0.55
      layers.push(
        `radial-gradient(rgba(${ink}, ${alpha(0.2 * grain * k)}) 0.6px, transparent 1px) 3px 2px / 7px 7px`,
        `radial-gradient(rgba(${ink}, ${alpha(0.14 * grain * k)}) 0.5px, transparent 0.9px) 0 0 / 4px 5px`,
        `repeating-linear-gradient(0deg, rgba(${ink}, ${alpha(0.035 * grain * k)}) 0 1px, transparent 1px 5px)`,
      )
    }
    if (sheen > 0) {
      layers.push(
        `linear-gradient(115deg, transparent 26%, rgba(255, 255, 255, ${alpha((light ? 0.6 : 0.16) * sheen)}) 46%, transparent 64%)`,
      )
    }
    if (tint) {
      const wash = rgbaOf(tint, tintStrength)
      layers.push(`linear-gradient(${wash}, ${wash})`)
    }
    if (grad) {
      const a = Math.min(1, opacity * (light ? 0.92 : themeMode === 'dark' ? 0.95 : 0.5))
      layers.push(
        `linear-gradient(${gradAngle}deg, ${rgbaOf(grad.from, a)} 0%, ${rgbaOf(grad.to, a)} 100%)`,
      )
    }
    layers.push(base)
    return layers.join(', ')
  }

  const decorateShadow = (shadow: string, light: boolean, glowScale: number): string => {
    if (shadowStyle === 'default' && glow === 0 && edge === 0) return shadow
    const parts = shadow.split(/,\s*(?=inset)/)
    let outer = parts.filter((part) => !part.startsWith('inset'))
    const insets = parts.filter((part) => part.startsWith('inset'))
    const tone = light ? '24, 36, 64' : '0, 0, 0'
    if (shadowStyle === 'diffuse') {
      const k = light ? 0.72 : 1
      outer = [
        `0 ${round(34 * shadowIntensity)}px ${round(110 * shadowIntensity)}px ${round(-10 * shadowIntensity)}px rgba(${tone}, ${alpha(0.42 * shadowIntensity * k)})`,
        `0 ${round(10 * shadowIntensity)}px ${round(30 * shadowIntensity)}px rgba(${tone}, ${alpha(0.16 * shadowIntensity * k)})`,
      ]
    } else if (shadowStyle === 'flat') {
      outer = []
    }
    if (glow > 0) {
      outer.unshift(
        `0 0 ${round(34 + 30 * glowScale)}px ${round(4 + 8 * glowScale)}px rgba(${accentRgbStr}, ${alpha(0.75 * glow * glowScale)})`,
      )
    }
    if (edge > 0) {
      insets.push(
        light
          ? `inset 0 0 0 1px rgba(255, 255, 255, ${alpha(0.95 * edge)})`
          : `inset 0 0 0 1px rgba(255, 255, 255, ${alpha(0.26 * edge)})`,
        light
          ? `inset 0 1px 0 rgba(255, 255, 255, ${alpha(edge)})`
          : `inset 0 1px 0 rgba(255, 255, 255, ${alpha(0.32 * edge)})`,
        light
          ? `inset 0 -1px 0 rgba(24, 36, 64, ${alpha(0.1 * edge)})`
          : `inset 0 0 26px rgba(255, 255, 255, ${alpha(0.09 * edge)})`,
      )
    }
    const all = [...outer, ...insets]
    return all.length > 0 ? all.join(', ') : 'none'
  }

  const rawShadowDark = shadowDark
  const rawShadowLight = shadowLight
  bgDark = decorateBg(bgDark, false)
  bgLight = decorateBg(bgLight, true)
  shadowDark = decorateShadow(rawShadowDark, false, 0.8)
  shadowLight = decorateShadow(rawShadowLight, true, 0.8)

  const isBrowserLight =
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(prefers-color-scheme: light)').matches ||
      document.documentElement?.getAttribute('data-theme') === 'light' ||
      document.body?.classList.contains('light'))
  const resolvedSystemTheme = options?.systemTheme || (isBrowserLight ? 'light' : 'dark')
  const isLight =
    themeMode === 'light' || (themeMode === 'system' && resolvedSystemTheme === 'light')

  const effectiveBg = isLight ? bgLight : bgDark
  const effectiveFilter = isLight ? filterLight : filterDark
  const effectiveBorder = isLight ? borderLight : borderDark
  const effectiveShadow = isLight ? shadowLight : shadowDark
  const effectiveColor = isLight ? textLight : textDark
  const rawShadow = isLight ? rawShadowLight : rawShadowDark
  const keyframesCss =
    glow > 0
      ? `@keyframes ocs-card-breathe{0%,100%{box-shadow:${decorateShadow(rawShadow, isLight, 0.35)}}50%{box-shadow:${decorateShadow(rawShadow, isLight, 1)}}}`
      : ''
  const animation = glow > 0 ? 'ocs-card-breathe 4.2s ease-in-out infinite' : ''
  // an animated box-shadow cannot win against !important, so a breathing card leaves it off
  const imp = glow > 0 ? '' : ' !important'

  const inlineRules = [
    `--card-accent: ${accentHex}`,
    `--card-accent-rgb: ${accentRgbStr}`,
    `--card-radius: ${borderRadius}`,
    `--card-bg: ${effectiveBg}`,
    `--card-filter: ${effectiveFilter}`,
    `--card-border: ${effectiveBorder}`,
    `--card-shadow: ${effectiveShadow}`,
    `--card-fg: ${effectiveColor}`,
  ]

  let inlineCss = `:root {
  ${inlineRules.join(';\n  ')};
}
.stage {
  background: var(--card-bg, ${effectiveBg}) !important;
  backdrop-filter: var(--card-filter, ${effectiveFilter}) !important;
  -webkit-backdrop-filter: var(--card-filter, ${effectiveFilter}) !important;
  border-radius: var(--card-radius, ${borderRadius}) !important;
  border: var(--card-border, ${effectiveBorder}) !important;
  box-shadow: var(--card-shadow, ${effectiveShadow})${imp};
  color: var(--card-fg, ${effectiveColor}) !important;
}
@media (prefers-reduced-transparency: reduce) {
  .stage {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    background: ${themeMode === 'light' ? '#f8f9fa' : '#14161b'} !important;
  }
}`

  if (themeMode === 'system') {
    inlineCss += `
@media (prefers-color-scheme: light) {
  .stage {
    background: ${bgLight} !important;
    backdrop-filter: ${filterLight} !important;
    -webkit-backdrop-filter: ${filterLight} !important;
    border: ${borderLight} !important;
    box-shadow: ${shadowLight}${imp};
    color: ${textLight} !important;
  }
}
@media (prefers-color-scheme: dark) {
  .stage {
    background: ${bgDark} !important;
    backdrop-filter: ${filterDark} !important;
    -webkit-backdrop-filter: ${filterDark} !important;
    border: ${borderDark} !important;
    box-shadow: ${shadowDark}${imp};
    color: ${textDark} !important;
  }
}`
  }

  if (glow > 0) {
    inlineCss += `
${keyframesCss}
@media (prefers-reduced-motion: no-preference) {
  .stage {
    animation: ${animation};
  }
}
@media (prefers-reduced-motion: reduce) {
  .stage {
    box-shadow: var(--card-shadow, ${effectiveShadow}) !important;
  }
}`
  }

  return {
    background: effectiveBg,
    backdropFilter: effectiveFilter,
    boxShadow: effectiveShadow,
    border: effectiveBorder,
    borderRadius,
    accentColor: accentHex,
    color: effectiveColor,
    inlineCss,
    keyframesCss,
    animation,
  }
}

export function sampleFileName(app: string, lang: string): string {
  const isVi = lang === 'vi'
  switch (app) {
    case 'sheets':
      return isVi ? 'Bảng tính của tôi.xlsx' : 'My spreadsheet.xlsx'
    case 'slides':
      return isVi ? 'Bản trình chiếu của tôi.pptx' : 'My presentation.pptx'
    case 'pdf':
      return isVi ? 'Tài liệu PDF.pdf' : 'Document.pdf'
    case 'markdown':
      return isVi ? 'Ghi chú.md' : 'Notes.md'
    case 'html':
      return isVi ? 'Trang web.html' : 'Page.html'
    case 'docs':
    default:
      return isVi ? 'Tài liệu của tôi.docx' : 'My document.docx'
  }
}
