import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => windows },
  app: { whenReady: () => new Promise(() => {}) },
  shell: { openExternal: () => undefined },
}))

const windows: Array<{
  isDestroyed: () => boolean
  webContents: { send: (channel: string, ...args: unknown[]) => void }
}> = []
function fakeWindow(sent: Array<[string, unknown[]]>): void {
  windows.push({
    isDestroyed: () => false,
    webContents: { send: (channel: string, ...args: unknown[]) => sent.push([channel, args]) },
  })
}

const catalogCall = vi.fn(async () => ({
  models: [] as string[],
  error: undefined as string | undefined,
}))
vi.mock('@genoffice/ai-provider/agy-cli', () => ({
  listAgyModels: (cliPath: string | undefined) => catalogCall(cliPath),
}))

import { AGY_CHAT_CHANNELS } from '@genoffice/ai-provider/agy-chat'
import { applySettingsWrite, type AiSettings } from '@genoffice/ai-provider'
import { AGY_CHAT_MODELS_KEY, registerAgyChat, AgyUsageCache } from '../src/main/fork/agy-chat-ipc'

const dirs: string[] = []
function paths(initialAi: Record<string, unknown>, initialApp: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agy-races-'))
  dirs.push(dir)
  const aiSettingsPath = join(dir, 'ai-settings.json')
  const settingsPath = join(dir, 'app-settings.json')
  writeFileSync(aiSettingsPath, JSON.stringify(initialAi), 'utf8')
  writeFileSync(settingsPath, JSON.stringify(initialApp), 'utf8')
  return { dir, aiSettingsPath, settingsPath, cachePath: join(dir, 'usage.json') }
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  catalogCall.mockReset()
  windows.length = 0
})
function wire(p: { settingsPath: string; aiSettingsPath: string; cachePath: string }) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  registerAgyChat({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    settingsPath: () => p.settingsPath,
    aiSettingsPath: () => p.aiSettingsPath,
    cachePath: () => p.cachePath,
  })
  return {
    call: (channel: string, ...args: unknown[]) => handlers.get(channel)!(undefined, ...args),
  }
}
const readAi = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
const readApp = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

const HIGH = 'gemini-3.8-flash-high'
const LOW = 'gemini-3.8-flash-low'
const PRO = 'gemini-3.1-pro-high'
const GEM = [HIGH, LOW, PRO]

