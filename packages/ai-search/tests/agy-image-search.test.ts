import { deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'

const dns = vi.hoisted(() => ({
  lookup: vi.fn(async (host: string) =>
    host.startsWith('internal')
      ? [{ address: '10.0.0.7', family: 4 }]
      : [{ address: '93.184.216.34', family: 4 }],
  ),
}))
vi.mock('node:dns/promises', () => dns)
vi.mock('@genoffice/ai-provider/agy-cli', () => ({
  AGY_DEFAULT_MODEL: 'default-model',
  runAgy: vi.fn(),
}))
vi.mock('../src/media-tools', async () => ({ readAiSettingsFile: vi.fn() }))

import { runAgy, type AgyRunOptions } from '@genoffice/ai-provider/agy-cli'
import { defaultAiSettings } from '@genoffice/ai-provider'
import {
  agyImageSearch,
  agyImageSearchWithFallback,
  buildAgyImageSearchPrompt,
  extractPageImageUrls,
  parseImageCandidates,
  sniffImageHead,
  verifyImageUrl,
} from '../src/agy-image-search'
import { readAiSettingsFile } from '../src/media-tools'
import { imageSearchTool } from '../src/search-tools'

afterEach(() => vi.clearAllMocks())

// ---- fixtures ------------------------------------------------------------

function png(width: number, height: number, salt = 0): Uint8Array {
  const b = new Uint8Array(64)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(b.buffer).setUint32(16, width)
  new DataView(b.buffer).setUint32(20, height)
  b[40] = salt
  return b
}
function jpeg(width: number, height: number): Uint8Array {
  // SOI, APP0 (len 16), SOF0 carrying the size
  const b = new Uint8Array(40)
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])
  b.set([0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3], 20)
  return b
}
function gif(width: number, height: number): Uint8Array {
  const b = new Uint8Array(16)
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, width & 255, width >> 8, height & 255, height >> 8])
  return b
}
function webpLossy(width: number, height: number): Uint8Array {
  const b = new Uint8Array(40)
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20])
  b.set([width & 255, (width >> 8) & 0x3f, height & 255, (height >> 8) & 0x3f], 26)
  return b
}

type Reply = { status?: number; type?: string; body?: Uint8Array | string; length?: number }
function fakeFetch(map: Record<string, Reply>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const reply = map[String(input)]
    if (!reply) throw new Error(`unreachable ${String(input)}`)
    const headers: Record<string, string> = {}
    if (reply.type) headers['content-type'] = reply.type
    if (reply.length !== undefined) headers['content-length'] = String(reply.length)
    const body = reply.body ?? ''
    return new Response(typeof body === 'string' ? body : new Uint8Array(body), {
      status: reply.status ?? 200,
      headers,
    })
  }) as typeof fetch
}

const IMG = (path: string) => `https://img.example.com/${path}`

// ---- parsing -------------------------------------------------------------

describe('parseImageCandidates', () => {
  it('keeps http(s) image links, de-duplicates and ignores everything else', () => {
    const out = parseImageCandidates(
      '```json\n' +
        JSON.stringify([
          { imageUrl: IMG('a.jpg'), sourceUrl: 'https://example.com/p', title: 'A' },
          { imageUrl: IMG('a.jpg#frag'), sourceUrl: 'https://example.com/q', title: 'dup' },
          { image_url: IMG('b.png'), title: 'B' },
          { imageUrl: 'ftp://example.com/c.png' },
          { imageUrl: 'javascript:alert(1)' },
          { imageUrl: 'https://user:pw@example.com/d.png' },
          { imageUrl: 'not a url' },
          { title: 'no url' },
          'string',
          null,
        ]) +
        '\n```',
    )
    expect(out.map((c) => c.imageUrl)).toEqual([IMG('a.jpg'), IMG('b.png')])
    expect(out[0]).toMatchObject({ sourceUrl: 'https://example.com/p', title: 'A' })
    // a missing source page falls back to the image itself, a missing title to the host
    expect(out[1]).toMatchObject({ sourceUrl: IMG('b.png'), title: 'B' })
  })

  it('keeps a page the agent named without an image, and an image without a page', () => {
    const out = parseImageCandidates(
      JSON.stringify([
        { sourceUrl: 'https://example.com/article', imageUrl: '', title: 'Page only' },
        { url: 'https://example.com/other', title: 'Legacy url key' },
        { imageUrl: IMG('solo.png') },
      ]),
    )
    expect(out).toEqual([
      { imageUrl: '', sourceUrl: 'https://example.com/article', title: 'Page only' },
      { imageUrl: '', sourceUrl: 'https://example.com/other', title: 'Legacy url key' },
      { imageUrl: IMG('solo.png'), sourceUrl: IMG('solo.png'), title: 'img.example.com' },
    ])
  })

  it('finds the array inside a sentence and rejects a reply without one', () => {
    expect(
      parseImageCandidates(`Here you go: [{"imageUrl":"${IMG('a.jpg')}"}] enjoy`),
    ).toHaveLength(1)
    expect(() => parseImageCandidates('no images found')).toThrow()
    expect(() => parseImageCandidates('{"imageUrl":"x"}')).toThrow()
  })
})

