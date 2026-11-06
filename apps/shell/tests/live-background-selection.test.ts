import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('electron', () => ({ protocol: { handle: vi.fn() }, dialog: {} }))
vi.mock('../src/main/app-settings', () => ({
  readAppSettings: () => store.value,
  writeAppSettings: (_path: string, patch: Record<string, unknown>) => {
    store.value = { ...store.value, ...patch }
  },
}))

import { registerLiveBackground } from '../src/main/fork/live-background'
import { LIVE_BACKGROUND_CHANNELS } from '../src/shared/fork/live-background'

let dir = ''
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
  store.value = {}
})

describe('shared background selection', () => {
  it('persists the source and resolves opening media with Home switched off', async () => {
    dir = mkdtempSync(join(process.cwd(), 'background-selection-'))
    const path = join(dir, 'movie.mp4')
    writeFileSync(path, 'test')
    const handlers = new Map<string, (...args: never[]) => unknown>()
    const makeController = () =>
      registerLiveBackground({
        ipcMain: {
          handle: (channel, listener) => {
            handlers.set(channel, listener as (...args: never[]) => unknown)
          },
        },
        settingsPath: () => '',
        parentWindow: () => null,
        broadcast: () => {},
      })
    const controller = makeController()
    const call = (channel: string, ...args: unknown[]) =>
      (handlers.get(channel) as (...values: unknown[]) => Promise<unknown>)(null, ...args)
    await call(LIVE_BACKGROUND_CHANNELS.setPrefs, { sourcePath: path, openingEnabled: true })
    expect(store.value.liveBackground).toMatchObject({
      sourcePath: path,
      enabled: false,
      openingEnabled: true,
    })
    expect(controller.getSelectedSource('opening')?.kind).toBe('video')
    const restarted = makeController()
    await call(LIVE_BACKGROUND_CHANNELS.getState)
    expect(restarted.getSelectedSource('opening')?.kind).toBe('video')
    await call(LIVE_BACKGROUND_CHANNELS.setPrefs, { openingEnabled: false })
    expect(restarted.getSelectedSource('opening')).toBeNull()
    expect(store.value.liveBackground).toMatchObject({
      sourcePath: path,
      enabled: false,
      openingEnabled: false,
    })
  })
})
