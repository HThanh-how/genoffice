import type {
  AiCardGenerationInput,
  AiCardGenerationResult,
  OpeningCardDefinition,
  OpeningMaterialConfig,
  OpeningMaterialPreset,
  OpeningThemeMode,
} from '../../shared/opening-card-types'
import { activeProvider, chatForProvider } from '@genoffice/ai-provider'
import type { AiSettings } from '@genoffice/ai-provider'
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

const CARD_DESIGN_SYSTEM_PROMPT = `You are a specialist UI designer for GenOffice Opening Card Studio.
Based on the user's brief, generate an elegant, minimalist opening splash card configuration as a strict JSON object.

Allowed presets: "solid", "frosted-glass", "liquid-glass", "minimal-monochrome".
Allowed themeMode: "light", "dark", "system".
JSON schema:
{
  "name": "Short, elegant card title (max 40 chars)",
  "description": "One sentence describing the mood and palette (max 120 chars)",
  "preset": "frosted-glass",
  "themeMode": "system",
  "opacity": 0.85,
  "blurPx": 22,
  "accentColor": "#2b7cd3",
  "borderRadiusPx": 18,
  "borderWidthPx": 1,
  "shadowIntensity": 0.35
}

Rules:
- Respond ONLY with the JSON object.
- DO NOT wrap in markdown fences or commentary if possible.
- Never include HTML, scripts, or executable code.`

/**
 * Invokes the configured GenOffice AI provider to generate a customized card configuration.
 * Produces a preview card only; the card is NOT saved to disk until explicit user approval.
 */
export async function generateAiCardWithRealProvider(
  input: AiCardGenerationInput,
  aiSettings: AiSettings,
  signal?: AbortSignal,
  chatFn: typeof chatForProvider = chatForProvider,
): Promise<AiCardGenerationResult> {
  if (!input || typeof input.prompt !== 'string' || !input.prompt.trim()) {
    return { ok: false, error: 'Please enter a description for the opening card.' }
  }

  const promptText = input.prompt.trim()
  if (promptText.length > 500) {
    return { ok: false, error: 'Prompt exceeds 500 characters.' }
  }

  const provider = activeProvider(aiSettings)
  const baseConfig = aiSettings.providers[provider]
  if (!baseConfig) {
    return {
      ok: false,
      error: `AI provider "${provider}" is not configured. Please set up an AI model in Settings > AI.`,
    }
  }

  // Check if provider is usable
  if (provider !== 'agy' && provider !== 'genspark' && !baseConfig.apiKey && !baseConfig.baseUrl) {
    return {
      ok: false,
      error: `No API key found for "${provider}". Please add an API key in Settings > AI.`,
    }
  }

  const config = input.model ? { ...baseConfig, model: input.model } : baseConfig

  let userMessage = `Create an opening card style based on this description:\n"${promptText}"`
  if (input.preset) userMessage += `\nPreferred preset: ${input.preset}`
  if (input.themeMode) userMessage += `\nPreferred theme mode: ${input.themeMode}`
  if (input.accentColor) userMessage += `\nPreferred accent color: ${input.accentColor}`

  try {
    const response = await chatFn(provider, config, CARD_DESIGN_SYSTEM_PROMPT, userMessage, signal)

    if (!response.ok) {
      return {
        ok: false,
        error: response.error || 'AI generation request failed.',
        modelUsed: config.model,
      }
    }

    if (!response.content || !response.content.trim()) {
      return {
        ok: false,
        error: 'The AI model returned an empty response. Please try again.',
        modelUsed: config.model,
      }
    }

    let parsed: unknown
    try {
      parsed = parseAiJsonPayload(response.content)
    } catch {
      return {
        ok: false,
        error: 'Failed to parse AI response into valid JSON.',
        rawResponse: response.content,
        modelUsed: config.model,
      }
    }

    const validation = validateAiCardSchema(parsed)
    if (!validation.ok || !validation.card) {
      return {
        ok: false,
        error: validation.error || 'AI generated output did not conform to card schema.',
        rawResponse: response.content,
        modelUsed: config.model,
      }
    }

    // Return the preview card (transient, not saved until user clicks Save)
    return {
      ok: true,
      card: validation.card,
      rawResponse: response.content,
      modelUsed: config.model,
    }
  } catch (err: unknown) {
    if (signal?.aborted) {
      return { ok: false, error: 'Generation was cancelled by the user.' }
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      modelUsed: config.model,
    }
  }
}
