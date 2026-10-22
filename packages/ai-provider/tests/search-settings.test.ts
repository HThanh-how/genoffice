import { describe, expect, it } from 'vitest'
import { defaultAiSettings, resolveAiSettings } from '../src/providers'
import {
  AI_SEARCH_PROVIDERS,
  activeSearchProvider,
  defaultAiSearchSettings,
  resolveAiSearchSettings,
} from '../src/search-settings'

describe('search settings', () => {
  it('defaults to keyless Parallel with empty keys and rides along in defaultAiSettings', () => {
    expect(defaultAiSearchSettings()).toEqual({
      provider: 'parallel',
      providers: {
        serper: { apiKey: '' },
        serply: { apiKey: '' },
        tavily: { apiKey: '' },
        parallel: { apiKey: '' },
        agy: { apiKey: '', cliPath: '', model: '' },
        exa: { apiKey: '' },
        firecrawl: { apiKey: '' },
        keenable: { apiKey: '' },
      },
    })
    expect(defaultAiSettings().search?.provider).toBe('parallel')
    const resolved = resolveAiSettings(
      { provider: 'genspark', providers: {} as never },
      defaultAiSettings(),
    )
    expect(resolved.search).toEqual(defaultAiSearchSettings())
  })

  it('merges and trims stored keys', () => {
    const s = resolveAiSearchSettings({
      provider: 'tavily',
      providers: { tavily: { apiKey: ' tvly-1 ' } } as never,
    })
    expect(s.provider).toBe('tavily')
    expect(s.providers.tavily.apiKey).toBe('tvly-1')
    expect(s.providers.serper.apiKey).toBe('')
  })

  it('restores Antigravity CLI settings keylessly and leaves an unset model available for shared chat settings', () => {
    const s = resolveAiSearchSettings({
      provider: 'agy',
      providers: {
        agy: { apiKey: '', cliPath: ' /opt/bin/agy ', model: ' custom-model ' },
      } as never,
    })
    expect(s.provider).toBe('agy')
    expect(s.providers.agy).toEqual({ apiKey: '', cliPath: '/opt/bin/agy', model: 'custom-model' })
    expect(activeSearchProvider({ search: s })).toBe('agy')
    expect(resolveAiSearchSettings({ provider: 'agy' } as never).providers.agy.model).toBe('')
  })

  it('activates a BYOK search provider only with a key', () => {
    expect(activeSearchProvider({ search: undefined })).toBe('parallel')
    expect(
      activeSearchProvider({
        search: {
          provider: 'serper',
          providers: {
            serper: { apiKey: '' },
            serply: { apiKey: '' },
            tavily: { apiKey: '' },
            parallel: { apiKey: '' },
            agy: { apiKey: '' },
            exa: { apiKey: '' },
            firecrawl: { apiKey: '' },
            keenable: { apiKey: '' },
          },
        },
      }),
    ).toBe('parallel')
    expect(
      activeSearchProvider({
        search: {
          provider: 'serper',
          providers: {
            serper: { apiKey: 'k' },
            serply: { apiKey: '' },
            tavily: { apiKey: '' },
            parallel: { apiKey: '' },
            agy: { apiKey: '' },
            exa: { apiKey: '' },
            firecrawl: { apiKey: '' },
            keenable: { apiKey: '' },
          },
        },
      }),
    ).toBe('serper')
    expect(
      activeSearchProvider({
        search: {
          provider: 'serper',
          providers: {
            serper: { apiKey: '   ' },
            serply: { apiKey: '' },
            tavily: { apiKey: '' },
            parallel: { apiKey: '' },
            agy: { apiKey: '' },
            exa: { apiKey: '' },
            firecrawl: { apiKey: '' },
            keenable: { apiKey: '' },
          },
        },
      }),
    ).toBe('parallel')
    expect(activeSearchProvider({ search: { provider: 'bing', providers: {} } as never })).toBe(
      'parallel',
    )
  })
})

describe('Serply search settings', () => {
  it('restores and trims a saved Serply key and activates it only with a key', () => {
    const settings = resolveAiSearchSettings({
      provider: 'serply',
      providers: { serply: { apiKey: ' serply-key ' } } as never,
    })
    expect(settings.provider).toBe('serply')
    expect(settings.providers.serply.apiKey).toBe('serply-key')
    expect(activeSearchProvider({ search: settings })).toBe('serply')
    expect(
      activeSearchProvider({
        search: { ...settings, providers: { ...settings.providers, serply: { apiKey: '  ' } } },
      }),
    ).toBe('parallel')
  })
})

describe('Parallel search settings', () => {
  it('restores and trims a saved Parallel key', () => {
    const settings = resolveAiSearchSettings(
      JSON.parse(
        JSON.stringify({
          provider: 'parallel',
          providers: { parallel: { apiKey: ' parallel-key ' } },
        }),
      ),
    )
    expect(settings.providers.parallel.apiKey).toBe('parallel-key')
    expect(activeSearchProvider({ search: settings })).toBe('parallel')
  })

  it('loads older settings without changing the selected provider or existing keys', () => {
    const settings = resolveAiSearchSettings(
      JSON.parse(
        JSON.stringify({
          provider: 'tavily',
          providers: { tavily: { apiKey: 'existing-key' } },
        }),
      ),
    )
    expect(activeSearchProvider({ search: settings })).toBe('tavily')
    expect(settings.providers.tavily.apiKey).toBe('existing-key')
    expect(settings.providers.parallel.apiKey).toBe('')
  })

  it('keeps Parallel selected for free search when the key is blank', () => {
    const settings = resolveAiSearchSettings(
      JSON.parse(
        JSON.stringify({
          provider: 'parallel',
          providers: { parallel: { apiKey: '   ' } },
        }),
      ),
    )
    expect(activeSearchProvider({ search: settings })).toBe('parallel')
  })
})

