import { describe, expect, it } from 'vitest'
import {
  AGY_CHAT_DEFAULT_ENABLED,
  agyChatModelInfo,
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
  it('defaults to Gemini 3.8 Flash Low only', () => {
    expect(AGY_CHAT_DEFAULT_ENABLED).toEqual(['gemini-3.8-flash-low'])
    expect(sanitizeEnabledChatModels(undefined)).toEqual(['gemini-3.8-flash-low'])
    expect(sanitizeEnabledChatModels([])).toEqual(['gemini-3.8-flash-low'])
    expect(sanitizeEnabledChatModels(['  bad id', 5, null])).toEqual(['gemini-3.8-flash-low'])
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