describe('sniffImageHead', () => {
  it('reads type and size from the first bytes of png, jpeg, gif and webp', () => {
    expect(sniffImageHead(png(800, 600))).toEqual({ mime: 'image/png', width: 800, height: 600 })
    expect(sniffImageHead(jpeg(1024, 768))).toEqual({
      mime: 'image/jpeg',
      width: 1024,
      height: 768,
    })
    expect(sniffImageHead(gif(300, 200))).toEqual({ mime: 'image/gif', width: 300, height: 200 })
    expect(sniffImageHead(webpLossy(640, 480))).toEqual({
      mime: 'image/webp',
      width: 640,
      height: 480,
    })
  })

  it('refuses everything that is not one of those', () => {
    expect(sniffImageHead(new TextEncoder().encode('<!doctype html><html>...</html>'))).toBeNull()
    expect(
      sniffImageHead(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">')),
    ).toBeNull()
    expect(sniffImageHead(new Uint8Array(0))).toBeNull()
    expect(sniffImageHead(deflateSync(Buffer.from('x')))).toBeNull()
  })
})

// ---- pictures on a page ----------------------------------------------------

describe('extractPageImageUrls', () => {
  const page = 'https://news.example.org/story/1'
  it('prefers og:image and twitter:image, then image_src, then content images', () => {
    const html = `<html><head>
      <meta content="/media/hero.jpg?a=1&amp;b=2" property="og:image">
      <meta name="twitter:image" content='https://cdn.example.org/tw.png'>
      <meta property="og:title" content="not an image">
      <link rel="image_src" href="//cdn.example.org/src.webp">
      </head><body>
      <img src="/img/site-logo.png">
      <img src="data:image/gif;base64,AAAA">
      <img src="/vector.svg">
      <img data-src="/lazy/photo.jpg" src="/placeholder.gif">
      <img srcset="/s/small.jpg 400w, /s/big.jpg 1600w, /s/mid.jpg 800w">
      </body></html>`
    expect(extractPageImageUrls(html, page)).toEqual([
      'https://news.example.org/media/hero.jpg?a=1&b=2',
      'https://cdn.example.org/tw.png',
      'https://cdn.example.org/src.webp',
      'https://news.example.org/lazy/photo.jpg',
      'https://news.example.org/s/big.jpg',
    ])
  })

  it('ignores javascript:, ftp: and unparsable values and caps the list', () => {
    const imgs = Array.from({ length: 12 }, (_, i) => `<img src="/p/${i}.jpg">`).join('')
    const html = `<meta property="og:image" content="javascript:alert(1)"><meta property="og:image" content="ftp://x/y.png">${imgs}`
    const urls = extractPageImageUrls(html, page)
    expect(urls).toHaveLength(5)
    expect(urls.every((u) => u.startsWith('https://news.example.org/p/'))).toBe(true)
  })
})

describe('agyImageSearch with pages', () => {
  const html = (body: string) => ({ type: 'text/html; charset=utf-8', body })

  it('takes the picture from the page when the agent only named the page (invented image URLs fail)', async () => {
    const fetchImpl = fakeFetch({
      'https://news.example.org/a': html(
        `<meta property="og:image" content="https://img.example.com/real-a.jpg">`,
      ),
      'https://news.example.org/b': html(`<img src="https://img.example.com/real-b.png">`),
      'https://news.example.org/c': html('<p>no pictures here</p>'),
      'https://news.example.org/d': { type: 'application/pdf', body: 'pdf' },
      [IMG('real-a.jpg')]: { type: 'image/jpeg', body: jpeg(1280, 720) },
      [IMG('real-b.png')]: { type: 'image/png', body: png(900, 600, 3) },
    })
    const run = async () => ({
      text: JSON.stringify([
        { sourceUrl: 'https://news.example.org/a', imageUrl: IMG('invented-a.jpg'), title: 'A' },
        { sourceUrl: 'https://news.example.org/b', imageUrl: '', title: 'B' },
        { sourceUrl: 'https://news.example.org/c', imageUrl: '', title: 'C' },
        { sourceUrl: 'https://news.example.org/d', imageUrl: '', title: 'D' },
        { sourceUrl: 'https://news.example.org/gone', imageUrl: '', title: 'Gone' },
      ]),
    })
    const r = await agyImageSearch('q', 5, {}, { run, fetchImpl })
    expect(r.method).toBe('agy')
    expect(r.images.map((i) => [i.title, i.imageUrl, i.sourceUrl])).toEqual([
      ['A', IMG('real-a.jpg'), 'https://news.example.org/a'],
      ['B', IMG('real-b.png'), 'https://news.example.org/b'],
    ])
    expect(r.images[0]).toMatchObject({ source: 'news.example.org', width: 1280, height: 720 })
  })

  it('reports the page the search redirect led to, not the redirect link', async () => {
    const redirect = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123'
    const inner = fakeFetch({
      [IMG('hero.jpg')]: { type: 'image/jpeg', body: jpeg(1600, 900) },
    })
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === redirect) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://wildlife.example.org/red-panda' },
        })
      }
      if (String(input) === 'https://wildlife.example.org/red-panda') {
        const page = new Response(`<meta property="og:image" content="${IMG('hero.jpg')}">`, {
          headers: { 'content-type': 'text/html' },
        })
        Object.defineProperty(page, 'url', { value: 'https://wildlife.example.org/red-panda' })
        return page
      }
      return inner(input, init)
    }) as typeof fetch
    const run = async () => ({
      text: JSON.stringify([{ sourceUrl: redirect, title: 'Red panda' }]),
    })
    const r = await agyImageSearch('q', 3, {}, { run, fetchImpl })
    expect(r.images).toEqual([
      {
        title: 'Red panda',
        imageUrl: IMG('hero.jpg'),
        sourceUrl: 'https://wildlife.example.org/red-panda',
        source: 'wildlife.example.org',
        width: 1600,
        height: 900,
      },
    ])
  })

  it('guards the page fetch and the pictures found on it', async () => {
    const calls: string[] = []
    const inner = fakeFetch({
      'https://news.example.org/p': html(
        `<meta property="og:image" content="http://127.0.0.1/secret.png"><img src="https://cdn.gettyimages.com/x.jpg"><img src="${IMG('ok.png')}">`,
      ),
      [IMG('ok.png')]: { type: 'image/png', body: png(700, 700) },
    })
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input))
      return inner(input, init)
    }) as typeof fetch
    const run = async () => ({
      text: JSON.stringify([
        { sourceUrl: 'http://127.0.0.1/admin', title: 'internal page' },
        { sourceUrl: 'https://news.example.org/p', title: 'P' },
      ]),
    })
    const r = await agyImageSearch('q', 3, {}, { run, fetchImpl })
    expect(r.images.map((i) => i.imageUrl)).toEqual([IMG('ok.png')])
    expect(calls).toEqual(['https://news.example.org/p', IMG('ok.png')])
  })
})

