import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_INDEXING_MODE,
  DEFAULT_PAUSE_ON_BATTERY,
  INDEXING_MODE_CHANNELS,
  indexingModeFrom,
  pauseOnBatteryFrom,
  type IndexingModeState,
} from '../src/shared/fork/indexing-mode'
import { registerIndexingModeIpc } from '../src/main/fork/indexing-mode-controller'
import { publishIndexingPolicy, resetIndexingPolicyBus } from '../src/main/fork/indexing-policy-bus'
import {
  indexingModeKeys,
  indexingStateLine,
  indexingString,
} from '../src/renderer/src/fork/indexing-mode-strings'
import { INDEXING_MODES } from '../src/shared/fork/indexing-mode'

type Handler = (event: unknown, ...args: unknown[]) => unknown

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'indexing-mode-'))
  path = join(dir, 'app-settings.json')
  resetIndexingPolicyBus()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function register(onSettingsChanged = vi.fn()) {
  const handlers = new Map<string, Handler>()
  const controller = registerIndexingModeIpc({
    ipcMain: { handle: (channel: string, handler: Handler) => void handlers.set(channel, handler) },
    settingsPath: () => path,
    onSettingsChanged,
  })
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
  return { controller, call, onSettingsChanged }
}

describe('indexing settings', () => {
  it('defaults to Balanced with pause-on-battery on', () => {
    expect(DEFAULT_INDEXING_MODE).toBe('balanced')
    expect(DEFAULT_PAUSE_ON_BATTERY).toBe(true)
    expect(indexingModeFrom({})).toBe('balanced')
    expect(pauseOnBatteryFrom({})).toBe(true)
    const { controller, call } = register()
    expect(controller.settings()).toEqual({ mode: 'balanced', pauseOnBattery: true })
    expect(call(INDEXING_MODE_CHANNELS.getState)).toEqual({
      mode: 'balanced',
      pauseOnBattery: true,
      effective: null,
    })
  })

  it('ignores invalid stored values', () => {
    writeFileSync(path, JSON.stringify({ indexingMode: 'turbo', pauseIndexingOnBattery: 'yes' }))
    const { controller } = register()
    expect(controller.settings()).toEqual({ mode: 'balanced', pauseOnBattery: true })
  })

  it('reads stored values', () => {
    writeFileSync(path, JSON.stringify({ indexingMode: 'fast', pauseIndexingOnBattery: false }))
    expect(register().controller.settings()).toEqual({ mode: 'fast', pauseOnBattery: false })
  })

  it('persists changes next to the other app settings and notifies the monitor', () => {
    writeFileSync(path, JSON.stringify({ language: 'vi' }))
    const { call, controller, onSettingsChanged } = register()
    expect(call(INDEXING_MODE_CHANNELS.setMode, 'light')).toBe(true)
    expect(call(INDEXING_MODE_CHANNELS.setPauseOnBattery, false)).toBe(true)
    expect(controller.settings()).toEqual({ mode: 'light', pauseOnBattery: false })
    expect(onSettingsChanged).toHaveBeenCalledTimes(2)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      language: 'vi',
      indexingMode: 'light',
      pauseIndexingOnBattery: false,
    })
  })

  it('rejects invalid input without writing', () => {
    const { call, onSettingsChanged } = register()
    expect(call(INDEXING_MODE_CHANNELS.setMode, 'ludicrous')).toBe(false)
    expect(call(INDEXING_MODE_CHANNELS.setMode, undefined)).toBe(false)
    expect(call(INDEXING_MODE_CHANNELS.setPauseOnBattery, 'false')).toBe(false)
    expect(onSettingsChanged).not.toHaveBeenCalled()
  })

  it('keeps the old value when the settings file cannot be written', () => {
    const { call, controller } = register()
    path = join(dir, 'missing-folder', 'app-settings.json')
    expect(call(INDEXING_MODE_CHANNELS.setMode, 'fast')).toBe(false)
    expect(controller.settings().mode).toBe('balanced')
  })

  it('serves the live effective state', () => {
    const { call } = register()
    publishIndexingPolicy({
      paused: true,
      pauseReason: 'battery-saver',
      threads: 1,
      cpuShare: 0,
      priority: 'idle',
      tier: 'paused',
      reason: 'x',
      onBattery: true,
    })
    const state = call(INDEXING_MODE_CHANNELS.getState) as IndexingModeState
    expect(state.effective).toEqual({
      tier: 'paused',
      paused: true,
      pauseReason: 'battery-saver',
      threads: 1,
      cpuShare: 0,
      onBattery: true,
    })
  })
})

describe('indexing strings', () => {
  it('has a name and an explanation for every mode in every shipped language', () => {
    for (const lang of ['en', 'vi', 'zh', 'fr'] as const)
      for (const mode of INDEXING_MODES) {
        const keys = indexingModeKeys(mode)
        expect(indexingString(lang, keys.label).length).toBeGreaterThan(0)
        expect(indexingString(lang, keys.desc).length).toBeGreaterThan(10)
      }
  })

  it('uses natural Vietnamese for the mode names and the battery toggle', () => {
    expect(INDEXING_MODES.map((m) => indexingString('vi', indexingModeKeys(m).label))).toEqual([
      'Nhẹ',
      'Cân bằng',
      'Nhanh',
    ])
    expect(indexingString('vi', 'pauseBattery')).toBe('Tạm dừng khi dùng pin')
    expect(indexingString('en', 'pauseBattery')).toBe('Pause on battery')
  })

  it('falls back to English for languages without a table', () => {
    expect(indexingString('de', 'balanced')).toBe('Balanced')
    expect(indexingString('ja', 'pauseBattery')).toBe('Pause on battery')
  })

  const idle = {
    tier: 'idle',
    paused: false,
    threads: 4,
    cpuShare: 1,
    onBattery: false,
  } as const
  it('describes the effective state', () => {
    expect(indexingStateLine('vi', idle)).toBe(
      'Đang chạy nhanh (4 luồng) vì máy đang rảnh và cắm điện',
    )
    expect(indexingStateLine('en', idle, true)).toBe('Running fast (4 threads)')
    expect(
      indexingStateLine('vi', {
        tier: 'paused',
        paused: true,
        pauseReason: 'battery',
        threads: 1,
        cpuShare: 0,
        onBattery: true,
      }),
    ).toBe('Tạm dừng: đang dùng pin')
    expect(
      indexingStateLine(
        'en',
        {
          tier: 'paused',
          paused: true,
          pauseReason: 'battery',
          threads: 1,
          cpuShare: 0,
          onBattery: true,
        },
        true,
      ),
    ).toBe('Paused: on battery')
    expect(indexingStateLine('en', { ...idle, tier: 'light', threads: 1 }, true)).toBe(
      'Running quietly (1 thread)',
    )
    expect(indexingStateLine('en', { ...idle, tier: 'battery', threads: 1, onBattery: true })).toBe(
      'On battery: running on 1 thread to save power',
    )
  })

  it('covers every pause reason', () => {
    for (const pauseReason of [
      'battery',
      'low-battery',
      'battery-saver',
      'locked',
      'low-memory',
      'thermal',
      'user',
    ] as const)
      for (const lang of ['en', 'vi', 'zh'] as const)
        expect(
          indexingStateLine(lang, {
            tier: 'paused',
            paused: true,
            pauseReason,
            threads: 1,
            cpuShare: 0,
            onBattery: false,
          }),
        ).not.toMatch(/\{|undefined/)
  })
})
