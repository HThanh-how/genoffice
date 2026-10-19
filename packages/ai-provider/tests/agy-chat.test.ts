import { describe, expect, it } from 'vitest'
import {
  AGY_CHAT_DEFAULT_ENABLED,
  AGY_CHAT_DEFAULT_MODEL,
  agyChatModelInfo,
  defaultEnabledChatModels,
  dedupeModelIds,
  firstRunChatModel,
  resolveChatModel,
  resolveChatModels,
  sanitizeEnabledChatModels,
  usageForModel,
} from '../src/agy-chat'

describe('agyChatModelInfo', () => {
  it('describes Gemini levels and ranks their quota cost', () => {
    const low = agyChatModelInfo('gemini-3.8-flash-low')
    expect(low).toMatchObject({ label: 'Gemini 3.8 Flash Low', family: 'gemini', speed: 'fast' })
    expect(low.group).toBe('Gemini Models')
    expect(agyChatModelInfo('gemini-3.8-flash-high').relativeCost).toBeGreaterThan(low.relativeCost)
    expect(agyChatModelInfo('gemini-3.1-pro-high').relativeCost).toBeGreaterThan(
      agyChatModelInfo('gemini-3.1-pro-low').relativeCost,
    )
  })

  it('puts Claude and GPT in their own, costlier pool', () => {
    const claude = agyChatModelInfo('claude-sonnet-4-6')
    expect(claude.group).toBe('Claude and GPT models')
    expect(claude.relativeCost).toBeGreaterThanOrEqual(
      agyChatModelInfo('gemini-3.1-pro-high').relativeCost,
    )
    expect(agyChatModelInfo('gpt-oss-120b-medium').group).toBe('Claude and GPT models')
  })

  it('still describes a model it does not know', () => {
    expect(agyChatModelInfo('some-future-model')).toMatchObject({
      id: 'some-future-model',
      family: 'other',
      group: null,
    })
  })
})

describe('sanitizeEnabledChatModels', () => {
  it('falls back to the offline seed when the saved list is empty or invalid', () => {
    expect(AGY_CHAT_DEFAULT_ENABLED).toEqual([AGY_CHAT_DEFAULT_MODEL])
    expect(sanitizeEnabledChatModels(undefined)).toEqual([AGY_CHAT_DEFAULT_MODEL])
    expect(sanitizeEnabledChatModels([])).toEqual([AGY_CHAT_DEFAULT_MODEL])
    expect(sanitizeEnabledChatModels(['  bad id', 5, null])).toEqual([AGY_CHAT_DEFAULT_MODEL])
  })
  it('keeps valid ids once, in order', () => {
    expect(
      sanitizeEnabledChatModels([
        'gemini-3.7-flash-low',
        'gemini-3.8-flash-low',
        'gemini-3.7-flash-low',
      ]),
    ).toEqual(['gemini-3.7-flash-low', 'gemini-3.8-flash-low'])
  })
})

describe('defaultEnabledChatModels', () => {
  const catalog = [
    'gemini-3.8-flash-low',
    'gemini-3.8-flash-medium',
    'gemini-3.8-flash-high',
    'gemini-3.1-pro-low',
    'gemini-3.1-pro-high',
    'claude-sonnet-4-6',
    'gpt-oss-120b-medium',
  ]

  it('enables every Gemini the CLI reports and nothing else', () => {
    expect(defaultEnabledChatModels(catalog)).toEqual([
      'gemini-3.8-flash-low',
      'gemini-3.8-flash-medium',
      'gemini-3.8-flash-high',
      'gemini-3.1-pro-low',
      'gemini-3.1-pro-high',
    ])
  })

  it('deduplicates ids while keeping catalog order', () => {
    expect(defaultEnabledChatModels(['gemini-3.8-flash-high', 'gemini-3.8-flash-high'])).toEqual([
      'gemini-3.8-flash-high',
    ])
  })

  it('treats an empty or failed catalog as "nothing is known", not as "these exist"', () => {
    expect(defaultEnabledChatModels([])).toEqual([])
    expect(defaultEnabledChatModels(undefined)).toEqual([])
    expect(defaultEnabledChatModels(['claude-sonnet-4-6'])).toEqual([])
  })
})

