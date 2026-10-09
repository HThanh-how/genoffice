/**
 * Image search through Antigravity. Measured on agy 1.3.2 (macOS, 2026-10): `search_web` works in the
 * headless sandbox but returns a text summary, `read_url_content` is denied (`denied_actions: read_url`),
 * and image URLs the model writes from memory are invented (10 of 10 Wikimedia upload paths did not
 * exist). So the agent is used for what it is good at, finding the right PAGES, and the picture files
 * are taken from those pages locally (og:image, twitter:image, image_src, large <img>), through the same
 * SSRF-guarded fetch. Model text is untrusted: every URL it names, and every one found on a page, is
 * verified before anyone sees it, so a result is only ever a real, public, image-typed, size-capped
 * file. Whatever fails degrades to the established keyless chain (see agyImageSearchWithFallback).
 *
 * Per candidate: http(s) only, SSRF-guarded fetch (every redirect hop revalidated), status 2xx,
 * content type an image (or octet-stream whose bytes are an image), declared size under the cap,
 * magic bytes match png/jpeg/gif/webp, dimensions read from the header when present, stock-photo
 * hosts dropped (shared.ts), duplicates dropped by URL and by pixel header.
 */

import { createHash } from 'node:crypto'
import {
  AGY_DEFAULT_MODEL,
  runAgy,
  type AgyRunOptions,
  type AgyRunResult,
} from '@genoffice/ai-provider/agy-cli'
import { remoteImageHeaders } from '@genoffice/electron-utils/remote-image'
import { fetchWithSsrfGuard } from '@genoffice/electron-utils/safe-remote-url'
import { MIN_USABLE_IMAGE_PX } from './index'
import { isCopyrightHost, safeHost, type ImageSearchResult } from './shared'

export interface AgyImageSearchConfig {
  cliPath?: string | undefined
  model?: string | undefined
}

/** one image search result set, shaped like imageSearch() */
export interface AgyImageSearchResponse {
  images: ImageSearchResult[]
  method: string
  error?: string
  /** set when the Antigravity route failed and the keyless chain answered instead */
  agyError?: string
}

/** a candidate larger than this is not worth embedding in a document */
export const AGY_IMAGE_SEARCH_MAX_BYTES = 20 * 1024 * 1024
/** bytes read per candidate to check magic numbers and dimensions */
const HEAD_BYTES = 64 * 1024
const CANDIDATE_TIMEOUT_MS = 8_000
const VALIDATE_CONCURRENCY = 4
const MAX_CANDIDATES = 24
const MAX_URL_CHARS = 2_048

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'])

// ---------------------------------------------------------------------------
// Prompt + reply parsing
// ---------------------------------------------------------------------------

export function buildAgyImageSearchPrompt(query: string, wanted: number): string {
  return [
    'Find web pages that contain good pictures for the query below. Use ONLY your built-in search_web tool (the headless sandbox denies every other tool, including read_url_content and shell commands).',
    'Return the real page URLs that search_web shows you. Give an imageUrl (a direct .jpg, .jpeg, .png, .webp or .gif link) ONLY when that exact URL appears in the search results; otherwise leave imageUrl empty. Never guess, build or complete a URL from memory or from a known URL pattern.',
    'Prefer pages where the picture is the main content (photo pages, articles, galleries, encyclopedia entries). Skip stock-photo marketplaces.',
    'Return ONLY a strict JSON array, with each item having string fields sourceUrl (the page), imageUrl (direct image file or empty string) and title. No markdown, no commentary.',
    `Return up to ${wanted} items.`,
    `Query: ${query}`,
  ].join('\n')
}

export interface ImageCandidate {
  /** direct image file the agent named; '' when it only named a page */
  imageUrl: string
  /** the page the picture belongs to (the image itself when no page was named) */
  sourceUrl: string
  title: string
}