// ---- verification --------------------------------------------------------

describe('verifyImageUrl', () => {
  it('accepts a real image and reports its size', async () => {
    const fetchImpl = fakeFetch({ [IMG('ok.png')]: { type: 'image/png', body: png(900, 700) } })
    expect(await verifyImageUrl(IMG('ok.png'), { fetchImpl })).toMatchObject({
      mime: 'image/png',
      width: 900,
      height: 700,
    })
  })

  it('rejects html pages, wrong types, lying types, missing types and error statuses', async () => {
    const html = new TextEncoder().encode('<html><body>not an image</body></html>')
    const fetchImpl = fakeFetch({
      [IMG('page.jpg')]: { type: 'text/html', body: html },
      [IMG('fake.jpg')]: { type: 'image/jpeg', body: html }, // says image, is html
      [IMG('mismatch.jpg')]: { type: 'image/jpeg', body: png(500, 500) }, // png bytes, jpeg label
      [IMG('notype.png')]: { body: png(500, 500) },
      [IMG('svg.svg')]: { type: 'image/svg+xml', body: '<svg/>' },
      [IMG('gone.png')]: { status: 404, type: 'image/png', body: png(500, 500) },
    })
    for (const name of [
      'page.jpg',
      'fake.jpg',
      'mismatch.jpg',
      'notype.png',
      'svg.svg',
      'gone.png',
    ]) {
      expect(await verifyImageUrl(IMG(name), { fetchImpl })).toBeNull()
    }
  })

  it('accepts octet-stream only when the bytes really are an image', async () => {
    const fetchImpl = fakeFetch({
      [IMG('a')]: { type: 'application/octet-stream', body: jpeg(600, 400) },
      [IMG('b')]: { type: 'application/octet-stream', body: new Uint8Array([1, 2, 3]) },
    })
    expect(await verifyImageUrl(IMG('a'), { fetchImpl })).toMatchObject({ mime: 'image/jpeg' })
    expect(await verifyImageUrl(IMG('b'), { fetchImpl })).toBeNull()
  })

  it('refuses an oversized declared length without reading the body', async () => {
    const fetchImpl = fakeFetch({
      [IMG('huge.png')]: { type: 'image/png', body: png(900, 900), length: 25 * 1024 * 1024 },
    })
    expect(await verifyImageUrl(IMG('huge.png'), { fetchImpl })).toBeNull()
  })

  it('never fetches private, loopback, metadata or non-http targets (SSRF guard)', async () => {
    const calls: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response(new Uint8Array(png(900, 900)), {
        headers: { 'content-type': 'image/png' },
      })
    }) as typeof fetch
    for (const url of [
      'http://127.0.0.1/a.png',
      'http://169.254.169.254/latest/meta-data.png',
      'http://[::1]/a.png',
      'https://internal.corp.example/a.png', // resolves to 10.0.0.7
      'file:///etc/passwd',
    ]) {
      expect(await verifyImageUrl(url, { fetchImpl })).toBeNull()
    }
    expect(calls).toEqual([])
  })

  it('re-validates every redirect hop', async () => {
    const calls: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/secret.png' },
      })
    }) as typeof fetch
    expect(await verifyImageUrl(IMG('bounce.png'), { fetchImpl })).toBeNull()
    expect(calls).toEqual([IMG('bounce.png')])
  })

  it('answers null (never throws) when the network fails', async () => {
    expect(await verifyImageUrl(IMG('x.png'), { fetchImpl: fakeFetch({}) })).toBeNull()
  })
})

