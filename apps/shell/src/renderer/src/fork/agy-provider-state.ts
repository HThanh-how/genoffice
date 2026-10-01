/** Pure helpers behind the Antigravity CLI settings block (kept free of React for tests). */

export interface AgyCatalog {
  models: string[]
  defaultModel: string
  error?: string
}

export type AgyConnection =
  | { state: 'checking' }
  | { state: 'connected'; count: number }
  | { state: 'missing'; error: string }

export type AgyPlatform = 'win' | 'mac' | 'other'

/** Coarse platform from a user-agent string; selects which auto-detect hint to show. */
export function agyPlatformOf(userAgent: string): AgyPlatform {
  if (/Windows/i.test(userAgent)) return 'win'
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'mac'
  return 'other'
}

/** Connection state from a `agy models` reply (an `error` or an empty list means not connected). */
export function agyConnectionOf(
  catalog: AgyCatalog | null | undefined,
  fallbackError: string,
): AgyConnection {
  if (!catalog) return { state: 'missing', error: fallbackError }
  if (catalog.error) return { state: 'missing', error: catalog.error }
  if (catalog.models.length === 0) return { state: 'missing', error: fallbackError }
  return { state: 'connected', count: catalog.models.length }
}

interface CatalogEntryLike {
  id: string
  models: string[]
  defaultModel: string
}

/**
 * Replace the agy entry's model list with the live one. A stored selection that
 * the live list does not contain stays pinned on top so the picker never drops it.
 */
export function withAgyModels<T extends CatalogEntryLike>(
  catalog: T[],
  live: AgyCatalog,
  selectedModel: string,
): T[] {
  if (live.models.length === 0) return catalog
  const selected = selectedModel.trim()
  const models =
    selected && !live.models.includes(selected) ? [selected, ...live.models] : live.models
  return catalog.map((entry) =>
    entry.id === 'agy'
      ? { ...entry, models, defaultModel: live.defaultModel || entry.defaultModel }
      : entry,
  )
}
