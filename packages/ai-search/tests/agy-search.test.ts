import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@genoffice/ai-provider/agy-cli', () => ({
  AGY_DEFAULT_MODEL: 'default-model',
  runAgy: vi.fn(),
}))
vi.mock('../src/media-tools', () => ({ readAiSettingsFile: vi.fn() }))

import { runAgy } from '@genoffice/ai-provider/agy-cli'
import { defaultAiSettings } from '@genoffice/ai-provider'
import { readAiSettingsFile } from '../src/media-tools'
import { agyWebSearch } from '../src/agy-search'
import { webSearchTool } from '../src/search-tools'

afterEach(() => vi.clearAllMocks())

describe('Antigravity CLI web search', () => {
  it('asks for strict JSON and returns only public HTTP(S) results up to the limit', async () => {
    vi.mocked(runAgy).mockResolvedValue({
      text: JSON.stringify([
        { title: 'one', url: 'https://example.com/a', snippet: 'ok' },
        { title: 'private', url: 'http://127.0.0.1/', snippet: 'bad' },
        { title: 'two', url: 'http://example.org', snippet: 'ok' },
      ]),
    })
    const result = await agyWebSearch('query', 1, { cliPath: '/opt/agy', model: 'model-x' })
    expect(result).toEqual({
      method: 'agy',
      results: [{ title: 'one', url: 'https://example.com/a', snippet: 'ok' }],
    })
    const request = vi.mocked(runAgy).mock.calls[0]![0]
    expect(request.cliPath).toBe('/opt/agy')
    expect(request.model).toBe('model-x')
    expect(request.prompt).toContain('strict JSON array')
    expect(request.prompt).toContain('built-in search_web tool')
    expect(request.prompt).toContain('Query: query')
  })

  it('returns a clean error for CLI failure or malformed model output', async () => {
    vi.mocked(runAgy).mockRejectedValueOnce(new Error('CLI missing'))
    expect(await agyWebSearch('q', 1)).toMatchObject({
      method: 'error',
      results: [],
      error: 'agy: CLI missing',
    })
    vi.mocked(runAgy).mockResolvedValueOnce({ text: 'not json' })
    expect(await agyWebSearch('q', 1)).toMatchObject({
      method: 'error',
      results: [],
      error: expect.stringContaining('agy:'),
    })
  })

  it('trims and bounds the query and clamps invalid result counts', async () => {
    vi.mocked(runAgy).mockResolvedValue({ text: '[]' })
    await agyWebSearch(`   ${'x'.repeat(5000)}   `, Number.POSITIVE_INFINITY)
    const prompt = vi.mocked(runAgy).mock.calls[0]![0].prompt
    expect(prompt).toContain(`Return no more than 6`)
    expect(prompt.length).toBeLessThan(4400)
    expect(await agyWebSearch('   ', 3)).toMatchObject({
      method: 'error',
      error: 'Search query is empty',
    })
  })

  it('uses chat CLI/model settings by default and prefers explicit search overrides', async () => {
    vi.mocked(runAgy).mockResolvedValue({ text: '[]' })
    const settings = defaultAiSettings()
    settings.provider = 'agy'
    settings.providers.agy = {
      ...settings.providers.agy,
      cliPath: '/chat/agy',
      model: 'chat-model',
    }
    settings.search = {
      provider: 'agy',
      providers: {
        serper: { apiKey: '' },
        serply: { apiKey: '' },
        tavily: { apiKey: '' },
        parallel: { apiKey: '' },
        exa: { apiKey: '' },
        firecrawl: { apiKey: '' },
        agy: { apiKey: '', cliPath: '', model: '' },
      },
    }
    vi.mocked(readAiSettingsFile).mockReturnValue(settings)

    await webSearchTool('/settings.json', 'q'.repeat(700))
    const inherited = vi.mocked(runAgy).mock.calls[0]![0]
    expect(inherited.cliPath).toBe('/chat/agy')
    expect(inherited.model).toBe('chat-model')
    expect(inherited.prompt).toContain(`Query: ${'q'.repeat(700)}`)

    settings.search.providers.agy = { apiKey: '', cliPath: '/search/agy', model: 'search-model' }
    await webSearchTool('/settings.json', 'next')
    const overridden = vi.mocked(runAgy).mock.calls[1]![0]
    expect(overridden.cliPath).toBe('/search/agy')
    expect(overridden.model).toBe('search-model')
  })
})