function field(row: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = row[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function httpUrl(value: string): URL | null {
  if (!value || value.length > MAX_URL_CHARS) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    return url
  } catch {
    return null
  }
}

function jsonArrayText(text: string): string {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  if (unfenced.startsWith('[')) return unfenced
  // the agent sometimes adds a sentence around the array
  const start = unfenced.indexOf('[')
  const end = unfenced.lastIndexOf(']')
  return start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced
}

/**
 * Candidates from the reply: syntactically public http(s) URLs only, de-duplicated, capped. An item
 * needs a page or an image URL. Nothing is fetched here.
 */
export function parseImageCandidates(text: string): ImageCandidate[] {
  const parsed: unknown = JSON.parse(jsonArrayText(text))
  if (!Array.isArray(parsed)) throw new Error('Antigravity image search returned no JSON array')
  const out: ImageCandidate[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const image = httpUrl(field(row, 'imageUrl', 'image_url'))
    const page = httpUrl(
      field(row, 'sourceUrl', 'source_url', 'pageUrl', 'page_url', 'page', 'url'),
    )
    const main = image ?? page
    if (!main) continue
    if (image) image.hash = ''
    if (page) page.hash = ''
    const key = image ? image.href : page!.href
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      imageUrl: image ? image.href : '',
      sourceUrl: page ? page.href : image!.href,
      title: field(row, 'title', 'alt', 'caption').slice(0, 500) || main.hostname,
    })
    if (out.length >= MAX_CANDIDATES) break
  }
  return out
}

// ---------------------------------------------------------------------------
// Image header sniffing
// ---------------------------------------------------------------------------

export interface ImageHead {
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  width?: number
  height?: number
}

const ascii = (b: Uint8Array, from: number, to: number): string =>
  String.fromCharCode(...b.subarray(from, to))
const be16 = (b: Uint8Array, i: number): number => (b[i]! << 8) | b[i + 1]!
const le16 = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8)
const le24 = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)

function jpegSize(b: Uint8Array): { width: number; height: number } | undefined {
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++
      continue
    }
    const marker = b[i + 1]!
    if (marker === 0xff) {
      i++
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2
      continue
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: be16(b, i + 5), width: be16(b, i + 7) }
    }
    i += 2 + be16(b, i + 2)
  }
  return undefined
}

function webpSize(b: Uint8Array): { width: number; height: number } | undefined {
  const kind = ascii(b, 12, 16)
  if (kind === 'VP8 ' && b.length >= 30) {
    return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff }
  }
  if (kind === 'VP8L' && b.length >= 25) {
    return {
      width: 1 + (((b[22]! & 0x3f) << 8) | b[21]!),
      height: 1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6)),
    }
  }
  if (kind === 'VP8X' && b.length >= 30) return { width: 1 + le24(b, 24), height: 1 + le24(b, 27) }
  return undefined
}

/** The image type from the leading bytes (png, jpeg, gif, webp), plus its pixel size when the header carries one. */
export function sniffImageHead(b: Uint8Array): ImageHead | null {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
    return { mime: 'image/png', width: dv.getUint32(16), height: dv.getUint32(20) }
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { mime: 'image/jpeg', ...jpegSize(b) }
  }
  if (b.length >= 10 && ascii(b, 0, 4) === 'GIF8') {
    return { mime: 'image/gif', width: le16(b, 6), height: le16(b, 8) }
  }
  if (b.length >= 16 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ...webpSize(b) }
  }
  return null
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

async function readHead(resp: Response, max: number): Promise<Uint8Array> {
  if (!resp.body) return new Uint8Array(await resp.arrayBuffer()).subarray(0, max)
  const reader = resp.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < max) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
  }
  await reader.cancel().catch(() => {})
  const out = new Uint8Array(Math.min(total, max))
  let offset = 0
  for (const chunk of chunks) {
    const part = chunk.subarray(0, out.length - offset)
    out.set(part, offset)
    offset += part.length
    if (offset >= out.length) break
  }
  return out
}

