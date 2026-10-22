import { agyDefaultsUsable } from './agy-default'
import type {
  AiSearchProviderId,
  AiSearchProviderMeta,
  AiSearchSettings,
  AiSettings,
} from './types'

export const AI_SEARCH_PROVIDERS: AiSearchProviderMeta[] = [
  { id: 'serper', label: 'Serper', keyPlaceholder: 'Serper API key', imageSearch: true },
  { id: 'serply', label: 'Serply', keyPlaceholder: 'Serply API key', imageSearch: true },
  { id: 'tavily', label: 'Tavily', keyPlaceholder: 'tvly-...', imageSearch: false },
  { id: 'parallel', label: 'Parallel', keyPlaceholder: 'Parallel API key', imageSearch: false },
  { id: 'agy', label: 'Antigravity CLI', keyPlaceholder: '', imageSearch: false, keyless: true },
  // exa/firecrawl: AI-search APIs without an image endpoint (like Tavily/Parallel)
  { id: 'exa', label: 'Exa', keyPlaceholder: 'Exa API key', imageSearch: false },
  { id: 'firecrawl', label: 'Firecrawl', keyPlaceholder: 'fc-...', imageSearch: false },
  // keenable: keyless like Parallel; a key only raises the rate limits
  { id: 'keenable', label: 'Keenable', keyPlaceholder: 'Keenable API key', imageSearch: false },
]

export function defaultAiSearchSettings(
  agyUsable: boolean = agyDefaultsUsable(),
): AiSearchSettings {
  return {
    // agy-first: Antigravity search when it is usable, otherwise keyless Parallel as before
    provider: agyUsable ? 'agy' : 'parallel',
    providers: {
      serper: { apiKey: '' },
      serply: { apiKey: '' },
      tavily: { apiKey: '' },
      parallel: { apiKey: '' },
      agy: { apiKey: '', cliPath: '', model: '' },
      exa: { apiKey: '' },
      firecrawl: { apiKey: '' },
      keenable: { apiKey: '' },
    },
  }
}

export function resolveAiSearchSettings(
  stored: Partial<AiSearchSettings> | undefined,
): AiSearchSettings {
  const defaults = defaultAiSearchSettings()
  if (!stored) return defaults
  const providers = { ...defaults.providers }
  for (const id of [
    'serper',
    'serply',
    'tavily',
    'parallel',
    'exa',
    'firecrawl',
    'keenable',
  ] as const) {
    const key = stored.providers?.[id]?.apiKey
    if (typeof key === 'string') providers[id] = { apiKey: key.trim() }
  }
  const agy = stored.providers?.agy
  providers.agy = {
    apiKey: '',
    cliPath: typeof agy?.cliPath === 'string' ? agy.cliPath.trim() : '',
    model: typeof agy?.model === 'string' ? agy.model.trim() : '',
  }
  return {
    provider:
      stored.provider === 'genspark' ? defaults.provider : (stored.provider ?? defaults.provider),
    providers,
  }
}

/** Parallel and Keenable can run keylessly; a missing key falls back to Parallel. */
export function activeSearchProvider(
  settings: Pick<AiSettings, 'search'> & Partial<Pick<AiSettings, 'provider'>>,
): Exclude<AiSearchProviderId, 'genspark'> {
  if (settings.provider === 'agy') {
    return 'agy'
  }
  const search = settings.search
  if (!search || search.provider === 'genspark') return 'parallel'
  if (!AI_SEARCH_PROVIDERS.some((m) => m.id === search.provider)) return 'parallel'
  if (search.provider === 'parallel' || search.provider === 'keenable' || search.provider === 'agy')
    return search.provider
  // Trim-aware: a whitespace-only key from in-memory settings falls back
  // instead of sending `Bearer    ` to the search backend.
  return search.providers?.[search.provider]?.apiKey?.trim() ? search.provider : 'parallel'
}
