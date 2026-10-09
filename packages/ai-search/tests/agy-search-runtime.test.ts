import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@genoffice/ai-provider/agy-cli', () => ({
  AGY_DEFAULT_MODEL: 'default-model',
  runAgy: vi.fn(),
  listAgyModels: vi.fn(),
}))
vi.mock('../src/media-tools', () => ({ readAiSettingsFile: vi.fn() }))

import { listAgyModels, runAgy } from '@genoffice/ai-provider/agy-cli'
import { AgyError, defaultAiSettings } from '@genoffice/ai-provider'
import { readAiSettingsFile } from '../src/media-tools'
import {
  AGY_SEARCH_CACHE_TTL_MS,
  agySearchSchema,
  agyWebSearch,
  normalizeAgySearchQuery,
  resetAgySearchCache,
} from '../src/agy-search'
import { createSearchAbortRegistry } from '../src/search-abort'
import { testSearchProvider, webSearchTool } from '../src/search-tools'

const rows = [
  { title: 'One', url: 'https://example.com/a', snippet: 'first' },
  { title: 'Two', url: 'https://example.org/b', snippet: 'second' },
]

let clock = 1_000_000
beforeEach(() => {
  clock = 1_000_000
  resetAgySearchCache(() => clock)
})
afterEach(() => {
  vi.clearAllMocks()
  resetAgySearchCache()
})

describe('agy web search: structured results and the summary', () => {
  it('asks agy for a schema-checked object and fills `answer` from the validated result', async () => {
    vi.mocked(runAgy).mockResolvedValue({
      text: '{"answer":"ignored text copy","results":[]}',
      structured: { answer: '  Tea started in China.  ', results: rows },
    })
    const result = await agyWebSearch('history of tea', 5)
    expect(result).toEqual({ method: 'agy', answer: 'Tea started in China.', results: rows })
    const request = vi.mocked(runAgy).mock.calls[0]![0]
    expect(request.task).toBe('search')
    expect(request.jsonSchema).toEqual(agySearchSchema(5))
    expect(request.jsonSchema).toMatchObject({
      type: 'object',
      required: ['answer', 'results'],
      properties: { results: { type: 'array', maxItems: 5 } },
    })
  })

  it('without schema support it parses the model JSON text: object with answer, bare array, prose around it', async () => {
    vi.mocked(runAgy).mockResolvedValueOnce({
      text: '```json\n{"answer":"Short summary","results":' + JSON.stringify(rows) + '}\n```',
    })
    expect(await agyWebSearch('q-object', 5)).toMatchObject({
      method: 'agy',
      answer: 'Short summary',
      results: rows,
    })
    vi.mocked(runAgy).mockResolvedValueOnce({ text: JSON.stringify(rows) })
    const bare = await agyWebSearch('q-array', 5)
    expect(bare.results).toEqual(rows)
    expect(bare.answer).toBeUndefined()
    vi.mocked(runAgy).mockResolvedValueOnce({
      text: 'Here you go:\n' + JSON.stringify({ answer: 'ok', results: rows }) + '\nHope it helps',
    })
    expect(await agyWebSearch('q-prose', 5)).toMatchObject({ method: 'agy', answer: 'ok' })
  })

  it('still keeps only public http(s) URLs, de-duplicated, and bounds every field', async () => {
    vi.mocked(runAgy).mockResolvedValue({
      text: '',
      structured: {
        answer: 'x'.repeat(9000),
        results: [
          { title: 'T'.repeat(900), url: 'https://example.com/a', snippet: 's'.repeat(5000) },
          { title: 'dup', url: 'https://example.com/a', snippet: '' },
          { title: 'private', url: 'http://192.168.1.4/', snippet: '' },
          { title: 'file', url: 'file:///etc/passwd', snippet: '' },
        ],
      },
    })
    const result = await agyWebSearch('q-bounds', 8)
    expect(result.results).toHaveLength(1)
    expect(result.results[0]!.title).toHaveLength(500)
    expect(result.results[0]!.snippet).toHaveLength(2000)
    expect(result.answer).toHaveLength(4000)
  })

  it('reports invalid output and empty result lists as errors', async () => {
    vi.mocked(runAgy).mockResolvedValueOnce({ text: 'I could not search.' })
    expect(await agyWebSearch('q-bad', 3)).toMatchObject({
      method: 'error',
      error: expect.stringContaining('invalid JSON'),
    })
    vi.mocked(runAgy).mockResolvedValueOnce({
      text: '',
      structured: { answer: 'no sources', results: [] },
    })
    expect(await agyWebSearch('q-empty', 3)).toMatchObject({
      method: 'error',
      error: 'Antigravity search returned no valid public URLs',
    })
  })
})

