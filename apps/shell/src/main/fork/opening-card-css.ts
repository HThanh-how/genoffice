import type {
  OpeningMaterialConfig,
  OpeningMaterialPreset,
  OpeningThemeMode,
} from '../../shared/opening-card-types'

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

export interface MaterialCssOutput {
  background: string
  backdropFilter: string
  boxShadow: string
  border: string
  borderRadius: string
  accentColor: string
  color: string
  inlineCss: string
}

/**
 * Generates calibrated, sandboxed CSS styles for card materials.
 * Produces clean, calm, neutral, monochromatic styles with zero GPL code.
 */
export function buildMaterialCss(
  rawConfig: OpeningMaterialConfig,
  options?: { appColor?: string },
): MaterialCssOutput {
  const preset: OpeningMaterialPreset = rawConfig.preset || 'frosted-glass'
  const themeMode: OpeningThemeMode = rawConfig.themeMode || 'system'
  const opacity = clamp(rawConfig.opacity, 0.1, 1.0, preset === 'solid' ? 0.98 : 0.85)
  const blurPx = clamp(rawConfig.blurPx, 0, 48, preset === 'solid' ? 0 : 22)
  const accentHex = sanitizeHexColor(rawConfig.accentColor || options?.appColor, '#2b7cd3')
  const borderRadius = `${clamp(rawConfig.borderRadiusPx, 8, 36, 18)}px`
  const borderWidth = clamp(rawConfig.borderWidthPx, 0, 4, 1)
  const shadowIntensity = clamp(rawConfig.shadowIntensity, 0.0, 1.0, 0.35)
  const reduceTransparency = rawConfig.reduceTransparency === true

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
      borderDark = `${borderWidth}px solid ${sanitizeBorderColor(rawConfig.borderColor, 'rgba(255, 255, 255, 0.09)')}`
      borderLight = `${borderWidth}px solid ${sanitizeBorderColor(rawConfig.borderColor, 'rgba(0, 0, 0, 0.08)')}`
      shadowDark = `0 ${Math.round(18 * shadowIntensity)}px ${Math.round(48 * shadowIntensity)}px rgba(0, 0, 0, ${0.45 * shadowIntensity})`
      shadowLight = `0 ${Math.round(14 * shadowIntensity)}px ${Math.round(36 * shadowIntensity)}px rgba(0, 0, 0, ${0.12 * shadowIntensity})`
      break
    }
    case 'frosted-glass': {
      bgDark = `rgba(20, 25, 36, ${reduceTransparency ? 0.96 : opacity})`
      bgLight = `rgba(255, 255, 255, ${reduceTransparency ? 0.96 : opacity})`
      filterDark = reduceTransparency || blurPx === 0 ? 'none' : `blur(${blurPx}px) saturate(140%)`
      filterLight = reduceTransparency || blurPx === 0 ? 'none' : `blur(${blurPx}px) saturate(130%)`
      borderDark = `${borderWidth}px solid ${sanitizeBorderColor(rawConfig.borderColor, 'rgba(255, 255, 255, 0.14)')}`
      borderLight = `${borderWidth}px solid ${sanitizeBorderColor(rawConfig.borderColor, 'rgba(255, 255, 255, 0.65)')}`
      shadowDark = `0 ${Math.round(22 * shadowIntensity)}px ${Math.round(60 * shadowIntensity)}px rgba(0, 0, 0, ${0.5 * shadowIntensity}), inset 0 1px 0 rgba(255, 255, 255, 0.1)`
      shadowLight = `0 ${Math.round(16 * shadowIntensity)}px ${Math.round(44 * shadowIntensity)}px rgba(0, 0, 0, ${0.14 * shadowIntensity}), inset 0 1px 0 rgba(255, 255, 255, 0.8)`
      break
    }
    case 'liquid-glass': {
      bgDark = `linear-gradient(135deg, rgba(22, 30, 48, ${reduceTransparency ? 0.97 : opacity * 0.92}) 0%, rgba(14, 18, 28, ${reduceTransparency ? 0.97 : opacity}) 100%)`
      bgLight = `linear-gradient(135deg, rgba(255, 255, 255, ${reduceTransparency ? 0.97 : opacity}) 0%, rgba(240, 245, 255, ${reduceTransparency ? 0.97 : opacity * 0.9}) 100%)`
      filterDark = reduceTransparency || blurPx === 0 ? 'none' : `blur(${blurPx}px) saturate(160%)`
      filterLight = reduceTransparency || blurPx === 0 ? 'none' : `blur(${blurPx}px) saturate(145%)`
      borderDark = `${borderWidth}px solid ${sanitizeBorderColor(rawConfig.borderColor, 'rgba(180, 210, 255, 0.22)')}`
      borderLight = `${borderWidth}px solid ${sanitizeBorderColor(rawConfig.borderColor, 'rgba(255, 255, 255, 0.75)')}`
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
      borderDark = `${borderWidth}px solid ${sanitizeBorderColor(rawConfig.borderColor, 'rgba(255, 255, 255, 0.1)')}`
      borderLight = `${borderWidth}px solid ${sanitizeBorderColor(rawConfig.borderColor, 'rgba(0, 0, 0, 0.1)')}`
      shadowDark = `0 ${Math.round(20 * shadowIntensity)}px ${Math.round(50 * shadowIntensity)}px rgba(0, 0, 0, ${0.5 * shadowIntensity})`
      shadowLight = `0 ${Math.round(14 * shadowIntensity)}px ${Math.round(32 * shadowIntensity)}px rgba(0, 0, 0, ${0.08 * shadowIntensity})`
      break
    }
  }

  const effectiveBg = themeMode === 'light' ? bgLight : bgDark
  const effectiveFilter = themeMode === 'light' ? filterLight : filterDark
  const effectiveBorder = themeMode === 'light' ? borderLight : borderDark
  const effectiveShadow = themeMode === 'light' ? shadowLight : shadowDark
  const effectiveColor = themeMode === 'light' ? textLight : textDark

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
  box-shadow: var(--card-shadow, ${effectiveShadow}) !important;
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
    box-shadow: ${shadowLight} !important;
    color: ${textLight} !important;
  }
}
@media (prefers-color-scheme: dark) {
  .stage {
    background: ${bgDark} !important;
    backdrop-filter: ${filterDark} !important;
    -webkit-backdrop-filter: ${filterDark} !important;
    border: ${borderDark} !important;
    box-shadow: ${shadowDark} !important;
    color: ${textDark} !important;
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
  }
}