describe('R1: an older enabled-list mutation cannot roll back a newer one', () => {
  it('R1: A rollback is skipped after B committed a newer enabled list', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { cliPath: '/cli/a', model: HIGH } } },
      { [AGY_CHAT_MODELS_KEY]: [HIGH, LOW] },
    )
    let release: (value: { models: string[]; error?: string }) => void = () => undefined
    let probes = 0
    catalogCall.mockImplementation(() => {
      probes += 1
      if (probes === 1)
        return new Promise((resolve) => {
          release = resolve
        })
      return Promise.resolve({ models: GEM })
    })
    const { call } = wire(p)
    const a = call(AGY_CHAT_CHANNELS.setEnabled, [LOW])
    // B commits a different, newer enabled list while A's catalog read is pending
    expect(await call(AGY_CHAT_CHANNELS.setEnabled, [HIGH, LOW, PRO])).toEqual([HIGH, LOW, PRO])
    release({ models: [], error: 'agy models timed out' })
    expect(await a).toBeNull()
    expect(readApp(p.settingsPath)[AGY_CHAT_MODELS_KEY]).toEqual([HIGH, LOW, PRO])
    expect(readAi(p.aiSettingsPath).providers.agy.model).toBe(HIGH)
  })

  it('R1b: an older mutation that succeeds still cannot overwrite a newer list', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { cliPath: '/cli/a', model: HIGH } } },
      { [AGY_CHAT_MODELS_KEY]: [HIGH, LOW] },
    )
    let release: (value: { models: string[] }) => void = () => undefined
    let probes = 0
    catalogCall.mockImplementation(() => {
      probes += 1
      if (probes === 1)
        return new Promise((resolve) => {
          release = resolve
        })
      return Promise.resolve({ models: GEM })
    })
    const { call } = wire(p)
    const a = call(AGY_CHAT_CHANNELS.setEnabled, [LOW])
    expect(await call(AGY_CHAT_CHANNELS.setEnabled, [PRO])).toEqual([PRO])
    release({ models: GEM })
    expect(await a).toBeNull()
    expect(readApp(p.settingsPath)[AGY_CHAT_MODELS_KEY]).toEqual([PRO])
    expect(readAi(p.aiSettingsPath).providers.agy.model).toBe(PRO)
  })

  it('R1c: a mutation that cannot be made consistent is reported as a failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-races-fail-'))
    dirs.push(dir)
    const settingsPath = join(dir, 'app-settings.json')
    writeFileSync(settingsPath, JSON.stringify({ [AGY_CHAT_MODELS_KEY]: [HIGH, LOW] }), 'utf8')
    writeFileSync(
      join(dir, 'ai-settings.json'),
      JSON.stringify({ provider: 'agy', providers: { agy: { cliPath: '/cli/a', model: HIGH } } }),
      'utf8',
    )
    catalogCall.mockImplementation(async () => ({ models: [], error: 'timeout' }))
    const sent: Array<[string, unknown[]]> = []
    fakeWindow(sent)
    const { call } = wire({
      settingsPath,
      aiSettingsPath: join(dir, 'ai-settings.json'),
      cachePath: join(dir, 'usage.json'),
    })
    expect(await call(AGY_CHAT_CHANNELS.setEnabled, [LOW])).toBeNull()
    expect(sent.length).toBe(0)
    // the list the person had before the failed mutation is still on disk
    expect(readApp(settingsPath)[AGY_CHAT_MODELS_KEY]).toEqual([HIGH, LOW])
  })
})

