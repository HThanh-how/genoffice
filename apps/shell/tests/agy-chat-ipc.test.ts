import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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
  while (dirs.length) {
    const dir = dirs.pop()!
    // a read-only settings directory would otherwise survive the cleanup
    try {
      chmodSync(dir, 0o755)
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        if (statSync(path).isDirectory()) chmodSync(path, 0o755)
      }
    } catch {
      // best effort
    }
    rmSync(dir, { recursive: true, force: true })
  }
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
  const call = (channel: string, arg?: unknown) => handlers.get(channel)!(undefined, arg)
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

/** a settings file that can be read but never rewritten: the directory is read-only */
function unwritableSettings(dir: string, name: string, content: Record<string, unknown>): string {
  const sub = join(dir, name)
  mkdirSync(sub)
  const path = join(sub, `${name}.json`)
  writeFileSync(path, JSON.stringify(content), 'utf8')
  chmodSync(sub, 0o555)
  return path
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
    const aiSettingsPath = unwritableSettings(dir, 'ai-settings', {
      provider: 'agy',
      providers: { agy: { model: 'gemini-3.8-flash-high' } },
    })
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
    // T9: no false success notification; T10: no silent re-selection
    expect(sent.length).toBe(0)
    // T7: the next read reports exactly what is on disk - both files back to the pre-mutation state
    expect(readApp(settingsPath)[AGY_CHAT_MODELS_KEY]).toEqual([
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-low',
    ])
    const state = await call(AGY_CHAT_CHANNELS.state)
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
    let release: (value: { models: string[] }) => void = () => undefined
    catalogCall.mockImplementation(() => new Promise((resolve) => (release = resolve)))
    const { call } = wire(p)
    const pending = call(AGY_CHAT_CHANNELS.select, 'gemini-3.1-pro-high')
    // the enabled list change happens while the other window's selection is still in flight
    expect(await call(AGY_CHAT_CHANNELS.setEnabled, ['gemini-3.8-flash-low'])).toEqual([
      'gemini-3.8-flash-low',
    ])
    release({ models: GEMINI_CATALOG })
    expect(await pending).toBe(false)
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const state = await call(AGY_CHAT_CHANNELS.state)
    expect(state.selected).toBe('gemini-3.8-flash-low')
    expect(readAi(p.aiSettingsPath).providers.agy.model).toBe('gemini-3.8-flash-low')
  })

  it('T6: when the rollback fails too, the failure is reported and the state read is honest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-chat-ipc-rollback-'))
    dirs.push(dir)
    const good = join(dir, 'app-settings.json')
    writeFileSync(
      good,
      JSON.stringify({ [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'] }),
      'utf8',
    )
    const blocked = join(dir, 'app-settings-blocked.json')
    mkdirSync(blocked)
    const aiSettingsPath = unwritableSettings(dir, 'ai-settings', {
      provider: 'agy',
      providers: { agy: { model: 'gemini-3.8-flash-high' } },
    })
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    const sent: Array<[string, unknown[]]> = []
    fakeWindow(sent)
    // the read and the first write succeed; the recovery write hits an unwritable path
    let calls = 0
    const { call } = wire({
      dir,
      settingsPath: () => {
        calls += 1
        // the recovery write is the third touch of the settings file, and it fails
        return calls === 3 ? blocked : good
      },
      aiSettingsPath,
      cachePath: join(dir, 'usage.json'),
    })
    expect(await call(AGY_CHAT_CHANNELS.setEnabled, ['gemini-3.8-flash-low'])).toBeNull()
    expect(sent.length).toBe(0)
    const state = await call(AGY_CHAT_CHANNELS.state)
    // detectable recovery condition: the stored selection is High while High is switched off
    expect(state.selected).toBe('gemini-3.8-flash-high')
    expect(
      state.models.find((m: { id: string }) => m.id === 'gemini-3.8-flash-high')?.enabled,
    ).toBe(false)
  })

  it('T8: after a failed mutation a restart reads a consistent, or clearly detectable, state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-chat-ipc-restart-'))
    dirs.push(dir)
    const settingsPath = join(dir, 'app-settings.json')
    writeFileSync(
      settingsPath,
      JSON.stringify({ [AGY_CHAT_MODELS_KEY]: ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'] }),
      'utf8',
    )
    const aiSettingsPath = unwritableSettings(dir, 'ai-settings', {
      provider: 'agy',
      providers: { agy: { model: 'gemini-3.8-flash-high' } },
    })
    catalogCall.mockImplementation(async () => ({ models: GEMINI_CATALOG }))
    let calls = 0
    const failing = wire({
      dir,
      settingsPath: () => {
        calls += 1
        // the recovery write is the third touch, and it fails
        return calls === 3 ? join(dir, 'blocked') : settingsPath
      },
      aiSettingsPath,
      cachePath: join(dir, 'usage.json'),
    })
    mkdirSync(join(dir, 'blocked'))
    expect(await failing.call(AGY_CHAT_CHANNELS.setEnabled, ['gemini-3.8-flash-low'])).toBeNull()
    const afterRestart = wire({
      dir,
      settingsPath,
      aiSettingsPath,
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
