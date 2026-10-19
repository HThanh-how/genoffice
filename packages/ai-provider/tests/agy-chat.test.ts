import { describe, expect, it } from 'vitest'
import {
  AGY_CHAT_DEFAULT_ENABLED,
  AGY_CHAT_DEFAULT_MODEL,
  agyChatModelInfo,
  defaultEnabledChatModels,
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
  it('keeps an explicit selection even when the catalog no longer lists it', () => {
    expect(resolveChatModel('gemini-3.1-pro-high', { models: ['gemini-3.8-flash-low'] })).toBe(
      'gemini-3.1-pro-high',
    )
    expect(resolveChatModel('claude-sonnet-4-6', { models: [] })).toBe('claude-sonnet-4-6')
  })

  it('uses the High default when nothing was chosen', () => {
    expect(resolveChatModel(undefined, { models: [] })).toBe(AGY_CHAT_DEFAULT_MODEL)
    expect(resolveChatModel('', { models: ['gemini-3.8-flash-high'] })).toBe(AGY_CHAT_DEFAULT_MODEL)
  })

  it('falls back to a model the CLI really has when the seeded default is absent', () => {
    expect(resolveChatModel(AGY_CHAT_DEFAULT_MODEL, { models: ['gemini-3.1-pro-low'] })).toBe(
      'gemini-3.1-pro-low',
    )
  })

  it('does not treat a catalog failure as evidence that the model is missing', () => {
    expect(
      resolveChatModel(AGY_CHAT_DEFAULT_MODEL, {
        models: [],
        error: 'Timed out waiting for `agy models`',
      }),
    ).toBe(AGY_CHAT_DEFAULT_MODEL)
  })
})

describe('resolveChatModels', () => {
  const geminiCatalog = {
    models: ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high'],
  }

  it('T01/T02: a fresh install defaults to High and enables every Gemini the CLI reports', () => {
    const state = resolveChatModels({
      savedEnabled: undefined,
      savedModel: AGY_CHAT_DEFAULT_MODEL,
      catalog: {
        models: ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high'],
      },
    })
    expect(state.selected).toBe('gemini-3.8-flash-high')
    expect(state.enabled).toEqual([
      'gemini-3.8-flash-low',
      'gemini-3.8-flash-medium',
      'gemini-3.8-flash-high',
    ])
    expect(state.fromCatalog).toBe(true)
  })

  it('T03: Claude and GPT stay off for an unset preference', () => {
    const state = resolveChatModels({
      savedEnabled: undefined,
      savedModel: AGY_CHAT_DEFAULT_MODEL,
      catalog: { models: [...geminiCatalog.models, 'claude-sonnet-4-6', 'gpt-oss-120b-medium'] },
    })
    expect(state.enabled).toEqual(geminiCatalog.models)
  })

  it('T04/T05/T06/T07: a saved preference is preserved exactly as stored', () => {
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
      savedModel: AGY_CHAT_DEFAULT_MODEL,
      catalog: { models: ['gemini-3.1-pro-low', 'gemini-3.8-flash-medium'] },
    })
    expect(state.selected).toBe('gemini-3.1-pro-low')
    expect(state.models.map((m) => m.id)).toContain('gemini-3.1-pro-low')
  })

  it('T09/T10: a failed or empty catalog changes nothing and is reported', () => {
    const state = resolveChatModels({
      savedEnabled: undefined,
      savedModel: 'gemini-3.1-pro-high',
      catalog: { models: [], error: 'Antigravity CLI returned no models. Are you signed in?' },
    })
    expect(state.selected).toBe('gemini-3.1-pro-high')
    expect(state.catalogError).toBe('Antigravity CLI returned no models. Are you signed in?')
    expect(state.fromCatalog).toBe(false)
  })

  it('T24: duplicate catalog ids produce one picker entry each', () => {
    const state = resolveChatModels({
      savedEnabled: undefined,
      savedModel: AGY_CHAT_DEFAULT_MODEL,
      catalog: {
        models: ['gemini-3.8-flash-high', 'gemini-3.8-flash-high', 'gemini-3.8-flash-low'],
      },
    })
    expect(state.models.map((m) => m.id)).toEqual(['gemini-3.8-flash-high', 'gemini-3.8-flash-low'])
  })

  it('T26: a corrupted saved list falls back to the seed without inventing availability', () => {
    const state = resolveChatModels({
      savedEnabled: ['   ', 7, null],
      savedModel: AGY_CHAT_DEFAULT_MODEL,
      catalog: { models: [], error: 'agy not found' },
    })
    expect(state.enabled).toEqual([AGY_CHAT_DEFAULT_MODEL])
    expect(state.catalogError).toBe('agy not found')
  })

  it('keeps a stored selection visible even when it is not in the enabled list', () => {
    const state = resolveChatModels({
      savedEnabled: ['gemini-3.8-flash-low'],
      savedModel: 'gemini-3.1-pro-high',
      catalog: geminiCatalog,
    })
    expect(state.selected).toBe('gemini-3.1-pro-high')
    expect(state.models.map((m) => m.id)).toEqual(['gemini-3.1-pro-high', 'gemini-3.8-flash-low'])
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
  it('T09/T10: an unavailable catalog keeps the seed without claiming availability', () => {
    expect(firstRunChatModel({ models: [], error: 'agy not found' })).toBe('gemini-3.8-flash-high')
    expect(firstRunChatModel({ models: [] })).toBe('gemini-3.8-flash-high')
  })
})