describe('R2: the quota cache cannot mix two CLI identities', () => {
  const reading = (remaining: number, readAt: number) => ({
    groups: [{ name: 'Gemini Models', buckets: [{ window: '5h' as const, remaining }] }],
    readAt,
  })

  it('R2: a reading from CLI A finishing after CLI B is discarded', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agy-usage-race-')), 'cache.json')
    dirs.push(path)
    let cli = '/cli/a'
    let resolveA: (value: unknown) => void = () => undefined
    let resolveB: (value: unknown) => void = () => undefined
    const read = vi.fn((cliPath?: string) =>
      cliPath === '/cli/a'
        ? new Promise((resolve) => {
            resolveA = resolve
          })
        : new Promise((resolve) => {
            resolveB = resolve
          }),
    )
    const cache = new AgyUsageCache(
      read,
      path,
      () => 100,
      () => {},
      () => cli,
    )
    const a = cache.refresh()
    cli = '/cli/b'
    const b = cache.refresh()
    resolveB(reading(0.2, 200))
    const doneB = await b
    resolveA(reading(0.9, 150))
    await a
    expect(doneB.groups?.[0]?.buckets[0]?.remaining).toBe(0.2)
    expect(cache.get().groups?.[0]?.buckets[0]?.remaining).toBe(0.2)
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { cliKey?: string }
    expect(saved.cliKey).toBe('/cli/b')
  })

  it('R2b: A finishing first does not poison B, and a failing B keeps nothing of A', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agy-usage-race2-')), 'cache.json')
    dirs.push(path)
    let cli = '/cli/a'
    const read = vi.fn(async (cliPath?: string) =>
      cliPath === '/cli/a' ? reading(0.9, 100) : null,
    )
    const cache = new AgyUsageCache(
      read,
      path,
      () => 100,
      () => {},
      () => cli,
    )
    await cache.refresh()
    cli = '/cli/b'
    const failed = await cache.refresh()
    expect(failed.failed).toBe(true)
    expect(failed.groups).toBeNull()
  })

  it('Q1: A pending, switch B, B pending, A finishes. B must still show refreshing', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agy-usage-q1-')), 'cache.json')
    dirs.push(path)
    let cli = '/cli/a'
    let resolveA: (value: unknown) => void = () => undefined
    let resolveB: (value: unknown) => void = () => undefined
    const read = vi.fn((cliPath?: string) =>
      cliPath === '/cli/a'
        ? new Promise((resolve) => {
            resolveA = resolve
          })
        : new Promise((resolve) => {
            resolveB = resolve
          }),
    )
    const cache = new AgyUsageCache(
      read,
      path,
      () => 100,
      () => {},
      () => cli,
    )
    const a = cache.refresh()
    cli = '/cli/b'
    const b = cache.refresh()
    resolveA(reading(0.9, 150))
    await a
    expect(cache.snapshot().refreshing).toBe(true)
    resolveB(reading(0.2, 200))
    const doneB = await b
    expect(doneB.refreshing).toBe(false)
    expect(doneB.groups?.[0]?.buckets[0]?.remaining).toBe(0.2)
  })

  it('Q2: A pending, switch B, switch back A, new A starts, old A finishes last. Old A must not overwrite new A', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agy-usage-q2-')), 'cache.json')
    dirs.push(path)
    let cli = '/cli/a'
    let resolveA1: (value: unknown) => void = () => undefined
    let _resolveB: (value: unknown) => void = () => undefined
    let resolveA2: (value: unknown) => void = () => undefined
    let aCalls = 0
    const read = vi.fn((cliPath?: string) => {
      if (cliPath === '/cli/b') {
        return new Promise((resolve) => {
          _resolveB = resolve
        })
      }
      aCalls += 1
      if (aCalls === 1) {
        return new Promise((resolve) => {
          resolveA1 = resolve
        })
      }
      return new Promise((resolve) => {
        resolveA2 = resolve
      })
    })
    const cache = new AgyUsageCache(
      read,
      path,
      () => 100,
      () => {},
      () => cli,
    )
    const a1 = cache.refresh()
    cli = '/cli/b'
    const _b = cache.refresh()
    cli = '/cli/a'
    const a2 = cache.refresh()
    resolveA2(reading(0.5, 300))
    await a2
    expect(cache.get().groups?.[0]?.buckets[0]?.remaining).toBe(0.5)
    resolveA1(reading(0.9, 100))
    await a1
    expect(cache.get().groups?.[0]?.buckets[0]?.remaining).toBe(0.5)
    const saved = JSON.parse(readFileSync(path, 'utf8')) as {
      groups: Array<{ buckets: Array<{ remaining: number }> }>
    }
    expect(saved.groups[0]!.buckets[0]!.remaining).toBe(0.5)
  })

  it('Q3: Cached quota from A is restored at startup; switch B before first refresh. B must not display A percentage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-usage-q3-'))
    dirs.push(dir)
    const path = join(dir, 'cache.json')
    writeFileSync(path, JSON.stringify({ ...reading(0.8, 100), cliKey: '/cli/a' }), 'utf8')
    let cli = '/cli/a'
    const read = vi.fn(async () => reading(0.3, 200))
    const cache = new AgyUsageCache(
      read,
      path,
      () => 100,
      () => {},
      () => cli,
    )
    cli = '/cli/b'
    const snap = cache.snapshot()
    expect(snap.groups).toBeNull()
    const getResult = cache.get()
    expect(getResult.groups).toBeNull()
  })

  it('Q4: Reader throws unexpectedly. The cache must recover and permit another refresh', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agy-usage-q4-')), 'cache.json')
    dirs.push(path)
    let shouldThrow = true
    const read = vi.fn(async () => {
      if (shouldThrow) throw new Error('CLI crash')
      return reading(0.7, 200)
    })
    const cache = new AgyUsageCache(
      read,
      path,
      () => 100,
      () => {},
      () => '/cli/a',
    )
    const failed = await cache.refresh()
    expect(failed.failed).toBe(true)
    expect(cache.snapshot().refreshing).toBe(false)
    shouldThrow = false
    const recovered = await cache.refresh()
    expect(recovered.failed).toBe(false)
    expect(recovered.groups?.[0]?.buckets[0]?.remaining).toBe(0.7)
  })

  it('Q5: Failures, successes and notifications belong to the appropriate CLI. Verify cached JSON', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agy-usage-q5-')), 'cache.json')
    dirs.push(path)
    let cli = '/cli/a'
    const notifications: Array<{ cli: string; remaining?: number; failed: boolean }> = []
    const read = vi.fn(async (cliPath?: string) => {
      if (cliPath === '/cli/a') return reading(0.85, 100)
      return null
    })
    const cache = new AgyUsageCache(
      read,
      path,
      () => 100,
      (state) => {
        notifications.push({
          cli,
          remaining: state.groups?.[0]?.buckets[0]?.remaining,
          failed: state.failed,
        })
      },
      () => cli,
    )
    await cache.refresh()
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { cliKey: string; groups: unknown[] }
    expect(saved.cliKey).toBe('/cli/a')
    expect(saved.groups).toHaveLength(1)

    cli = '/cli/b'
    const failed = await cache.refresh()
    expect(failed.failed).toBe(true)
    expect(failed.groups).toBeNull()
    expect(notifications.some((n) => n.cli === '/cli/a' && n.remaining === 0.85)).toBe(true)
    expect(notifications.some((n) => n.cli === '/cli/b' && n.failed === true)).toBe(true)
  })
})

