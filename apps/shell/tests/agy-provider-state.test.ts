import { describe, expect, it } from 'vitest'
import {
  agyConnectionOf,
  agyPlatformOf,
  withAgyModels,
} from '../src/renderer/src/fork/agy-provider-state'
import { agyString } from '../src/renderer/src/fork/agy-strings'

const catalog = () => [
  { id: 'codex', models: ['a'], defaultModel: 'a' },
  { id: 'agy', models: ['seed'], defaultModel: 'seed' },
]

describe('withAgyModels', () => {
  it('replaces only the agy entry and pins an unknown stored selection on top', () => {
    const next = withAgyModels(catalog(), { models: ['m1', 'm2'], defaultModel: 'm1' }, 'custom-id')
    expect(next[0]).toEqual({ id: 'codex', models: ['a'], defaultModel: 'a' })
    expect(next[1]).toEqual({ id: 'agy', models: ['custom-id', 'm1', 'm2'], defaultModel: 'm1' })
  })

  it('keeps the list when the stored model is in it, and ignores empty or failed replies', () => {
    const live = { models: ['m1', 'm2'], defaultModel: 'm1' }
    expect(withAgyModels(catalog(), live, 'm2')[1]!.models).toEqual(['m1', 'm2'])
    const original = catalog()
    expect(withAgyModels(original, { models: [], defaultModel: '', error: 'x' }, 'm')).toBe(
      original,
    )
  })
})

describe('agyConnectionOf', () => {
  it('maps an `agy models` reply to a connection state', () => {
    expect(agyConnectionOf({ models: ['a', 'b'], defaultModel: 'a' }, 'fail')).toEqual({
      state: 'connected',
      count: 2,
    })
    expect(agyConnectionOf({ models: [], defaultModel: '', error: 'not found' }, 'fail')).toEqual({
      state: 'missing',
      error: 'not found',
    })
    expect(agyConnectionOf({ models: [], defaultModel: '' }, 'fail')).toEqual({
      state: 'missing',
      error: 'fail',
    })
    expect(agyConnectionOf(null, 'fail')).toEqual({ state: 'missing', error: 'fail' })
  })
})

describe('platform hint selection', () => {
  it('detects windows, mac and everything else', () => {
    expect(agyPlatformOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('win')
    expect(agyPlatformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('mac')
    expect(agyPlatformOf('Mozilla/5.0 (X11; Linux x86_64)')).toBe('other')
  })

  it('shows Windows paths only in the Windows hint and has en/vi copy', () => {
    expect(agyString('en', 'agyWhereWin')).toContain('LOCALAPPDATA')
    expect(agyString('en', 'agyWhereMac')).not.toMatch(/LOCALAPPDATA|\.exe/)
    expect(agyString('vi', 'agyNote')).toContain('Antigravity')
    expect(agyString('fr', 'agyNote')).toContain('slower than a direct API call')
  })
})

describe('Windows hint text', () => {
  it('keeps backslashes in the install path', () => {
    expect(agyString('en', 'agyWhereWin')).toContain('%LOCALAPPDATA%\\agy\\bin\\agy.exe')
  })
})