export interface VerifiedImage {
  mime: ImageHead['mime']
  width?: number
  height?: number
  /** identifies the pixels' header, so the same picture behind two URLs counts once */
  fingerprint: string
}

export interface VerifyDeps {
  fetchImpl?: typeof fetch
  signal?: AbortSignal | undefined
  timeoutMs?: number
}

/** Fetch `url` through the SSRF guard and prove it is a real, reasonably sized image; null otherwise. Never throws. */
export async function verifyImageUrl(
  url: string,
  deps: VerifyDeps = {},
): Promise<VerifiedImage | null> {
  const base = deps.fetchImpl ?? fetch
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? CANDIDATE_TIMEOUT_MS)
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout
  const fetchImpl = ((input, init) => base(input, { ...init, signal })) as typeof fetch
  try {
    const resp = await fetchWithSsrfGuard(url, {
      fetchImpl,
      maxRedirects: 3,
      headers: remoteImageHeaders(url),
    })
    if (!resp || !resp.ok) {
      await resp?.body?.cancel().catch(() => {})
      return null
    }
    const declared = Number(resp.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > AGY_IMAGE_SEARCH_MAX_BYTES) {
      await resp.body?.cancel().catch(() => {})
      return null
    }
    const type = resp.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
    const octet = type === 'application/octet-stream' || type === 'binary/octet-stream'
    // a missing or non-image type is rejected; octet-stream is accepted only when the bytes are an image
    if (!octet && !IMAGE_TYPES.has(type)) {
      await resp.body?.cancel().catch(() => {})
      return null
    }
    const head = await readHead(resp, HEAD_BYTES)
    const sniffed = sniffImageHead(head)
    if (!sniffed) return null
    // a header claiming one image type while the bytes are another is not a picture we can label
    if (!octet && type.replace('jpg', 'jpeg') !== sniffed.mime) return null
    const fingerprint = createHash('sha1')
      .update(head.subarray(0, 4096))
      .update(String(sniffed.width ?? ''))
      .update(String(sniffed.height ?? ''))
      .digest('hex')
    return {
      mime: sniffed.mime,
      ...(sniffed.width ? { width: sniffed.width } : {}),
      ...(sniffed.height ? { height: sniffed.height } : {}),
      fingerprint,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Pictures on a page
// ---------------------------------------------------------------------------

/** html read per page: the head (og:image) and the first screens of the body are all that is used */
const PAGE_HTML_BYTES = 512 * 1024
const MAX_PAGE_IMAGES = 5
const NOT_CONTENT_IMAGE =
  /(?:^|[/_.-])(?:icon|logo|sprite|avatar|pixel|spacer|blank|badge|button)s?(?:[/_.-]|$)|1x1/i

const META_IMAGE_KEYS = new Set([
  'og:image',
  'og:image:url',
  'og:image:secure_url',
  'twitter:image',
  'twitter:image:src',
])

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1]!.toLowerCase()] = (m[2] ?? m[3] ?? '').replace(/&amp;/gi, '&').trim()
  }
  return out
}

/** the widest entry of a srcset, which is the closest to the original picture */
function largestSrcset(srcset: string): string {
  let best = ''
  let bestWidth = -1
  for (const part of srcset.split(',')) {
    const [url, descriptor] = part.trim().split(/\s+/)
    if (!url) continue
    const width = Number.parseInt(descriptor ?? '', 10)
    const score = Number.isFinite(width) ? width : 0
    if (score >= bestWidth) {
      best = url
      bestWidth = score
    }
  }
  return best
}

