import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearAgyCapabilitiesCache, readAgyCapabilities } from '../src/agy-capabilities'
import {
  AGY_TASK_EFFORT,
  agyModelHasBakedEffort,
  helpMentionsFlag,
  resolveAgyEffort,
} from '../src/agy-effort'

// the flag lines of a real `agy --help` (agy 1.3.2, 2026-10-09)
const HELP = `Usage of agy:
  --add-dir                       Add a directory to the workspace (repeatable) (default [])
  --effort                        Reasoning effort for the current CLI session (low|medium|high|xhigh|max)
  --json-schema                   Optional JSON schema string or path to a schema file to enforce structured output
  --model                         Model for the current CLI session
`

afterEach(() => clearAgyCapabilitiesCache())

describe('agy --help capability detection', () => {
  it('finds whole flags only', () => {
    expect(helpMentionsFlag(HELP, '--effort')).toBe(true)
    expect(helpMentionsFlag(HELP, '--json-schema')).toBe(true)
    expect(helpMentionsFlag(HELP, '--model')).toBe(true)
    expect(helpMentionsFlag('  --effort-level  something', '--effort')).toBe(false)
    expect(helpMentionsFlag('mentions effort in prose', '--effort')).toBe(false)
  })

  it('reads the help once per executable and caches the answer', async () => {
    const help = vi.fn(async () => HELP)
    const first = await readAgyCapabilities('/a/agy', { help })
    const second = await readAgyCapabilities('/a/agy', { help })
    expect(first).toEqual({ effort: true, jsonSchema: true })
    expect(second).toBe(first)
    expect(help).toHaveBeenCalledTimes(1)
    await readAgyCapabilities('/b/agy', { help })
    expect(help).toHaveBeenCalledTimes(2)
  })

  it('shares one help run between concurrent callers', async () => {
    let release!: (text: string) => void
    const help = vi.fn(() => new Promise<string>((resolve) => (release = resolve)))
    const a = readAgyCapabilities('/a/agy', { help })
    const b = readAgyCapabilities('/a/agy', { help })
    release(HELP)
    expect(await a).toEqual(await b)
    expect(help).toHaveBeenCalledTimes(1)
  })

  it('an older agy without the flags answers false, and that answer is cached', async () => {
    const help = vi.fn(async () => '  --model   Model\n  --sandbox  Sandbox\n')
    expect(await readAgyCapabilities('/old/agy', { help })).toEqual({
      effort: false,
      jsonSchema: false,
    })
    await readAgyCapabilities('/old/agy', { help })
    expect(help).toHaveBeenCalledTimes(1)
  })

  it('a failed probe means "unsupported" for now but is retried next time', async () => {
    const help = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('spawn EACCES'))
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(HELP)
    expect(await readAgyCapabilities('/a/agy', { help })).toEqual({
      effort: false,
      jsonSchema: false,
    })
    expect(await readAgyCapabilities('/a/agy', { help })).toEqual({
      effort: false,
      jsonSchema: false,
    })
    expect(await readAgyCapabilities('/a/agy', { help })).toEqual({
      effort: true,
      jsonSchema: true,
    })
    expect(help).toHaveBeenCalledTimes(3)
  })
})

describe('effort per task', () => {
  it('low for retrieval-style work, medium for chat', () => {
    expect(AGY_TASK_EFFORT).toMatchObject({
      chat: 'medium',
      search: 'low',
      ocr: 'low',
      classify: 'low',
    })
    expect(resolveAgyEffort({ task: 'search', model: 'claude-sonnet-4-6' })).toBe('low')
    expect(resolveAgyEffort({ task: 'chat', model: 'claude-sonnet-4-6' })).toBe('medium')
  })

  it('sends nothing unless a task or level is named', () => {
    expect(resolveAgyEffort({ model: 'claude-sonnet-4-6' })).toBeUndefined()
  })

  it('an explicit level beats the task, unknown levels are ignored', () => {
    expect(resolveAgyEffort({ task: 'search', effort: 'high', model: 'x' })).toBe('high')
    expect(resolveAgyEffort({ task: 'search', effort: 'turbo' as never, model: 'x' })).toBe('low')
  })

  it('never overrides a model whose id already carries its effort', () => {
    for (const model of ['gemini-3.8-flash-low', 'gemini-3.1-pro-high', 'gpt-oss-120b-medium']) {
      expect(agyModelHasBakedEffort(model)).toBe(true)
      expect(resolveAgyEffort({ task: 'search', effort: 'max', model })).toBeUndefined()
    }
    expect(agyModelHasBakedEffort('claude-sonnet-4-6')).toBe(false)
    expect(agyModelHasBakedEffort('claude-opus-4-6-thinking')).toBe(false)
  })

  it('the environment can switch it off or force a level (but not for baked-effort models)', () => {
    expect(resolveAgyEffort({ task: 'search', model: 'x', env: 'off' })).toBeUndefined()
    expect(resolveAgyEffort({ task: 'search', model: 'x', env: 'MAX' })).toBe('max')
    expect(resolveAgyEffort({ task: 'search', model: 'x', env: 'nonsense' })).toBe('low')
    expect(
      resolveAgyEffort({ task: 'search', model: 'gemini-3.8-flash-low', env: 'max' }),
    ).toBeUndefined()
  })
})
