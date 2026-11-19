import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAiSettings, resolveAiSettings, activeProvider } from '../src/providers'
import { canAttemptChat } from '../src/readiness'
import { getProviderAdapter } from '../src/registry'
import { streamForProvider } from '../src/stream'
import { chatForProvider } from '../src/chat'
import { setLocalChatTransport } from '../src/local'
import { sanitizeAiSettings } from '../src/ai-settings-guard'

afterEach(() => setLocalChatTransport(undefined))
describe('local provider', () => {
  it('defaults fresh/unselected files to local, preserving saved Gemini and Agy', () => {
    for (const raw of [undefined, {}, { providers: {} }])
      expect(resolveAiSettings(raw, defaultAiSettings()).provider).toBe('local')
    for (const provider of ['gemini', 'agy'] as const) {
      expect(resolveAiSettings({ provider }, defaultAiSettings()).provider).toBe(provider)
      const settings = resolveAiSettings(
        { provider, providers: { [provider]: { model: 'saved', apiKey: 'saved-key' } } },
        defaultAiSettings(),
      )
      expect(activeProvider(settings)).toBe(provider)
      expect(settings.providers[provider].model).toBe('saved')
    }
  })
  it('advertises native text/tools, needs no credentials, and preserves local options', () => {
    const settings = defaultAiSettings()
    settings.providers.local.local = { thinking: true, gpu: 'cpu', keepHotMinutes: 4 }
    expect(canAttemptChat(settings)).toBe(true)
    expect(getProviderAdapter('local').resolveEndpoint(settings.providers.local).protocol).toBe(
      'local-llm',
    )
    expect(getProviderAdapter('local').capabilities).toMatchObject({
      auth: 'local',
      vision: false,
      tools: true,
    })
    expect(sanitizeAiSettings(settings)?.providers.local.local).toMatchObject({
      thinking: true,
      gpu: 'cpu',
      keepHotMinutes: 4,
    })
  })
  it('does not invoke any network fallback when unavailable or when images arrive', async () => {
    const network = vi.spyOn(globalThis, 'fetch')
    const cb = { signal: new AbortController().signal, onDelta: vi.fn(), onToolCall: vi.fn() }
    try {
      await expect(
        streamForProvider('local', defaultAiSettings().providers.local, '', [], [], 50, cb),
      ).rejects.toMatchObject({ code: 'NOT_READY' })
      const local = vi.fn()
      setLocalChatTransport(local)
      await expect(
        streamForProvider(
          'local',
          defaultAiSettings().providers.local,
          '',
          [{ role: 'user', text: 'ảnh', images: [{ base64: 'AA==', mime: 'image/png' }] }],
          [],
          50,
          cb,
        ),
      ).rejects.toMatchObject({ code: 'NOT_READY' })
      expect(local).not.toHaveBeenCalled()
      expect(network).not.toHaveBeenCalled()
    } finally {
      network.mockRestore()
    }
  })
  it('separates thought text and rechecks the grant, without injecting a delete target', async () => {
    const cb = {
      signal: new AbortController().signal,
      onDelta: vi.fn(),
      onReasoningDelta: vi.fn(),
      onToolCall: vi.fn(),
    }
    const call = { id: '1', name: 'deleteBlocks', input: {} }
    setLocalChatTransport(async (_config, _request, event) => {
      event({ id: '1', type: 'thought', text: 'reasoning' })
      event({ id: '1', type: 'text', text: 'answer' })
      event({ id: '1', type: 'toolcall', call })
    })
    await expect(
      streamForProvider('local', defaultAiSettings().providers.local, '', [], [], 50, cb),
    ).rejects.toThrow('not granted')
    await expect(
      streamForProvider(
        'local',
        defaultAiSettings().providers.local,
        '',
        [],
        [{ name: 'deleteBlocks', description: '', inputSchema: {} }],
        50,
        cb,
      ),
    ).rejects.toThrow('explicit target')
    expect(cb.onToolCall).not.toHaveBeenCalled()
    expect(call.input).toEqual({})
    expect(cb.onReasoningDelta).toHaveBeenCalledWith('reasoning')
    expect(cb.onDelta).toHaveBeenCalledWith('answer')
  })
  it('routes one-shot calls to local without a key or base URL', async () => {
    setLocalChatTransport(async (_config, request, event) => {
      expect(request.thinking).toBe(false)
      event({ id: '1', type: 'text', text: 'Xin chào' })
    })
    expect(
      await chatForProvider('local', defaultAiSettings().providers.local, '', 'hello'),
    ).toMatchObject({ ok: true, content: 'Xin chào' })
  })
})