describe('agy web search: Stop', () => {
  it('passes the AbortSignal to the agy run so the process tree can be killed', async () => {
    const ctrl = new AbortController()
    vi.mocked(runAgy).mockResolvedValue({ text: '', structured: { answer: '', results: rows } })
    await agyWebSearch('q-signal', 3, {}, { signal: ctrl.signal })
    expect(vi.mocked(runAgy).mock.calls[0]![0].signal).toBe(ctrl.signal)
  })

  it('a cancelled search comes back as an error result and is not cached', async () => {
    const ctrl = new AbortController()
    vi.mocked(runAgy).mockImplementationOnce(async (options) => {
      await new Promise((_resolve, reject) =>
        options.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' })),
        ),
      )
      throw new Error('unreachable')
    })
    const pending = agyWebSearch('q-cancel', 3, {}, { signal: ctrl.signal })
    ctrl.abort()
    expect(await pending).toMatchObject({ method: 'error', error: 'agy: Request aborted' })
    vi.mocked(runAgy).mockResolvedValueOnce({ text: '', structured: { answer: '', results: rows } })
    expect((await agyWebSearch('q-cancel', 3)).method).toBe('agy')
    expect(runAgy).toHaveBeenCalledTimes(2)
  })

  it('webSearchTool forwards the signal for the agy provider', async () => {
    const settings = defaultAiSettings()
    settings.search = {
      provider: 'agy',
      providers: { ...settings.search!.providers },
    }
    vi.mocked(readAiSettingsFile).mockReturnValue(settings)
    vi.mocked(runAgy).mockResolvedValue({ text: '', structured: { answer: '', results: rows } })
    const ctrl = new AbortController()
    await webSearchTool('/settings.json', 'q-tool-signal', 3, ctrl.signal)
    expect(vi.mocked(runAgy).mock.calls[0]![0].signal).toBe(ctrl.signal)
  })

  it("the per-window registry aborts only that window's searches", () => {
    const registry = createSearchAbortRegistry()
    const a1 = registry.begin(1)
    const a2 = registry.begin(1)
    const b = registry.begin(2)
    registry.cancel(1)
    expect(a1.signal.aborted).toBe(true)
    expect(a2.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(false)
    a1.end()
    a2.end()
    registry.cancel(1) // nothing left, no throw
    const later = registry.begin(1)
    expect(later.signal.aborted).toBe(false)
    b.end()
    registry.cancel(2)
    expect(b.signal.aborted).toBe(false) // finished searches are not touched
  })
})