/** Picture URLs a page declares, most authoritative first: og:image / twitter:image, image_src, then <img>. */
export function extractPageImageUrls(html: string, baseUrl: string): string[] {
  const found: string[] = []
  const add = (raw: string | undefined): void => {
    if (!raw || raw.startsWith('data:')) return
    let url: URL
    try {
      url = new URL(raw, baseUrl)
    } catch {
      return
    }
    if (!httpUrl(url.href) || /\.(?:svg|ico)(?:$|[?#])/i.test(url.pathname + url.search)) return
    url.hash = ''
    if (!found.includes(url.href)) found.push(url.href)
  }
  const metas: string[] = []
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attributes(m[0])
    const key = (a.property ?? a.name ?? '').toLowerCase()
    if (META_IMAGE_KEYS.has(key)) metas.push(a.content ?? '')
  }
  metas.forEach(add)
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const a = attributes(m[0])
    if ((a.rel ?? '').toLowerCase() === 'image_src') add(a.href)
  }
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const a = attributes(m[0])
    const src = a.srcset ? largestSrcset(a.srcset) : (a['data-src'] ?? a['data-original'] ?? a.src)
    if (src && !NOT_CONTENT_IMAGE.test(src)) add(src)
    if (found.length >= MAX_PAGE_IMAGES * 2) break
  }
  return found.slice(0, MAX_PAGE_IMAGES)
}

interface PageImages {
  /** where the page really lives: search_web hands out Google grounding redirect links */
  finalUrl: string
  images: string[]
}

async function fetchPageImageUrls(pageUrl: string, deps: VerifyDeps): Promise<PageImages | null> {
  const base = deps.fetchImpl ?? fetch
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? CANDIDATE_TIMEOUT_MS)
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout
  const fetchImpl = ((input, init) => base(input, { ...init, signal })) as typeof fetch
  try {
    const resp = await fetchWithSsrfGuard(pageUrl, {
      fetchImpl,
      maxRedirects: 3,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,application/xhtml+xml;q=0.9' },
    })
    if (!resp || !resp.ok) {
      await resp?.body?.cancel().catch(() => {})
      return null
    }
    const type = resp.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
    if (type !== 'text/html' && type !== 'application/xhtml+xml') {
      await resp.body?.cancel().catch(() => {})
      return null
    }
    const finalUrl = httpUrl(resp.url)?.href ?? pageUrl
    const html = new TextDecoder().decode(await readHead(resp, PAGE_HTML_BYTES))
    return { finalUrl, images: extractPageImageUrls(html, finalUrl) }
  } catch {
    return null
  }
}

interface ResolvedImage extends VerifiedImage {
  url: string
  /** the page the picture was found on, after redirects; '' when the agent named the image itself */
  pageUrl: string
}

/** The agent's own image URL if it verifies, otherwise the first picture of its page that does. */
async function resolveCandidate(
  candidate: ImageCandidate,
  deps: VerifyDeps,
): Promise<ResolvedImage | null> {
  if (candidate.imageUrl) {
    const direct = await verifyImageUrl(candidate.imageUrl, deps)
    if (direct) return { ...direct, url: candidate.imageUrl, pageUrl: '' }
  }
  if (candidate.sourceUrl === candidate.imageUrl) return null
  const page = await fetchPageImageUrls(candidate.sourceUrl, deps)
  if (!page || isCopyrightHost(page.finalUrl)) return null
  for (const url of page.images) {
    if (deps.signal?.aborted) return null
    if (isCopyrightHost(url)) continue
    const verified = await verifyImageUrl(url, deps)
    if (verified) return { ...verified, url, pageUrl: page.finalUrl }
  }
  return null
}

