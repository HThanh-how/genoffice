import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => windows },
  app: { whenReady: () => new Promise(() => {}) },
  shell: { openExternal: () => undefined },
}))

/** fake windows so the tests can see what the main process broadcasts */
const windows: Array<{
  isDestroyed: () => boolean
  webContents: { send: (channel: string, ...args: unknown[]) => void }
}> = []
function fakeWindow(sent: Array<[string, unknown[]]>): void {
  windows.push({
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, ...args: unknown[]) => sent.push([channel, args]),
    },
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
import { AGY_CHAT_MODELS_KEY, registerAgyChat } from '../src/main/fork/agy-chat-ipc'

const dirs: string[] = []
function paths(initialAi: Record<string, unknown> = {}, initialApp: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agy-chat-ipc-'))
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

type PathLike = string | (() => string)
function wire(p: {
  dir: string
  settingsPath: PathLike
  aiSettingsPath: PathLike
  cachePath: PathLike
}) {
  const of = (value: PathLike): (() => string) =>
    typeof value === 'function' ? value : () => value
  const handlers = new Map<string, (event: unknown, arg?: unknown) => unknown>()
  registerAgyChat({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    settingsPath: of(p.settingsPath),
    aiSettingsPath: of(p.aiSettingsPath),
    cachePath: of(p.cachePath),
  })
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(undefined, ...args)
  return { call, handlers }
}

const readAi = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

const GEMINI_CATALOG = [
  'gemini-3.8-flash-low',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-high',
  'gemini-3.1-pro-low',
  'gemini-3.1-pro-high',
]

describe('agy chat IPC: read-only state', () => {
  it('T01/T02: with no saved preference it defaults to High and enables every Gemini', async () => {
    const p = paths({ provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } })
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const { call } = wire(p)
    const state = await call(AGY_CHAT_CHANNELS.state)
    expect(state.selected).toBe('gemini-3.8-flash-high')
    expect(state.models.map((m: { id: string }) => m.id)).toEqual(GEMINI_CATALOG)
  })

  it('T01/T02: a settings file with no Antigravity model resolves High from the catalog', async () => {
    const p = paths({ provider: 'agy', providers: { agy: { cliPath: '' } } })
    const before = readFileSync(p.aiSettingsPath, 'utf8')
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const { call } = wire(p)
    const state = await call(AGY_CHAT_CHANNELS.state)
    expect(state.selected).toBe('gemini-3.8-flash-high')
    expect(state.selectedStatus).toBe('verified')
    expect(state.models.map((m: { id: string }) => m.id)).toEqual(GEMINI_CATALOG)
    // reading the chat state never writes a model into the settings
    expect(readFileSync(p.aiSettingsPath, 'utf8')).toBe(before)
  })

  it('T03: Claude and GPT are not enabled for an unset preference', async () => {
    const p = paths({ provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } })
    catalogCall.mockImplementation(async () => ({
      models: [...GEMINI_CATALOG, 'claude-sonnet-4-6', 'gpt-oss-120b-medium'],
    }))
    const { call } = wire(p)
    const state = await call(AGY_CHAT_CHANNELS.state)
    expect(state.models.map((m: { id: string }) => m.id)).toEqual(GEMINI_CATALOG)
  })

  it('T04/T05/T06/T07: a saved preference is preserved exactly', async () => {
    for (const saved of [
      ['gemini-3.8-flash-low'],
      ['gemini-3.1-pro-high'],
      ['claude-sonnet-4-6', 'gemini-3.8-flash-high'],
    ]) {
      const p = paths(
        { provider: 'agy', providers: { agy: { model: saved[0] } } },
        { [AGY_CHAT_MODELS_KEY]: saved },
      )
      catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
      const { call } = wire(p)
      const state = await call(AGY_CHAT_CHANNELS.state)
      expect(state.models.map((m: { id: string }) => m.id)).toEqual(saved)
      expect(state.selected).toBe(saved[0])
    }
  })

  it('T09: a catalog failure reports the error and writes nothing', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { model: 'gemini-3.1-pro-high' } } },
      { [AGY_CHAT_MODELS_KEY]: ['gemini-3.1-pro-high'] },
    )
    const before = readFileSync(p.aiSettingsPath, 'utf8')
    catalogCall.mockImplementation(async () => ({
      models: [],
      error: 'Timed out waiting for `agy models`',
    }))
    const { call } = wire(p)
    const state = await call(AGY_CHAT_CHANNELS.state)
    expect(state.selected).toBe('gemini-3.1-pro-high')
    expect(state.catalogError).toBe('Timed out waiting for `agy models`')
    expect(readFileSync(p.aiSettingsPath, 'utf8')).toBe(before)
  })

  it('T26: a corrupted saved list falls back to the seed without inventing availability', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } },
      { [AGY_CHAT_MODELS_KEY]: ['   ', 7, null] },
    )
    catalogCall.mockImplementation(async () => ({ models: [], error: 'agy not found' }))
    const { call } = wire(p)
    const state = await call(AGY_CHAT_CHANNELS.state)
    expect(state.models.map((m: { id: string }) => m.id)).toEqual(['gemini-3.8-flash-high'])
    expect(state.catalogError).toBe('agy not found')
  })

  it('T23: reading state for another provider does not touch the agy settings', async () => {
    const p = paths({ provider: 'gemini', providers: { agy: { model: 'gemini-3.1-pro-high' } } })
    const before = readFileSync(p.aiSettingsPath, 'utf8')
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const { call } = wire(p)
    const state = await call(AGY_CHAT_CHANNELS.state)
    expect(state.active).toBe(false)
    expect(readFileSync(p.aiSettingsPath, 'utf8')).toBe(before)
  })

  it('T22: the catalog is read through the configured CLI path', async () => {
    const p = paths({
      provider: 'agy',
      providers: { agy: { model: 'gemini-3.8-flash-high', cliPath: '/opt/agy/agy' } },
    })
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const { call } = wire(p)
    await call(AGY_CHAT_CHANNELS.state)
    expect(catalogCall).toHaveBeenCalledWith('/opt/agy/agy')
  })
})