describe('agy web search: query cache', () => {
  it('answers an identical query from memory for ten minutes', async () => {
    vi.mocked(runAgy).mockResolvedValue({
      text: '',
      structured: { answer: 'cached answer', results: rows },
    })
    const first = await agyWebSearch('Best  Tea Brands', 5)
    expect(first.cached).toBeUndefined()
    clock += AGY_SEARCH_CACHE_TTL_MS - 1
    const second = await agyWebSearch('best tea brands', 5)
    expect(second).toEqual({ method: 'agy', answer: 'cached answer', results: rows, cached: true })
    expect(runAgy).toHaveBeenCalledTimes(1)
    clock += 2
    const third = await agyWebSearch('best tea brands', 5)
    expect(third.cached).toBeUndefined()
    expect(runAgy).toHaveBeenCalledTimes(2)
  })

  it('normalises case, spacing and Unicode width, but not meaning', () => {
    expect(normalizeAgySearchQuery('  Best \n Tea\tBrands ')).toBe('best tea brands')
    expect(normalizeAgySearchQuery('ＡＢＣ')).toBe('abc')
    expect(normalizeAgySearchQuery('tea')).not.toBe(normalizeAgySearchQuery('coffee'))
  })

  it('a different result count, model or CLI path is a different entry', async () => {
    vi.mocked(runAgy).mockResolvedValue({ text: '', structured: { answer: '', results: rows } })
    await agyWebSearch('q-keys', 3)
    await agyWebSearch('q-keys', 4)
    await agyWebSearch('q-keys', 3, { model: 'other' })
    await agyWebSearch('q-keys', 3, { cliPath: '/x/agy' })
    expect(runAgy).toHaveBeenCalledTimes(4)
    await agyWebSearch('q-keys', 3)
    expect(runAgy).toHaveBeenCalledTimes(4)
  })

  it('never caches failures, and hands out copies a caller can modify', async () => {
    vi.mocked(runAgy).mockRejectedValueOnce(new Error('boom'))
    expect((await agyWebSearch('q-fail', 3)).method).toBe('error')
    vi.mocked(runAgy).mockResolvedValue({ text: '', structured: { answer: '', results: rows } })
    await agyWebSearch('q-fail', 3)
    const hit = await agyWebSearch('q-fail', 3)
    hit.results[0]!.title = 'mutated'
    expect((await agyWebSearch('q-fail', 3)).results[0]!.title).toBe('One')
    expect(runAgy).toHaveBeenCalledTimes(2)
  })

  it('noCache bypasses both the read and the write', async () => {
    vi.mocked(runAgy).mockResolvedValue({ text: '', structured: { answer: '', results: rows } })
    await agyWebSearch('q-nocache', 3, {}, { noCache: true })
    await agyWebSearch('q-nocache', 3, {}, { noCache: true })
    expect(runAgy).toHaveBeenCalledTimes(2)
    await agyWebSearch('q-nocache', 3)
    expect(runAgy).toHaveBeenCalledTimes(3)
  })

  it('keeps at most 50 queries', async () => {
    vi.mocked(runAgy).mockResolvedValue({ text: '', structured: { answer: '', results: rows } })
    for (let i = 0; i < 55; i++) await agyWebSearch(`query number ${i}`, 3)
    expect(runAgy).toHaveBeenCalledTimes(55)
    await agyWebSearch('query number 54', 3) // newest is still cached
    expect(runAgy).toHaveBeenCalledTimes(55)
    await agyWebSearch('query number 0', 3) // oldest was evicted
    expect(runAgy).toHaveBeenCalledTimes(56)
  })
})

describe('agy web search: typed errors', () => {
  it('carries the kind and reset time of a quota failure next to the message', async () => {
    const resetAt = Date.now() + 7_200_000
    vi.mocked(runAgy).mockRejectedValue(
      new AgyError({ kind: 'quota', message: 'quota used up', resetAt }),
    )
    expect(await agyWebSearch('q-quota', 3)).toEqual({
      results: [],
      method: 'error',
      error: 'agy: quota used up',
      errorKind: 'quota',
      errorResetAt: resetAt,
    })
    vi.mocked(runAgy).mockRejectedValue(new AgyError({ kind: 'auth', message: 'not signed in' }))
    expect(await agyWebSearch('q-auth', 3)).toMatchObject({ errorKind: 'auth' })
    vi.mocked(runAgy).mockRejectedValue(new AgyError({ kind: 'unknown', message: 'odd' }))
    expect(await agyWebSearch('q-unknown', 3)).not.toHaveProperty('errorKind')
  })
})

describe('agy search "Test connection"', () => {
  it('uses the free `agy models` check, never a real search', async () => {
    vi.mocked(listAgyModels).mockResolvedValue({
      models: ['gemini-3.8-flash-low'],
      defaultModel: '',
    })
    expect(await testSearchProvider('agy', '', { cliPath: ' /opt/agy ' })).toEqual({ ok: true })
    expect(listAgyModels).toHaveBeenCalledWith('/opt/agy', undefined, { force: true })
    expect(runAgy).not.toHaveBeenCalled()
  })

  it('reports a missing or signed-out CLI from the models listing', async () => {
    vi.mocked(listAgyModels).mockResolvedValue({
      models: [],
      defaultModel: '',
      error: 'Antigravity CLI returned no models. Are you signed in?',
    })
    expect(await testSearchProvider('agy', '')).toEqual({
      ok: false,
      error: 'Antigravity CLI returned no models. Are you signed in?',
    })
    expect(runAgy).not.toHaveBeenCalled()
  })
})
