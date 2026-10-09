import { isIP } from 'node:net'
import { AGY_DEFAULT_MODEL, runAgy } from '@genoffice/ai-provider/agy-cli'
import { isAgyError, type AgyErrorKind } from '@genoffice/ai-provider'
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

const MAX_ANSWER_CHARS = 4000

/** How long an identical query is answered from memory instead of spending quota again. */
export const AGY_SEARCH_CACHE_TTL_MS = 10 * 60_000
const AGY_SEARCH_CACHE_MAX = 50

function resultsFrom(rows: unknown, maxResults: number): WebSearchResult[] {
  if (!Array.isArray(rows)) return []
  const results: WebSearchResult[] = []
  const seen = new Set<string>()
  for (const item of rows) {
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

function answerFrom(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim().slice(0, MAX_ANSWER_CHARS)
  return text || undefined
}

/** The JSON value in the model's text: the whole text, a fenced block, or the outermost {...}/[...]. */
function parseModelJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    return JSON.parse(trimmed)
  } catch (first) {
    // prose around the JSON: take the outermost array or object, whichever opens first (an
    // object holding the results array must not be mistaken for the bare array inside it)
    const pairs = (
      [
        ['[', ']'],
        ['{', '}'],
      ] as const
    )
      .map(([open, close]) => ({ from: trimmed.indexOf(open), to: trimmed.lastIndexOf(close) }))
      .filter((pair) => pair.from >= 0 && pair.to > pair.from)
      .sort((a, b) => a.from - b.from)
    for (const { from, to } of pairs) {
      try {
        return JSON.parse(trimmed.slice(from, to + 1))
      } catch {
        /* try the other bracket */
      }
    }
    throw first
  }
}

function parseSearch(
  text: string,
  structured: unknown,
  maxResults: number,
): { results: WebSearchResult[]; answer?: string } {
  let parsed: unknown = structured
  if (parsed === undefined || parsed === null) {
    try {
      parsed = parseModelJson(text)
    } catch {
      throw new Error('Antigravity search returned invalid JSON (expected results with URLs)')
    }
  }
  if (Array.isArray(parsed)) return { results: resultsFrom(parsed, maxResults) }
  if (parsed && typeof parsed === 'object') {
    const object = parsed as Record<string, unknown>
    const answer = answerFrom(object.answer ?? object.summary)
    return { results: resultsFrom(object.results, maxResults), ...(answer ? { answer } : {}) }
  }
  throw new Error('Antigravity search returned invalid JSON (expected an object or an array)')
}

/** The shape asked for with `--json-schema`: a short summary and the sources behind it. */
export function agySearchSchema(limit: number): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      answer: {
        type: 'string',
        description:
          'A short factual summary of what the search found, in the language of the query',
      },
      results: {
        type: 'array',
        maxItems: limit,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            url: { type: 'string' },
            snippet: { type: 'string' },
          },
          required: ['title', 'url', 'snippet'],
        },
      },
    },
    required: ['answer', 'results'],
  }
}

export interface AgySearchResponse {
  results: WebSearchResult[]
  answer?: string
  method: string
  error?: string
  /** typed cause of a failure, so a caller can localize it */
  errorKind?: AgyErrorKind
  /** epoch ms when an exhausted quota is expected back */
  errorResetAt?: number
  /** served from the query cache; no agy process ran */
  cached?: true
}

export interface AgySearchOptions {
  /** Stop: kills the agy process tree and frees its slot */
  signal?: AbortSignal | undefined
  /** skip the query cache for this call (it is also not written) */
  noCache?: boolean | undefined
}

interface CacheEntry {
  at: number
  value: { results: WebSearchResult[]; answer?: string }
}

const searchCache = new Map<string, CacheEntry>()
let cacheClock: () => number = () => Date.now()

/** Test seam: forget every cached query (and optionally replace the clock). */
export function resetAgySearchCache(now?: () => number): void {
  searchCache.clear()
  cacheClock = now ?? (() => Date.now())
}

/** Same question, different spacing or case, is the same query. */
export function normalizeAgySearchQuery(query: string): string {
  return query.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

function cacheKey(query: string, limit: number, config: AgySearchConfig): string {
  return JSON.stringify([
    normalizeAgySearchQuery(query),
    limit,
    config.model?.trim() || AGY_DEFAULT_MODEL,
    config.cliPath?.trim() || '',
  ])
}

function cacheGet(key: string): CacheEntry['value'] | undefined {
  const entry = searchCache.get(key)
  if (!entry) return undefined
  if (cacheClock() - entry.at > AGY_SEARCH_CACHE_TTL_MS) {
    searchCache.delete(key)
    return undefined
  }
  return entry.value
}

function cachePut(key: string, value: CacheEntry['value']): void {
  searchCache.delete(key)
  searchCache.set(key, { at: cacheClock(), value })
  while (searchCache.size > AGY_SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value
    if (oldest === undefined) break
    searchCache.delete(oldest)
  }
}

export async function agyWebSearch(
  query: string,
  maxResults: number,
  config: AgySearchConfig = {},
  options: AgySearchOptions = {},
): Promise<AgySearchResponse> {
  const normalizedQuery = typeof query === 'string' ? query.trim().slice(0, 4000) : ''
  if (!normalizedQuery) return { results: [], method: 'error', error: 'Search query is empty' }
  const limit = Number.isFinite(maxResults) ? Math.min(20, Math.max(1, Math.floor(maxResults))) : 6
  const key = cacheKey(normalizedQuery, limit, config)
  if (!options.noCache) {
    const hit = cacheGet(key)
    if (hit) {
      return {
        results: hit.results.map((result) => ({ ...result })),
        ...(hit.answer ? { answer: hit.answer } : {}),
        method: 'agy',
        cached: true,
      }
    }
  }
  const prompt = [
    'Use your built-in search_web tool to search the web for the user query below. Do not rely on memory or invent results or URLs.',
    'Return ONLY a JSON object: "answer" (short summary string) and "results" (a strict JSON array of {title,url,snippet} strings).',
    `Return no more than ${limit} relevant results; URLs must be public HTTP(S) pages. No markdown or commentary.`,
    `Query: ${normalizedQuery}`,
  ].join('\n')
  try {
    const response = await runAgy({
      cliPath: config.cliPath,
      model: config.model?.trim() || AGY_DEFAULT_MODEL,
      prompt,
      signal: options.signal,
      task: 'search',
      jsonSchema: agySearchSchema(limit),
    })
    const parsed = parseSearch(response.text, response.structured, limit)
    if (!parsed.results.length)
      return {
        results: [],
        method: 'error',
        error: 'Antigravity search returned no valid public URLs',
      }
    if (!options.noCache) cachePut(key, parsed)
    return {
      results: parsed.results,
      ...(parsed.answer ? { answer: parsed.answer } : {}),
      method: 'agy',
    }
  } catch (error) {
    return {
      results: [],
      method: 'error',
      error: `agy: ${error instanceof Error ? error.message : String(error)}`,
      ...(isAgyError(error) && error.kind !== 'unknown'
        ? {
            errorKind: error.kind,
            ...(error.resetAt === undefined ? {} : { errorResetAt: error.resetAt }),
          }
        : {}),
    }
  }
}