describe('agy chat IPC: explicit mutations', () => {
  it('T12: disabling the selected model moves the selection to the first one still on', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } },
      { [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'] },
    )
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const { call } = wire(p)
    const next = await call(AGY_CHAT_CHANNELS.setEnabled, ['gemini-3.8-flash-low'])
    expect(next).toEqual(['gemini-3.8-flash-low'])
    expect(readAi(p.aiSettingsPath).providers.agy.model).toBe('gemini-3.8-flash-low')
  })

  it('T12: disabling a model that is not selected leaves the selection alone', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } },
      { [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'] },
    )
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const { call } = wire(p)
    await call(AGY_CHAT_CHANNELS.setEnabled, ['gemini-3.8-flash-high'])
    expect(readAi(p.aiSettingsPath).providers.agy.model).toBe('gemini-3.8-flash-high')
  })

  it('T13: enabling a Gemini model in Settings shows up in the chat state', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-low' } } },
      { [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-low'] },
    )
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const { call } = wire(p)
    await call(AGY_CHAT_CHANNELS.setEnabled, ['gemini-3.8-flash-low', 'gemini-3.1-pro-high'])
    const state = await call(AGY_CHAT_CHANNELS.state)
    expect(state.models.map((m: { id: string }) => m.id)).toEqual([
      'gemini-3.8-flash-low',
      'gemini-3.1-pro-high',
    ])
  })

  it('T14: selecting a model persists it and the next state read reports it', async () => {
    const p = paths({ provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } })
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const { call } = wire(p)
    for (const model of ['gemini-3.8-flash-low', 'gemini-3.8-flash-high', 'gemini-3.1-pro-high']) {
      expect(await call(AGY_CHAT_CHANNELS.select, model)).toBe(true)
      const state = await call(AGY_CHAT_CHANNELS.state)
      expect(state.selected).toBe(model)
      expect(readAi(p.aiSettingsPath).providers.agy.model).toBe(model)
    }
  })

  it('a model the user switched off cannot be selected', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-low' } } },
      { [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-low'] },
    )
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const { call } = wire(p)
    const before = readFileSync(p.aiSettingsPath, 'utf8')
    expect(await call(AGY_CHAT_CHANNELS.select, 'gemini-3.1-pro-high')).toBe(false)
    expect(readFileSync(p.aiSettingsPath, 'utf8')).toBe(before)
  })

  it('T11: a choice made while a catalog read is pending is not overwritten', async () => {
    const p = paths({ provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } })
    let resolveCatalog: (value: { models: string[] }) => void = () => undefined
    catalogCall.mockImplementation(
      () =>
        new Promise<{ models: string[] }>((resolve) => {
          resolveCatalog = resolve
        }),
    )
    const { call } = wire(p)

    // 1. a state read starts resolving the catalog
    const pendingState = call(AGY_CHAT_CHANNELS.state)
    // 2. the user changes the model while that read is in flight
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    await call(AGY_CHAT_CHANNELS.select, 'gemini-3.1-pro-high')
    // 3. the original catalog read completes
    resolveCatalog({ models: GEMINI_CATALOG })
    const state = await pendingState
    // 4. the newer preference survives
    expect(state.selected).toBe('gemini-3.1-pro-high')
    expect(readAi(p.aiSettingsPath).providers.agy.model).toBe('gemini-3.1-pro-high')
  })

  it('T15: a saved selection survives a reload of the handlers', async () => {
    const p = paths({ provider: 'agy', providers: { agy: { model: 'gemini-3.1-pro-high' } } })
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const first = wire(p)
    await first.call(AGY_CHAT_CHANNELS.select, 'gemini-3.1-pro-high')
    const second = wire(p)
    const state = await second.call(AGY_CHAT_CHANNELS.state)
    expect(state.selected).toBe('gemini-3.1-pro-high')
  })

  it('T36: a customized enabled list and selection survive a restart', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { model: 'gemini-3.1-pro-high' } } },
      { [AGY_CHAT_MODELS_KEY]: ['gemini-3.1-pro-high', 'claude-sonnet-4-6'] },
    )
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const state = await wire(p).call(AGY_CHAT_CHANNELS.state)
    expect(state.selected).toBe('gemini-3.1-pro-high')
    expect(state.models.map((m: { id: string }) => m.id)).toEqual([
      'gemini-3.1-pro-high',
      'claude-sonnet-4-6',
    ])
  })
})

describe('agy chat IPC: a stored choice is never silently replaced', () => {
  it('T40: saved High stays saved when the catalog no longer lists it', async () => {
    const p = paths({ provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } })
    const before = readFileSync(p.aiSettingsPath, 'utf8')
    catalogCall.mockImplementation(async () => ({ models: ['gemini-3.8-flash-low'] }))
    const { call } = wire(p)
    const state = await call(AGY_CHAT_CHANNELS.state)
    expect(state.selected).toBe('gemini-3.8-flash-high')
    expect(state.selectedStatus).toBe('unavailable')
    expect(state.available).toEqual(['gemini-3.8-flash-low'])
    expect(readFileSync(p.aiSettingsPath, 'utf8')).toBe(before)
  })

  it('T34: an unavailable selection is kept and reported, not swapped for a verified model', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { model: 'gemini-3.1-pro-high' } } },
      { [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-low'] },
    )
    catalogCall.mockImplementation(async () => ({ models: ['gemini-3.8-flash-low'] }))
    const state = await wire(p).call(AGY_CHAT_CHANNELS.state)
    expect(state.selected).toBe('gemini-3.1-pro-high')
    expect(state.selectedStatus).toBe('unavailable')
    expect(state.models.map((m: { id: string }) => m.id)).toEqual([
      'gemini-3.1-pro-high',
      'gemini-3.8-flash-low',
    ])
  })

  it('T39: a CLI that reports no Gemini advertises nothing and selects nothing', async () => {
    const p = paths({ provider: 'agy', providers: { agy: { cliPath: '/opt/agy' } } })
    catalogCall.mockImplementation(async () => ({
      models: ['claude-sonnet-4-6', 'gpt-oss-120b-medium'],
    }))
    const { call } = wire(p)
    const state = await call(AGY_CHAT_CHANNELS.state)
    expect(state.selected).toBe('')
    expect(state.selectedStatus).toBe('none')
    expect(state.models.map((m: { id: string }) => m.id)).toEqual([])
    expect(readAi(p.aiSettingsPath).providers.agy.model).toBeUndefined()
  })

  it('T10: a catalog that answered with an empty list is not read as "High exists"', async () => {
    const p = paths({ provider: 'agy', providers: { agy: {} } })
    catalogCall.mockImplementation(async () => ({ models: [] }))
    const state = await wire(p).call(AGY_CHAT_CHANNELS.state)
    expect(state.selected).toBe('')
    expect(state.selectedStatus).toBe('none')
  })
})

