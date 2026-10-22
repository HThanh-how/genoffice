import type {
  AiCardGenerationInput,
  AiCardGenerationResult,
  GeneratedHtmlCardDraft,
  OpeningCardDefinition,
  OpeningMaterialConfig,
  OpeningMaterialPreset,
  OpeningThemeMode,
} from '../../shared/opening-card-types'
import { activeProvider, chatForProvider } from '@genoffice/ai-provider'
import type { AiSettings } from '@genoffice/ai-provider'
import { MATERIAL_EXTRA_KEYS, sanitizeHexColor, sanitizeMaterialExtras } from './opening-card-css'
import { sanitizeOpeningCss, sanitizeOpeningHtml } from './opening-card-html-sanitizer'

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
  ...MATERIAL_EXTRA_KEYS,
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
    ...sanitizeMaterialExtras(matRaw),
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
  "shadowIntensity": 0.35,
  "tint": "optional #hexcode wash over the surface (e.g. lavender, paper)",
  "tintStrength": 0.3,
  "gradient": { "from": "#hexcode", "to": "#hexcode", "angle": 145 },
  "sheen": 0.0,
  "grain": 0.0,
  "edgeHighlight": 0.0,
  "glow": 0.0,
  "shadowStyle": "default | diffuse | flat"
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
  "shadowIntensity": 0.35,
  "tint": "optional #hexcode wash over the surface (e.g. lavender, paper)",
  "tintStrength": 0.3,
  "gradient": { "from": "#hexcode", "to": "#hexcode", "angle": 145 },
  "sheen": 0.0,
  "grain": 0.0,
  "edgeHighlight": 0.0,
  "glow": 0.0,
  "shadowStyle": "default | diffuse | flat"
}

Rules:
- Respond ONLY with the JSON object.
- DO NOT wrap in markdown fences or commentary if possible.
- Never include HTML, scripts, or executable code.`

export const HTML_CARD_SYSTEM_PROMPT = `You are a specialist UI & motion design engineer for GenOffice Opening Card Studio.
Based on the user's brief, produce an original, visually stunning, self-contained HTML/CSS opening card scene as a strict JSON object.

Allowed themeMode: "light", "dark", "system".
JSON schema:
{
  "version": 1,
  "name": "Short, elegant card title (max 40 chars)",
  "description": "Brief description of the visual scene and mood (max 120 chars)",
  "themeMode": "dark",
  "accentColor": "#2b7cd3",
  "html": "<div class=\\"opening-scene\\"><div class=\\"glow-orb\\"></div><div class=\\"card-glass\\"><div class=\\"doc-badge\\">{{appName}}</div><div class=\\"doc-info\\"><h1 class=\\"doc-title\\">{{title}}</h1><p class=\\"doc-name\\">{{fileName}}</p><span class=\\"doc-hint\\">{{hint}}</span></div><div class=\\"loading-bar\\"><div class=\\"loading-fill\\"></div></div></div></div>",
  "css": ".opening-scene { position: relative; width: 440px; height: 240px; display: flex; align-items: center; justify-content: center; overflow: hidden; border-radius: 20px; box-shadow: 0 24px 60px rgba(0,0,0,0.35); } ..."
}

Critical Design & Technical Guidelines:
1. Return self-contained HTML structure and CSS styling.
2. The card should be centered, sized around 440px by 240px (responsive with max-width/max-height).
3. Use rich CSS keyframes animations: floating elements, moving light reflections, glowing orbs, animated gradients, subtle particle/petal effects, smooth loading indicators.
4. Support glassmorphism, translucency (backdrop-filter: blur), rounded corners (border-radius: 16-24px), layered depth, and delicate borders (rgba(255,255,255,0.15)).
5. Include dynamic document placeholders inside the HTML text nodes:
   - {{fileName}} : name of opening document
   - {{title}}    : opening action title (e.g. "Opening document…")
   - {{hint}}     : status hint (e.g. "Getting document ready")
   - {{appName}}  : application name or badge
   - {{accentColor}} : accent color
6. Always include a prefers-reduced-motion media query:
   @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
