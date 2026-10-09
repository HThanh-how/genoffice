import { describe, expect, it, vi } from 'vitest'
import { registerStorageStartup } from '../src/main/fork/storage-startup'
import {
  STORAGE_STARTUP_CHANNELS,
  isStorageStartupBusy,
  normalizeStorageStartupState,
} from '../src/shared/fork/storage-startup'

describe('storage start-up state (main side)', () => {
  function setup() {
    const handlers = new Map<string, () => unknown>()
    const send = vi.fn()
    const tracker = registerStorageStartup({
      ipcMain: { handle: (channel: string, fn: () => unknown) => void handlers.set(channel, fn) },
      send,
    })
    return { handlers, send, tracker }
  }

  it('starts as "checking" so a window that opens mid-migration already says so', () => {
    const { handlers } = setup()
    expect(handlers.get(STORAGE_STARTUP_CHANNELS.getState)!()).toEqual({
      phase: 'checking',
      percent: null,
    })
  })

  it('answers with the latest state and broadcasts only real changes', () => {
    const { handlers, send, tracker } = setup()
    tracker.set('migrating', 10)
    tracker.set('migrating', 10)
    tracker.set('migrating', 11)
    tracker.set('ready')
    expect(send.mock.calls.map((c) => c[1])).toEqual([
      { phase: 'migrating', percent: 10 },
      { phase: 'migrating', percent: 11 },
      { phase: 'ready', percent: null },
    ])
    expect(handlers.get(STORAGE_STARTUP_CHANNELS.getState)!()).toEqual({
      phase: 'ready',
      percent: null,
    })
  })
})

describe('storage start-up state (renderer side)', () => {
  it('knows which phases keep the banner up', () => {
    expect(isStorageStartupBusy({ phase: 'checking', percent: null })).toBe(true)
    expect(isStorageStartupBusy({ phase: 'migrating', percent: 3 })).toBe(true)
    expect(isStorageStartupBusy({ phase: 'finalizing', percent: null })).toBe(true)
    expect(isStorageStartupBusy({ phase: 'ready', percent: null })).toBe(false)
    expect(isStorageStartupBusy({ phase: 'unavailable', percent: null })).toBe(false)
  })

  it('normalises hostile or missing payloads to "nothing to show"', () => {
    expect(normalizeStorageStartupState(undefined)).toEqual({ phase: 'ready', percent: null })
    expect(normalizeStorageStartupState({ phase: 'bogus', percent: 'x' })).toEqual({
      phase: 'ready',
      percent: null,
    })
    expect(normalizeStorageStartupState({ phase: 'migrating', percent: 250.4 })).toEqual({
      phase: 'migrating',
      percent: 100,
    })
    expect(normalizeStorageStartupState({ phase: 'migrating', percent: -4 })).toEqual({
      phase: 'migrating',
      percent: 0,
    })
  })
})
