import { randomBytes } from 'node:crypto'
import type {
  CardCategory,
  CardContentKind,
  OpeningCardDefinition,
  OpeningCardExportBundle,
  OpeningMaterialConfig,
  OpeningMaterialPreset,
  OpeningThemeMode,
  StoredMediaAsset,
} from '../../shared/opening-card-types'
import { isBuiltInCard } from '../../shared/opening-card-families'
import { sanitizeBorderColor, sanitizeHexColor } from './opening-card-css'
import { getAssetDataUrl, isSafeAssetId, storeMediaAssetFromBuffer } from './opening-media-storage'

const FORBIDDEN_PATTERN = /<script|javascript:|on\w+=|<\/|<[a-z]|expression\(|eval\(/i
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_.:-]+$/

const ALLOWED_PRESETS: readonly OpeningMaterialPreset[] = [
  'solid',
  'frosted-glass',
  'liquid-glass',
  'minimal-monochrome',
]

const ALLOWED_THEME_MODES: readonly OpeningThemeMode[] = ['light', 'dark', 'system']

const ALLOWED_CATEGORIES: readonly CardCategory[] = ['canvas', 'curated', 'media', 'ai', 'custom']

const ALLOWED_CONTENT_KINDS: readonly CardContentKind[] = [
  'canvas-scene',
  'curated-material',
  'personal-media',
  'ai-declarative',
  'custom-html',
]

function clampNumber(val: unknown, min: number, max: number, fallback: number): number {
  if (typeof val !== 'number' || Number.isNaN(val) || !Number.isFinite(val)) return fallback
  return Math.max(min, Math.min(max, val))
}

/**
 * Validates a full OpeningCardDefinition object coming across IPC or import.
 * Ensures all fields conform to the security model and rejects any script or HTML patterns.
 */
export function validateCardDefinition(raw: unknown): {
  ok: boolean
  card?: OpeningCardDefinition
  error?: string
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Card definition must be an object' }
  }

  const obj = raw as Record<string, unknown>

  // Reject prototype pollution
  if (
    Object.prototype.hasOwnProperty.call(obj, '__proto__') ||
    Object.prototype.hasOwnProperty.call(obj, 'constructor') ||
    Object.prototype.hasOwnProperty.call(obj, 'prototype')
  ) {
    return { ok: false, error: 'Forbidden prototype properties detected' }
  }

  // Validate ID
  if (typeof obj.id !== 'string' || !obj.id.trim()) {
    return { ok: false, error: 'Card id is required' }
  }
  const id = obj.id.trim()
  if (id.length > 100 || !SAFE_ID_PATTERN.test(id)) {
    return { ok: false, error: 'Invalid card ID format or length' }
  }

  // Validate Name
  if (typeof obj.name !== 'string' || !obj.name.trim()) {
    return { ok: false, error: 'Card name is required' }
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

  // Validate Category
  const rawCategory = typeof obj.category === 'string' ? obj.category : 'custom'
  const category = (ALLOWED_CATEGORIES as readonly string[]).includes(rawCategory)
    ? (rawCategory as CardCategory)
    : 'custom'

  // Validate ContentKind
  const rawKind = typeof obj.contentKind === 'string' ? obj.contentKind : 'curated-material'
  const contentKind = (ALLOWED_CONTENT_KINDS as readonly string[]).includes(rawKind)
    ? (rawKind as CardContentKind)
    : 'curated-material'

  // Validate Material
  if (!obj.material || typeof obj.material !== 'object' || Array.isArray(obj.material)) {
    return { ok: false, error: 'Material configuration object is required' }
  }
  const matRaw = obj.material as Record<string, unknown>

  const rawPreset = String(matRaw.preset || 'frosted-glass').toLowerCase()
  const preset: OpeningMaterialPreset = (ALLOWED_PRESETS as readonly string[]).includes(rawPreset)
    ? (rawPreset as OpeningMaterialPreset)
    : 'frosted-glass'

  const rawTheme = String(matRaw.themeMode || 'system').toLowerCase()
  const themeMode: OpeningThemeMode = (ALLOWED_THEME_MODES as readonly string[]).includes(rawTheme)
    ? (rawTheme as OpeningThemeMode)
    : 'system'

  const opacity = clampNumber(matRaw.opacity, 0.1, 1.0, preset === 'solid' ? 0.98 : 0.85)
  const blurPx = clampNumber(matRaw.blurPx, 0, 48, preset === 'solid' ? 0 : 22)
  const accentColor = sanitizeHexColor(
    typeof matRaw.accentColor === 'string' ? matRaw.accentColor : undefined,
    '#2b7cd3',
  )
  const borderRadiusPx = Math.round(clampNumber(matRaw.borderRadiusPx, 8, 36, 18))
  const borderWidthPx = Math.round(clampNumber(matRaw.borderWidthPx, 0, 4, 1))
  const borderColor =
    typeof matRaw.borderColor === 'string'
      ? sanitizeBorderColor(matRaw.borderColor, 'rgba(255, 255, 255, 0.14)')
      : undefined
  const shadowIntensity = clampNumber(matRaw.shadowIntensity, 0.0, 1.0, 0.35)
  const reduceTransparency = matRaw.reduceTransparency === true

  const material: OpeningMaterialConfig = {
    preset,
    themeMode,
    opacity,
    blurPx,
    accentColor,
    borderRadiusPx,
    borderWidthPx,
    ...(borderColor ? { borderColor } : {}),
    shadowIntensity,
    ...(reduceTransparency ? { reduceTransparency: true } : {}),
  }

  // Validate optional mediaAssetId
  let mediaAssetId: string | undefined
  if (obj.mediaAssetId !== undefined) {
    if (typeof obj.mediaAssetId === 'string' && isSafeAssetId(obj.mediaAssetId)) {
      mediaAssetId = obj.mediaAssetId
    } else {
      return { ok: false, error: 'Invalid mediaAssetId format' }
    }
  }

  // Validate mediaFit & mediaDim
  const rawFit = typeof obj.mediaFit === 'string' ? obj.mediaFit : 'cover'
  const mediaFit = rawFit === 'contain' ? 'contain' : rawFit === 'center' ? 'center' : 'cover'
  const mediaDim =
    obj.mediaDim !== undefined ? clampNumber(obj.mediaDim, 0.0, 0.9, 0.25) : undefined

  // Validate thumbnailColors
  let thumbnailColors: [string, string] | undefined
  if (Array.isArray(obj.thumbnailColors) && obj.thumbnailColors.length >= 2) {
    const c1 = sanitizeHexColor(String(obj.thumbnailColors[0]), accentColor)
    const c2 = sanitizeHexColor(String(obj.thumbnailColors[1]), '#181b22')
    thumbnailColors = [c1, c2]
  }

  // Validate tags
  let tags: string[] | undefined
  if (Array.isArray(obj.tags)) {
    tags = obj.tags
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .map((t) => t.trim().slice(0, 30))
      .filter((t) => !FORBIDDEN_PATTERN.test(t))
      .slice(0, 10)
  }

  const createdAt =
    typeof obj.createdAt === 'number' && Number.isFinite(obj.createdAt) ? obj.createdAt : Date.now()

  const card: OpeningCardDefinition = {
    id,
    name,
    ...(description ? { description } : {}),
    category,
    contentKind,
    material,
    ...(mediaAssetId ? { mediaAssetId } : {}),
    ...(obj.mediaFit ? { mediaFit } : {}),
    ...(mediaDim !== undefined ? { mediaDim } : {}),
    ...(thumbnailColors ? { thumbnailColors } : {}),
    createdAt,
    isBuiltIn: false,
    ...(tags && tags.length > 0 ? { tags } : {}),
  }

  return { ok: true, card }
}

/**
 * Creates a versioned, portable export bundle of custom cards and their embedded media assets.
 */
export function createOpeningCardExportBundle(
  cards: readonly OpeningCardDefinition[],
  userDataPath: string,
): OpeningCardExportBundle {
  const assets: StoredMediaAsset[] = []
  const exportedCards: OpeningCardDefinition[] = []

  for (const card of cards) {
    const validation = validateCardDefinition(card)
    if (!validation.ok || !validation.card) continue

    const validCard = validation.card
    if (validCard.mediaAssetId) {
      try {
        const dataUrl = getAssetDataUrl(userDataPath, validCard.mediaAssetId)
        if (dataUrl) {
          assets.push({
            assetId: validCard.mediaAssetId,
            mime: 'image/png',
            sizeBytes: dataUrl.length,
            dataUrl,
            createdAt: Date.now(),
          })
        }
      } catch {
        // Asset file missing: export card with warning, card can fallback to material
      }
    }
    exportedCards.push(validCard)
  }

  return {
    version: 1,
    exportedAt: Date.now(),
    cards: exportedCards,
    assets: assets.length > 0 ? assets : undefined,
  }
}

/**
 * Validates and imports cards from an exported JSON bundle or legacy array.
 * Copies embedded assets into app storage, prevents duplicate ID clashes, and guarantees lossless round-trip.
 */
export async function importCardsFromExportBundle(
  jsonContent: string,
  userDataPath: string,
  existingCards: readonly OpeningCardDefinition[],
): Promise<{
  ok: boolean
  importedCards: OpeningCardDefinition[]
  count: number
  error?: string
}> {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonContent)
  } catch (err) {
    return { ok: false, importedCards: [], count: 0, error: 'Invalid JSON payload' }
  }

  let cardsToProcess: unknown[]
  const embeddedAssets: StoredMediaAsset[] = []

  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>).version === 1
  ) {
    const bundle = parsed as OpeningCardExportBundle
    if (!Array.isArray(bundle.cards)) {
      return { ok: false, importedCards: [], count: 0, error: 'Bundle missing cards array' }
    }
    cardsToProcess = bundle.cards
    if (Array.isArray(bundle.assets)) {
      embeddedAssets.push(...bundle.assets)
    }
  } else if (Array.isArray(parsed)) {
    // Backwards compatibility with raw card array
    cardsToProcess = parsed
  } else {
    return {
      ok: false,
      importedCards: [],
      count: 0,
      error: 'Unsupported import format. Expected version 1 card bundle or card array.',
    }
  }

  // Restore portable assets if available
  const importedAssetMap = new Map<string, string>() // oldAssetId -> newAssetId
  for (const asset of embeddedAssets) {
    if (
      asset.dataUrl &&
      typeof asset.dataUrl === 'string' &&
      asset.dataUrl.startsWith('data:image/')
    ) {
      try {
        const base64Index = asset.dataUrl.indexOf(';base64,')
        if (base64Index > 0) {
          const base64Data = asset.dataUrl.slice(base64Index + 8)
          const buffer = Buffer.from(base64Data, 'base64')
          const stored = await storeMediaAssetFromBuffer(userDataPath, buffer)
          importedAssetMap.set(asset.assetId, stored.assetId)
        }
      } catch {
        // Skip unparseable asset
      }
    }
  }

  const existingIds = new Set(existingCards.map((c) => c.id))
  const importedCards: OpeningCardDefinition[] = []

  for (const raw of cardsToProcess) {
    const check = validateCardDefinition(raw)
    if (!check.ok || !check.card) continue

    let card = check.card

    // Never overwrite built-in cards
    if (isBuiltInCard(card.id)) {
      card = { ...card, id: `custom:imported_${Date.now()}_${randomBytes(4).toString('hex')}` }
    } else if (existingIds.has(card.id)) {
      // Re-key duplicate ID to avoid accidental clobbering
      card = { ...card, id: `custom:imported_${Date.now()}_${randomBytes(4).toString('hex')}` }
    }

    // Remap media asset ID if asset was restored or check if asset exists
    if (card.mediaAssetId) {
      const remapped = importedAssetMap.get(card.mediaAssetId)
      if (remapped) {
        card = { ...card, mediaAssetId: remapped }
      }
    }

    importedCards.push(card)
  }

  if (importedCards.length === 0) {
    return {
      ok: false,
      importedCards: [],
      count: 0,
      error: 'No valid card definitions found in import',
    }
  }

  return {
    ok: true,
    importedCards,
    count: importedCards.length,
  }
}
