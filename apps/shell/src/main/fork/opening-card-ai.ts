import type {
  OpeningCardDefinition,
  OpeningMaterialConfig,
  OpeningMaterialPreset,
  OpeningThemeMode,
} from '../../shared/opening-card-types'
import { sanitizeHexColor } from './opening-card-css'

const ALLOWED_PRESETS: readonly OpeningMaterialPreset[] = [
  'solid',
  'frosted-glass',
  'liquid-glass',
  'minimal-monochrome',
]

const ALLOWED_THEME_MODES: readonly OpeningThemeMode[] = ['light', 'dark', 'system']

const TOP_LEVEL_WHITELIST = new Set([
  'name',
  'description',
  'material',
  'preset',
  'themeMode',
  'accentColor',
  'opacity',
  'blurPx',
  'borderRadiusPx',
  'borderWidthPx',
  'shadowIntensity',
  'tags',
])

const MATERIAL_WHITELIST = new Set([
  'preset',
  'themeMode',
  'opacity',
  'blurPx',
  'accentColor',
  'borderRadiusPx',
  'borderWidthPx',
  'borderColor',
  'shadowIntensity',
  'reduceTransparency',
])

const FORBIDDEN_PATTERN = /<script|javascript:|on\w+=|<\/|<[a-z]|expression\(|eval\(/i

/**
 * Validates untrusted AI output against our strict declarative card schema.
 * Prevents script injection, unknown fields, or malicious HTML.
 */
export function validateAiCardSchema(raw: unknown): {
  ok: boolean
  card?: OpeningCardDefinition
  error?: string
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'AI output must be a JSON object' }
  }

  const obj = raw as Record<string, unknown>

  // Reject any unknown top-level keys
  for (const key of Object.keys(obj)) {
    if (!TOP_LEVEL_WHITELIST.has(key)) {
      return { ok: false, error: `Unauthorized field in AI output: ${key}` }
    }
  }

  // Validate Name
  if (typeof obj.name !== 'string' || obj.name.trim().length === 0) {
    return { ok: false, error: 'Card name is required and must be a non-empty string' }
  }
  const name = obj.name.trim()
  if (name.length > 60) {
    return { ok: false, error: 'Card name exceeds 60 characters' }
  }
  if (FORBIDDEN_PATTERN.test(name)) {
    return { ok: false, error: 'Card name contains prohibited code or HTML patterns' }
  }

  // Validate Description
  let description: string | undefined
  if (obj.description !== undefined) {
    if (typeof obj.description !== 'string') {
      return { ok: false, error: 'Description must be a string' }
    }
    description = obj.description.trim()
    if (description.length > 200) {
      return { ok: false, error: 'Description exceeds 200 characters' }
    }
    if (FORBIDDEN_PATTERN.test(description)) {
      return { ok: false, error: 'Description contains prohibited code or HTML patterns' }
    }
  }

  // Flatten or resolve material object
  const matRaw =
    obj.material && typeof obj.material === 'object' && !Array.isArray(obj.material)
      ? (obj.material as Record<string, unknown>)
      : obj

  // Reject any unauthorized material keys
  for (const key of Object.keys(matRaw)) {
    if (!MATERIAL_WHITELIST.has(key) && !TOP_LEVEL_WHITELIST.has(key)) {
      return { ok: false, error: `Unauthorized material property: ${key}` }
    }
  }

  // Preset
  const rawPreset = String(matRaw.preset || 'frosted-glass').toLowerCase()
  const preset = (ALLOWED_PRESETS as readonly string[]).includes(rawPreset)
    ? (rawPreset as OpeningMaterialPreset)
    : 'frosted-glass'

  // Theme Mode
  const rawTheme = String(matRaw.themeMode || 'system').toLowerCase()
  const themeMode = (ALLOWED_THEME_MODES as readonly string[]).includes(rawTheme)
    ? (rawTheme as OpeningThemeMode)
    : 'system'

  // Opacity (0.1 - 1.0)
  let opacity = 0.85
  if (typeof matRaw.opacity === 'number' && !Number.isNaN(matRaw.opacity)) {
    opacity = Math.max(0.1, Math.min(1.0, matRaw.opacity))
  }

  // Blur (0 - 48)
  let blurPx = preset === 'solid' ? 0 : 22
  if (typeof matRaw.blurPx === 'number' && !Number.isNaN(matRaw.blurPx)) {
    blurPx = Math.max(0, Math.min(48, Math.round(matRaw.blurPx)))
  }

  // Accent Color
  const accentColor = sanitizeHexColor(
    typeof matRaw.accentColor === 'string' ? matRaw.accentColor : undefined,
    '#2b7cd3',
  )

  // Border Radius (8 - 36)
  let borderRadiusPx = 18
  if (typeof matRaw.borderRadiusPx === 'number' && !Number.isNaN(matRaw.borderRadiusPx)) {
    borderRadiusPx = Math.max(8, Math.min(36, Math.round(matRaw.borderRadiusPx)))
  }

  // Border Width (0 - 4)
  let borderWidthPx = 1
  if (typeof matRaw.borderWidthPx === 'number' && !Number.isNaN(matRaw.borderWidthPx)) {
    borderWidthPx = Math.max(0, Math.min(4, Math.round(matRaw.borderWidthPx)))
  }

  // Shadow Intensity (0.0 - 1.0)
  let shadowIntensity = 0.35
  if (typeof matRaw.shadowIntensity === 'number' && !Number.isNaN(matRaw.shadowIntensity)) {
    shadowIntensity = Math.max(0.0, Math.min(1.0, matRaw.shadowIntensity))
  }

  const material: OpeningMaterialConfig = {
    preset,
    themeMode,
    opacity,
    blurPx,
    accentColor,
    borderRadiusPx,
    borderWidthPx,
    shadowIntensity,
  }

  const cardId = `ai:card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  const card: OpeningCardDefinition = {
    id: cardId,
    name,
    description,
    category: 'ai',
    contentKind: 'ai-declarative',
    material,
    thumbnailColors: [accentColor, preset === 'solid' ? '#181b22' : '#23324d'],
    createdAt: Date.now(),
    isBuiltIn: false,
    tags: ['ai-generated', preset, themeMode],
  }

  return { ok: true, card }
}

/**
 * Extracts and parses a JSON object from raw LLM output, safely stripping markdown fences.
 */
export function parseAiJsonPayload(rawOutput: string): unknown {
  let cleaned = rawOutput.trim()

  // Match ```json ... ``` or ``` ... ```
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(cleaned)
  if (fenceMatch?.[1]) {
    cleaned = fenceMatch[1].trim()
  } else {
    // Look for first '{' and last '}'
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start !== -1 && end !== -1 && end > start) {
      cleaned = cleaned.slice(start, end + 1)
    }
  }

  return JSON.parse(cleaned)
}

/**
 * Prompt instruction guiding the AI model to return a strict declarative card spec.
 */
export function buildTextToCardPrompt(userPrompt: string): string {
  return `You are a minimalist UI design assistant for GenOffice Opening Card Studio.
Based on the user's brief, produce a declarative card configuration as a strict JSON object.

Allowed presets: "solid", "frosted-glass", "liquid-glass", "minimal-monochrome".
Allowed themeMode: "light", "dark", "system".
Allowed fields:
{
  "name": "Short card name (max 40 chars)",
  "description": "Brief aesthetic description (max 120 chars)",
  "preset": "frosted-glass",
  "themeMode": "system",
  "opacity": 0.85,
  "blurPx": 22,
  "accentColor": "#hexcode",
  "borderRadiusPx": 18,
  "borderWidthPx": 1,
  "shadowIntensity": 0.35
}

DO NOT include HTML, scripts, code, or markdown. Output ONLY the JSON object.
User brief: "${userPrompt.slice(0, 500)}"`
}