describe('exa and firecrawl providers', () => {
  it('are in the catalog without image search and default to empty keys', () => {
    const exa = AI_SEARCH_PROVIDERS.find((m) => m.id === 'exa')
    const firecrawl = AI_SEARCH_PROVIDERS.find((m) => m.id === 'firecrawl')
    expect(exa?.imageSearch).toBe(false)
    expect(firecrawl?.imageSearch).toBe(false)
    const s = defaultAiSearchSettings()
    expect(s.providers.exa.apiKey).toBe('')
    expect(s.providers.firecrawl.apiKey).toBe('')
  })

  it('activate with a key and fall back to keyless parallel without one', () => {
    const mk = (id: 'exa' | 'firecrawl', apiKey: string) => ({
      search: {
        provider: id,
        providers: {
          serper: { apiKey: '' },
          serply: { apiKey: '' },
          tavily: { apiKey: '' },
          parallel: { apiKey: '' },
          agy: { apiKey: '' },
          exa: { apiKey: id === 'exa' ? apiKey : '' },
          firecrawl: { apiKey: id === 'firecrawl' ? apiKey : '' },
          keenable: { apiKey: '' },
        },
      },
    })
    expect(activeSearchProvider(mk('exa', ''))).toBe('parallel')
    expect(activeSearchProvider(mk('exa', 'exa-1'))).toBe('exa')
    expect(activeSearchProvider(mk('firecrawl', ' '))).toBe('parallel')
    expect(activeSearchProvider(mk('firecrawl', 'fc-1'))).toBe('firecrawl')
  })

  it('resolveAiSearchSettings keeps stored exa/firecrawl keys trimmed', () => {
    const s = resolveAiSearchSettings({
      provider: 'exa',
      providers: {
        exa: { apiKey: ' k ' },
        firecrawl: { apiKey: 'fc ' },
      } as never,
    })
    expect(s.providers.exa.apiKey).toBe('k')
    expect(s.providers.firecrawl.apiKey).toBe('fc')
    expect(s.provider).toBe('exa')
  })
})

describe('effective AGY search routing and provider retention', () => {
  it('automatically routes search to agy when chat provider is agy', () => {
    const settings = defaultAiSettings()
    settings.provider = 'agy'
    settings.search = {
      ...settings.search!,
      provider: 'serper',
      providers: {
        ...settings.search!.providers,
        serper: { apiKey: 'serper-secret-key' },
      },
    }
    // When AGY is selected for chat, effective search provider is agy:
    expect(activeSearchProvider(settings)).toBe('agy')
  })

  it('restores stored BYOK search choices immediately upon switching away from agy', () => {
    const settings = defaultAiSettings()
    settings.provider = 'openai'
    settings.search = {
      ...settings.search!,
      provider: 'serper',
      providers: {
        ...settings.search!.providers,
        serper: { apiKey: 'serper-secret-key' },
      },
    }
    expect(activeSearchProvider(settings)).toBe('serper')
  })

  it('falls back to parallel when switching away from agy without keys', () => {
    const settings = defaultAiSettings()
    settings.provider = 'openai'
    settings.search = {
      ...settings.search!,
      provider: 'serper',
      providers: {
        ...settings.search!.providers,
        serper: { apiKey: '   ' },
      },
    }
    expect(activeSearchProvider(settings)).toBe('parallel')
  })
})

describe('Keenable search settings', () => {
  it('is in the catalog without image search and defaults to an empty key', () => {
    expect(AI_SEARCH_PROVIDERS.find((m) => m.id === 'keenable')?.imageSearch).toBe(false)
    expect(defaultAiSearchSettings().providers.keenable.apiKey).toBe('')
  })

  it('keeps Keenable selected for free search when the key is blank', () => {
    const settings = resolveAiSearchSettings(
      JSON.parse(
        JSON.stringify({
          provider: 'keenable',
          providers: { keenable: { apiKey: '   ' } },
        }),
      ),
    )
    expect(settings.providers.keenable.apiKey).toBe('')
    expect(activeSearchProvider({ search: settings })).toBe('keenable')
  })

  it('restores and trims a saved Keenable key', () => {
    const settings = resolveAiSearchSettings({
      provider: 'keenable',
      providers: { keenable: { apiKey: ' kn-key ' } } as never,
    })
    expect(settings.providers.keenable.apiKey).toBe('kn-key')
    expect(activeSearchProvider({ search: settings })).toBe('keenable')
  })

  it('preserves the keyless Parallel default when AGY is unavailable', () => {
    expect(defaultAiSearchSettings(false).provider).toBe('parallel')
    expect(activeSearchProvider({ search: defaultAiSearchSettings(false) })).toBe('parallel')
  })
})