// ---- the agy route -------------------------------------------------------

describe('agyImageSearch', () => {
  const reply = (items: unknown[]) => ({ text: JSON.stringify(items) })

  it('returns only verified, usable, de-duplicated, non-stock images in the agent order', async () => {
    const fetchImpl = fakeFetch({
      [IMG('one.png')]: { type: 'image/png', body: png(1200, 800, 1) },
      [IMG('dead.png')]: { status: 404 },
      [IMG('thumb.png')]: { type: 'image/png', body: png(64, 64, 2) },
      [IMG('mirror.png')]: { type: 'image/png', body: png(1200, 800, 1) }, // same pixels as one.png
      [IMG('two.jpg')]: { type: 'image/jpeg', body: jpeg(1000, 700) },
      [IMG('three.gif')]: { type: 'image/gif', body: gif(640, 480) },
    })
    const run = vi.fn(async (_options: AgyRunOptions) =>
      reply([
        { imageUrl: IMG('one.png'), sourceUrl: 'https://news.example.org/a', title: 'One' },
        { imageUrl: IMG('dead.png'), sourceUrl: 'https://news.example.org/b', title: 'Dead' },
        { imageUrl: IMG('thumb.png'), sourceUrl: 'https://news.example.org/c', title: 'Thumb' },
        { imageUrl: IMG('mirror.png'), sourceUrl: 'https://other.example.net/d', title: 'Mirror' },
        {
          imageUrl: 'https://cdn.gettyimages.com/x.jpg',
          sourceUrl: 'https://www.gettyimages.com/p',
        },
        {
          imageUrl: IMG('stock-page.jpg'),
          sourceUrl: 'https://www.shutterstock.com/p',
          title: 'Stock page',
        },
        { imageUrl: IMG('two.jpg'), sourceUrl: 'https://blog.example.com/e', title: 'Two' },
        { imageUrl: IMG('three.gif'), sourceUrl: 'https://blog.example.com/f', title: 'Three' },
      ]),
    )
    const r = await agyImageSearch(
      'red pandas',
      5,
      { cliPath: '/opt/agy', model: 'm-1' },
      { run, fetchImpl },
    )
    expect(r.method).toBe('agy')
    expect(r.images.map((i) => i.title)).toEqual(['One', 'Two', 'Three'])
    expect(r.images[0]).toEqual({
      title: 'One',
      imageUrl: IMG('one.png'),
      sourceUrl: 'https://news.example.org/a',
      source: 'news.example.org',
      width: 1200,
      height: 800,
    })
    const request = run.mock.calls[0]![0]
    expect(request.cliPath).toBe('/opt/agy')
    expect(request.model).toBe('m-1')
    expect(request.prompt).toBe(buildAgyImageSearchPrompt('red pandas', 11))
    expect(request.prompt).toContain('search_web')
    expect(request.prompt).toContain('Never guess')
  })

  it('stops at the requested count', async () => {
    const map: Record<string, Reply> = {}
    const items = Array.from({ length: 8 }, (_, i) => {
      map[IMG(`p${i}.png`)] = { type: 'image/png', body: png(800 + i, 600, i) }
      return { imageUrl: IMG(`p${i}.png`), title: `p${i}` }
    })
    const r = await agyImageSearch(
      'q',
      3,
      {},
      { run: async () => reply(items), fetchImpl: fakeFetch(map) },
    )
    expect(r.images).toHaveLength(3)
  })

  it('reports agent failures, junk output and all-invented URLs as errors', async () => {
    const fetchImpl = fakeFetch({})
    expect(
      await agyImageSearch(
        'q',
        3,
        {},
        { run: async () => Promise.reject(new Error('quota')), fetchImpl },
      ),
    ).toMatchObject({ method: 'error', images: [], error: 'agy: quota' })
    expect(
      await agyImageSearch('q', 3, {}, { run: async () => ({ text: 'sorry' }), fetchImpl }),
    ).toMatchObject({ method: 'error', error: expect.stringContaining('agy:') })
    expect(
      await agyImageSearch('q', 3, {}, { run: async () => reply([]), fetchImpl }),
    ).toMatchObject({ method: 'error', error: 'Antigravity named no usable image URLs' })
    expect(
      await agyImageSearch(
        'q',
        3,
        {},
        { run: async () => reply([{ imageUrl: IMG('invented.jpg') }]), fetchImpl },
      ),
    ).toMatchObject({ method: 'error', error: expect.stringContaining('could be verified') })
    expect(
      await agyImageSearch(
        'q',
        3,
        {},
        {
          run: async () => ({
            text: '',
            deniedActions: [{ action: 'read_url', displayName: 'ReadUrlContent' }],
          }),
          fetchImpl,
        },
      ),
    ).toMatchObject({
      method: 'error',
      error: 'agy: Antigravity gave no answer; its sandbox denied ReadUrlContent',
    })
    expect(await agyImageSearch('   ', 3)).toMatchObject({ method: 'error' })
  })

  it('passes the abort signal to the agent', async () => {
    const controller = new AbortController()
    const run = vi.fn(async (_options: AgyRunOptions) => reply([]))
    await agyImageSearch('q', 3, {}, { run, signal: controller.signal, fetchImpl: fakeFetch({}) })
    expect(run.mock.calls[0]![0].signal).toBe(controller.signal)
  })
})

