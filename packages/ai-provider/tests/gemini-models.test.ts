import { afterEach, describe, expect, it, vi } from 'vitest'
import { listGeminiModels } from '../src/gemini-models'

afterEach(() => vi.unstubAllGlobals())

describe('listGeminiModels', () => {
  it('paginates the live catalog and marks non-chat models without exposing the key in the URL', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-flash-latest',
                displayName: 'Gemini Flash Latest',
                supportedGenerationMethods: ['generateContent'],
              },
            ],
            nextPageToken: 'next-page',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-embedding-001',
                displayName: 'Embedding',
                supportedGenerationMethods: ['embedContent'],
              },
              {
                name: 'models/gemini-3.1-flash-image',
                displayName: 'Image',
                supportedGenerationMethods: ['generateContent'],
              },
              {
                name: 'models/gemma-4-26b-a4b-it',
                displayName: 'Gemma 4',
                supportedGenerationMethods: ['generateContent'],
              },
              {
                name: 'models/gemma-3-27b-it',
                displayName: 'Gemma 3',
                supportedGenerationMethods: ['generateContent'],
              },
            ],
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    const models = await listGeminiModels('secret-example')
    expect(models.map((model) => [model.id, model.usableForChat])).toEqual([
      ['gemini-flash-latest', true],
      ['gemini-embedding-001', false],
      ['gemini-3.1-flash-image', false],
      ['gemma-4-26b-a4b-it', true],
      ['gemma-3-27b-it', false],
    ])
    expect(fetchMock.mock.calls[1]![0]).toContain('pageToken=next-page')
    expect(fetchMock.mock.calls[0]![0]).not.toContain('secret-example')
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
      'x-goog-api-key': 'secret-example',
    })
  })
})
