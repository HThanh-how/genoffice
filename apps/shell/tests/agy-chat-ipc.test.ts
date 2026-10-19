import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { whenReady: () => new Promise(() => {}) },
  shell: { openExternal: () => undefined },
}))

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
})

function wire(p: { dir: string; settingsPath: string; aiSettingsPath: string; cachePath: string }) {
  const handlers = new Map<string, (event: unknown, arg?: unknown) => unknown>()
  registerAgyChat({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    settingsPath: () => p.settingsPath,
    aiSettingsPath: () => p.aiSettingsPath,
    cachePath: () => p.cachePath,
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
})
