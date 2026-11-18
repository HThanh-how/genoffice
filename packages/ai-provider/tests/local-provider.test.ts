import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@genoffice/agent-core'
import { isCliProvider } from '../src/agy-meta'
import { canAttemptChat } from '../src/readiness'
import {
  AI_PROVIDER_ADAPTERS,
  endpointSupportsVision,
  providerNeedsApiKey,
  providerNeedsConfiguredModel,
} from '../src/registry'
import { AI_PROVIDERS, defaultAiSettings } from '../src/providers'
import { LOCAL_MAX_OUTPUT_TOKENS, LOCAL_MODEL_ID } from '../src/local-llm/local-meta'
import { IMAGE_OMITTED_NOTE, streamLocal, withoutImages } from '../src/local-llm/local-stream'
import type { AiProviderConfig, AiSettings } from '../src/types'
import { okResponse, sseStream } from './test-utils'

const streamLocalSpy = vi.hoisted(() => vi.fn())
vi.mock('../src/local-llm/local-stream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/local-llm/local-stream')>()
  return {
    ...actual,
    streamLocal: (...args: Parameters<typeof actual.streamLocal>) => {
      streamLocalSpy(...args)
      // the real bridge still runs for the tests below that inject their own runtime
      return args[6] ? actual.streamLocal(...args) : Promise.resolve()
    },
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  streamLocalSpy.mockClear()
})

const LOCAL: AiProviderConfig = { apiKey: '', model: LOCAL_MODEL_ID }

function settingsFor(config: AiProviderConfig): AiSettings {
  const settings = defaultAiSettings(undefined, false)
  return { ...settings, provider: 'local', providers: { ...settings.providers, local: config } }
}

describe('local provider registration', () => {
  it('is listed with a text-only, keyless adapter', () => {
    expect(AI_PROVIDERS.some((meta) => meta.id === 'local')).toBe(true)
    const adapter = AI_PROVIDER_ADAPTERS.local
    expect(adapter.capabilities).toEqual({ auth: 'local-runtime', vision: false })
    expect(adapter.resolveEndpoint(LOCAL)).toEqual({
      protocol: 'local-llama',
      baseUrl: '',
      maxTokens: LOCAL_MAX_OUTPUT_TOKENS,
      vision: false,
    })
  })

  it('seeds the single model and never claims vision', () => {
    expect(defaultAiSettings(undefined, false).providers.local.model).toBe(LOCAL_MODEL_ID)
    expect(endpointSupportsVision(settingsFor(LOCAL))).toBe(false)
  })

  it('is ready with a model and no key, not without a model', () => {
    expect(canAttemptChat(settingsFor(LOCAL))).toBe(true)
    expect(canAttemptChat(settingsFor({ ...LOCAL, model: '' }))).toBe(false)
  })
})

describe('auth-based request requirements', () => {
  it.each([
    ['anthropic', true, true],
    ['custom', true, true],
    ['genspark', true, true],
    ['codex', false, false],
    ['agy', false, false],
    ['local', false, true],
    ['not-a-provider', true, true],
  ])('%s: needs key %s, needs model %s', (provider, key, model) => {
    expect(providerNeedsApiKey(provider)).toBe(key)
    expect(providerNeedsConfiguredModel(provider)).toBe(model)
  })

  it('keeps isCliProvider to the CLI-backed providers', () => {
    expect(isCliProvider('local')).toBe(false)
    expect(isCliProvider('agy')).toBe(true)
    expect(isCliProvider('codex')).toBe(true)
  })
})

describe('streamForProvider routing', () => {
  const cb = () => ({ signal: new AbortController().signal, onDelta: () => {}, onToolCall: () => {} })

  it('routes local to the managed runtime without an API key and caps the output', async () => {
    const { streamForProvider } = await import('../src/stream')
    await streamForProvider('local', LOCAL, 'sys', [], [], 32768, cb())
    expect(streamLocalSpy).toHaveBeenCalledTimes(1)
    expect(streamLocalSpy.mock.calls[0]![4]).toBe(LOCAL_MAX_OUTPUT_TOKENS)
  })

  it('still requires a model for local', async () => {
    const { streamForProvider } = await import('../src/stream')
    await expect(
      streamForProvider('local', { ...LOCAL, model: '' }, 'sys', [], [], 100, cb()),
    ).rejects.toThrow(/Choose an AI model/)
    expect(streamLocalSpy).not.toHaveBeenCalled()
  })
})

describe('local bridge (text-only)', () => {
  it('replaces images with a note and leaves other turns alone', () => {
    const messages: AgentMessage[] = [
      { role: 'user', text: 'describe', images: [{ mime: 'image/png', base64: 'AAAA' }] },
      { role: 'assistant', text: 'ok' },
      { role: 'user', text: 'plain' },
    ]
    const out = withoutImages(messages)
    expect(out[0]).toEqual({ role: 'user', text: `describe\n\n${IMAGE_OMITTED_NOTE}` })
    expect(out[1]).toBe(messages[1])
    expect(out[2]).toBe(messages[2])
  })

  it('sends a text-only chat-completions request with the runtime token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(sseStream(['data: [DONE]'])))
    vi.stubGlobal('fetch', fetchMock)
    const ensure = vi.fn().mockResolvedValue({
      baseUrl: 'http://127.0.0.1:41000/v1',
      token: 'tok',
    })
    await streamLocal(
      LOCAL,
      'sys',
      [{ role: 'user', text: 'hi', images: [{ mime: 'image/png', base64: 'AAAA' }] }],
      [],
      LOCAL_MAX_OUTPUT_TOKENS,
      { signal: new AbortController().signal, onDelta: () => {}, onToolCall: () => {} },
      ensure,
    ).catch(() => {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:41000/v1/chat/completions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    const body = String(init.body)
    expect(body).not.toContain('image_url')
    expect(body).toContain(IMAGE_OMITTED_NOTE)
  })
})