describe('agy chat IPC: notifications and races', () => {
  it('T19: enabling or disabling a model notifies every window, even when the selection is unchanged', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } },
      { [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'] },
    )
    const sent: Array<[string, unknown[]]> = []
    fakeWindow(sent)
    fakeWindow(sent)
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const { call } = wire(p)
    await call(AGY_CHAT_CHANNELS.setEnabled, ['gemini-3.8-flash-high'])
    expect(sent.map(([channel]) => channel)).toEqual([
      AGY_CHAT_CHANNELS.modelChanged,
      AGY_CHAT_CHANNELS.modelChanged,
    ])
  })

  it('T19: moving the selection when a model is switched off also notifies the settings listeners', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } },
      { [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'] },
    )
    const sent: Array<[string, unknown[]]> = []
    fakeWindow(sent)
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    await wire(p).call(AGY_CHAT_CHANNELS.setEnabled, ['gemini-3.8-flash-low'])
    expect(sent.map(([channel]) => channel)).toEqual([
      AGY_CHAT_CHANNELS.modelChanged,
      'ai:settings-changed',
    ])
  })

  it('T19: selecting a model notifies every window', async () => {
    const p = paths({ provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } })
    const sent: Array<[string, unknown[]]> = []
    fakeWindow(sent)
    fakeWindow(sent)
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    await wire(p).call(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-low')
    expect(sent.map(([channel]) => channel)).toEqual([
      AGY_CHAT_CHANNELS.modelChanged,
      'ai:settings-changed',
      AGY_CHAT_CHANNELS.modelChanged,
      'ai:settings-changed',
    ])
  })

  it('T20: two rapid selections leave the newer one in effect', async () => {
    const p = paths({ provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } })
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const { call } = wire(p)
    const first = call(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-low')
    const second = call(AGY_CHAT_CHANNELS.select, 'gemini-3.1-pro-high')
    await Promise.all([first, second])
    expect(readAi(p.aiSettingsPath).providers.agy.model).toBe('gemini-3.1-pro-high')
  })

  it('T21: an older selection request cannot undo a newer one', async () => {
    const p = paths({ provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } })
    let releaseSlow: (value: { models: string[] }) => void = () => undefined
    const slow = new Promise<{ models: string[] }>((resolve) => {
      releaseSlow = resolve
    })
    catalogCall.mockImplementation(() => slow)
    const { call } = wire(p)
    const older = call(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-low')
    // a newer request resolves immediately and lands first
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const newer = call(AGY_CHAT_CHANNELS.select, 'gemini-3.1-pro-high')
    await newer
    releaseSlow({ models: GEMINI_CATALOG })
    const olderOk = await older
    expect(olderOk).toBe(false)
    expect(readAi(p.aiSettingsPath).providers.agy.model).toBe('gemini-3.1-pro-high')
  })

  it('T22: a settings write that fails is reported as a failure, not as success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-chat-ipc-fail-'))
    dirs.push(dir)
    // both "settings files" are directories: every atomic write to them fails
    const aiSettingsPath = join(dir, 'ai-settings.json')
    const settingsPath = join(dir, 'app-settings.json')
    mkdirSync(aiSettingsPath)
    mkdirSync(settingsPath)
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const { call } = wire({
      dir,
      settingsPath,
      aiSettingsPath,
      cachePath: join(dir, 'usage.json'),
    })
    expect(await call(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-low')).toBe(false)
    expect(await call(AGY_CHAT_CHANNELS.setEnabled, ['gemini-3.8-flash-low'])).toBeNull()
  })
})

const readApp = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

/**
 * A settings path that behaves normally except on the `failOn`-th touch, which points at a
 * directory so the atomic write (rename onto a directory) fails on every platform.
 */
function flakyPath(dir: string, name: string, content: Record<string, unknown>, failFrom: number) {
  const good = join(dir, name)
  writeFileSync(good, JSON.stringify(content), 'utf8')
  const blocked = join(dir, `${name}-blocked`)
  mkdirSync(blocked)
  let calls = 0
  return () => {
    calls += 1
    // sticky: once the write route is blocked it stays blocked, so the test does
    // not depend on how many reads the handler makes before it writes
    return calls >= failFrom ? blocked : good
  }
}