7. STRICT SECURITY RULES:
   - NEVER include <script>, <iframe>, <object>, <embed>, <form>, <base>, or <meta>.
   - NEVER use inline event handlers (onclick, onload, onerror).
   - NEVER use @import or external url() links. NO external fonts, scripts, or CDN styles.
   - Output ONLY the strict JSON object.`

/**
 * Validates and sanitizes AI-generated HTML/CSS card output.
 */
export function validateAiHtmlCardSchema(raw: unknown): {
  ok: boolean
  draft?: GeneratedHtmlCardDraft
  card?: OpeningCardDefinition
  error?: string
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'AI output must be a JSON object' }
  }

  const obj = raw as Record<string, unknown>

  // Name
  if (typeof obj.name !== 'string' || obj.name.trim().length === 0) {
    return { ok: false, error: 'Card name is required' }
  }
  const name = obj.name.trim().slice(0, 60)
  if (FORBIDDEN_PATTERN.test(name)) {
    return { ok: false, error: 'Card name contains prohibited code or HTML patterns' }
  }

  // Description
  let description: string | undefined
  if (typeof obj.description === 'string' && obj.description.trim()) {
    description = obj.description.trim().slice(0, 200)
    if (FORBIDDEN_PATTERN.test(description)) {
      return { ok: false, error: 'Description contains prohibited code or HTML patterns' }
    }
  }

  // Theme Mode
  const rawTheme = String(obj.themeMode || 'system').toLowerCase()
  const themeMode: OpeningThemeMode = (ALLOWED_THEME_MODES as readonly string[]).includes(rawTheme)
    ? (rawTheme as OpeningThemeMode)
    : 'system'

  // Accent Color
  const accentColor = sanitizeHexColor(
    typeof obj.accentColor === 'string' ? obj.accentColor : undefined,
    '#2b7cd3',
  )

  // HTML
  if (typeof obj.html !== 'string' || !obj.html.trim()) {
    return { ok: false, error: 'Generated HTML is empty or invalid' }
  }
  const sanitizedHtmlRes = sanitizeOpeningHtml(obj.html)
  if (!sanitizedHtmlRes.ok || !sanitizedHtmlRes.sanitizedHtml) {
    return { ok: false, error: sanitizedHtmlRes.error || 'HTML sanitization failed' }
  }

  // CSS
  if (typeof obj.css !== 'string' || !obj.css.trim()) {
    return { ok: false, error: 'Generated CSS is empty or invalid' }
  }
  const sanitizedCssRes = sanitizeOpeningCss(obj.css)
  if (!sanitizedCssRes.ok || !sanitizedCssRes.sanitizedCss) {
    return { ok: false, error: sanitizedCssRes.error || 'CSS validation failed' }
  }

  const cardId = `ai:html_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  const draft: GeneratedHtmlCardDraft = {
    version: 1,
    name,
    description,
    html: sanitizedHtmlRes.sanitizedHtml,
    css: sanitizedCssRes.sanitizedCss,
    themeMode,
    accentColor,
  }

  const card: OpeningCardDefinition = {
    id: cardId,
    name,
    description,
    category: 'ai',
    contentKind: 'ai-html',
    material: {
      preset: 'frosted-glass',
      themeMode,
      accentColor,
    },
    thumbnailColors: [accentColor, themeMode === 'light' ? '#e2e8f0' : '#181b22'],
    createdAt: Date.now(),
    isBuiltIn: false,
    tags: ['ai-generated', 'ai-html', themeMode],
  }

  return { ok: true, draft, card }
}

/**
 * Invokes the configured GenOffice AI provider to generate a customized card configuration or HTML card.
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

  const mode = input.mode || 'style'

  if (mode === 'image') {
    return {
      ok: false,
      error:
        'AI image generation is not supported by the active AI provider or is not yet implemented. Please select HTML Scene or Style Preset mode.',
      modeUsed: 'image',
    }
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

  if (mode === 'html') {
    let userMessage = `Create an original HTML opening card scene based on this description:\n"${promptText}"`
    if (input.themeMode) userMessage += `\nPreferred theme mode: ${input.themeMode}`
    if (input.accentColor) userMessage += `\nPreferred accent color: ${input.accentColor}`

    try {
      const response = await chatFn(provider, config, HTML_CARD_SYSTEM_PROMPT, userMessage, signal)

      if (!response.ok) {
        return {
          ok: false,
          error: response.error || 'AI generation request failed.',
          modelUsed: config.model,
          modeUsed: 'html',
        }
      }

      if (!response.content || !response.content.trim()) {
        return {
          ok: false,
          error: 'The AI model returned an empty response. Please try again.',
          modelUsed: config.model,
          modeUsed: 'html',
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
          modeUsed: 'html',
        }
      }

      const validation = validateAiHtmlCardSchema(parsed)
      if (!validation.ok || !validation.card || !validation.draft) {
        return {
          ok: false,
          error: validation.error || 'AI generated HTML did not conform to safe card schema.',
          rawResponse: response.content,
          modelUsed: config.model,
          modeUsed: 'html',
        }
      }

      return {
        ok: true,
        card: validation.card,
        htmlDraft: validation.draft,
        modeUsed: 'html',
        rawResponse: response.content,
        modelUsed: config.model,
      }
    } catch (err: unknown) {
      if (signal?.aborted) {
        return { ok: false, error: 'Generation was cancelled by the user.', modeUsed: 'html' }
      }
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        modelUsed: config.model,
        modeUsed: 'html',
      }
    }
  }

  if (mode !== 'style') {
    return {
      ok: false,
      error: `Unsupported generation mode: ${mode}`,
    }
  }

  // Declarative Material Style mode
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
        modeUsed: 'style',
      }
    }

    if (!response.content || !response.content.trim()) {
      return {
        ok: false,
        error: 'The AI model returned an empty response. Please try again.',
        modelUsed: config.model,
        modeUsed: 'style',
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
        modeUsed: 'style',
      }
    }

    const validation = validateAiCardSchema(parsed)
    if (!validation.ok || !validation.card) {
      return {
        ok: false,
        error: validation.error || 'AI generated output did not conform to card schema.',
        rawResponse: response.content,
        modelUsed: config.model,
        modeUsed: 'style',
      }
    }

    // Return the preview card (transient, not saved until user clicks Save)
    return {
      ok: true,
      card: validation.card,
      modeUsed: 'style',
      rawResponse: response.content,
      modelUsed: config.model,
    }
  } catch (err: unknown) {
    if (signal?.aborted) {
      return { ok: false, error: 'Generation was cancelled by the user.', modeUsed: 'style' }
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      modelUsed: config.model,
      modeUsed: 'style',
    }
  }
}