describe('resolveChatModel', () => {
  it('T04/T05/T06/T38: keeps every persisted selection, even when the catalog no longer lists it', () => {
    for (const model of [
      'gemini-3.8-flash-low',
      'gemini-3.8-flash-medium',
      'gemini-3.8-flash-high',
      'gemini-3.1-pro-high',
      'claude-sonnet-4-6',
    ]) {
      expect(resolveChatModel(model, { models: ['gemini-3.8-flash-low'] })).toBe(model)
    }
  })

  it('T40: a saved High is never replaced just because High disappears from the catalog', () => {
    expect(resolveChatModel('gemini-3.8-flash-high', { models: ['gemini-3.8-flash-low'] })).toBe(
      'gemini-3.8-flash-high',
    )
    expect(resolveChatModel('gemini-3.8-flash-high', { models: [] })).toBe('gemini-3.8-flash-high')
  })

  it('T01: nothing stored and the CLI offers High -> High', () => {
    expect(
      resolveChatModel(undefined, {
        models: ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high'],
      }),
    ).toBe(AGY_CHAT_DEFAULT_MODEL)
    expect(resolveChatModel('', { models: ['gemini-3.8-flash-high'] })).toBe(AGY_CHAT_DEFAULT_MODEL)
  })

  it('T08: nothing stored and High is absent -> the first Gemini the CLI actually reports', () => {
    expect(
      resolveChatModel(undefined, { models: ['gemini-3.1-pro-low', 'gemini-3.8-flash-medium'] }),
    ).toBe('gemini-3.1-pro-low')
  })

  it('T09/T39: a catalog with no Gemini yields nothing rather than a fabricated model', () => {
    expect(
      resolveChatModel(undefined, { models: ['claude-sonnet-4-6', 'gpt-oss-120b-medium'] }),
    ).toBe(undefined)
  })

  it('T10: a catalog that answered with an empty list confirms no model', () => {
    expect(resolveChatModel(undefined, { models: [] })).toBeUndefined()
  })

  it('T11/T12/T13: a catalog failure is never read as "the model is missing"', () => {
    expect(
      resolveChatModel('gemini-3.8-flash-high', {
        models: [],
        error: 'Timed out waiting for `agy models`',
      }),
    ).toBe('gemini-3.8-flash-high')
    expect(resolveChatModel(undefined, { models: [], error: 'agy not found' })).toBeUndefined()
  })

  it('malformed stored values are not treated as a selection', () => {
    for (const junk of [null, undefined, '', '   ', 0, {}, [], true])
      expect(resolveChatModel(junk, { models: [] })).toBeUndefined()
  })
})

