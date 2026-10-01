import { describe, expect, it } from 'vitest'
import {
  agyEffectiveCliPath,
  agyMediaModelOptions,
  agyMediaTestConfig,
} from '../src/renderer/src/fork/agy-media-state'
import { agyMediaString } from '../src/renderer/src/fork/agy-media-strings'

describe('agy media settings helpers', () => {
  it('shares the chat path in the connection test unless the media block has its own', () => {
    const base = { apiKey: '', imageModel: '', analysisModel: '' }
    expect(agyMediaTestConfig('agy', base, ' /usr/local/bin/agy ')).toEqual({
      ...base,
      cliPath: '/usr/local/bin/agy',
    })
    const own = { ...base, cliPath: '/own/agy' }
    expect(agyMediaTestConfig('agy', own, '/chat/agy')).toBe(own)
    expect(agyMediaTestConfig('agy', base, undefined)).toBe(base)
    // other vendors are never touched
    expect(agyMediaTestConfig('gemini', base, '/chat/agy')).toBe(base)
  })

  it('picks the effective CLI path: media override, chat path, then auto-detect', () => {
    expect(agyEffectiveCliPath('/a', '/b')).toBe('/a')
    expect(agyEffectiveCliPath('  ', '/b')).toBe('/b')
    expect(agyEffectiveCliPath(undefined, undefined)).toBeUndefined()
  })

  it('keeps a stored model pinned when the live list lacks it, and falls back to the seed', () => {
    expect(agyMediaModelOptions(['a', 'b'], ['seed'], 'a')).toEqual(['a', 'b'])
    expect(agyMediaModelOptions(['a', 'b'], ['seed'], 'old')).toEqual(['old', 'a', 'b'])
    expect(agyMediaModelOptions([], ['seed'], '')).toEqual(['seed'])
  })

  it('has the honest hint in English and Vietnamese, with English fallback elsewhere', () => {
    expect(agyMediaString('en', 'agyMediaHint')).toBe(
      'Uses your Antigravity account, no API key. Slower than a direct API (about 10–40 s per image). Counts against your Antigravity quota.',
    )
    expect(agyMediaString('vi', 'agyMediaHint')).toContain('không cần khóa API')
    expect(agyMediaString('zh', 'agyMediaHint')).toContain('Antigravity')
    expect(agyMediaString('fr', 'agyMediaHint')).toBe(agyMediaString('en', 'agyMediaHint'))
    expect(agyMediaString('en', 'agyMediaTestOk', { n: 5 })).toBe(
      'Connected · 5 models (no quota used)',
    )
  })
})
