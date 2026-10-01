import { isIP } from 'node:net'
import { AGY_DEFAULT_MODEL, runAgy } from '@genoffice/ai-provider/agy-cli'
import type { WebSearchResult } from './shared'

export interface AgySearchConfig {
  cliPath?: string | undefined
  model?: string | undefined
}

function publicHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (url.username || url.password) return false
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))
      return false
    if (isIP(host)) {
      if (
        host === '::1' ||
        host.startsWith('fc') ||
        host.startsWith('fd') ||
        host.startsWith('fe80:')
      )
        return false
      const octets = host.split('.').map(Number)
      if (
        octets[0] === 10 ||
        octets[0] === 127 ||
        octets[0] === 0 ||
        (octets[0] === 169 && octets[1] === 254) ||
        (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
        (octets[0] === 192 && octets[1] === 168)
      )
        return false
    }
    return true
  } catch {
    return false
  }
}

function parseResults(text: string, maxResults: number): WebSearchResult[] {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  const parsed: unknown = JSON.parse(trimmed)
  if (!Array.isArray(parsed))
    throw new Error('Antigravity search returned invalid JSON (expected an array)')
  const results: WebSearchResult[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    if (!publicHttpUrl(row.url)) continue
    const canonical = new URL(row.url).href
    if (seen.has(canonical)) continue
    seen.add(canonical)
    results.push({
      title: typeof row.title === 'string' ? row.title.slice(0, 500) : row.url,
      url: row.url,
      snippet: typeof row.snippet === 'string' ? row.snippet.slice(0, 2000) : '',
    })
    if (results.length >= maxResults) break
  }
  return results
}

export async function agyWebSearch(
  query: string,
  maxResults: number,
  config: AgySearchConfig = {},
): Promise<{
  results: WebSearchResult[]
  answer?: string
  method: string
  error?: string
}> {
  const normalizedQuery = typeof query === 'string' ? query.trim().slice(0, 4000) : ''
  if (!normalizedQuery) return { results: [], method: 'error', error: 'Search query is empty' }
  const limit = Number.isFinite(maxResults) ? Math.min(20, Math.max(1, Math.floor(maxResults))) : 6
  const prompt = [
    'Use your built-in search_web tool to search the web for the user query below. Do not rely on memory or invent search results or URLs.',
    'Return ONLY a strict JSON array, with each item having string fields title, url, snippet.',
    `Return no more than ${limit} relevant results. URLs must be public HTTP or HTTPS pages. Do not include markdown or commentary.`,
    `Query: ${normalizedQuery}`,
  ].join('\n')
  try {
    const response = await runAgy({
      cliPath: config.cliPath,
      model: config.model?.trim() || AGY_DEFAULT_MODEL,
      prompt,
    })
    const results = parseResults(response.text, limit)
    if (!results.length)
      return {
        results: [],
        method: 'error',
        error: 'Antigravity search returned no valid public URLs',
      }
    return { results, method: 'agy' }
  } catch (error) {
    return {
      results: [],
      method: 'error',
      error: `agy: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