describe('resolveChatModels', () => {
  const geminiCatalog = {
    models: ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high'],
  }

  it('T01/T02: a fresh install defaults to High and enables every Gemini the CLI reports', () => {
    const state = resolveChatModels({
      savedEnabled: undefined,
      savedModel: '',
      catalog: geminiCatalog,
    })
    expect(state.selected).toBe('gemini-3.8-flash-high')
    expect(state.enabled).toEqual(geminiCatalog.models)
    expect(state.available).toEqual(geminiCatalog.models)
    expect(state.verified).toBe(true)
    expect(state.selectedStatus).toBe('verified')
    expect(state.fromCatalog).toBe(true)
  })

  it('T03: Claude and GPT stay off for an unset preference', () => {
    const state = resolveChatModels({
      savedEnabled: undefined,
      savedModel: '',
      catalog: { models: [...geminiCatalog.models, 'claude-sonnet-4-6', 'gpt-oss-120b-medium'] },
    })
    expect(state.enabled).toEqual(geminiCatalog.models)
    expect(state.available).toEqual([
      ...geminiCatalog.models,
      'claude-sonnet-4-6',
      'gpt-oss-120b-medium',
    ])
  })

  it('T04/T05/T06/T07/T38: a saved enabled list is preserved exactly as stored', () => {
    for (const saved of [
      ['gemini-3.8-flash-low'],
      ['gemini-3.1-pro-high'],
      ['gemini-3.8-flash-low'],
      ['claude-sonnet-4-6', 'gemini-3.8-flash-high'],
    ]) {
      const state = resolveChatModels({
        savedEnabled: saved,
        savedModel: saved[0],
        catalog: geminiCatalog,
      })
      expect(state.enabled).toEqual(saved)
      expect(state.fromCatalog).toBe(false)
    }
  })

  it('T08: a first run with a catalog that lacks High uses a model the CLI has', () => {
    const state = resolveChatModels({
      savedEnabled: undefined,
      savedModel: '',
      catalog: { models: ['gemini-3.1-pro-low', 'gemini-3.8-flash-medium'] },
    })
    expect(state.selected).toBe('gemini-3.1-pro-low')
    expect(state.models.map((m) => m.id)).toContain('gemini-3.1-pro-low')
  })

  it('T09/T39: a catalog with no Gemini advertises nothing and selects nothing', () => {
    const state = resolveChatModels({
      savedEnabled: undefined,
      savedModel: '',
      catalog: { models: ['claude-sonnet-4-6', 'gpt-oss-120b-medium'] },
    })
    expect(state.selected).toBe('')
    expect(state.selectedStatus).toBe('none')
    expect(state.enabled).toEqual([])
    expect(state.models.map((m) => m.id)).toEqual([])
    expect(state.available).toEqual(['claude-sonnet-4-6', 'gpt-oss-120b-medium'])
    expect(state.verified).toBe(true)
  })

  it('T10/T11/T12/T13: a failed catalog preserves stored choices and reports itself', () => {
    const state = resolveChatModels({
      savedEnabled: undefined,
      savedModel: 'gemini-3.1-pro-high',
      catalog: { models: [], error: 'Antigravity CLI returned no models. Are you signed in?' },
    })
    expect(state.selected).toBe('gemini-3.1-pro-high')
    expect(state.selectedStatus).toBe('unverified')
    expect(state.available).toEqual([])
    expect(state.verified).toBe(false)
    expect(state.catalogError).toBe('Antigravity CLI returned no models. Are you signed in?')
    expect(state.fromCatalog).toBe(false)
  })

  it('T24/T32: duplicate catalog ids produce one entry each without changing identity', () => {
    const state = resolveChatModels({
      savedEnabled: undefined,
      savedModel: '',
      catalog: {
        models: ['gemini-3.8-flash-high', 'gemini-3.8-flash-high', 'gemini-3.8-flash-low'],
      },
    })
    expect(state.models.map((m) => m.id)).toEqual(['gemini-3.8-flash-high', 'gemini-3.8-flash-low'])
    expect(dedupeModelIds(['a', 'a', 'b', ' b ']).length).toBe(2)
  })

  it('T26: a corrupted saved list falls back to the seed without inventing availability', () => {
    const state = resolveChatModels({
      savedEnabled: ['   ', 7, null],
      savedModel: '',
      catalog: { models: [], error: 'agy not found' },
    })
    expect(state.enabled).toEqual([AGY_CHAT_DEFAULT_MODEL])
    expect(state.catalogError).toBe('agy not found')
  })

  it('T33: a model the person switched off is shown but flagged as not enabled', () => {
    const state = resolveChatModels({
      savedEnabled: ['gemini-3.8-flash-low'],
      savedModel: 'gemini-3.1-pro-high',
      catalog: geminiCatalog,
    })
    expect(state.selected).toBe('gemini-3.1-pro-high')
    expect(state.enabled).toEqual(['gemini-3.8-flash-low'])
    const entries = Object.fromEntries(state.models.map((m) => [m.id, m.enabled]))
    expect(entries['gemini-3.1-pro-high']).toBe(false)
    expect(entries['gemini-3.8-flash-low']).toBe(true)
  })

  it('T34: a selected model absent from a verified catalog stays selected but is flagged unavailable', () => {
    const state = resolveChatModels({
      savedEnabled: ['gemini-3.8-flash-low'],
      savedModel: 'gemini-3.8-flash-high',
      catalog: { models: ['gemini-3.8-flash-low'] },
    })
    expect(state.selected).toBe('gemini-3.8-flash-high')
    expect(state.selectedStatus).toBe('unavailable')
    expect(state.available).toEqual(['gemini-3.8-flash-low'])
  })
})

describe('usageForModel', () => {
  const state = {
    groups: [
      { name: 'Gemini Models', buckets: [{ window: '5h' as const, remaining: 0.85 }] },
      { name: 'Claude and GPT models', buckets: [{ window: '5h' as const, remaining: 0.95 }] },
    ],
    readAt: 1,
    refreshing: false,
    failed: false,
  }
  it('returns the pool the model draws from', () => {
    expect(usageForModel(state, 'gemini-3.8-flash-low')?.[0]?.remaining).toBe(0.85)
    expect(usageForModel(state, 'claude-sonnet-4-6')?.[0]?.remaining).toBe(0.95)
    expect(usageForModel(state, 'mystery')).toBeNull()
    expect(usageForModel(null, 'gemini-3.8-flash-low')).toBeNull()
  })
})

describe('firstRunChatModel', () => {
  it('T01: picks High when the CLI offers it', () => {
    expect(firstRunChatModel({ models: ['gemini-3.8-flash-low', 'gemini-3.8-flash-high'] })).toBe(
      'gemini-3.8-flash-high',
    )
  })
  it('T08: falls back to a model the CLI really has when High is absent', () => {
    expect(firstRunChatModel({ models: ['gemini-3.1-pro-low', 'claude-sonnet-4-6'] })).toBe(
      'gemini-3.1-pro-low',
    )
  })
  it('T09/T10/T39: nothing is invented when the catalog has no Gemini or could not be read', () => {
    expect(firstRunChatModel({ models: [], error: 'agy not found' })).toBeUndefined()
    expect(firstRunChatModel({ models: [] })).toBeUndefined()
    expect(firstRunChatModel({ models: ['claude-sonnet-4-6'] })).toBeUndefined()
    expect(firstRunChatModel({})).toBeUndefined()
  })
})
