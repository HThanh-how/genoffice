import { describe, expect, it } from 'vitest'
import { AI_PROVIDERS, defaultAiSettings } from '@genoffice/ai-provider'
import {
  aiModelPickerGroups,
  aiModelPickerSelection,
  dedupeAgyModelItems,
  resolveAgyModelAlias,
  withAiModelSelection,
} from '../src/ai-model-picker-options'

const anthropicModels = AI_PROVIDERS.find((m) => m.id === 'anthropic')!.models

describe('aiModelPickerGroups', () => {
  it('lists nothing while signed out with no keys', () => {
    expect(aiModelPickerGroups(defaultAiSettings(), false)).toEqual([])
  })

  it('never lists Genspark, signed in or not (this build does not route through it)', () => {
    const ids = aiModelPickerGroups(defaultAiSettings(), true).map((g) => g.id)
    expect(ids).toEqual([])
  })

  it('adds a vendor once its key is set and puts an off-catalog model first', () => {
    const settings = defaultAiSettings()
    settings.providers.anthropic = { apiKey: 'k', model: 'claude-next' }
    const groups = aiModelPickerGroups(settings, false)
    expect(groups.map((g) => g.id)).toEqual(['anthropic'])
    expect(groups[0]!.models).toEqual(['claude-next', ...anthropicModels])
  })

  it('needs a base URL for custom endpoints', () => {
    const settings = defaultAiSettings()
    settings.providers.custom = { apiKey: '', model: 'llama', baseUrl: '' }
    expect(aiModelPickerGroups(settings, false)).toEqual([])
    settings.providers.custom = { apiKey: '', model: 'llama', baseUrl: 'http://localhost:11434/v1' }
    expect(aiModelPickerGroups(settings, false).map((g) => g.id)).toEqual(['custom'])
  })
})

describe('selection round trip', () => {
  it('switches provider and model in one write and reads back', () => {
    const settings = defaultAiSettings()
    settings.providers.anthropic = { apiKey: 'k', model: anthropicModels[0]! }
    const next = withAiModelSelection(settings, {
      provider: 'anthropic',
      model: anthropicModels[1]!,
    })
    expect(next.provider).toBe('anthropic')
    expect(next.providers.anthropic.apiKey).toBe('k')
    expect(aiModelPickerSelection(next)).toEqual({
      provider: 'anthropic',
      model: anthropicModels[1],
    })
    expect(settings.providers.anthropic.model).toBe(anthropicModels[0])
  })

  it('keeps the stored provider before its key is set (never rerouted to Genspark)', () => {
    const settings = defaultAiSettings()
    settings.provider = 'anthropic'
    expect(aiModelPickerSelection(settings).provider).toBe('anthropic')
  })
})

describe('CLI vendors', () => {
  it('lists Codex only after the settings page stored a path or model', () => {
    const settings = defaultAiSettings()
    expect(aiModelPickerGroups(settings, false)).toEqual([])
    settings.providers.codex = { apiKey: '', model: '', cliPath: '/usr/local/bin/codex' }
    expect(aiModelPickerGroups(settings, false)).toEqual([
      { id: 'codex', label: 'Codex CLI', models: [] },
    ])
  })
})

describe('Antigravity availability (S01-S05)', () => {
  const HIGH = 'gemini-3.8-flash-high'
  const LOW = 'gemini-3.8-flash-low'
  const PRO = 'gemini-3.1-pro-high'
  const agySettings = (model: string) => {
    const settings = defaultAiSettings()
    settings.provider = 'agy'
    settings.providers.agy = { apiKey: '', model, cliPath: '/cli/agy' }
    return settings
  }
  const live = (entries: Array<{ id: string; enabled?: boolean; verified?: boolean }>) =>
    entries.map((entry) => ({ id: entry.id, label: entry.id, ...entry }))

  it('S01: only a model that is switched on and confirmed by the CLI is selectable', () => {
    const groups = aiModelPickerGroups(
      agySettings(HIGH),
      false,
      live([
        { id: HIGH, enabled: true, verified: true },
        { id: LOW, enabled: true, verified: true },
      ]),
    )
    const agy = groups.find((g) => g.id === 'agy')!
    expect(agy.models).toEqual([HIGH, LOW])
    expect(agy.unusable ?? []).toEqual([])
  })

  it('S02: a catalog that could not be read makes nothing selectable, but keeps the saved model visible', () => {
    const groups = aiModelPickerGroups(
      agySettings(HIGH),
      false,
      live([
        { id: HIGH, enabled: true },
        { id: PRO, enabled: true },
      ]),
      true,
    )
    const agy = groups.find((g) => g.id === 'agy')!
    expect(agy.models).toEqual([])
    expect(agy.unusable).toEqual([HIGH])
  })

  it('S03: a model the person switched off is never selectable, even when the CLI serves it', () => {
    const groups = aiModelPickerGroups(
      agySettings(HIGH),
      false,
      live([
        { id: HIGH, enabled: true, verified: true },
        { id: PRO, enabled: false, verified: true },
      ]),
    )
    const agy = groups.find((g) => g.id === 'agy')!
    expect(agy.models).toEqual([HIGH])
    expect(agy.unusable ?? []).toEqual([])
  })

  it('S04: an unconfirmed model is not the same as an empty catalog', () => {
    const groups = aiModelPickerGroups(
      agySettings(HIGH),
      false,
      live([
        { id: HIGH, enabled: true, verified: true },
        { id: PRO, enabled: true, verified: false },
      ]),
    )
    const agy = groups.find((g) => g.id === 'agy')!
    expect(agy.models).toEqual([HIGH])
  })

  it('S05: with nothing usable and nothing saved the group is not offered at all', () => {
    const settings = defaultAiSettings()
    settings.providers.agy = { apiKey: '', model: '', cliPath: '/cli/agy' }
    const groups = aiModelPickerGroups(settings, false, live([{ id: PRO, enabled: true }]), true)
    expect(groups.find((g) => g.id === 'agy')).toBeUndefined()
  })
})