/** Verify candidates (bounded parallelism, stopping once `max` pass) and shape them like imageSearch() results. */
export async function verifyImageCandidates(
  candidates: readonly ImageCandidate[],
  max: number,
  deps: VerifyDeps = {},
): Promise<ImageSearchResult[]> {
  const eligible = candidates.filter(
    (c) => !isCopyrightHost(c.imageUrl) && !isCopyrightHost(c.sourceUrl),
  )
  const results: Array<ImageSearchResult | undefined> = new Array(eligible.length)
  const fingerprints = new Set<string>()
  let accepted = 0
  let next = 0
  const worker = async (): Promise<void> => {
    while (accepted < max && next < eligible.length && !deps.signal?.aborted) {
      const index = next++
      const candidate = eligible[index]!
      const resolved = await resolveCandidate(candidate, deps)
      if (!resolved || fingerprints.has(resolved.fingerprint)) continue
      if (
        (resolved.width !== undefined && resolved.width < MIN_USABLE_IMAGE_PX) ||
        (resolved.height !== undefined && resolved.height < MIN_USABLE_IMAGE_PX)
      ) {
        continue
      }
      fingerprints.add(resolved.fingerprint)
      accepted++
      results[index] = {
        title: candidate.title,
        imageUrl: resolved.url,
        sourceUrl: resolved.pageUrl || candidate.sourceUrl,
        source: safeHost(resolved.pageUrl || candidate.sourceUrl) || safeHost(resolved.url),
        ...(resolved.width ? { width: resolved.width } : {}),
        ...(resolved.height ? { height: resolved.height } : {}),
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(VALIDATE_CONCURRENCY, eligible.length) }, () => worker()),
  )
  // report in the agent's own order (best match first)
  return results.filter((r): r is ImageSearchResult => r !== undefined).slice(0, max)
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export interface AgyImageSearchDeps extends VerifyDeps {
  /** replaces runAgy (tests) */
  run?: (options: AgyRunOptions) => Promise<Pick<AgyRunResult, 'text' | 'deniedActions'>>
}

/** Ask the user's Antigravity agent for image URLs and keep only the ones that verify. */
export async function agyImageSearch(
  query: string,
  maxResults: number,
  config: AgyImageSearchConfig = {},
  deps: AgyImageSearchDeps = {},
): Promise<AgyImageSearchResponse> {
  const q = typeof query === 'string' ? query.trim().slice(0, 500) : ''
  if (!q) return { images: [], method: 'error', error: 'Search query is empty' }
  const max = Number.isFinite(maxResults) ? Math.min(20, Math.max(1, Math.floor(maxResults))) : 8
  const run = deps.run ?? ((options) => runAgy(options))
  try {
    const reply = await run({
      cliPath: config.cliPath,
      model: config.model?.trim() || AGY_DEFAULT_MODEL,
      // ask for more than needed: invented or dead URLs are dropped by verification
      prompt: buildAgyImageSearchPrompt(q, Math.min(MAX_CANDIDATES, max + 6)),
      signal: deps.signal,
    })
    if (!reply.text.trim()) {
      const denied = (reply.deniedActions ?? []).map((d) => d.displayName || d.action).join(', ')
      throw new Error(
        denied
          ? `Antigravity gave no answer; its sandbox denied ${denied}`
          : 'Antigravity gave an empty answer',
      )
    }
    const candidates = parseImageCandidates(reply.text)
    if (candidates.length === 0) {
      return { images: [], method: 'error', error: 'Antigravity named no usable image URLs' }
    }
    const images = await verifyImageCandidates(candidates, max, deps)
    if (images.length === 0) {
      return {
        images: [],
        method: 'error',
        error: `no picture from the ${candidates.length} pages and image URLs Antigravity named could be verified`,
      }
    }
    return { images, method: 'agy' }
  } catch (error) {
    return {
      images: [],
      method: 'error',
      error: `agy: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Antigravity first; when it fails or nothing verifies, the keyless chain answers (and the response
 * says why through `agyError`). An aborted request is not retried through the fallback.
 */
export async function agyImageSearchWithFallback(
  query: string,
  maxResults: number,
  config: AgyImageSearchConfig,
  fallback: () => Promise<{ images: ImageSearchResult[]; method: string; error?: string }>,
  deps: AgyImageSearchDeps = {},
): Promise<AgyImageSearchResponse> {
  const viaAgy = await agyImageSearch(query, maxResults, config, deps)
  if (viaAgy.images.length > 0 || deps.signal?.aborted) return viaAgy
  const rescued = await fallback()
  return { ...rescued, ...(viaAgy.error ? { agyError: viaAgy.error } : {}) }
}