describe('agy chat IPC: an enabled-list change is written consistently (T1-T10)', () => {
  it('T1: both writes land, the selection moves, and every window is told', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } },
      { [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'] },
    )
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const sent: Array<[string, unknown[]]> = []
    fakeWindow(sent)
    const { call } = wire(p)
    expect(await call(AGY_CHAT_CHANNELS.setEnabled, ['gemini-3.8-flash-low'])).toEqual([
      'gemini-3.8-flash-low',
    ])
    expect(readApp(p.settingsPath)[AGY_CHAT_MODELS_KEY]).toEqual(['gemini-3.8-flash-low'])
    expect(readAi(p.aiSettingsPath).providers.agy.model).toBe('gemini-3.8-flash-low')
    const state = await call(AGY_CHAT_CHANNELS.state)
    expect(state.selected).toBe('gemini-3.8-flash-low')
    expect(state.selectedStatus).toBe('verified')
    expect(sent.map(([channel]) => channel)).toEqual([
      AGY_CHAT_CHANNELS.modelChanged,
      'ai:settings-changed',
    ])
  })

  it('T2: when the enabled list cannot be written, nothing is reported and nothing is broadcast', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-chat-ipc-appfail-'))
    dirs.push(dir)
    const settingsPath = join(dir, 'app-settings.json')
    mkdirSync(settingsPath)
    const aiSettingsPath = join(dir, 'ai-settings.json')
    writeFileSync(
      aiSettingsPath,
      JSON.stringify({ provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } }),
      'utf8',
    )
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const sent: Array<[string, unknown[]]> = []
    fakeWindow(sent)
    const { call } = wire({
      dir,
      settingsPath,
      aiSettingsPath,
      cachePath: join(dir, 'usage.json'),
    })
    expect(await call(AGY_CHAT_CHANNELS.setEnabled, ['gemini-3.8-flash-low'])).toBeNull()
    // T9 and T10: no notification, and no model was chosen behind the person's back
    expect(sent.length).toBe(0)
    expect(readAi(aiSettingsPath).providers.agy.model).toBe('gemini-3.8-flash-high')
  })

  it('T3: when the selection write fails, the enabled list is rolled back and the call reports failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-chat-ipc-aifail-'))
    dirs.push(dir)
    const settingsPath = join(dir, 'app-settings.json')
    writeFileSync(
      settingsPath,
      JSON.stringify({ [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'] }),
      'utf8',
    )
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const sent: Array<[string, unknown[]]> = []
    fakeWindow(sent)
    const { call } = wire({
      dir,
      settingsPath,
      // the selection is read from the real file; the write that follows hits a directory
      aiSettingsPath: flakyPath(
        dir,
        'ai-settings.json',
        { provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } },
        3,
      ),
      cachePath: join(dir, 'usage.json'),
    })
    expect(await call(AGY_CHAT_CHANNELS.setEnabled, ['gemini-3.8-flash-low'])).toBeNull()
    // T9: no false success notification; T10: no model was chosen behind the person's back
    expect(sent.length).toBe(0)
    // T7: the enabled list is back to what was stored, so the two files agree
    expect(readApp(settingsPath)[AGY_CHAT_MODELS_KEY]).toEqual([
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-low',
    ])
    const after = wire({
      dir,
      settingsPath,
      aiSettingsPath: join(dir, 'ai-settings.json'),
      cachePath: join(dir, 'usage.json'),
    })
    const state = await after.call(AGY_CHAT_CHANNELS.state)
    expect(state.selected).toBe('gemini-3.8-flash-high')
    expect(
      state.models.find((m: { id: string }) => m.id === 'gemini-3.8-flash-high')?.enabled,
    ).toBe(true)
  })

  it('T4: two changes in a row leave the newest one consistently persisted', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } },
      { [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-high', 'gemini-3.1-pro-high'] },
    )
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const { call } = wire(p)
    await call(AGY_CHAT_CHANNELS.setEnabled, ['gemini-3.1-pro-high'])
    await call(AGY_CHAT_CHANNELS.setEnabled, ['gemini-3.8-flash-low'])
    const state = await call(AGY_CHAT_CHANNELS.state)
    expect(
      state.models.filter((m: { enabled: boolean }) => m.enabled).map((m: { id: string }) => m.id),
    ).toEqual(['gemini-3.8-flash-low'])
    expect(state.selected).toBe('gemini-3.8-flash-low')
    expect(readAi(p.aiSettingsPath).providers.agy.model).toBe('gemini-3.8-flash-low')
  })

  it('T5: a selection made in another window while the list change is pending is not lost', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } },
      {
        [AGY_CHAT_MODELS_KEY]: [
          'gemini-3.8-flash-high',
          'gemini-3.8-flash-low',
          'gemini-3.1-pro-high',
        ],
      },
    )
    const resolvers: Array<(value: { models: string[] }) => void> = []
    catalogCall.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)))
    const { call } = wire(p)
    const pending = call(AGY_CHAT_CHANNELS.select, 'gemini-3.1-pro-high')
    // the enabled list change happens while the other window's selection is still in flight
    const listChange = call(AGY_CHAT_CHANNELS.setEnabled, ['gemini-3.8-flash-low'])
    resolvers[1]({ models: GEMINI_CATALOG })
    expect(await listChange).toEqual(['gemini-3.8-flash-low'])
    resolvers[0]({ models: GEMINI_CATALOG })
    expect(await pending).toBe(false)
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const state = await call(AGY_CHAT_CHANNELS.state)
    expect(state.selected).toBe('gemini-3.8-flash-low')
    expect(readAi(p.aiSettingsPath).providers.agy.model).toBe('gemini-3.8-flash-low')
  })

  it('T6: when the rollback fails too, the failure is reported and the state read is honest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-chat-ipc-rollback-'))
    dirs.push(dir)
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const sent: Array<[string, unknown[]]> = []
    fakeWindow(sent)
    const { call } = wire({
      dir,
      // the first two touches succeed, the recovery write hits a directory
      settingsPath: flakyPath(
        dir,
        'app-settings.json',
        { [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'] },
        3,
      ),
      aiSettingsPath: flakyPath(
        dir,
        'ai-settings.json',
        { provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } },
        3,
      ),
      cachePath: join(dir, 'usage.json'),
    })
    expect(await call(AGY_CHAT_CHANNELS.setEnabled, ['gemini-3.8-flash-low'])).toBeNull()
    expect(sent.length).toBe(0)
    const after = wire({
      dir,
      settingsPath: join(dir, 'app-settings.json'),
      aiSettingsPath: join(dir, 'ai-settings.json'),
      cachePath: join(dir, 'usage.json'),
    })
    const state = await after.call(AGY_CHAT_CHANNELS.state)
    // detectable recovery condition: the stored selection is High while High is switched off
    expect(state.selected).toBe('gemini-3.8-flash-high')
    expect(
      state.models.find((m: { id: string }) => m.id === 'gemini-3.8-flash-high')?.enabled,
    ).toBe(false)
  })

  it('T8: after a failed mutation a restart reads a consistent, or clearly detectable, state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-chat-ipc-restart-'))
    dirs.push(dir)
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const failing = wire({
      dir,
      settingsPath: flakyPath(
        dir,
        'app-settings.json',
        { [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'] },
        3,
      ),
      aiSettingsPath: flakyPath(
        dir,
        'ai-settings.json',
        { provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } },
        3,
      ),
      cachePath: join(dir, 'usage.json'),
    })
    expect(await failing.call(AGY_CHAT_CHANNELS.setEnabled, ['gemini-3.8-flash-low'])).toBeNull()
    const afterRestart = wire({
      dir,
      settingsPath: join(dir, 'app-settings.json'),
      aiSettingsPath: join(dir, 'ai-settings.json'),
      cachePath: join(dir, 'usage.json'),
    })
    const state = await afterRestart.call(AGY_CHAT_CHANNELS.state)
    const enabledIds = state.models
      .filter((m: { enabled: boolean }) => m.enabled)
      .map((m: { id: string }) => m.id)
    const consistent = enabledIds.includes(state.selected)
    const detectable =
      state.selected &&
      state.models.find((m: { id: string }) => m.id === state.selected)?.enabled === false
    expect(consistent || detectable).toBe(true)
  })
})

