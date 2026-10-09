import { describe, expect, it } from 'vitest'
import { canAttemptChat } from '../src/readiness'
import type { AiProviderConfig, AiProviderId, AiSettings } from '../src/types'

function makeSettings(provider: AiProviderId, config?: Partial<AiProviderConfig>): AiSettings {
  return {
    provider,
    providers: {
      [provider]: {
        apiKey: config?.apiKey ?? 'test-api-key',
        model: config?.model ?? 'test-model',
        baseUrl: config?.baseUrl,
        cliPath: config?.cliPath,
      },
    } as any,
  }
}

describe('canAttemptChat (SPEC R1.11 READY-01 to READY-12)', () => {
  // READY-01: null settings
  it('READY-01: returns false when settings is null', () => {
    expect(canAttemptChat(null)).toBe(false)
  })

  // READY-02: undefined settings
  it('READY-02: returns false when settings is undefined', () => {
    expect(canAttemptChat(undefined)).toBe(false)
  })

  // READY-03: missing provider config in settings.providers
  it('READY-03: returns false when settings.providers lacks the active provider config', () => {
    const settings: AiSettings = {
      provider: 'openai',
      providers: {} as any,
    }
    expect(canAttemptChat(settings)).toBe(false)
  })

  // READY-04: unknown provider throws in getProviderAdapter
  it('READY-04: returns false when provider is unknown', () => {
    const settings = {
      provider: 'unknown-vendor' as AiProviderId,
      providers: {
        'unknown-vendor': { apiKey: 'key', model: 'model' },
      },
    } as unknown as AiSettings
    expect(canAttemptChat(settings)).toBe(false)
  })

  // READY-05: agy provider with empty apiKey and model (agy-cli auth)
  it('READY-05: returns true for agy provider even with empty apiKey and model', () => {
    const settings = makeSettings('agy', { apiKey: '', model: '' })
    expect(canAttemptChat(settings)).toBe(true)
  })

  // READY-06: codex provider with empty apiKey and model (codex-chatgpt auth)
  it('READY-06: returns true for codex provider even with empty apiKey and model', () => {
    const settings = makeSettings('codex', { apiKey: '', model: '' })
    expect(canAttemptChat(settings)).toBe(true)
  })

  // READY-07: genspark provider with model (gsk-login auth)
  it('READY-07: returns true for genspark provider when model is specified', () => {
    const settings = makeSettings('genspark', { apiKey: '', model: 'claude-3-5-sonnet' })
    expect(canAttemptChat(settings)).toBe(true)
  })

  // READY-08: genspark provider with empty model (gsk-login auth)
  it('READY-08: returns false for genspark provider when model is empty', () => {
    const settings = makeSettings('genspark', { apiKey: '', model: '' })
    expect(canAttemptChat(settings)).toBe(false)
  })

  // READY-09: api-key provider with valid apiKey and model
  it('READY-09: returns true for api-key provider with valid apiKey and model', () => {
    const settings = makeSettings('openai', { apiKey: 'sk-proj-12345', model: 'gpt-4o' })
    expect(canAttemptChat(settings)).toBe(true)
  })

  // READY-10: api-key provider with empty or whitespace-only apiKey
  it('READY-10: returns false for api-key provider with empty or whitespace apiKey', () => {
    const emptyKeySettings = makeSettings('openai', { apiKey: '', model: 'gpt-4o' })
    expect(canAttemptChat(emptyKeySettings)).toBe(false)

    const whitespaceKeySettings = makeSettings('openai', { apiKey: '   ', model: 'gpt-4o' })
    expect(canAttemptChat(whitespaceKeySettings)).toBe(false)
  })

  // READY-11: api-key provider with empty or whitespace-only model
  it('READY-11: returns false for api-key provider with empty or whitespace model', () => {
    const emptyModelSettings = makeSettings('openai', { apiKey: 'sk-proj-12345', model: '' })
    expect(canAttemptChat(emptyModelSettings)).toBe(false)

    const whitespaceModelSettings = makeSettings('openai', {
      apiKey: 'sk-proj-12345',
      model: '   ',
    })
    expect(canAttemptChat(whitespaceModelSettings)).toBe(false)
  })

  // READY-12: custom provider (api-key auth) with empty apiKey returns false
  it('READY-12: returns false for custom provider with missing apiKey or whitespace fields', () => {
    const customEmptyKey = makeSettings('custom', {
      apiKey: '',
      model: 'llama3:latest',
      baseUrl: 'http://localhost:11434/v1',
    })
    expect(canAttemptChat(customEmptyKey)).toBe(false)

    const customWhitespaceKey = makeSettings('custom', {
      apiKey: '  ',
      model: 'llama3:latest',
      baseUrl: 'http://localhost:11434/v1',
    })
    expect(canAttemptChat(customWhitespaceKey)).toBe(false)
  })
})