describe('R4 + R6: the generic settings write is validated against the file it commits to', () => {
  const settingsOf = (model: string): AiSettings => ({
    provider: 'agy',
    providers: {
      agy: { apiKey: 'k', cliPath: '/cli/a', model },
      openai: { apiKey: 'o', model: 'gpt-5' },
    },
  })

  it('R6: a rejected model never reaches the settings file on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-guard-disk-'))
    dirs.push(dir)
    const file = join(dir, 'ai-settings.json')
    writeFileSync(file, JSON.stringify(settingsOf(HIGH)), 'utf8')
    catalogCall.mockImplementation(async () => ({ models: [HIGH, LOW] }))
    const decision = await applySettingsWrite(
      settingsOf(PRO),
      () => JSON.parse(readFileSync(file, 'utf8')) as AiSettings,
      (next) => writeFileSync(file, JSON.stringify(next), 'utf8'),
      (cliPath: string | undefined) => catalogCall(cliPath),
      [HIGH, LOW, PRO],
    )
    expect(decision.ok).toBe(false)
    expect(decision.reason).toBe('not-confirmed')
    expect((readAi(file).providers as Record<string, { model: string }>).agy.model).toBe(HIGH)
  })

  it('R6b: a write failure leaves the last valid commit readable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-guard-fail-'))
    dirs.push(dir)
    const file = join(dir, 'ai-settings.json')
    writeFileSync(file, JSON.stringify(settingsOf(HIGH)), 'utf8')
    catalogCall.mockImplementation(async () => ({ models: GEM }))
    const decision = await applySettingsWrite(
      settingsOf(LOW),
      () => JSON.parse(readFileSync(file, 'utf8')) as AiSettings,
      () => {
        throw new Error('disk full')
      },
      (cliPath: string | undefined) => catalogCall(cliPath),
      GEM,
    )
    expect(decision.ok).toBe(false)
    expect(decision.reason).toBe('write-failed')
    expect((readAi(file).providers as Record<string, { model: string }>).agy.model).toBe(HIGH)
  })

  it('S1: Model conflict - A submits model PRO based on LOW while B commits HIGH. A fails with stale-model without rolling back HIGH', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { apiKey: '', cliPath: '/cli/a', model: LOW } } },
      { [AGY_CHAT_MODELS_KEY]: GEM },
    )
    let release: (value: { models: string[] }) => void = () => undefined
    let probes = 0
    catalogCall.mockImplementation(() => {
      probes += 1
      if (probes === 1)
        return new Promise((resolve) => {
          release = resolve
        })
      return Promise.resolve({ models: GEM })
    })
    const { call } = wire(p)
    // A takes snapshot when model is LOW, submits PRO (changing model from LOW to PRO)
    const generic = applySettingsWrite(
      {
        provider: 'agy',
        providers: {
          agy: { apiKey: '', cliPath: '/cli/a', model: PRO },
        },
      },
      () => JSON.parse(readFileSync(p.aiSettingsPath, 'utf8')) as AiSettings,
      (next) => writeFileSync(p.aiSettingsPath, JSON.stringify(next), 'utf8'),
      (cliPath: string | undefined) => catalogCall(cliPath),
      GEM,
    )
    // B commits HIGH while A is pending
    expect(await call(AGY_CHAT_CHANNELS.select, HIGH, true)).toBe(true)
    release({ models: GEM })
    const decision = await generic
    expect(decision.ok).toBe(false)
    expect(decision.reason).toBe('stale-model')
    const saved = readAi(p.aiSettingsPath)
    expect((saved.providers as Record<string, { model: string }>).agy.model).toBe(HIGH)
  })

  it('S2 (R4): Independent settings - A changes non-model settings while B commits HIGH. A succeeds preserving HIGH', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { apiKey: '', cliPath: '/cli/a', model: LOW } } },
      { [AGY_CHAT_MODELS_KEY]: GEM },
    )
    let release: (value: { models: string[] }) => void = () => undefined
    let probes = 0
    catalogCall.mockImplementation(() => {
      probes += 1
      if (probes === 1)
        return new Promise((resolve) => {
          release = resolve
        })
      return Promise.resolve({ models: GEM })
    })
    const { call } = wire(p)
    // the settings modal snapshot was taken while stored model was LOW; it keeps model: LOW unchanged
    const generic = applySettingsWrite(
      {
        provider: 'gemini',
        providers: {
          gemini: { apiKey: 'gk', model: 'gemini-2.5-flash' },
          agy: { apiKey: '', cliPath: '/cli/a', model: LOW },
        },
        maxOutputTokens: 2048,
      },
      () => JSON.parse(readFileSync(p.aiSettingsPath, 'utf8')) as AiSettings,
      (next) => writeFileSync(p.aiSettingsPath, JSON.stringify(next), 'utf8'),
      (cliPath: string | undefined) => catalogCall(cliPath),
      GEM,
    )
    // a newer, valid selection commits while the generic write is still validating
    expect(await call(AGY_CHAT_CHANNELS.select, HIGH, true)).toBe(true)
    release({ models: GEM })
    const decision = await generic
    expect(decision.ok).toBe(true)
    const saved = readAi(p.aiSettingsPath)
    expect(saved.provider).toBe('gemini')
    expect((saved.providers as Record<string, { model: string }>).agy.model).toBe(HIGH)
    expect(saved.maxOutputTokens).toBe(2048)
  })

  it('S3: CLI identity change - A validates against /cli/a while B changes configured CLI to /cli/b. A fails with conflict', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-s3-'))
    dirs.push(dir)
    const file = join(dir, 'ai-settings.json')
    writeFileSync(file, JSON.stringify(settingsOf(HIGH)), 'utf8')
    let release: (value: { models: string[] }) => void = () => undefined
    let probes = 0
    catalogCall.mockImplementation(() => {
      probes += 1
      if (probes === 1)
        return new Promise((resolve) => {
          release = resolve
        })
      return Promise.resolve({ models: GEM })
    })
    const decisionPromise = applySettingsWrite(
      {
        provider: 'agy',
        providers: {
          agy: { apiKey: '', cliPath: '/cli/a', model: LOW },
        },
      },
      () => JSON.parse(readFileSync(file, 'utf8')) as AiSettings,
      (next) => writeFileSync(file, JSON.stringify(next), 'utf8'),
      (cliPath: string | undefined) => catalogCall(cliPath),
      GEM,
    )
    // Concurrently B changes configured CLI to /cli/b
    writeFileSync(
      file,
      JSON.stringify({
        provider: 'agy',
        providers: {
          agy: { apiKey: '', cliPath: '/cli/b', model: HIGH },
        },
      }),
      'utf8',
    )
    release({ models: GEM })
    const decision = await decisionPromise
    expect(decision.ok).toBe(false)
    expect(decision.reason).toBe('conflict')
    expect(readAi(file).providers.agy.cliPath).toBe('/cli/b')
  })

  it('S4: Other provider settings - concurrent change to openai rejects conflict', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-s4-'))
    dirs.push(dir)
    const file = join(dir, 'ai-settings.json')
    writeFileSync(
      file,
      JSON.stringify({
        provider: 'agy',
        providers: {
          agy: { apiKey: '', cliPath: '/cli/a', model: HIGH },
          openai: { apiKey: 'key1', model: 'gpt-4o' },
        },
      }),
      'utf8',
    )
    let release: (value: { models: string[] }) => void = () => undefined
    let probes = 0
    catalogCall.mockImplementation(() => {
      probes += 1
      if (probes === 1)
        return new Promise((resolve) => {
          release = resolve
        })
      return Promise.resolve({ models: GEM })
    })
    const decisionPromise = applySettingsWrite(
      {
        provider: 'agy',
        providers: {
          agy: { apiKey: '', cliPath: '/cli/a', model: HIGH },
          openai: { apiKey: 'key-from-A', model: 'gpt-4o' },
        },
      },
      () => JSON.parse(readFileSync(file, 'utf8')) as AiSettings,
      (next) => writeFileSync(file, JSON.stringify(next), 'utf8'),
      (cliPath: string | undefined) => catalogCall(cliPath),
      GEM,
    )
    // Concurrently B updates openai apiKey to key-from-B
    writeFileSync(
      file,
      JSON.stringify({
        provider: 'agy',
        providers: {
          agy: { apiKey: '', cliPath: '/cli/a', model: HIGH },
          openai: { apiKey: 'key-from-B', model: 'gpt-4o' },
        },
      }),
      'utf8',
    )
    release({ models: GEM })
    const decision = await decisionPromise
    expect(decision.ok).toBe(false)
    expect(decision.reason).toBe('conflict')
    expect(readAi(file).providers.openai.apiKey).toBe('key-from-B')
  })

  it('R5: a process without the enabled-list policy cannot introduce a new AGY model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-guard-policy-'))
    dirs.push(dir)
    const file = join(dir, 'ai-settings.json')
    writeFileSync(file, JSON.stringify(settingsOf(HIGH)), 'utf8')
    catalogCall.mockImplementation(async () => ({ models: GEM }))
    const decision = await applySettingsWrite(
      settingsOf(PRO),
      () => JSON.parse(readFileSync(file, 'utf8')) as AiSettings,
      (next) => writeFileSync(file, JSON.stringify(next), 'utf8'),
      (cliPath: string | undefined) => catalogCall(cliPath),
      undefined,
      false,
    )
    expect(decision.ok).toBe(false)
    expect(decision.reason).toBe('unknown-policy')
    expect((readAi(file).providers as Record<string, { model: string }>).agy.model).toBe(HIGH)
    // unrelated settings still work through the same route
    const unrelated = await applySettingsWrite(
      { ...settingsOf(HIGH), maxOutputTokens: 4096 },
      () => JSON.parse(readFileSync(file, 'utf8')) as AiSettings,
      (next) => writeFileSync(file, JSON.stringify(next), 'utf8'),
      (cliPath: string | undefined) => catalogCall(cliPath),
      undefined,
      false,
    )
    expect(unrelated.ok).toBe(true)
    expect(readAi(file).maxOutputTokens).toBe(4096)
  })
})