describe('custom endpoints', () => {
  const settings = () => ({
    ...defaultAiSettings(),
    customEndpoints: [
      {
        id: 'a',
        name: 'Ollama',
        baseUrl: 'http://localhost:11434/v1',
        apiKey: '',
        model: 'llama3',
      },
      {
        id: 'b',
        name: '',
        baseUrl: 'https://gw.example.com/v1',
        apiKey: 'k',
        model: 'gpt-x',
        models: ['gpt-y'],
      },
      { id: 'c', name: 'Empty', baseUrl: '', apiKey: '', model: 'm' },
    ],
    customEndpoint: 'a',
  })

  it('lists one group per configured endpoint with its cached models', () => {
    const groups = aiModelPickerGroups(settings(), false)
    expect(groups).toEqual([
      { id: 'custom', endpoint: 'a', label: 'Ollama', models: ['llama3'] },
      { id: 'custom', endpoint: 'b', label: 'gw.example.com', models: ['gpt-x', 'gpt-y'] },
    ])
  })

  it('picking a model on another endpoint activates that endpoint', () => {
    const start = { ...settings(), provider: 'custom' as const }
    expect(aiModelPickerSelection(start)).toEqual({
      provider: 'custom',
      endpoint: 'a',
      model: 'llama3',
    })
    const next = withAiModelSelection(start, { provider: 'custom', endpoint: 'b', model: 'gpt-y' })
    expect(aiModelPickerSelection(next)).toEqual({
      provider: 'custom',
      endpoint: 'b',
      model: 'gpt-y',
    })
    expect(next.providers.custom).toEqual({
      apiKey: 'k',
      model: 'gpt-y',
      baseUrl: 'https://gw.example.com/v1',
    })
    expect(next.customEndpoints!.find((e) => e.id === 'a')!.model).toBe('llama3')
  })
})

describe('Antigravity alias duplicates', () => {
  const item = (id: string, label: string) => ({ id, label })
  const live = [
    item('gemini-flash-medium', 'Gemini Flash Medium'),
    item('gemini-flash-high', 'Gemini Flash High'),
    item('gemini-3.8-flash-high', 'Gemini 3.8 Flash High'),
    item('gemini-3.8-flash-medium', 'Gemini 3.8 Flash Medium'),
    item('gemini-3.8-flash-low', 'Gemini 3.8 Flash Low'),
  ]

  it('folds unversioned aliases into the versioned twin', () => {
    expect(dedupeAgyModelItems(live).map((m) => m.id)).toEqual([
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-medium',
      'gemini-3.8-flash-low',
    ])
  })

  it('keeps an alias that has no versioned twin', () => {
    const only = [item('gemini-flash-low', 'Gemini Flash Low')]
    expect(dedupeAgyModelItems(only)).toEqual(only)
  })

  it('maps a saved alias to the newest twin and leaves other ids alone', () => {
    const ids = live.map((m) => m.id)
    expect(resolveAgyModelAlias('gemini-flash-high', ids)).toBe('gemini-3.8-flash-high')
    expect(resolveAgyModelAlias('claude-sonnet-5-5-high', ids)).toBe('claude-sonnet-5-5-high')
  })

  it('lists the Antigravity group without duplicates', () => {
    const settings = defaultAiSettings()
    settings.provider = 'agy'
    // only models the CLI confirmed are selectable
    const confirmed = live.map((m) => ({ ...m, verified: true }))
    const g = aiModelPickerGroups(settings, false, confirmed).find((x) => x.id === 'agy')!
    expect(g.models).toHaveLength(3)
  })
})