describe('agy chat IPC: a new selection must be enabled and confirmed (A1-A12)', () => {
  it('A1/A12: a model that is enabled and confirmed by the CLI is selected', async () => {
    const p = paths({ provider: 'agy', providers: { agy: { model: '' } } })
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const { call } = wire(p)
    expect(await call(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-high')).toBe(true)
    expect(readAi(p.aiSettingsPath).providers.agy.model).toBe('gemini-3.8-flash-high')
  })

  it('A2/A8: an enabled model the current CLI no longer reports is refused', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } },
      { [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-high', 'gemini-3.1-pro-high'] },
    )
    const before = readFileSync(p.aiSettingsPath, 'utf8')
    catalogCall.mockImplementation(async () => ({ models: ['gemini-3.8-flash-high'] }))
    const sent: Array<[string, unknown[]]> = []
    fakeWindow(sent)
    const { call } = wire(p)
    expect(await call(AGY_CHAT_CHANNELS.select, 'gemini-3.1-pro-high')).toBe(false)
    expect(readFileSync(p.aiSettingsPath, 'utf8')).toBe(before)
    expect(sent.length).toBe(0)
  })

  it('A3/A4: a model the person switched off is refused even when the CLI has it', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } },
      { [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-high'] },
    )
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const { call } = wire(p)
    expect(await call(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-low')).toBe(false)
    catalogCall.mockImplementation(async () => ({ models: [] }))
    expect(await call(AGY_CHAT_CHANNELS.select, 'gemini-3.1-pro-high')).toBe(false)
  })

  it('A5: a saved model the CLI no longer reports is preserved by a state read', async () => {
    const p = paths({ provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } })
    catalogCall.mockImplementation(async () => ({ models: ['gemini-3.8-flash-low'] }))
    const { call } = wire(p)
    const state = await call(AGY_CHAT_CHANNELS.state)
    expect(state.selected).toBe('gemini-3.8-flash-high')
    expect(state.selectedStatus).toBe('unavailable')
  })

  it('A9: a catalog that changes while a selection is pending is the one that decides', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } },
      { [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-high', 'gemini-3.1-pro-high'] },
    )
    const before = readFileSync(p.aiSettingsPath, 'utf8')
    const { call } = wire(p)
    let release: (value: { models: string[]; error?: string }) => void = () => undefined
    catalogCall.mockImplementation(() => new Promise((resolve) => (release = resolve)))
    const pending = call(AGY_CHAT_CHANNELS.select, 'gemini-3.1-pro-high')
    // the CLI answers only after the request was made, and it no longer has that model
    release({ models: ['gemini-3.8-flash-high'] })
    expect(await pending).toBe(false)
    expect(readFileSync(p.aiSettingsPath, 'utf8')).toBe(before)
    // the same request for a model the newer catalog does report still works
    catalogCall.mockImplementation(async () => ({ models: ['gemini-3.8-flash-high'] }))
    expect(await call(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-high')).toBe(true)
  })

  it('A10: an explicitly enabled non-Gemini model the CLI reports is selectable', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } },
      { [AGY_CHAT_MODELS_KEY]: ['claude-sonnet-4-6'] },
    )
    catalogCall.mockImplementation(async () => ({
      models: ['claude-sonnet-4-6', 'gemini-3.8-flash-high'],
    }))
    const { call } = wire(p)
    expect(await call(AGY_CHAT_CHANNELS.select, 'claude-sonnet-4-6')).toBe(true)
  })

  it('A11: a failed catalog preserves the old settings and claims no verified availability', async () => {
    const p = paths({ provider: 'agy', providers: { agy: { model: 'gemini-3.8-flash-high' } } })
    const before = readFileSync(p.aiSettingsPath, 'utf8')
    catalogCall.mockImplementation(async () => ({ models: [], error: 'agy models timed out' }))
    const { call } = wire(p)
    expect(await call(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-low')).toBe(false)
    expect(readFileSync(p.aiSettingsPath, 'utf8')).toBe(before)
    const state = await call(AGY_CHAT_CHANNELS.state)
    expect(state.selectedStatus).toBe('unverified')
    expect(state.available).toEqual([])
  })
})

