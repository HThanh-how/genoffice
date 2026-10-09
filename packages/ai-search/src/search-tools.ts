/**
 * ai:web-search / ai:image-search for the editors' main processes: reads
 * ai-settings.json live and turns the search provider choice into
 * SearchOptions. Parallel works without a key, and a configured provider runs first.
 */

import {
  activeSearchProvider,
  type AiSearchProviderId,
  type AiSettings,
} from '@genoffice/ai-provider'
import { imageSearch, webSearch, type SearchOptions } from './index'
import { readAiSettingsFile } from './media-tools'
import { agyWebSearch } from './agy-search'
import { agyImageSearchWithFallback } from './agy-image-search'

export function searchOptionsFromSettings(settings: AiSettings): SearchOptions {
  const provider = activeSearchProvider(settings)
  const key = settings.search!.providers?.[provider]?.apiKey?.trim() ?? ''
  // The keyless source chain (Parallel, then DuckDuckGo): imageSearchTool asks Antigravity first
  // and falls back to this chain when it cannot name verifiable image URLs.
  if (provider === 'agy') return { useGsk: false, parallelKey: '', prefer: 'parallel' }
  if (provider === 'parallel') return { useGsk: false, parallelKey: key, prefer: 'parallel' }
  if (provider === 'serply') return { useGsk: false, serplyKey: key, prefer: 'serply' }
  if (provider === 'exa') return { useGsk: false, exaKey: key, prefer: 'exa' }
  if (provider === 'firecrawl') return { useGsk: false, firecrawlKey: key, prefer: 'firecrawl' }
  return provider === 'tavily'
    ? { useGsk: false, tavilyKey: key, prefer: 'tavily' }
    : { useGsk: false, serperKey: key, prefer: 'serper' }
}

export function webSearchTool(settingsPath: string, query: string, maxResults = 6) {
  const settings = readAiSettingsFile(settingsPath)
  if (activeSearchProvider(settings) === 'agy') {
    const searchConfig = settings.search?.providers.agy
    const chatConfig = settings.providers.agy
    return agyWebSearch(query, maxResults, {
      cliPath: searchConfig?.cliPath?.trim() || chatConfig?.cliPath?.trim(),
      model: searchConfig?.model?.trim() || chatConfig?.model?.trim(),
    })
  }
  return webSearch(query, maxResults, searchOptionsFromSettings(settings))
}

export function imageSearchTool(settingsPath: string, query: string, maxResults = 8) {
  const settings = readAiSettingsFile(settingsPath)
  const keyless = () => imageSearch(query, maxResults, searchOptionsFromSettings(settings))
  if (activeSearchProvider(settings) !== 'agy') return keyless()
  // same CLI path / model resolution as the agy web search
  return agyImageSearchWithFallback(
    query,
    maxResults,
    {
      cliPath:
        settings.search?.providers.agy?.cliPath?.trim() || settings.providers.agy?.cliPath?.trim(),
      model: settings.search?.providers.agy?.model?.trim() || settings.providers.agy?.model?.trim(),
    },
    keyless,
  )
}

/** settings-UI test: the selected backend (keyed or free) must answer one minimal query. */
export async function testSearchProvider(
  provider: AiSearchProviderId,
  apiKey: string,
  config?: { cliPath?: string | undefined; model?: string | undefined },
): Promise<{ ok: boolean; error?: string }> {
  if (provider === 'genspark') return { ok: false, error: 'Genspark search is disabled' }
  if (provider === 'agy') {
    const r = await agyWebSearch('GenOffice', 1, config)
    return r.method === 'agy'
      ? { ok: true }
      : { ok: false, error: r.error ?? 'Antigravity search failed' }
  }
  apiKey = apiKey.trim()
  if (!apiKey && provider !== 'parallel') return { ok: false, error: 'API key is empty' }
  const options: SearchOptions = {
    useGsk: false,
    serperKey: provider === 'serper' ? apiKey : '',
    serplyKey: provider === 'serply' ? apiKey : '',
    tavilyKey: provider === 'tavily' ? apiKey : '',
    parallelKey: provider === 'parallel' ? apiKey : '',
    exaKey: provider === 'exa' ? apiKey : '',
    firecrawlKey: provider === 'firecrawl' ? apiKey : '',
    prefer: provider,
  }
  const r = await webSearch('GenOffice', 1, options)
  if (r.method === provider) return { ok: true }
  return {
    ok: false,
    error:
      r.method === 'error'
        ? (r.error ?? 'search failed')
        : `${provider} did not answer (service unavailable, key rejected or quota exhausted); fell back to ${r.method}`,
  }
}
