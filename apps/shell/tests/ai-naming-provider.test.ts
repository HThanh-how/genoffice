import { describe, expect, it } from 'vitest'
import { resolveNamingProvider } from '../src/main/ai-naming-provider'

/**
 * The naming service used to resolve its provider on its own: a hardcoded list
 * of three ids, and the key read out of the settings file. That list did not
 * know every provider the build can talk to, and it never saw the Genspark
 * key — which lives in the login state, not in the file — so for the default
 * account the call failed and the feature quietly did nothing.
 *
 * These assertions are the evidence that the provider is now resolved the way
 * the rest of the app resolves it.
 *
 * Fork policy: Genspark is never selected from saved settings. `activeProvider`
 * maps a saved Genspark selection, or an unknown provider id, to `local`, and
 * an incomplete provider (missing key or model) is not replaced by another one.
 * A naming request whose provider is not usable is therefore declined (null),
 * and the Genspark login key is never handed to another provider.
 */

describe('resolveNamingProvider', () => {
  it('never hands the Genspark login key to the default provider', () => {
    expect(resolveNamingProvider({}, 'gsk-live-key')).toMatchObject({
      provider: 'local',
      config: { apiKey: '' },
    })
  })

  it('uses local without a sign-in on fresh settings', () => {
    expect(resolveNamingProvider({}, '')?.provider).toBe('local')
  })

  it('uses local for a retired Genspark selection without forwarding its key', () => {
    expect(
      resolveNamingProvider({ provider: 'genspark', providers: {} }, 'gsk-live-key'),
    ).toMatchObject({ provider: 'local', config: { apiKey: '' } })
  })

  it('uses local when the settings file does not exist', () => {
    expect(resolveNamingProvider(null, '')?.provider).toBe('local')
  })

  it('honors a configured provider', () => {
    const resolved = resolveNamingProvider(
      {
        provider: 'anthropic',
        providers: { anthropic: { apiKey: 'sk-ant', model: 'claude-sonnet-4-6' } },
      },
      '',
    )
    expect(resolved?.provider).toBe('anthropic')
    expect(resolved?.config.apiKey).toBe('sk-ant')
    expect(resolved?.config.model).toBe('claude-sonnet-4-6')
  })

  it('declines a half-filled configured provider instead of falling back to Genspark', () => {
    // anthropic is selected but has no model: the request is declined, and the
    // Genspark login key is not substituted
    const resolved = resolveNamingProvider(
      {
        provider: 'anthropic',
        providers: { anthropic: { apiKey: 'sk-ant', model: '' } },
      },
      'gsk-live-key',
    )
    expect(resolved).toBeNull()
  })

  it('uses local for an unknown id without forwarding the Genspark key', () => {
    const resolved = resolveNamingProvider(
      { provider: 'not-a-provider', providers: {} },
      'gsk-live-key',
    )
    expect(resolved).toMatchObject({ provider: 'local', config: { apiKey: '' } })
  })

  it('does not need a key for codex', () => {
    const resolved = resolveNamingProvider({ provider: 'codex', providers: {} }, '')
    expect(resolved?.provider).toBe('codex')
  })

  it("resolves a custom endpoint's key from the environment", () => {
    process.env.GENOFFICE_NAMING_TEST_KEY = 'from-env'
    try {
      const resolved = resolveNamingProvider(
        {
          provider: 'custom',
          providers: {
            custom: {
              apiKey: '',
              model: 'local-model',
              baseUrl: 'http://127.0.0.1:11434/v1',
              profile: { apiKeyEnv: 'GENOFFICE_NAMING_TEST_KEY' },
            },
          },
        },
        '',
      )
      expect(resolved?.provider).toBe('custom')
      expect(resolved?.config.apiKey).toBe('from-env')
    } finally {
      delete process.env.GENOFFICE_NAMING_TEST_KEY
    }
  })
})