describe('agyImageSearchWithFallback', () => {
  const keyless = {
    images: [
      {
        title: 'k',
        imageUrl: IMG('k.jpg'),
        sourceUrl: 'https://k.example.com/',
        source: 'k.example.com',
      },
    ],
    method: 'duckduckgo',
  }

  it('does not touch the keyless chain when agy delivers', async () => {
    const fallback = vi.fn(async () => keyless)
    const fetchImpl = fakeFetch({ [IMG('a.png')]: { type: 'image/png', body: png(800, 600) } })
    const r = await agyImageSearchWithFallback('q', 3, {}, fallback, {
      run: async () => ({ text: JSON.stringify([{ imageUrl: IMG('a.png') }]) }),
      fetchImpl,
    })
    expect(r.method).toBe('agy')
    expect(fallback).not.toHaveBeenCalled()
  })

  it('degrades to the keyless chain and says why', async () => {
    const fallback = vi.fn(async () => keyless)
    const r = await agyImageSearchWithFallback('q', 3, {}, fallback, {
      run: async () => Promise.reject(new Error('agy is not signed in')),
    })
    expect(r.method).toBe('duckduckgo')
    expect(r.images).toEqual(keyless.images)
    expect(r.agyError).toBe('agy: agy is not signed in')
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('does not fall back after the caller aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const fallback = vi.fn(async () => keyless)
    const r = await agyImageSearchWithFallback('q', 3, {}, fallback, {
      run: async () => Promise.reject(new Error('aborted')),
      signal: controller.signal,
    })
    expect(r.images).toEqual([])
    expect(fallback).not.toHaveBeenCalled()
  })
})

// ---- wiring --------------------------------------------------------------

describe('imageSearchTool with the agy search provider', () => {
  it('asks agy first, with the search provider CLI path and model, and falls back on failure', async () => {
    const settings = defaultAiSettings()
    settings.search = {
      ...settings.search!,
      provider: 'agy',
      providers: {
        ...settings.search!.providers,
        agy: { apiKey: '', cliPath: '/opt/agy-search', model: 'search-model' },
      },
    }
    vi.mocked(readAiSettingsFile).mockReturnValue(settings)
    vi.mocked(runAgy).mockRejectedValue(new Error('offline'))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network is off in tests')
      }),
    )
    const r = await imageSearchTool('/x/ai-settings.json', 'cats', 2)
    vi.unstubAllGlobals()
    const request = vi.mocked(runAgy).mock.calls[0]![0]
    expect(request.cliPath).toBe('/opt/agy-search')
    expect(request.model).toBe('search-model')
    // the keyless chain was tried after agy failed (and could not reach the network either)
    expect((r as { agyError?: string }).agyError).toBe('agy: offline')
    expect(r.method).toBe('error')
  })

  it('leaves every other provider on its own chain without calling agy', async () => {
    const settings = defaultAiSettings()
    settings.search = { ...settings.search!, provider: 'serper' }
    vi.mocked(readAiSettingsFile).mockReturnValue(settings)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network is off in tests')
      }),
    )
    await imageSearchTool('/x/ai-settings.json', 'cats', 2)
    vi.unstubAllGlobals()
    expect(runAgy).not.toHaveBeenCalled()
  })
})
