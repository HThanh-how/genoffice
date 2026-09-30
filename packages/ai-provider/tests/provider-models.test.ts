import { afterEach, describe, expect, it, vi } from 'vitest'
import { listProviderModelsForIpc } from '../src/provider-models'

afterEach(() => vi.unstubAllGlobals())

describe('provider model discovery', () => {
  it('uses the Mistral models endpoint and bearer key', async () => {
    const requests: Array<{ url: RequestInfo | URL; init?: RequestInit }> = []
    const fetchMock = async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url, init })
      return Response.json([{ id: 'mistral-large-latest' }, { id: 'codestral-latest' }])
    }
    vi.stubGlobal('fetch', fetchMock)

    const result = await listProviderModelsForIpc({
      provider: 'mistral',
      config: { apiKey: ' mistral-secret ' },
    })

    expect(result.models).toEqual(['mistral-large-latest', 'codestral-latest'])
    expect(String(requests[0]?.url)).toBe('https://api.mistral.ai/v1/models')
    expect(new Headers(requests[0]?.init?.headers).get('authorization')).toBe(
      'Bearer mistral-secret',
    )
  })

  it('follows Anthropic cursor pages with its native key and version headers', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ data: [{ id: 'claude-opus' }], has_more: true, last_id: 'claude-opus' }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id: 'claude-sonnet' }],
          has_more: false,
          last_id: 'claude-sonnet',
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const result = await listProviderModelsForIpc({
      provider: 'anthropic',
      config: { apiKey: 'anthropic-secret' },
    })

    expect(result.models).toEqual(['claude-opus', 'claude-sonnet'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [firstUrl, firstInit] = fetchMock.mock.calls[0]!
    expect(String(firstUrl)).toBe('https://api.anthropic.com/v1/models?limit=1000')
    expect(new Headers(firstInit?.headers).get('x-api-key')).toBe('anthropic-secret')
    expect(new Headers(firstInit?.headers).get('anthropic-version')).toBe('2023-06-01')
    const [secondUrl] = fetchMock.mock.calls[1]!
    expect(String(secondUrl)).toBe(
      'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-opus',
    )
  })

  it('returns an empty catalog for unknown providers and missing credentials without fetching', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(listProviderModelsForIpc(null)).resolves.toEqual({ models: [], defaultModel: '' })
    await expect(
      listProviderModelsForIpc({ provider: 'not-a-provider', config: { apiKey: 'key' } }),
    ).resolves.toEqual({ models: [], defaultModel: '' })
    await expect(
      listProviderModelsForIpc({ provider: 'mistral', config: { apiKey: '' } }),
    ).resolves.toEqual({ models: [], defaultModel: '' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses Opper’s public paged catalog without sending a key', async () => {
    const requests: Array<{ url: RequestInfo | URL; init?: RequestInit }> = []
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url, init })
      const parsed = new URL(String(url))
      const offset = Number(parsed.searchParams.get('offset'))
      const models =
        offset === 0
          ? Array.from({ length: 100 }, (_, index) => ({ id: `model-${index}` }))
          : [{ id: 'model-final' }]
      return Response.json({ models, total: 101 })
    })

    const result = await listProviderModelsForIpc({ provider: 'opper', config: { apiKey: '' } })

    expect(result.models).toHaveLength(101)
    expect(String(requests[0]?.url)).toBe(
      'https://api.opper.ai/v3/models?type=llm&limit=100&offset=0',
    )
    expect(String(requests[1]?.url)).toBe(
      'https://api.opper.ai/v3/models?type=llm&limit=100&offset=100',
    )
    expect(new Headers(requests[0]?.init?.headers).has('authorization')).toBe(false)
  })

  it('pages through Gemini Models API using the Google key header', async () => {
    const requests: Array<{ url: RequestInfo | URL; init?: RequestInit }> = []
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url, init })
      const parsed = new URL(String(url))
      return parsed.searchParams.has('pageToken')
        ? Response.json({
            models: [
              { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
            ],
          })
        : Response.json({
            models: [
              { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
            ],
            nextPageToken: 'next-page',
          })
    })

    const result = await listProviderModelsForIpc({
      provider: 'gemini',
      config: { apiKey: 'google-secret' },
    })

    expect(result.models).toEqual(['gemini-2.5-flash', 'gemini-2.0-flash'])
    expect(requests).toHaveLength(2)
    expect(String(requests[0]?.url)).toContain(
      'https://generativelanguage.googleapis.com/v1beta/models',
    )
    expect(String(requests[1]?.url)).toContain('pageToken=next-page')
    expect(new Headers(requests[0]?.init?.headers).get('x-goog-api-key')).toBe('google-secret')
  })
})