describe('agy chat IPC: CLI identity, atomic switches and enabled-list races (C1-C6, B1-B12, E1-E7)', () => {
  const GEM = ['gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'gemini-3.1-pro-high']

  it('C1: a catalog answer for CLI A cannot authorize a model after the path moved to B', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { cliPath: '/cli/a', model: '' } } },
      { [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-high'] },
    )
    let release: (value: { models: string[]; error?: string }) => void = () => undefined
    catalogCall.mockImplementation((cliPath: string | undefined) =>
      cliPath === '/cli/a'
        ? new Promise((resolve) => {
            release = resolve
          })
        : Promise.resolve({ models: ['gemini-3.8-flash-low'] }),
    )
    const { call } = wire(p)
    const pending = call(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-high')
    // the person points Antigravity at a different executable while the probe is in flight
    writeFileSync(
      p.aiSettingsPath,
      JSON.stringify({ provider: 'agy', providers: { agy: { cliPath: '/cli/b', model: '' } } }),
      'utf8',
    )
    release({ models: ['gemini-3.8-flash-high'] })
    expect(await pending).toBe(false)
    expect(readAi(p.aiSettingsPath).providers.agy.model).toBe('')
  })

  it('C2: a model confirmed by both CLIs is validated against the one configured now', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { cliPath: '/cli/a', model: '' } } },
      { [AGY_CHAT_MODELS_KEY]: GEM },
    )
    let release: (value: { models: string[] }) => void = () => undefined
    catalogCall.mockImplementation((cliPath: string | undefined) =>
      cliPath === '/cli/a'
        ? new Promise((resolve) => {
            release = resolve
          })
        : Promise.resolve({ models: ['gemini-3.8-flash-high'] }),
    )
    const { call } = wire(p)
    const pending = call(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-high')
    writeFileSync(
      p.aiSettingsPath,
      JSON.stringify({ provider: 'agy', providers: { agy: { cliPath: '/cli/b', model: '' } } }),
      'utf8',
    )
    release({ models: GEM })
    expect(await pending).toBe(true)
    expect(readAi(p.aiSettingsPath).providers.agy.model).toBe('gemini-3.8-flash-high')
  })

  it('C3: A -> B -> A does not let the first, stale A answer win', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { cliPath: '/cli/a', model: '' } } },
      { [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-high'] },
    )
    let releaseFirst: (value: { models: string[] }) => void = () => undefined
    let probes = 0
    catalogCall.mockImplementation(() => {
      probes += 1
      if (probes === 1)
        return new Promise((resolve) => {
          releaseFirst = resolve
        })
      return Promise.resolve({ models: [] as string[], error: 'the CLI changed' })
    })
    const { call } = wire(p)
    const pending = call(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-high')
    writeFileSync(
      p.aiSettingsPath,
      JSON.stringify({ provider: 'agy', providers: { agy: { cliPath: '/cli/b', model: '' } } }),
      'utf8',
    )
    writeFileSync(
      p.aiSettingsPath,
      JSON.stringify({ provider: 'agy', providers: { agy: { cliPath: '/cli/a', model: '' } } }),
      'utf8',
    )
    releaseFirst({ models: ['gemini-3.8-flash-high'] })
    // the path is A again, so the answer for A is applicable; nothing from the intermediate
    // CLI (which reports a different model) ever authorized the choice
    expect(await pending).toBe(true)
    expect(readAi(p.aiSettingsPath).providers.agy.model).toBe('gemini-3.8-flash-high')
    expect(probes).toBe(1)
  })

  it('C4: a failed catalog for the new CLI leaves no stale selectable model behind', async () => {
    const p = paths(
      {
        provider: 'agy',
        providers: { agy: { cliPath: '/cli/a', model: 'gemini-3.8-flash-high' } },
      },
      { [AGY_CHAT_MODELS_KEY]: GEM },
    )
    catalogCall.mockImplementation(async (cliPath: string | undefined) =>
      cliPath === '/cli/a' ? { models: GEM } : { models: [], error: 'not installed' },
    )
    const { call } = wire(p)
    expect(await call(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-low')).toBe(true)
    writeFileSync(
      p.aiSettingsPath,
      JSON.stringify({
        provider: 'agy',
        providers: { agy: { cliPath: '/cli/b', model: 'gemini-3.8-flash-low' } },
      }),
      'utf8',
    )
    const state = await call(AGY_CHAT_CHANNELS.state)
    expect(state.catalogError).toBe('not installed')
    expect(state.available).toEqual([])
    expect(state.selected).toBe('gemini-3.8-flash-low')
    expect(state.selectedStatus).toBe('unverified')
    expect(await call(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-high')).toBe(false)
  })

  it('C5: a selection and a CLI change in the same tick stay attributable to one identity', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { cliPath: '/cli/a', model: '' } } },
      { [AGY_CHAT_MODELS_KEY]: GEM },
    )
    catalogCall.mockImplementation(async (cliPath: string | undefined) => ({
      models: cliPath === '/cli/a' ? ['gemini-3.8-flash-high'] : ['gemini-3.8-flash-low'],
    }))
    const { call } = wire(p)
    const select = call(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-high')
    writeFileSync(
      p.aiSettingsPath,
      JSON.stringify({ provider: 'agy', providers: { agy: { cliPath: '/cli/b', model: '' } } }),
      'utf8',
    )
    expect(await select).toBe(false)
    expect(readAi(p.aiSettingsPath).providers.agy.model).toBe('')
  })

  it('B1/B2: a provider switch is one atomic write of provider and model', async () => {
    const p = paths(
      {
        provider: 'gemini',
        providers: {
          gemini: { apiKey: 'gk', model: 'gemini-2.5-flash' },
          agy: { cliPath: '/cli/a', model: '' },
        },
      },
      { [AGY_CHAT_MODELS_KEY]: GEM },
    )
    catalogCall.mockImplementation(async () => ({ models: GEM }))
    const sent: Array<[string, unknown[]]> = []
    fakeWindow(sent)
    const { call } = wire(p)
    expect(await call(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-high', true)).toBe(true)
    const saved = readAi(p.aiSettingsPath)
    expect(saved.provider).toBe('agy')
    expect(saved.providers.agy.model).toBe('gemini-3.8-flash-high')
    expect(saved.providers.gemini).toEqual({ apiKey: 'gk', model: 'gemini-2.5-flash' })
    expect(sent.map(([channel]) => channel)).toEqual([
      AGY_CHAT_CHANNELS.modelChanged,
      'ai:settings-changed',
    ])
  })

  it('B3/B4: a refused model leaves provider and model exactly as they were', async () => {
    const p = paths(
      {
        provider: 'gemini',
        providers: {
          gemini: { apiKey: 'gk', model: 'gemini-2.5-flash' },
          agy: { cliPath: '/cli/a', model: '' },
        },
      },
      { [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-low'] },
    )
    catalogCall.mockImplementation(async () => ({ models: GEM }))
    const sent: Array<[string, unknown[]]> = []
    fakeWindow(sent)
    const { call } = wire(p)
    expect(await call(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-high', true)).toBe(false)
    const saved = readAi(p.aiSettingsPath)
    expect(saved.provider).toBe('gemini')
    expect(saved.providers.agy.model).toBe('')
    expect(sent.length).toBe(0)
  })

  it('B5: a failed atomic write keeps the previously committed provider and model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-chat-ipc-atomicfail-'))
    dirs.push(dir)
    const settingsPath = join(dir, 'app-settings.json')
    writeFileSync(settingsPath, JSON.stringify({ [AGY_CHAT_MODELS_KEY]: GEM }), 'utf8')
    catalogCall.mockImplementation(async () => ({ models: GEM }))
    const sent: Array<[string, unknown[]]> = []
    fakeWindow(sent)
    const { call } = wire({
      dir,
      settingsPath,
      aiSettingsPath: flakyPath(
        dir,
        'ai-settings.json',
        {
          provider: 'gemini',
          providers: {
            gemini: { apiKey: 'gk', model: 'gemini-2.5-flash' },
            agy: { cliPath: '/cli/a', model: 'gemini-3.8-flash-low' },
          },
        },
        2,
      ),
      cachePath: join(dir, 'usage.json'),
    })
    expect(await call(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-high', true)).toBe(false)
    expect(sent.length).toBe(0)
  })

  it('B6: an older in-flight selection cannot overwrite a newer one', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { cliPath: '/cli/a', model: 'gemini-3.8-flash-low' } } },
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
    const slow = paths(
      {
        provider: 'agy',
        providers: { agy: { cliPath: '/cli/slow', model: 'gemini-3.8-flash-low' } },
      },
      { [AGY_CHAT_MODELS_KEY]: GEM },
    )
    const { call } = wire(slow)
    const older = call(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-high')
    // a newer selection lands while the first catalog is still in flight
    expect(await call(AGY_CHAT_CHANNELS.select, 'gemini-3.1-pro-high')).toBe(true)
    release({ models: GEM })
    expect(await older).toBe(false)
    expect(readAi(slow.aiSettingsPath).providers.agy.model).toBe('gemini-3.1-pro-high')
    void p
  })

  it('B7: two windows selecting different models end on one real commit', async () => {
    const p = paths(
      {
        provider: 'gemini',
        providers: {
          gemini: { apiKey: 'gk', model: 'gemini-2.5-flash' },
          agy: { cliPath: '/cli/a', model: '' },
        },
      },
      { [AGY_CHAT_MODELS_KEY]: GEM },
    )
    catalogCall.mockImplementation(async () => ({ models: GEM }))
    const { call } = wire(p)
    const a = call(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-high', true)
    const b = call(AGY_CHAT_CHANNELS.select, 'gemini-3.1-pro-high', true)
    await Promise.all([a, b])
    const saved = readAi(p.aiSettingsPath)
    expect(saved.provider).toBe('agy')
    expect(['gemini-3.8-flash-high', 'gemini-3.1-pro-high']).toContain(saved.providers.agy.model)
  })

  it('C6: the catalog is read through the configured CLI, and through auto-detect when none is set', async () => {
    const configured = paths(
      { provider: 'agy', providers: { agy: { cliPath: '/cli/a', model: '' } } },
      { [AGY_CHAT_MODELS_KEY]: GEM },
    )
    catalogCall.mockImplementation(async (cliPath: string | undefined) => ({
      models: cliPath === '/cli/a' ? ['gemini-3.8-flash-high'] : [],
    }))
    const { call: callConfigured } = wire(configured)
    expect(await callConfigured(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-high')).toBe(true)
    expect(catalogCall.mock.calls.map(([cliPath]) => cliPath)).toEqual(['/cli/a'])

    catalogCall.mockReset()
    catalogCall.mockImplementation(async (cliPath: string | undefined) => ({
      models: cliPath === undefined ? ['gemini-3.8-flash-high'] : [],
    }))
    const auto = paths(
      { provider: 'agy', providers: { agy: { cliPath: '   ', model: '' } } },
      {
        [AGY_CHAT_MODELS_KEY]: GEM,
      },
    )
    const { call: callAuto } = wire(auto)
    expect(await callAuto(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-high')).toBe(true)
    expect(catalogCall.mock.calls.map(([cliPath]) => cliPath)).toEqual([undefined])
  })

  it('C7: a catalog retaken for an intermediate CLI cannot authorize a model for the CLI configured at commit time', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { cliPath: '/cli/a', model: '' } } },
      { [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-high', 'gemini-3.1-pro-high'] },
    )
    let releaseFirst: (value: { models: string[] }) => void = () => undefined
    let releaseSecond: (value: { models: string[] }) => void = () => undefined
    let probes = 0
    catalogCall.mockImplementation(() => {
      probes += 1
      if (probes === 1)
        return new Promise((resolve) => {
          releaseFirst = resolve
        })
      return new Promise((resolve) => {
        releaseSecond = resolve
      })
    })
    const { call } = wire(p)
    const pending = call(AGY_CHAT_CHANNELS.select, 'gemini-3.1-pro-high')
    // A is probed, the person switches to B, and switches back to A while B's probe is still open
    writeFileSync(
      p.aiSettingsPath,
      JSON.stringify({ provider: 'agy', providers: { agy: { cliPath: '/cli/b', model: '' } } }),
      'utf8',
    )
    releaseFirst({ models: ['gemini-3.1-pro-high'] })
    // let the handler notice the path moved and start the probe for B before moving it back
    await Promise.resolve()
    writeFileSync(
      p.aiSettingsPath,
      JSON.stringify({ provider: 'agy', providers: { agy: { cliPath: '/cli/a', model: '' } } }),
      'utf8',
    )
    releaseSecond({ models: ['gemini-3.1-pro-high'] })
    // the answer that finally arrives belongs to B, not to the A that is configured now
    expect(await pending).toBe(false)
    expect(readAi(p.aiSettingsPath).providers.agy.model).toBe('')
    expect(probes).toBe(2)
  })

  it('B8: after a successful switch a fresh process reads back the same committed pair', async () => {
    const p = paths(
      {
        provider: 'gemini',
        providers: {
          gemini: { apiKey: 'gk', model: 'gemini-2.5-flash' },
          agy: { cliPath: '/cli/a', model: '' },
        },
      },
      { [AGY_CHAT_MODELS_KEY]: GEM },
    )
    catalogCall.mockImplementation(async () => ({ models: GEM }))
    const first = wire(p)
    expect(await first.call(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-high', true)).toBe(true)
    // a new process registers the handlers again and reads the same files
    const second = wire(p)
    const state = await second.call(AGY_CHAT_CHANNELS.state)
    expect(state.active).toBe(true)
    expect(state.selected).toBe('gemini-3.8-flash-high')
    expect(state.selectedStatus).toBe('verified')
  })

  it('B9: after a failed switch a fresh process reads back the previous committed pair', async () => {
    const p = paths(
      {
        provider: 'gemini',
        providers: {
          gemini: { apiKey: 'gk', model: 'gemini-2.5-flash' },
          agy: { cliPath: '/cli/a', model: 'gemini-3.8-flash-low' },
        },
      },
      { [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-low'] },
    )
    catalogCall.mockImplementation(async () => ({ models: GEM }))
    const first = wire(p)
    expect(await first.call(AGY_CHAT_CHANNELS.select, 'gemini-3.1-pro-high', true)).toBe(false)
    const second = wire(p)
    const state = await second.call(AGY_CHAT_CHANNELS.state)
    expect(state.active).toBe(false)
    expect(readAi(p.aiSettingsPath).provider).toBe('gemini')
    expect(readAi(p.aiSettingsPath).providers.agy.model).toBe('gemini-3.8-flash-low')
  })

  it('B10: every window is told only after the new settings are durable on disk', async () => {
    const p = paths(
      { provider: 'gemini', providers: { agy: { cliPath: '/cli/a', model: '' } } },
      { [AGY_CHAT_MODELS_KEY]: GEM },
    )
    catalogCall.mockImplementation(async () => ({ models: GEM }))
    const snapshots: string[] = []
    windows.push({
      isDestroyed: () => false,
      webContents: {
        send: (channel: string) => {
          if (channel === 'ai:settings-changed')
            snapshots.push(readFileSync(p.aiSettingsPath, 'utf8'))
        },
      },
    })
    const { call } = wire(p)
    expect(await call(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-high', true)).toBe(true)
    expect(snapshots.length).toBe(1)
    const announced = JSON.parse(snapshots[0]!) as {
      provider?: string
      providers?: Record<string, { model?: string }>
    }
    expect(announced.provider).toBe('agy')
    expect(announced.providers?.agy?.model).toBe('gemini-3.8-flash-high')
  })

  it('B11: a rejected switch broadcasts nothing, so no window is told a success happened', async () => {
    const p = paths(
      { provider: 'gemini', providers: { agy: { cliPath: '/cli/a', model: '' } } },
      { [AGY_CHAT_MODELS_KEY]: GEM },
    )
    catalogCall.mockImplementation(async () => ({ models: [], error: 'agy models timed out' }))
    const sent: Array<[string, unknown[]]> = []
    fakeWindow(sent)
    const { call } = wire(p)
    expect(await call(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-high', true)).toBe(false)
    expect(sent).toEqual([])
  })

  it('B12: an atomic switch leaves every unrelated setting byte-for-byte intact', async () => {
    const p = paths(
      {
        provider: 'gemini',
        maxOutputTokens: 8192,
        gskToolsEnabled: true,
        customEndpoints: [
          {
            id: 'local',
            name: 'Local',
            baseUrl: 'http://127.0.0.1:8000',
            apiKey: 'k',
            model: 'm1',
          },
        ],
        media: { providers: { image: { baseUrl: 'https://img.example', apiKey: 'mk' } } },
        search: { provider: 'agy', providers: { agy: { apiKey: '', model: 'search-model' } } },
        providers: {
          openai: { apiKey: 'sk-openai', model: 'gpt-5' },
          gemini: { apiKey: 'gk', model: 'gemini-2.5-flash' },
          agy: { apiKey: '', cliPath: '/cli/a', model: '' },
        },
      },
      { [AGY_CHAT_MODELS_KEY]: GEM },
    )
    catalogCall.mockImplementation(async () => ({ models: GEM }))
    const { call } = wire(p)
    expect(await call(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-high', true)).toBe(true)
    const saved = readAi(p.aiSettingsPath)
    expect(saved.maxOutputTokens).toBe(8192)
    expect(saved.gskToolsEnabled).toBe(true)
    expect(saved.customEndpoints).toEqual([
      { id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:8000', apiKey: 'k', model: 'm1' },
    ])
    expect(saved.search).toEqual({
      provider: 'agy',
      providers: { agy: { apiKey: '', model: 'search-model' } },
    })
    expect(saved.providers.openai).toEqual({ apiKey: 'sk-openai', model: 'gpt-5' })
    expect(saved.providers.gemini).toEqual({ apiKey: 'gk', model: 'gemini-2.5-flash' })
    expect(saved.providers.agy.cliPath).toBe('/cli/a')
  })

  it('E7: a stale selection request cannot undo a newer enabled-list change', async () => {
    const p = paths(
      {
        provider: 'agy',
        providers: { agy: { cliPath: '/cli/a', model: 'gemini-3.8-flash-high' } },
      },
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
    const stale = call(AGY_CHAT_CHANNELS.select, 'gemini-3.1-pro-high')
    // a newer, legitimate toggle turns High off and moves the selection to Low
    expect(await call(AGY_CHAT_CHANNELS.setEnabled, ['gemini-3.8-flash-low'])).toEqual([
      'gemini-3.8-flash-low',
    ])
    release({ models: GEM })
    expect(await stale).toBe(false)
    expect(readAi(p.aiSettingsPath).providers.agy.model).toBe('gemini-3.8-flash-low')
    expect(readApp(p.settingsPath)[AGY_CHAT_MODELS_KEY]).toEqual(['gemini-3.8-flash-low'])
  })

  it('E1/E2: concurrent enabled-list toggles never leave the selection outside the list', async () => {
    const p = paths(
      {
        provider: 'agy',
        providers: { agy: { cliPath: '/cli/a', model: 'gemini-3.8-flash-high' } },
      },
      { [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'] },
    )
    catalogCall.mockImplementation(async () => ({ models: GEM }))
    const { call } = wire(p)
    const first = call(AGY_CHAT_CHANNELS.setEnabled, ['gemini-3.8-flash-low'])
    const second = call(AGY_CHAT_CHANNELS.setEnabled, ['gemini-3.1-pro-high'])
    await Promise.all([first, second])
    const enabled = readApp(p.settingsPath)[AGY_CHAT_MODELS_KEY]
    const selected = readAi(p.aiSettingsPath).providers.agy.model
    expect(enabled).toEqual(['gemini-3.1-pro-high'])
    expect(enabled).toContain(selected)
  })

  it('E3: switching off the selected model moves it to a confirmed one', async () => {
    const p = paths(
      {
        provider: 'agy',
        providers: { agy: { cliPath: '/cli/a', model: 'gemini-3.8-flash-high' } },
      },
      { [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'] },
    )
    catalogCall.mockImplementation(async () => ({ models: GEM }))
    const { call } = wire(p)
    expect(await call(AGY_CHAT_CHANNELS.setEnabled, ['gemini-3.8-flash-low'])).toEqual([
      'gemini-3.8-flash-low',
    ])
    expect(readAi(p.aiSettingsPath).providers.agy.model).toBe('gemini-3.8-flash-low')
  })

  it('E4: with no confirmed replacement the toggle is not half-applied', async () => {
    const p = paths(
      {
        provider: 'agy',
        providers: { agy: { cliPath: '/cli/a', model: 'gemini-3.8-flash-high' } },
      },
      { [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'] },
    )
    catalogCall.mockImplementation(async () => ({ models: [], error: 'agy models timed out' }))
    const sent: Array<[string, unknown[]]> = []
    fakeWindow(sent)
    const { call } = wire(p)
    expect(await call(AGY_CHAT_CHANNELS.setEnabled, ['gemini-3.8-flash-low'])).toBeNull()
    expect(readApp(p.settingsPath)[AGY_CHAT_MODELS_KEY]).toEqual([
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-low',
    ])
    expect(readAi(p.aiSettingsPath).providers.agy.model).toBe('gemini-3.8-flash-high')
    expect(sent.length).toBe(0)
  })

  it('E5: a catalog failure never disables a model the person had enabled', async () => {
    const p = paths(
      {
        provider: 'agy',
        providers: { agy: { cliPath: '/cli/a', model: 'gemini-3.8-flash-high' } },
      },
      { [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-high'] },
    )
    catalogCall.mockImplementation(async () => ({ models: [], error: 'timeout' }))
    const { call } = wire(p)
    expect(await call(AGY_CHAT_CHANNELS.setEnabled, ['gemini-3.8-flash-high'])).toEqual([
      'gemini-3.8-flash-high',
    ])
    expect(readApp(p.settingsPath)[AGY_CHAT_MODELS_KEY]).toEqual(['gemini-3.8-flash-high'])
    expect(readAi(p.aiSettingsPath).providers.agy.model).toBe('gemini-3.8-flash-high')
  })

  it('E6: rapid operations on the same settings path stay consistent', async () => {
    const p = paths(
      { provider: 'agy', providers: { agy: { cliPath: '/cli/a', model: '' } } },
      { [AGY_CHAT_MODELS_KEY]: [] },
    )
    catalogCall.mockImplementation(async () => ({ models: GEM }))
    const { call } = wire(p)
    const ops = [
      call(AGY_CHAT_CHANNELS.setEnabled, ['gemini-3.8-flash-high']),
      call(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-high'),
      call(AGY_CHAT_CHANNELS.setEnabled, ['gemini-3.8-flash-high', 'gemini-3.8-flash-low']),
      call(AGY_CHAT_CHANNELS.select, 'gemini-3.8-flash-low'),
    ]
    await Promise.all(ops)
    const saved = readAi(p.aiSettingsPath)
    const enabled = readApp(p.settingsPath)[AGY_CHAT_MODELS_KEY]
    expect(enabled).toEqual(['gemini-3.8-flash-high', 'gemini-3.8-flash-low'])
    expect(enabled).toContain(saved.providers.agy.model)
  })
})
