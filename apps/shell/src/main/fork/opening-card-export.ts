import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type {
  CardCategory,
  CardContentKind,
  OpeningCardDefinition,
  OpeningCardExportBundle,
  OpeningMaterialConfig,
  OpeningMaterialPreset,
  OpeningThemeMode,
  StoredHtmlAsset,
  StoredMediaAsset,
} from '../../shared/opening-card-types'
import { isBuiltInCard } from '../../shared/opening-card-families'
import { SCENES } from '../../shared/opening-scenes-meta'
import { sanitizeBorderColor, sanitizeHexColor } from './opening-card-css'
import {
  deleteMediaAsset,
  isSafeAssetId,
  resolveSafeAssetPath,
  sniffImageSignature,
  storeMediaAssetFromBuffer,
} from './opening-media-storage'
import {
  deleteHtmlCardAsset,
  isSafeHtmlAssetId,
  readHtmlCardAsset,
  storeHtmlCardAsset,
} from './opening-html-storage'
import { sanitizeOpeningCss, sanitizeOpeningHtml } from './opening-card-html-sanitizer'

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
  'ai-html',
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
    if (typeof obj.mediaAssetId === 'string' && SAFE_ID_PATTERN.test(obj.mediaAssetId)) {
      mediaAssetId = obj.mediaAssetId
    } else {
      return { ok: false, error: 'Invalid mediaAssetId format' }
    }
  }

  // Validate optional htmlAssetId
  let htmlAssetId: string | undefined
  if (obj.htmlAssetId !== undefined) {
    if (typeof obj.htmlAssetId === 'string' && SAFE_ID_PATTERN.test(obj.htmlAssetId)) {
      htmlAssetId = obj.htmlAssetId
    } else {
      return { ok: false, error: 'Invalid htmlAssetId format' }
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

  // Validate optional sceneId (for canvas-scene or customized animated cards)
  let sceneId: string | undefined
  if (obj.sceneId !== undefined) {
    if (typeof obj.sceneId === 'string' && SCENES.some((s) => s.id === obj.sceneId)) {
      sceneId = obj.sceneId
    } else {
      return { ok: false, error: 'Invalid or unsupported sceneId reference' }
    }
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
    ...(sceneId ? { sceneId } : {}),
    ...(mediaAssetId ? { mediaAssetId } : {}),
    ...(htmlAssetId ? { htmlAssetId } : {}),
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
 * Deduplicates shared assets, computes true binary byte sizes, and sniffs exact image MIME types.
 */
export function createOpeningCardExportBundle(
  cards: readonly OpeningCardDefinition[],
  userDataPath: string,
): OpeningCardExportBundle {
  const assetsMap = new Map<string, StoredMediaAsset>()
  const htmlAssetsMap = new Map<string, StoredHtmlAsset>()
  const exportedCards: OpeningCardDefinition[] = []

  for (const card of cards) {
    const validation = validateCardDefinition(card)
    if (!validation.ok || !validation.card) continue

    const validCard = validation.card
    if (validCard.mediaAssetId && !assetsMap.has(validCard.mediaAssetId)) {
      try {
        const filePath = resolveSafeAssetPath(userDataPath, validCard.mediaAssetId)
        if (existsSync(filePath)) {
          const buf = readFileSync(filePath)
          const sniffed = sniffImageSignature(buf)
          if (sniffed) {
            const dataUrl = `data:${sniffed.mime};base64,${buf.toString('base64')}`
            assetsMap.set(validCard.mediaAssetId, {
              assetId: validCard.mediaAssetId,
              mime: sniffed.mime,
              sizeBytes: buf.length,
              dataUrl,
              createdAt: Date.now(),
            })
          }
        }
      } catch {
        // Asset file missing: card exported with degraded media, will fall back to material
      }
    }

    if (validCard.htmlAssetId && !htmlAssetsMap.has(validCard.htmlAssetId)) {
      try {
        const htmlAsset = readHtmlCardAsset(userDataPath, validCard.htmlAssetId)
        if (htmlAsset) {
          htmlAssetsMap.set(validCard.htmlAssetId, htmlAsset)
        }
      } catch {
        // HTML asset missing: fallback
      }
    }

    exportedCards.push(validCard)
  }

  const assets = Array.from(assetsMap.values())
  const htmlAssets = Array.from(htmlAssetsMap.values())
  return {
    version: 1,
    exportedAt: Date.now(),
    cards: exportedCards,
    assets: assets.length > 0 ? assets : undefined,
    htmlAssets: htmlAssets.length > 0 ? htmlAssets : undefined,
  }
}

export const MAX_IMPORT_BUNDLE_JSON_CHARS = 50 * 1024 * 1024 // 50 MB
export const MAX_IMPORT_CARDS = 100
export const MAX_IMPORT_ASSETS = 50
export const MAX_SINGLE_ASSET_BASE64_CHARS = 14 * 1024 * 1024 // ~10 MB binary

/**
 * Validates and imports cards from an exported JSON bundle or legacy array.
 * Uses a controlled 5-phase transaction with automatic asset rollback on failure.
 */
export async function importCardsFromExportBundle(
  jsonContent: string,
  userDataPath: string,
  existingCards: readonly OpeningCardDefinition[],
): Promise<{
  ok: boolean
  importedCards: OpeningCardDefinition[]
  count: number
  newlyCreatedMediaAssetIds: string[]
  newlyCreatedHtmlAssetIds: string[]
  error?: string
}> {
  // Phase 1: Preflight Validation
  if (typeof jsonContent !== 'string' || !jsonContent.trim()) {
    return {
      ok: false,
      importedCards: [],
      count: 0,
      newlyCreatedMediaAssetIds: [],
      newlyCreatedHtmlAssetIds: [],
      error: 'Empty import payload',
    }
  }
  if (jsonContent.length > MAX_IMPORT_BUNDLE_JSON_CHARS) {
    return {
      ok: false,
      importedCards: [],
      count: 0,
      newlyCreatedMediaAssetIds: [],
      newlyCreatedHtmlAssetIds: [],
      error: 'Bundle exceeds maximum size limit of 50 MB',
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonContent)
  } catch {
    return {
      ok: false,
      importedCards: [],
      count: 0,
      newlyCreatedMediaAssetIds: [],
      newlyCreatedHtmlAssetIds: [],
      error: 'Invalid JSON payload',
    }
  }

  let rawCards: unknown[]
  let rawAssets: unknown[] = []
  let rawHtmlAssets: unknown[] = []

  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>).version === 1
  ) {
    const bundle = parsed as OpeningCardExportBundle
    if (!Array.isArray(bundle.cards)) {
      return {
        ok: false,
        importedCards: [],
        count: 0,
        newlyCreatedMediaAssetIds: [],
        newlyCreatedHtmlAssetIds: [],
        error: 'Bundle missing cards array',
      }
    }
    rawCards = bundle.cards
    if (Array.isArray(bundle.assets)) {
      rawAssets = bundle.assets
    }
    if (Array.isArray(bundle.htmlAssets)) {
      rawHtmlAssets = bundle.htmlAssets
    }
  } else if (Array.isArray(parsed)) {
    rawCards = parsed
  } else {
    return {
      ok: false,
      importedCards: [],
      count: 0,
      newlyCreatedMediaAssetIds: [],
      newlyCreatedHtmlAssetIds: [],
      error: 'Unsupported import format. Expected version 1 card bundle or card array.',
    }
  }

  if (rawCards.length > MAX_IMPORT_CARDS) {
    return {
      ok: false,
      importedCards: [],
      count: 0,
      newlyCreatedMediaAssetIds: [],
      newlyCreatedHtmlAssetIds: [],
      error: `Bundle exceeds maximum card limit of ${MAX_IMPORT_CARDS} cards`,
    }
  }
  if (rawAssets.length > MAX_IMPORT_ASSETS) {
    return {
      ok: false,
      importedCards: [],
      count: 0,
      newlyCreatedMediaAssetIds: [],
      newlyCreatedHtmlAssetIds: [],
      error: `Bundle exceeds maximum asset limit of ${MAX_IMPORT_ASSETS} assets`,
    }
  }
  if (rawHtmlAssets.length > MAX_IMPORT_ASSETS) {
    return {
      ok: false,
      importedCards: [],
      count: 0,
      newlyCreatedMediaAssetIds: [],
      newlyCreatedHtmlAssetIds: [],
      error: `Bundle exceeds maximum HTML asset limit of ${MAX_IMPORT_ASSETS} assets`,
    }
  }

  // Pre-validate all card definitions first
  const validatedCards: OpeningCardDefinition[] = []
  for (const raw of rawCards) {
    const check = validateCardDefinition(raw)
    if (check.ok && check.card) {
      validatedCards.push(check.card)
    }
  }

  if (validatedCards.length === 0) {
    return {
      ok: false,
      importedCards: [],
      count: 0,
      newlyCreatedMediaAssetIds: [],
      newlyCreatedHtmlAssetIds: [],
      error: 'No valid card definitions found in import',
    }
  }

  // Pre-validate embedded asset payload lengths
  const validAssets: StoredMediaAsset[] = []
  for (const a of rawAssets) {
    if (
      a &&
      typeof a === 'object' &&
      typeof (a as StoredMediaAsset).assetId === 'string' &&
      SAFE_ID_PATTERN.test((a as StoredMediaAsset).assetId) &&
      typeof (a as StoredMediaAsset).dataUrl === 'string'
    ) {
      const asset = a as StoredMediaAsset
      if (asset.dataUrl!.length > MAX_SINGLE_ASSET_BASE64_CHARS) {
        return {
          ok: false,
          importedCards: [],
          count: 0,
          newlyCreatedMediaAssetIds: [],
          newlyCreatedHtmlAssetIds: [],
          error: `Embedded asset ${asset.assetId} exceeds single asset size limit`,
        }
      }
      validAssets.push(asset)
    }
  }

  // Pre-validate embedded HTML assets
  const validHtmlAssets: StoredHtmlAsset[] = []
  for (const h of rawHtmlAssets) {
    if (
      h &&
      typeof h === 'object' &&
      typeof (h as StoredHtmlAsset).assetId === 'string' &&
      SAFE_ID_PATTERN.test((h as StoredHtmlAsset).assetId) &&
      typeof (h as StoredHtmlAsset).html === 'string' &&
      typeof (h as StoredHtmlAsset).css === 'string'
    ) {
      const hAsset = h as StoredHtmlAsset
      const htmlCheck = sanitizeOpeningHtml(hAsset.html)
      const cssCheck = sanitizeOpeningCss(hAsset.css)
      if (!htmlCheck.ok || !cssCheck.ok) {
        return {
          ok: false,
          importedCards: [],
          count: 0,
          newlyCreatedMediaAssetIds: [],
          newlyCreatedHtmlAssetIds: [],
          error: `Embedded HTML asset ${hAsset.assetId} contains prohibited or unsafe code`,
        }
      }
      validHtmlAssets.push({
        ...hAsset,
        html: htmlCheck.sanitizedHtml!,
        css: cssCheck.sanitizedCss!,
      })
    }
  }

  // Phase 2: Prepare IDs & references
  const allocatedIds = new Set(existingCards.map((c) => c.id))
  const preparedCards: OpeningCardDefinition[] = []

  for (const card of validatedCards) {
    let finalId = card.id
    if (isBuiltInCard(finalId) || allocatedIds.has(finalId)) {
      finalId = `custom:imported_${Date.now()}_${randomBytes(4).toString('hex')}`
    }
    allocatedIds.add(finalId)
    preparedCards.push({ ...card, id: finalId })
  }

  // Phase 3 & 4: Import Media and HTML Assets with Rollback on Failure
  const newlyCreatedAssetIds: string[] = []
  const newlyCreatedHtmlAssetIds: string[] = []
  const importedAssetMap = new Map<string, string>() // oldAssetId -> newAssetId
  const importedHtmlAssetMap = new Map<string, string>() // oldHtmlAssetId -> newHtmlAssetId

  const referencedAssetIds = new Set(
    preparedCards.map((c) => c.mediaAssetId).filter((id): id is string => typeof id === 'string'),
  )
  const referencedHtmlAssetIds = new Set(
    preparedCards.map((c) => c.htmlAssetId).filter((id): id is string => typeof id === 'string'),
  )

  try {
    for (const asset of validAssets) {
      if (!referencedAssetIds.has(asset.assetId)) {
        continue
      }
      if (!asset.dataUrl || !asset.dataUrl.startsWith('data:image/')) {
        continue
      }
      const base64Index = asset.dataUrl.indexOf(';base64,')
      if (base64Index <= 0) continue
      const base64Data = asset.dataUrl.slice(base64Index + 8)
      const buffer = Buffer.from(base64Data, 'base64')
      const stored = await storeMediaAssetFromBuffer(userDataPath, buffer)
      newlyCreatedAssetIds.push(stored.assetId)
      importedAssetMap.set(asset.assetId, stored.assetId)
    }

    for (const hAsset of validHtmlAssets) {
      if (!referencedHtmlAssetIds.has(hAsset.assetId)) {
        continue
      }
      const stored = await storeHtmlCardAsset(userDataPath, hAsset.html, hAsset.css)
      newlyCreatedHtmlAssetIds.push(stored.assetId)
      importedHtmlAssetMap.set(hAsset.assetId, stored.assetId)
    }
  } catch (err) {
    // Phase 5: Rollback newly created assets
    for (const assetId of newlyCreatedAssetIds) {
      deleteMediaAsset(userDataPath, assetId)
    }
    for (const assetId of newlyCreatedHtmlAssetIds) {
      deleteHtmlCardAsset(userDataPath, assetId)
    }
    return {
      ok: false,
      importedCards: [],
      count: 0,
      newlyCreatedMediaAssetIds: [],
      newlyCreatedHtmlAssetIds: [],
      error: `Asset import failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // Remap media and HTML asset IDs on accepted cards and validate un-embedded local references
  const finalCards: OpeningCardDefinition[] = preparedCards.map((card) => {
    let remappedCard = card
    if (remappedCard.mediaAssetId) {
      const remappedMedia = importedAssetMap.get(remappedCard.mediaAssetId)
      if (remappedMedia) {
        remappedCard = { ...remappedCard, mediaAssetId: remappedMedia }
      } else {
        let localExists: boolean
        try {
          localExists =
            isSafeAssetId(remappedCard.mediaAssetId) &&
            existsSync(resolveSafeAssetPath(userDataPath, remappedCard.mediaAssetId))
        } catch {
          localExists = false
        }
        if (!localExists) {
          remappedCard = { ...remappedCard, mediaAssetId: undefined }
        }
      }
    }
    if (remappedCard.htmlAssetId) {
      const remappedHtml = importedHtmlAssetMap.get(remappedCard.htmlAssetId)
      if (remappedHtml) {
        remappedCard = { ...remappedCard, htmlAssetId: remappedHtml }
      } else {
        let localExists: boolean
        try {
          localExists =
            isSafeHtmlAssetId(remappedCard.htmlAssetId) &&
            Boolean(readHtmlCardAsset(userDataPath, remappedCard.htmlAssetId))
        } catch {
          localExists = false
        }
        if (!localExists) {
          remappedCard = { ...remappedCard, htmlAssetId: undefined }
        }
      }
    }
    return remappedCard
  })

  return {
    ok: true,
    importedCards: finalCards,
    count: finalCards.length,
    newlyCreatedMediaAssetIds: newlyCreatedAssetIds,
    newlyCreatedHtmlAssetIds,
  }
}
