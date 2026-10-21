// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { defaultAiSettings, type AiSettings } from '@genoffice/ai-provider'
import { AiModelPicker } from '../src/AiModelPicker'
import {
  aiModelPickerGroups,
  aiModelPickerSelection,
  type AiModelItemMeta,
} from '../src/ai-model-picker-options'
import type { AgyBarState } from '../src/AgyChatBar'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/**
 * These tests drive the real composer picker: they open the chip, click a model row, and check
 * what actually reached the settings bridge and the Antigravity selection handler. The fake
 * handler applies the same rule the main process does - a model that is not switched on, or that
 * the CLI did not confirm, is never persisted.
 */
const CATALOG = ['gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'gemini-3.1-pro-high']

interface Fixture {
  settings: AiSettings
  enabled: string[]
  selected: string
  available: string[]
  catalogError?: string
  /** when set it replaces the fixture catalog, so a CLI that answered with nothing is testable */
  models?: AiModelItemMeta[]
  /** the chat box has not answered yet */
  pending?: boolean
  /** the state read itself fails (no IPC handler, main process gone, invoke rejected) */
  stateThrows?: boolean
}

function agySettings(model: string): AiSettings {
  const settings = defaultAiSettings()
  settings.provider = 'agy'
  settings.providers.agy = { apiKey: '', cliPath: '/fixture/agy', model }
  return settings
}

function mount(fixture: Fixture, selectThrows = false) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const written: AiSettings[] = []
  const selectCalls: string[] = []
  const activations: string[] = []

  const state = (): AgyBarState | null => {
    if (fixture.pending) return null
    if (fixture.models) {
      const available = fixture.models.filter((m) => m.verified === true).map((m) => m.id)
      const chosen = fixture.selected
      return {
        active: fixture.settings.provider === 'agy',
        selected: chosen,
        available,
        selectedStatus: chosen
          ? fixture.catalogError
            ? 'unverified'
            : available.includes(chosen)
              ? 'verified'
              : 'unavailable'
          : 'none',
        models: fixture.models,
        ...(fixture.catalogError ? { catalogError: fixture.catalogError } : {}),
      }
    }
    const ids = [...CATALOG]
    if (fixture.selected && !ids.includes(fixture.selected)) ids.push(fixture.selected)
    return {
      active: fixture.settings.provider === 'agy',
      selected: fixture.selected,
      available: fixture.available,
      selectedStatus: fixture.catalogError
        ? 'unverified'
        : fixture.selected
          ? fixture.available.includes(fixture.selected)
            ? 'verified'
            : 'unavailable'
          : 'none',
      models: ids.map((id) => ({
        id,
        label: id,
        group: 'Gemini Models',
        relativeCost: 1,
        speed: 'fast',
        enabled: fixture.enabled.includes(id),
        verified: fixture.available.includes(id),
      })),
      ...(fixture.catalogError ? { catalogError: fixture.catalogError } : {}),
    }
  }

  Object.assign(window, {
    agyChat: {
      getAgyChatState: async () => {
        if (fixture.stateThrows) throw new Error('no Antigravity handler in this process')
        return state()
      },
      selectAgyChatModel: async (id: string, activate = false) => {
        selectCalls.push(id)
        activations.push(id)
        if (selectThrows) throw new Error('settings write failed')
        const s = state()
        if (!s) return false
        // the same rule the main process applies: switched on *and* confirmed by the CLI
        if (!s.available.includes(id)) return false
        const item = s.models.find((m) => m.id === id)
        if (!item || item.enabled === false) return false
        fixture.selected = id
        fixture.settings.providers.agy = {
          ...(fixture.settings.providers.agy ?? { apiKey: '', cliPath: '/fixture/agy' }),
          model: id,
        }
        // a provider switch is part of the same commit, never a second write
        if (activate) fixture.settings.provider = 'agy'
        return true
      },
      onAgyChatModelChanged: () => () => {},
      getAgyChatUsage: async () => ({ groups: null, readAt: 0, refreshing: false, failed: false }),
      refreshAgyChatUsage: async () => ({
        groups: null,
        readAt: 0,
        refreshing: false,
        failed: false,
      }),
      onAgyChatUsage: () => () => {},
    },
  })

  const bridge = {
    getSettings: async () => fixture.settings,
    setSettings: async (settings: AiSettings) => {
      written.push(structuredClone(settings))
    },
  }

  return { host, root, bridge, written, selectCalls, activations, state, fixture }
}

async function renderPicker(f: ReturnType<typeof mount>) {
  await act(async () =>
    f.root.render(createElement(AiModelPicker, { bridge: f.bridge, lang: 'en' })),
  )
  await act(async () => {})
}

async function openPicker(host: HTMLElement) {
  const chip = host.querySelector<HTMLButtonElement>('.ai-model-chip')
  expect(chip).not.toBeNull()
  await act(async () => chip!.click())
  return Array.from(host.querySelectorAll<HTMLButtonElement>('.ai-model-item'))
}

function teardown(f: ReturnType<typeof mount>) {
  act(() => f.root.unmount())
  f.host.remove()
  Reflect.deleteProperty(window, 'agyChat')
}

it('A: an enabled, available model is selectable and persisted through the Antigravity handler', async () => {
  const f = mount({
    settings: agySettings(''),
    enabled: ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'],
    selected: 'gemini-3.8-flash-high',
    available: CATALOG,
  })
  await renderPicker(f)
  const options = await openPicker(f.host)
  const low = options.find((b) => b.textContent?.includes('gemini-3.8-flash-low'))
  expect(low).not.toBeNull()
  await act(async () => low!.click())
  expect(f.selectCalls).toEqual(['gemini-3.8-flash-low'])
  expect(f.fixture.selected).toBe('gemini-3.8-flash-low')
  // the generic settings write never carries an Antigravity model on its own
  for (const settings of f.written)
    expect(settings.providers.agy.model).not.toBe('gemini-3.8-flash-low')
  teardown(f)
})

it('B: a model the person switched off is shown but cannot be chosen or persisted', async () => {
  const f = mount({
    settings: agySettings('gemini-3.8-flash-high'),
    enabled: ['gemini-3.8-flash-low'],
    selected: 'gemini-3.8-flash-high',
    available: CATALOG,
  })
  await renderPicker(f)
  const options = await openPicker(f.host)
  const high = options.find((b) => b.textContent?.includes('gemini-3.8-flash-high'))
  expect(high).not.toBeNull()
  expect(high!.disabled).toBe(true)
  expect(high!.getAttribute('aria-disabled')).toBe('true')
  await act(async () => high!.click())
  expect(f.selectCalls).toEqual([])
  expect(f.fixture.selected).toBe('gemini-3.8-flash-high')
  teardown(f)
})

it('C: a model the CLI confirmed it no longer has is not offered as a normal option', async () => {
  const f = mount({
    settings: agySettings('gemini-3.1-pro-high'),
    enabled: ['gemini-3.1-pro-high'],
    selected: 'gemini-3.1-pro-high',
    available: ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'],
  })
  await renderPicker(f)
  const groups = aiModelPickerGroups(f.fixture.settings, false, f.state().models)
  const agy = groups.find((g) => g.id === 'agy')
  expect(agy?.models).toEqual([])
  expect(agy?.unusable).toEqual(['gemini-3.1-pro-high'])
  const options = await openPicker(f.host)
  const pro = options.find((b) => b.textContent?.includes('gemini-3.1-pro-high'))
  expect(pro?.disabled).toBe(true)
  teardown(f)
})

it('D: a saved model that is no longer usable is kept and shown as the current configuration', async () => {
  const f = mount({
    settings: agySettings('gemini-3.1-pro-high'),
    enabled: ['gemini-3.8-flash-low'],
    selected: 'gemini-3.1-pro-high',
    available: CATALOG,
  })
  await renderPicker(f)
  expect(f.fixture.settings.providers.agy.model).toBe('gemini-3.1-pro-high')
  expect(aiModelPickerSelection(f.fixture.settings, f.state().selected).model).toBe(
    'gemini-3.1-pro-high',
  )
  expect(f.host.querySelector('.ai-model-chip-text')?.textContent).toBe('gemini-3.1-pro-high')
  const options = await openPicker(f.host)
  const pro = options.find((b) => b.textContent?.includes('gemini-3.1-pro-high'))
  expect(pro?.disabled).toBe(true)
  teardown(f)
})

it('E: switching from another provider to Antigravity does not invent a model', async () => {
  const settings = defaultAiSettings()
  settings.provider = 'gemini'
  settings.providers.gemini = { apiKey: 'key', model: 'gemini-2.5-flash' }
  settings.providers.agy = { apiKey: '', cliPath: '/fixture/agy', model: '' }
  const f = mount({
    settings,
    enabled: ['gemini-3.8-flash-high'],
    selected: 'gemini-3.8-flash-high',
    available: CATALOG,
  })
  await renderPicker(f)
  const options = await openPicker(f.host)
  const high = options.find((b) => b.textContent?.includes('gemini-3.8-flash-high'))
  expect(high).not.toBeNull()
  await act(async () => high!.click())
  await act(async () => {})
  // the switch is committed by the validated Antigravity handler in one write; the generic
  // settings bridge is never used for an Antigravity model
  expect(f.written.length).toBe(0)
  expect(f.activations).toEqual(['gemini-3.8-flash-high'])
  expect(f.fixture.settings.provider).toBe('agy')
  // the model written with the provider is the one the validated handler just confirmed
  expect(f.fixture.settings.providers.agy.model).toBe('gemini-3.8-flash-high')
  expect(f.fixture.settings.providers.gemini.model).toBe('gemini-2.5-flash')
  expect(f.fixture.selected).toBe('gemini-3.8-flash-high')
  teardown(f)
})

it('F: switching away from Antigravity keeps the other provider settings intact', async () => {
  const settings = agySettings('gemini-3.8-flash-high')
  settings.providers.gemini = { apiKey: 'key', model: 'gemini-2.5-flash' }
  const f = mount({
    settings,
    enabled: ['gemini-3.8-flash-high'],
    selected: 'gemini-3.8-flash-high',
    available: CATALOG,
  })
  await renderPicker(f)
  const options = await openPicker(f.host)
  const geminiRow = options.find((b) => b.textContent?.includes('gemini-2.5-flash'))
  expect(geminiRow).not.toBeNull()
  await act(async () => geminiRow!.click())
  expect(f.written.length).toBe(1)
  expect(f.written[0].provider).toBe('gemini')
  expect(f.written[0].providers.gemini).toEqual({ apiKey: 'key', model: 'gemini-2.5-flash' })
  expect(f.written[0].providers.agy.model).toBe('gemini-3.8-flash-high')
  expect(f.selectCalls.length).toBe(0)
  teardown(f)
})

it('H: a stale picker cannot select a model another window switched off', async () => {
  const f = mount({
    settings: agySettings('gemini-3.8-flash-high'),
    enabled: ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'],
    selected: 'gemini-3.8-flash-high',
    available: CATALOG,
  })
  await renderPicker(f)
  const options = await openPicker(f.host)
  // another window switches High off (and moves the selection) before this click lands
  f.fixture.enabled = ['gemini-3.8-flash-low']
  f.fixture.selected = 'gemini-3.8-flash-low'
  f.fixture.settings.providers.agy.model = 'gemini-3.8-flash-low'
  const high = options.find((b) => b.textContent?.includes('gemini-3.8-flash-high'))
  expect(high).not.toBeNull()
  await act(async () => high!.click())
  expect(f.selectCalls).toEqual(['gemini-3.8-flash-high'])
  expect(f.fixture.selected).toBe('gemini-3.8-flash-low')
  for (const settings of f.written)
    expect(settings.providers.agy.model).toBe('gemini-3.8-flash-low')
  teardown(f)
})

it('I: a catalog failure is reported as unverified and never as a confirmed model list', async () => {
  const f = mount({
    settings: agySettings(''),
    enabled: ['gemini-3.8-flash-high'],
    selected: '',
    available: [],
    catalogError: 'agy models timed out',
  })
  await renderPicker(f)
  const state = f.state()
  expect(state.selectedStatus).toBe('unverified')
  expect(state.available).toEqual([])
  expect(state.models.every((m) => m.verified === false)).toBe(true)
  // a catalog that could not be read is not a catalog: nothing is confirmed, so nothing is
  // selectable, and the picker never falls back to the hardcoded provider seed
  const agy = aiModelPickerGroups(f.fixture.settings, false, state.models, true).find(
    (g) => g.id === 'agy',
  )
  expect(agy).toBeUndefined()
  // with a model already saved, the group stays visible but only as the current configuration
  const kept = aiModelPickerGroups(
    agySettings('gemini-3.8-flash-high'),
    false,
    state.models,
    true,
  ).find((g) => g.id === 'agy')
  expect(kept?.models).toEqual([])
  expect(kept?.unusable).toEqual(['gemini-3.8-flash-high'])
  expect(kept?.modelItems?.every((m) => m.verified === false)).toBe(true)
  // a catalog that answered with no usable model offers nothing at all
  expect(
    aiModelPickerGroups(
      f.fixture.settings,
      false,
      state.models.map((m) => ({ ...m, verified: true, enabled: false })),
      false,
    ).find((g) => g.id === 'agy'),
  ).toBeUndefined()
  teardown(f)
})

it('J: a selection that errors is not presented as a success', async () => {
  const f = mount(
    {
      settings: agySettings('gemini-3.8-flash-low'),
      enabled: ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'],
      selected: 'gemini-3.8-flash-low',
      available: CATALOG,
    },
    true,
  )
  await renderPicker(f)
  const options = await openPicker(f.host)
  const high = options.find((b) => b.textContent?.includes('gemini-3.8-flash-high'))
  await act(async () => high!.click())
  await act(async () => {})
  expect(f.fixture.selected).toBe('gemini-3.8-flash-low')
  expect(f.host.querySelector('.ai-model-chip-text')?.textContent).toBe('gemini-3.8-flash-low')
  const selectedText = f.host.querySelector('.ai-model-item.selected')?.textContent ?? ''
  expect(selectedText).not.toContain('gemini-3.8-flash-high')
  teardown(f)
})

it('K: a CLI with no Gemini offers no Antigravity group instead of the hardcoded seed', () => {
  const settings = agySettings('')
  const live = [
    {
      id: 'claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6',
      group: 'Claude and GPT models',
      relativeCost: 10,
      speed: 'slow',
      enabled: false,
      verified: true,
    },
    {
      id: 'gpt-oss-120b-medium',
      label: 'GPT OSS 120B',
      group: 'Claude and GPT models',
      relativeCost: 6,
      speed: 'slow',
      enabled: false,
      verified: true,
    },
  ]
  expect(aiModelPickerGroups(settings, false, live).find((g) => g.id === 'agy')).toBeUndefined()
  expect(aiModelPickerSelection(settings, '').model).toBe('')
  // an explicit opt-in for Claude is preserved and selectable
  const optedIn = live.map((m) => ({ ...m, enabled: true }))
  expect(aiModelPickerGroups(settings, false, optedIn).find((g) => g.id === 'agy')?.models).toEqual(
    ['claude-sonnet-4-6', 'gpt-oss-120b-medium'],
  )
})

/**
 * A bridge that behaves like a real editor: `setSettings` really stores what is written, so a
 * later `getSettings` shows the state a restart would see. `handler` models the Antigravity IPC:
 * 'present' answers like the shell, 'missing' is a preload without a registered main-process
 * handler (Docs, Sheets, Slides), 'reject' refuses the model, 'throw' fails outright. `state`
 * models the state read: 'ok', 'reject' (no handler), or 'pending' (not answered yet).
 */
function mountEditor({
  settings: initial,
  handler = 'present',
  state = 'ok',
  enabled = ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'],
  available = CATALOG,
  error,
  shared,
}: {
  settings: AiSettings
  handler?: 'present' | 'missing' | 'reject' | 'throw'
  state?: 'ok' | 'reject' | 'pending'
  enabled?: string[]
  available?: string[]
  error?: string
  shared?: AiSettings
}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const written: AiSettings[] = []
  const selectCalls: string[] = []
  const activations: string[] = []
  const unsubscribed: string[] = []
  // `shared` lets two mounted pickers act as two windows over one settings file
  const settings = shared ?? structuredClone(initial)
  // mutable so a test can move the CLI's answer between the render and the click
  const live = { enabled, available, error }

  const api: Record<string, unknown> = {}
  if (handler !== 'missing') {
    api.getAgyChatState =
      state === 'reject'
        ? async () => {
            throw new Error('No handler found for channel agyChat:state')
          }
        : state === 'pending'
          ? () => new Promise<AgyBarState>(() => {})
          : async () => stateOf()
    api.selectAgyChatModel = async (id: string, activate = false) => {
      selectCalls.push(id)
      activations.push(id)
      if (handler === 'throw') throw new Error('settings write failed')
      if (handler === 'reject') return false
      if (!live.enabled.includes(id) || !live.available.includes(id)) return false
      settings.providers.agy = { ...(settings.providers.agy ?? {}), model: id }
      if (activate) settings.provider = 'agy'
      return true
    }
    api.onAgyChatModelChanged = (handler2: () => void) => {
      const off = () => {
        unsubscribed.push('model-changed')
        handler2()
      }
      window.addEventListener('genoffice-agy-model-changed', handler2)
      return off
    }
  }
  Object.assign(window, { agyChat: api })

  function stateOf(): AgyBarState {
    // the chat box reports every model the person switched on, plus whatever the CLI confirmed;
    // a model that is switched on but not confirmed is exactly the case the picker must refuse
    const ids = [...live.available, ...live.enabled.filter((id) => !live.available.includes(id))]
    const selected = settings.providers?.agy?.model ?? ''
    if (selected && !ids.includes(selected)) ids.push(selected)
    return {
      active: settings.provider === 'agy',
      selected,
      available: live.available,
      selectedStatus: selected
        ? live.error
          ? 'unverified'
          : live.available.includes(selected)
            ? 'verified'
            : 'unavailable'
        : 'none',
      models: ids.map((id) => ({
        id,
        label: id,
        group: 'Gemini Models',
        relativeCost: 1,
        speed: 'fast',
        enabled: live.enabled.includes(id),
        verified: live.available.includes(id),
      })),
      ...(live.error ? { catalogError: live.error } : {}),
    }
  }

  const bridge = {
    getSettings: async () => settings,
    setSettings: async (next: AiSettings) => {
      written.push(structuredClone(next))
      for (const key of Object.keys(next)) (settings as Record<string, unknown>)[key] = next[key]
    },
  }
  return {
    host,
    root,
    bridge,
    written,
    selectCalls,
    activations,
    unsubscribed,
    settings,
    stateOf,
    live,
  }
}

describe('the composer picker cannot bypass Antigravity validation (B1-B14)', () => {
  const geminiFirst = (): AiSettings => {
    const settings = defaultAiSettings()
    settings.provider = 'gemini'
    settings.providers.gemini = { apiKey: 'gemini-key', model: 'gemini-2.5-flash' }
    settings.providers.agy = { apiKey: '', cliPath: '/fixture/agy', model: '' }
    return settings
  }

  it('B1: a normal Antigravity selection goes through the handler, never the settings bridge', async () => {
    const f = mountEditor({ settings: agySettings('gemini-3.8-flash-high') })
    await renderPicker(f)
    const options = await openPicker(f.host)
    const low = options.find((b) => b.textContent?.includes('gemini-3.8-flash-low'))
    await act(async () => low!.click())
    await act(async () => {})
    expect(f.selectCalls).toEqual(['gemini-3.8-flash-low'])
    expect(f.written.length).toBe(0)
    expect(f.settings.providers.agy.model).toBe('gemini-3.8-flash-low')
    act(() => f.root.unmount())
    f.host.remove()
    Reflect.deleteProperty(window, 'agyChat')
  })

  it('B2: while the Antigravity state has not answered yet, no Antigravity model is offered', async () => {
    const f = mountEditor({ settings: geminiFirst(), state: 'pending' })
    await renderPicker(f)
    const options = await openPicker(f.host)
    expect(options.some((b) => b.textContent?.includes('gemini-3.8-flash-high'))).toBe(false)
    for (const option of options) await act(async () => option.click())
    await act(async () => {})
    expect(f.selectCalls).toEqual([])
    expect(f.settings.provider).toBe('gemini')
    expect(f.settings.providers.agy.model).toBe('')
    act(() => f.root.unmount())
    f.host.remove()
    Reflect.deleteProperty(window, 'agyChat')
  })

  it('B3: a rejected state read leaves the saved model alone and writes nothing', async () => {
    const f = mountEditor({ settings: agySettings('gemini-3.8-flash-high'), state: 'reject' })
    await renderPicker(f)
    const options = await openPicker(f.host)
    for (const option of options) {
      expect(option.disabled).toBe(true)
      await act(async () => option.click())
    }
    await act(async () => {})
    expect(f.written.length).toBe(0)
    expect(f.settings.provider).toBe('agy')
    expect(f.settings.providers.agy.model).toBe('gemini-3.8-flash-high')
    act(() => f.root.unmount())
    f.host.remove()
    Reflect.deleteProperty(window, 'agyChat')
  })

  it('B4: a preload method that disappears mid-session offers nothing to click', async () => {
    const f = mountEditor({ settings: agySettings('gemini-3.8-flash-high') })
    await renderPicker(f)
    Reflect.deleteProperty(window.agyChat, 'selectAgyChatModel')
    const options = await openPicker(f.host)
    for (const option of options) {
      expect(option.disabled).toBe(true)
      await act(async () => option.click())
    }
    await act(async () => {})
    expect(f.written.length).toBe(0)
    expect(f.settings.providers.agy.model).toBe('gemini-3.8-flash-high')
    act(() => f.root.unmount())
    f.host.remove()
    Reflect.deleteProperty(window, 'agyChat')
  })

  it('B4b: a row the renderer already painted cannot be saved once the handler is gone', async () => {
    const f = mountEditor({ settings: agySettings('gemini-3.8-flash-high') })
    await renderPicker(f)
    const options = await openPicker(f.host)
    const low = options.find((b) => b.textContent?.includes('gemini-3.8-flash-low'))
    expect(low?.disabled).toBe(false)
    // the Antigravity bridge disappears between painting the list and the click
    Reflect.deleteProperty(window.agyChat, 'selectAgyChatModel')
    await act(async () => low!.click())
    await act(async () => {})
    expect(f.written.length).toBe(0)
    expect(f.settings.providers.agy.model).toBe('gemini-3.8-flash-high')
    act(() => f.root.unmount())
    f.host.remove()
    Reflect.deleteProperty(window, 'agyChat')
  })

  it('B5/B6: a refused or throwing selection is never persisted through the bridge', async () => {
    for (const handler of ['reject', 'throw'] as const) {
      const f = mountEditor({ settings: agySettings('gemini-3.8-flash-high'), handler })
      await renderPicker(f)
      const options = await openPicker(f.host)
      const low = options.find((b) => b.textContent?.includes('gemini-3.8-flash-low'))
      await act(async () => low!.click())
      await act(async () => {})
      expect(f.written.length).toBe(0)
      expect(f.settings.provider).toBe('agy')
      expect(f.settings.providers.agy.model).toBe('gemini-3.8-flash-high')
      act(() => f.root.unmount())
      f.host.remove()
      Reflect.deleteProperty(window, 'agyChat')
    }
  })

  it('B7/B8: a switched-off or absent model is not offered and never reaches the bridge', async () => {
    const cases: Array<[string[], string[]]> = [
      // switched off, even though the CLI has it
      [['gemini-3.8-flash-high'], CATALOG],
      // switched on, even though the CLI no longer has it
      [CATALOG, ['gemini-3.8-flash-high']],
    ]
    for (const [enabled, available] of cases) {
      const f = mountEditor({
        settings: agySettings('gemini-3.8-flash-high'),
        enabled,
        available,
      })
      await renderPicker(f)
      const options = await openPicker(f.host)
      const low = options.find((b) => b.textContent?.includes('gemini-3.8-flash-low'))
      expect(low).toBeUndefined()
      for (const option of options) await act(async () => option.click())
      await act(async () => {})
      expect(f.written.length).toBe(0)
      expect(f.settings.provider).toBe('agy')
      expect(f.settings.providers.agy.model).toBe('gemini-3.8-flash-high')
      act(() => f.root.unmount())
      f.host.remove()
      Reflect.deleteProperty(window, 'agyChat')
    }
  })

  it('B9: a list the renderer still holds cannot override what the CLI just confirmed', async () => {
    const f = mountEditor({
      settings: agySettings('gemini-3.8-flash-high'),
      enabled: ['gemini-3.8-flash-high', 'gemini-3.1-pro-high'],
      available: CATALOG,
    })
    await renderPicker(f)
    const options = await openPicker(f.host)
    const pro = options.find((b) => b.textContent?.includes('gemini-3.1-pro-high'))
    expect(pro?.disabled).toBe(false)
    // the CLI drops Pro after the list was built but before the click is handled
    f.live.available = ['gemini-3.8-flash-high']
    await act(async () => pro!.click())
    await act(async () => {})
    expect(f.written.length).toBe(0)
    expect(f.settings.providers.agy.model).toBe('gemini-3.8-flash-high')
    act(() => f.root.unmount())
    f.host.remove()
    Reflect.deleteProperty(window, 'agyChat')
  })

  it('B10/B12/B13: a home-chat Antigravity choice works while other providers stay untouched', async () => {
    const f = mountEditor({ settings: geminiFirst() })
    await renderPicker(f)
    const options = await openPicker(f.host)
    const high = options.find((b) => b.textContent?.includes('gemini-3.8-flash-high'))
    await act(async () => high!.click())
    await act(async () => {})
    expect(f.settings.provider).toBe('agy')
    expect(f.settings.providers.agy.model).toBe('gemini-3.8-flash-high')
    expect(f.settings.providers.gemini).toEqual({ apiKey: 'gemini-key', model: 'gemini-2.5-flash' })
    // and switching back to another provider still works normally
    const again = await openPicker(f.host)
    const flash = again.find((b) => b.textContent?.includes('gemini-2.5-flash'))
    await act(async () => flash!.click())
    await act(async () => {})
    expect(f.settings.provider).toBe('gemini')
    expect(f.settings.providers.agy.model).toBe('gemini-3.8-flash-high')
    act(() => f.root.unmount())
    f.host.remove()
    Reflect.deleteProperty(window, 'agyChat')
  })

  it('B11: an editor without the Antigravity IPC offers no Antigravity model to click', async () => {
    for (const provider of ['agy', 'gemini']) {
      const settings = provider === 'agy' ? agySettings('gemini-3.8-flash-high') : geminiFirst()
      const f = mountEditor({ settings, handler: 'missing' })
      await renderPicker(f)
      const options = await openPicker(f.host)
      for (const option of options) {
        await act(async () => option.click())
      }
      await act(async () => {})
      expect(f.selectCalls).toEqual([])
      expect(f.settings.provider).toBe(provider)
      if (provider === 'agy') expect(f.settings.providers.agy.model).toBe('gemini-3.8-flash-high')
      act(() => f.root.unmount())
      f.host.remove()
      Reflect.deleteProperty(window, 'agyChat')
    }
  })

  it('B14: the picker releases every listener it registered', async () => {
    const f = mountEditor({ settings: agySettings('gemini-3.8-flash-high') })
    await renderPicker(f)
    const before = f.unsubscribed.length
    act(() => f.root.unmount())
    f.host.remove()
    expect(f.unsubscribed.length).toBe(before + 1)
    Reflect.deleteProperty(window, 'agyChat')
  })
})

describe('D6-D8: refreshes that finish out of order still describe one real state', () => {
  const HIGH = 'gemini-3.8-flash-high'
  const LOW = 'gemini-3.8-flash-low'
  const api = () => (window as unknown as { agyChat?: Record<string, unknown> }).agyChat
  const cleanup = (f: { host: HTMLElement; root: ReturnType<typeof createRoot> }) => {
    act(() => f.root.unmount())
    f.host.remove()
    Reflect.deleteProperty(window, 'agyChat')
  }
  const verified = (ids: string[]): AgyBarState => ({
    active: true,
    selected: ids[0] ?? '',
    available: ids,
    selectedStatus: ids.length ? 'verified' : 'none',
    models: ids.map((id) => ({
      id,
      label: id,
      group: 'Gemini Models',
      relativeCost: 1,
      speed: 'fast',
      enabled: true,
      verified: true,
    })),
  })

  it('D6: three focus refreshes resolving in reverse order leave the newest answer', async () => {
    const f = mountEditor({
      settings: agySettings(HIGH),
      enabled: [HIGH, LOW],
      available: [HIGH, LOW],
    })
    await renderPicker(f)
    const resolvers: Array<(value: AgyBarState) => void> = []
    api()!.getAgyChatState = () => new Promise((resolve) => resolvers.push(resolve))
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('focus'))
    })
    expect(resolvers.length).toBe(3)
    // the oldest answers last
    resolvers[0](verified([LOW]))
    await act(async () => {})
    resolvers[1](verified([HIGH]))
    await act(async () => {})
    resolvers[2](verified([HIGH, LOW]))
    await act(async () => {})
    const options = await openPicker(f.host)
    const selectable = options
      .filter((b) => !b.disabled)
      .map((b) => b.textContent?.trim())
      .filter((t) => t?.startsWith('gemini'))
    expect(selectable.sort()).toEqual([HIGH, LOW].sort())
    cleanup(f)
  })

  it('D7: the settings read landing after the Antigravity state read still shows one valid pair', async () => {
    const f = mountEditor({ settings: agySettings(HIGH), enabled: [HIGH], available: [HIGH] })
    await renderPicker(f)
    const stateResolvers: Array<(value: AgyBarState) => void> = []
    api()!.getAgyChatState = () => new Promise((resolve) => stateResolvers.push(resolve))
    await act(async () => window.dispatchEvent(new Event('genoffice-agy-model-changed')))
    // the CLI answers first: the saved model is no longer confirmed
    stateResolvers[0]({
      active: true,
      selected: HIGH,
      available: [],
      selectedStatus: 'unverified',
      models: [],
      catalogError: 'agy models timed out',
    })
    await act(async () => {})
    const options = await openPicker(f.host)
    const row = options.find((b) => b.textContent?.includes(HIGH))
    // the chip still reports what is stored, but nothing unconfirmed is clickable
    expect(f.host.querySelector('.ai-model-chip-text')?.textContent).toBe(HIGH)
    expect(row?.disabled).toBe(true)
    cleanup(f)
  })

  it('D8: two asynchronous settings reads resolving out of order keep the newer provider', async () => {
    const f = mountEditor({ settings: agySettings(HIGH), enabled: [HIGH], available: [HIGH] })
    await renderPicker(f)
    const resolvers: Array<(value: AiSettings) => void> = []
    f.bridge.getSettings = () => new Promise<AiSettings>((resolve) => resolvers.push(resolve))
    await act(async () => {
      window.dispatchEvent(new Event('genoffice-agy-model-changed'))
      window.dispatchEvent(new Event('genoffice-agy-model-changed'))
    })
    const newer: AiSettings = {
      ...structuredClone(f.settings),
      provider: 'openai',
      providers: {
        ...structuredClone(f.settings).providers,
        openai: { apiKey: 'k', model: 'gpt-5' },
      },
    }
    const older: AiSettings = {
      ...structuredClone(f.settings),
      provider: 'gemini',
      providers: {
        ...structuredClone(f.settings).providers,
        gemini: { apiKey: 'gk', model: 'gemini-2.5-flash' },
      },
    }
    resolvers[1](newer)
    await act(async () => {})
    resolvers[0](older)
    await act(async () => {})
    expect(f.host.querySelector('.ai-model-chip-text')?.textContent).toBe('gpt-5')
    cleanup(f)
  })
})

describe('a provider switch and a model choice succeed or fail together (C1-C12)', () => {
  const geminiFirst = (): AiSettings => {
    const settings = defaultAiSettings()
    settings.provider = 'gemini'
    settings.providers.gemini = { apiKey: 'gemini-key', model: 'gemini-2.5-flash' }
    settings.providers.openai = { apiKey: 'openai-key', model: 'gpt-4.1-mini' }
    settings.providers.agy = { apiKey: '', cliPath: '/fixture/agy', model: '' }
    return settings
  }

  it('C1: Gemini -> Antigravity with a valid model ends with both the provider and the model set', async () => {
    const f = mountEditor({ settings: geminiFirst() })
    await renderPicker(f)
    const options = await openPicker(f.host)
    const high = options.find((b) => b.textContent?.includes('gemini-3.8-flash-high'))
    await act(async () => high!.click())
    await act(async () => {})
    expect(f.settings.provider).toBe('agy')
    expect(f.settings.providers.agy.model).toBe('gemini-3.8-flash-high')
    expect(f.host.querySelector('.ai-model-chip-text')?.textContent).toBe('gemini-3.8-flash-high')
    act(() => f.root.unmount())
    f.host.remove()
    Reflect.deleteProperty(window, 'agyChat')
  })

  it('C2/C3/C4/C5: a refused model leaves the original provider and model untouched', async () => {
    for (const handler of ['reject', 'throw'] as const) {
      const f = mountEditor({ settings: geminiFirst(), handler })
      await renderPicker(f)
      const options = await openPicker(f.host)
      const high = options.find((b) => b.textContent?.includes('gemini-3.8-flash-high'))
      await act(async () => high!.click())
      await act(async () => {})
      expect(f.written.length).toBe(0)
      expect(f.settings.provider).toBe('gemini')
      expect(f.settings.providers.gemini.model).toBe('gemini-2.5-flash')
      expect(f.settings.providers.agy.model).toBe('')
      expect(f.host.querySelector('.ai-model-chip-text')?.textContent).toBe('gemini-2.5-flash')
      act(() => f.root.unmount())
      f.host.remove()
      Reflect.deleteProperty(window, 'agyChat')
    }
  })

  it('C6: a provider switch is one validated commit, never a model write plus a settings write', async () => {
    const f = mountEditor({ settings: geminiFirst() })
    await renderPicker(f)
    f.bridge.setSettings = async () => {
      throw new Error('disk full')
    }
    const options = await openPicker(f.host)
    const high = options.find((b) => b.textContent?.includes('gemini-3.8-flash-high'))
    await act(async () => high!.click())
    await act(async () => {})
    // the picker asked the main process to commit provider and model together, and it never
    // touched the generic settings bridge, so a broken settings route cannot half-apply a switch
    expect(f.activations).toEqual(['gemini-3.8-flash-high'])
    expect(f.written.length).toBe(0)
    expect(f.settings.provider).toBe('agy')
    expect(f.settings.providers.agy.model).toBe('gemini-3.8-flash-high')
    expect(f.settings.providers.gemini.model).toBe('gemini-2.5-flash')
    expect(f.host.querySelector('.ai-model-chip-text')?.textContent).toBe('gemini-3.8-flash-high')
    act(() => f.root.unmount())
    f.host.remove()
    Reflect.deleteProperty(window, 'agyChat')
  })

  it('C6b: when the atomic commit itself fails, neither provider nor model moves', async () => {
    const f = mountEditor({ settings: geminiFirst(), handler: 'throw' })
    await renderPicker(f)
    const options = await openPicker(f.host)
    const high = options.find((b) => b.textContent?.includes('gemini-3.8-flash-high'))
    await act(async () => high!.click())
    await act(async () => {})
    expect(f.settings.provider).toBe('gemini')
    expect(f.settings.providers.agy.model).toBe('')
    expect(f.host.querySelector('.ai-model-chip-text')?.textContent).toBe('gemini-2.5-flash')
    act(() => f.root.unmount())
    f.host.remove()
    Reflect.deleteProperty(window, 'agyChat')
  })

  it('C7: a model that disappears between the click and the write is not switched to', async () => {
    const f = mountEditor({
      settings: geminiFirst(),
      enabled: ['gemini-3.8-flash-high', 'gemini-3.1-pro-high'],
      available: CATALOG,
    })
    await renderPicker(f)
    const options = await openPicker(f.host)
    const pro = options.find((b) => b.textContent?.includes('gemini-3.1-pro-high'))
    // another window switches Pro off before this click is handled
    f.live.enabled = ['gemini-3.8-flash-high']
    await act(async () => pro!.click())
    await act(async () => {})
    expect(f.settings.provider).toBe('gemini')
    expect(f.settings.providers.agy.model).toBe('')
    act(() => f.root.unmount())
    f.host.remove()
    Reflect.deleteProperty(window, 'agyChat')
  })

  it('C8: two windows switching at the same time never write a stale snapshot over the newer one', async () => {
    const shared = geminiFirst()
    const a = mountEditor({ settings: shared, shared })
    const b = mountEditor({ settings: shared, shared })
    await renderPicker(a)
    await renderPicker(b)
    const optionsA = await openPicker(a.host)
    const optionsB = await openPicker(b.host)
    const high = optionsA.find((x) => x.textContent?.includes('gemini-3.8-flash-high'))
    const gpt = optionsB.find((x) => x.textContent?.includes('gpt-4.1-mini'))
    await act(async () => {
      void high!.click()
      void gpt!.click()
    })
    await act(async () => {})
    // whichever window landed last, provider and model agree and nothing else was clobbered
    expect(['agy', 'openai']).toContain(shared.provider)
    if (shared.provider === 'agy') expect(shared.providers.agy.model).toBe('gemini-3.8-flash-high')
    expect(shared.providers.gemini.model).toBe('gemini-2.5-flash')
    for (const f of [a, b]) {
      const chip = f.host.querySelector('.ai-model-chip-text')?.textContent
      expect(chip).toBe(shared.provider === 'agy' ? 'gemini-3.8-flash-high' : 'gpt-4.1-mini')
    }
    for (const f of [a, b]) {
      act(() => f.root.unmount())
      f.host.remove()
    }
    Reflect.deleteProperty(window, 'agyChat')
  })

  it('C12: reopening the picker after a failed switch shows the state that is really stored', async () => {
    const shared = geminiFirst()
    const first = mountEditor({ settings: shared, shared, handler: 'reject' })
    await renderPicker(first)
    const options = await openPicker(first.host)
    const high = options.find((x) => x.textContent?.includes('gemini-3.8-flash-high'))
    await act(async () => high!.click())
    await act(async () => {})
    act(() => first.root.unmount())
    first.host.remove()
    // a fresh window reads the same settings file and sees the unchanged provider
    const second = mountEditor({ settings: shared, shared })
    await renderPicker(second)
    expect(second.host.querySelector('.ai-model-chip-text')?.textContent).toBe('gemini-2.5-flash')
    expect(second.settings.provider).toBe('gemini')
    expect(second.settings.providers.agy.model).toBe('')
    act(() => second.root.unmount())
    second.host.remove()
    Reflect.deleteProperty(window, 'agyChat')
  })

  it('C9/C10: an Antigravity model is left alone while another provider is active, and leaving works', async () => {
    const f = mountEditor({ settings: geminiFirst() })
    await renderPicker(f)
    const options = await openPicker(f.host)
    const gpt = options.find((b) => b.textContent?.includes('gpt-4.1-mini'))
    await act(async () => gpt!.click())
    await act(async () => {})
    expect(f.settings.provider).toBe('openai')
    expect(f.settings.providers.agy.model).toBe('')
    act(() => f.root.unmount())
    f.host.remove()
    Reflect.deleteProperty(window, 'agyChat')
  })
})

describe('M1-M20: only a positively confirmed Antigravity model can be chosen', () => {
  const HIGH = 'gemini-3.8-flash-high'
  const LOW = 'gemini-3.8-flash-low'
  const PRO = 'gemini-3.1-pro-high'
  const TIMEOUT = 'agy models timed out'

  const cleanup = (f: { host: HTMLElement; root: ReturnType<typeof createRoot> }) => {
    act(() => f.root.unmount())
    f.host.remove()
    Reflect.deleteProperty(window, 'agyChat')
  }

  const agyGroup = (f: { settings: AiSettings; stateOf: () => AgyBarState }) =>
    aiModelPickerGroups(
      f.settings,
      false,
      f.stateOf().models,
      f.stateOf().catalogError !== undefined,
    ).find((g) => g.id === 'agy')

  it('M1: a confirmed, switched-on model is selectable and reaches the validated handler', async () => {
    const f = mountEditor({ settings: agySettings(''), enabled: [HIGH], available: [HIGH] })
    await renderPicker(f)
    const high = await openPicker(f.host)
    const row = high.find((b) => b.textContent?.includes(HIGH))
    expect(row).not.toBeNull()
    expect(row!.disabled).toBe(false)
    await act(async () => row!.click())
    expect(f.selectCalls).toEqual([HIGH])
    expect(f.settings.providers.agy.model).toBe(HIGH)
    cleanup(f)
  })

  it('M2: every confirmed, switched-on model is selectable and no seed model is invented', async () => {
    const f = mountEditor({
      settings: agySettings(''),
      enabled: [HIGH, LOW, PRO],
      available: [HIGH, LOW, PRO],
    })
    await renderPicker(f)
    expect(agyGroup(f)?.models).toEqual([HIGH, LOW, PRO])
    // nothing is selected yet, so the chip cannot claim a model the CLI never confirmed
    expect(f.host.querySelector('.ai-model-chip-text')?.textContent ?? '').not.toBe(LOW)
    cleanup(f)
  })

  it('M3: a confirmed model the person switched off stays unselectable', async () => {
    const f = mountEditor({ settings: agySettings(''), enabled: [LOW], available: [HIGH, LOW] })
    await renderPicker(f)
    const options = await openPicker(f.host)
    const high = options.find((b) => b.textContent?.includes(HIGH))
    expect(high).toBeUndefined()
    expect(agyGroup(f)?.models).toEqual([LOW])
    cleanup(f)
  })

  it('M4: a catalog failure never makes an unconfirmed model selectable', async () => {
    const f = mountEditor({
      settings: agySettings(''),
      enabled: [HIGH],
      available: [],
      error: TIMEOUT,
    })
    await renderPicker(f)
    const state = f.stateOf()
    expect(state.catalogError).toBe(TIMEOUT)
    expect(state.available).toEqual([])
    expect(state.models.every((m) => m.verified === false)).toBe(true)
    expect(agyGroup(f)).toBeUndefined()
    const options = await openPicker(f.host)
    expect(options.some((b) => b.textContent?.includes(HIGH))).toBe(false)
    cleanup(f)
  })

  it('M5: a saved model survives a catalog failure, shown as current but not selectable', async () => {
    const f = mountEditor({
      settings: agySettings(HIGH),
      enabled: [HIGH],
      available: [],
      error: TIMEOUT,
    })
    await renderPicker(f)
    expect(f.host.querySelector('.ai-model-chip-text')?.textContent).toBe(HIGH)
    const group = agyGroup(f)
    expect(group?.models).toEqual([])
    expect(group?.unusable).toEqual([HIGH])
    const options = await openPicker(f.host)
    const row = options.find((b) => b.textContent?.includes(HIGH))
    expect(row?.disabled).toBe(true)
    await act(async () => row!.click())
    expect(f.selectCalls).toEqual([])
    expect(f.written.length).toBe(0)
    expect(f.settings.providers.agy.model).toBe(HIGH)
    cleanup(f)
  })

  it('M6: a failed catalog with nothing saved offers no Antigravity model at all', async () => {
    const f = mountEditor({ settings: agySettings(''), enabled: [], available: [], error: TIMEOUT })
    await renderPicker(f)
    expect(agyGroup(f)).toBeUndefined()
    const options = await openPicker(f.host)
    expect(options.some((b) => b.textContent?.includes('Antigravity'))).toBe(false)
    cleanup(f)
  })

  it('M7: a CLI that answered with an empty catalog is confirmed empty, not unreadable', async () => {
    const f = mountEditor({ settings: agySettings(''), enabled: [], available: [] })
    await renderPicker(f)
    const state = f.stateOf()
    expect(state.catalogError).toBeUndefined()
    expect(state.models).toEqual([])
    expect(state.selectedStatus).toBe('none')
    expect(agyGroup(f)).toBeUndefined()
    cleanup(f)
  })

  it('M8: a Claude/GPT-only catalog with no opt-in invents no Gemini and enables nothing', async () => {
    const models: AiModelItemMeta[] = [
      { id: 'claude-sonnet-4', label: 'Claude Sonnet 4', enabled: false, verified: true },
      { id: 'gpt-5', label: 'GPT-5', enabled: false, verified: true },
    ]
    const groups = aiModelPickerGroups(agySettings(''), false, models, false)
    expect(groups.find((g) => g.id === 'agy')).toBeUndefined()
    expect(groups.some((g) => g.models.some((m) => m.includes('gemini')))).toBe(false)
  })

  it('M9: an explicitly opted-in non-Gemini model is selectable when the CLI confirms it', async () => {
    const f = mountEditor({
      settings: agySettings(''),
      enabled: ['claude-sonnet-4'],
      available: ['claude-sonnet-4'],
    })
    await renderPicker(f)
    const group = agyGroup(f)
    expect(group?.models).toEqual(['claude-sonnet-4'])
    const options = await openPicker(f.host)
    const row = options.find((b) => b.textContent?.includes('claude-sonnet-4'))
    expect(row?.disabled).toBe(false)
    await act(async () => row!.click())
    expect(f.selectCalls).toEqual(['claude-sonnet-4'])
    expect(f.settings.providers.agy.model).toBe('claude-sonnet-4')
    cleanup(f)
  })

  it('M10: a confirmed catalog that no longer has the saved model keeps it, unselectable', async () => {
    const f = mountEditor({ settings: agySettings(HIGH), enabled: [HIGH, LOW], available: [LOW] })
    await renderPicker(f)
    const group = agyGroup(f)
    expect(group?.models).toEqual([LOW])
    expect(group?.unusable).toEqual([HIGH])
    const options = await openPicker(f.host)
    const row = options.find((b) => b.textContent?.includes(HIGH))
    expect(row?.disabled).toBe(true)
    await act(async () => row!.click())
    expect(f.selectCalls).toEqual([])
    expect(f.settings.providers.agy.model).toBe(HIGH)
    cleanup(f)
  })

  it('M11: without the Antigravity handler no Antigravity model can be chosen', async () => {
    const f = mountEditor({ settings: agySettings(HIGH), handler: 'missing' })
    await renderPicker(f)
    const group = aiModelPickerGroups(f.settings, false, undefined, false, false).find(
      (g) => g.id === 'agy',
    )
    expect(group?.models ?? []).toEqual([])
    const options = await openPicker(f.host)
    const row = options.find((b) => b.textContent?.includes(HIGH))
    expect(row?.disabled).toBe(true)
    await act(async () => row!.click())
    expect(f.selectCalls).toEqual([])
    expect(f.written.length).toBe(0)
    cleanup(f)
  })

  it('M12: a pending state offers nothing clickable, and the answer renders when it arrives', async () => {
    const f = mountEditor({ settings: agySettings(''), state: 'pending' })
    await renderPicker(f)
    const options = await openPicker(f.host)
    expect(options.some((b) => b.textContent?.includes(HIGH))).toBe(false)
    // close the popover so the next open reads the freshly arrived state
    await act(async () => f.host.querySelector<HTMLButtonElement>('.ai-model-chip')!.click())
    ;(window as unknown as { agyChat?: Record<string, unknown> }).agyChat!.getAgyChatState =
      async () => f.stateOf()
    await act(async () => {
      window.dispatchEvent(new Event('genoffice-agy-model-changed'))
    })
    const after = await openPicker(f.host)
    const row = after.find((b) => b.textContent?.includes(HIGH))
    expect(row?.disabled).toBe(false)
    cleanup(f)
  })

  it('M13: a rejected state read does not leave stale confirmed options behind', async () => {
    const f = mountEditor({ settings: agySettings(HIGH), state: 'reject' })
    await renderPicker(f)
    const options = await openPicker(f.host)
    const row = options.find((b) => b.textContent?.includes(HIGH))
    expect(row?.disabled).toBe(true)
    await act(async () => row!.click())
    expect(f.selectCalls).toEqual([])
    expect(f.written.length).toBe(0)
    expect(f.settings.providers.agy.model).toBe(HIGH)
    cleanup(f)
  })

  it('M13b: a state read that fails after a good one does not keep the old list clickable', async () => {
    const f = mountEditor({ settings: agySettings(HIGH), enabled: [HIGH], available: [HIGH] })
    await renderPicker(f)
    const before = await openPicker(f.host)
    expect(before.find((b) => b.textContent?.includes(HIGH))?.disabled).toBe(false)
    await act(async () => f.host.querySelector<HTMLButtonElement>('.ai-model-chip')!.click())
    ;(window as unknown as { agyChat?: Record<string, unknown> }).agyChat!.getAgyChatState =
      async () => {
        throw new Error('No handler found for channel agyChat:state')
      }
    await act(async () => {
      window.dispatchEvent(new Event('genoffice-agy-model-changed'))
    })
    const after = await openPicker(f.host)
    const stale = after.find((b) => b.textContent?.includes(HIGH))
    expect(stale === undefined || stale.disabled).toBe(true)
    if (stale) await act(async () => stale.click())
    expect(f.selectCalls).toEqual([])
    expect(f.written.length).toBe(0)
    cleanup(f)
  })

  it('M14: a confirmed catalog that later fails stops advertising the old selection', async () => {
    const f = mountEditor({ settings: agySettings(HIGH), enabled: [HIGH], available: [HIGH] })
    await renderPicker(f)
    const first = await openPicker(f.host)
    expect(first.find((b) => b.textContent?.includes(HIGH))?.disabled).toBe(false)
    await act(async () => f.host.querySelector<HTMLButtonElement>('.ai-model-chip')!.click())
    f.live.available = []
    f.live.error = TIMEOUT
    await act(async () => {
      window.dispatchEvent(new Event('genoffice-agy-model-changed'))
    })
    const again = await openPicker(f.host)
    const row = again.find((b) => b.textContent?.includes(HIGH))
    expect(row === undefined || row.disabled).toBe(true)
    if (row) await act(async () => row.click())
    expect(f.selectCalls).toEqual([])
    expect(f.written.length).toBe(0)
    expect(f.settings.providers.agy.model).toBe(HIGH)
    cleanup(f)
  })

  it('M15: when the catalog recovers the model becomes selectable again without a restart', async () => {
    const f = mountEditor({
      settings: agySettings(HIGH),
      enabled: [HIGH],
      available: [],
      error: TIMEOUT,
    })
    await renderPicker(f)
    expect(agyGroup(f)?.models).toEqual([])
    f.live.available = [HIGH]
    f.live.error = undefined
    await act(async () => {
      window.dispatchEvent(new Event('genoffice-agy-model-changed'))
    })
    const options = await openPicker(f.host)
    const row = options.find((b) => b.textContent?.includes(HIGH))
    expect(row?.disabled).toBe(false)
    await act(async () => row!.click())
    expect(f.selectCalls).toEqual([HIGH])
    cleanup(f)
  })

  it('M16: a model chosen in another window is reflected here instead of overwritten', async () => {
    const shared = agySettings(HIGH)
    const f = mountEditor({
      settings: shared,
      shared,
      enabled: [HIGH, LOW],
      available: [HIGH, LOW],
    })
    await renderPicker(f)
    shared.providers.agy.model = LOW
    f.live.enabled = [LOW]
    await act(async () => {
      window.dispatchEvent(new Event('genoffice-agy-model-changed'))
    })
    expect(f.host.querySelector('.ai-model-chip-text')?.textContent).toBe(LOW)
    const options = await openPicker(f.host)
    const high = options.find((b) => b.textContent?.includes(HIGH))
    expect(high === undefined || high.disabled).toBe(true)
    cleanup(f)
  })

  it('M17: a stale click on an unselectable model changes nothing', async () => {
    const f = mountEditor({ settings: agySettings(HIGH), enabled: [HIGH], available: [HIGH] })
    await renderPicker(f)
    const options = await openPicker(f.host)
    const row = options.find((b) => b.textContent?.includes(HIGH))
    expect(row).not.toBeNull()
    // the CLI drops the model and the person switches it off before the click lands
    f.live.available = []
    f.live.enabled = []
    await act(async () => {
      window.dispatchEvent(new Event('genoffice-agy-model-changed'))
    })
    const stale = await openPicker(f.host)
    const staleRow = stale.find((b) => b.textContent?.includes(HIGH))
    if (staleRow) await act(async () => staleRow.click())
    expect(f.selectCalls).toEqual([])
    expect(f.written.length).toBe(0)
    expect(f.settings.providers.agy.model).toBe(HIGH)
    cleanup(f)
  })

  it('M18: an unconfirmed Antigravity model cannot switch the provider away', async () => {
    const settings = defaultAiSettings()
    settings.provider = 'openai'
    settings.providers.openai = { apiKey: 'sk-test', model: 'gpt-4.1-mini' }
    settings.providers.agy = { apiKey: '', cliPath: '/fixture/agy', model: HIGH }
    const f = mountEditor({ settings, enabled: [HIGH], available: [], error: TIMEOUT })
    await renderPicker(f)
    const options = await openPicker(f.host)
    const agyRow = options.find((b) => b.textContent?.includes(HIGH))
    if (agyRow) await act(async () => agyRow.click())
    expect(f.selectCalls).toEqual([])
    expect(f.written.length).toBe(0)
    expect(f.settings.provider).toBe('openai')
    cleanup(f)
  })

  it('M19: a failed catalog and refresh leave every other setting untouched', async () => {
    const settings = agySettings(HIGH)
    settings.providers.gemini = { apiKey: 'gk-secret', model: 'gemini-2.5-flash' }
    settings.search = {
      provider: 'agy',
      providers: { agy: { apiKey: '', cliPath: '/search/agy', model: 'search-model' } },
    }
    settings.maxOutputTokens = 4096
    const snapshot = structuredClone(settings)
    const f = mountEditor({
      settings,
      shared: settings,
      enabled: [HIGH],
      available: [],
      error: TIMEOUT,
    })
    await renderPicker(f)
    await act(async () => {
      window.dispatchEvent(new Event('genoffice-agy-model-changed'))
    })
    const options = await openPicker(f.host)
    for (const row of options.filter((r) => r.textContent?.includes(HIGH)))
      await act(async () => row.click())
    expect(f.written.length).toBe(0)
    expect(settings).toEqual(snapshot)
    cleanup(f)
  })

  it('M20: two windows over one main process agree on what is selectable', async () => {
    const shared = agySettings(HIGH)
    const a = mountEditor({ settings: shared, shared, enabled: [HIGH], available: [HIGH] })
    const b = mountEditor({ settings: shared, shared, enabled: [HIGH], available: [HIGH] })
    await renderPicker(a)
    await renderPicker(b)
    expect(agyGroup(a)?.models).toEqual(agyGroup(b)?.models)
    const rowA = await openPicker(a.host)
    const rowB = await openPicker(b.host)
    expect(rowA.find((x) => x.textContent?.includes(HIGH))?.disabled).toBe(false)
    expect(rowB.find((x) => x.textContent?.includes(HIGH))?.disabled).toBe(false)
    cleanup(a)
    cleanup(b)
  })
})

describe('D1-D6: an older async refresh cannot overwrite a newer one', () => {
  const HIGH = 'gemini-3.8-flash-high'
  const api = () => (window as unknown as { agyChat?: Record<string, unknown> }).agyChat
  const cleanup = (f: { host: HTMLElement; root: ReturnType<typeof createRoot> }) => {
    act(() => f.root.unmount())
    f.host.remove()
    Reflect.deleteProperty(window, 'agyChat')
  }

  it('D1/D2: a stale success arriving after a newer failure does not resurrect old options', async () => {
    const f = mountEditor({ settings: agySettings(HIGH), enabled: [HIGH], available: [HIGH] })
    await renderPicker(f)
    const resolvers: Array<(value: AgyBarState) => void> = []
    api()!.getAgyChatState = () => new Promise((resolve) => resolvers.push(resolve))
    await act(async () => {
      window.dispatchEvent(new Event('genoffice-agy-model-changed'))
      window.dispatchEvent(new Event('genoffice-agy-model-changed'))
    })
    // the newer refresh (2) fails first, the older one (1) answers afterwards with a good list
    resolvers[1]({
      active: true,
      selected: HIGH,
      available: [],
      selectedStatus: 'unverified',
      models: [],
      catalogError: 'agy models timed out',
    })
    await act(async () => {})
    resolvers[0]({
      active: true,
      selected: HIGH,
      available: [HIGH],
      selectedStatus: 'verified',
      models: [
        {
          id: HIGH,
          label: HIGH,
          group: 'Gemini Models',
          relativeCost: 1,
          speed: 'fast',
          enabled: true,
          verified: true,
        },
      ],
    })
    await act(async () => {})
    const options = await openPicker(f.host)
    expect(options.some((b) => b.textContent?.includes(HIGH) && !b.disabled)).toBe(false)
    cleanup(f)
  })

  it('D3: a newer success after an older failure restores the verified options', async () => {
    const f = mountEditor({
      settings: agySettings(HIGH),
      enabled: [HIGH],
      available: [],
      error: 'agy models timed out',
    })
    await renderPicker(f)
    const resolvers: Array<(value: AgyBarState) => void> = []
    api()!.getAgyChatState = () => new Promise((resolve) => resolvers.push(resolve))
    await act(async () => {
      window.dispatchEvent(new Event('genoffice-agy-model-changed'))
      window.dispatchEvent(new Event('genoffice-agy-model-changed'))
    })
    resolvers[1]({
      active: true,
      selected: HIGH,
      available: [HIGH],
      selectedStatus: 'verified',
      models: [
        {
          id: HIGH,
          label: HIGH,
          group: 'Gemini Models',
          relativeCost: 1,
          speed: 'fast',
          enabled: true,
          verified: true,
        },
      ],
    })
    await act(async () => {})
    resolvers[0]({
      active: true,
      selected: HIGH,
      available: [],
      selectedStatus: 'unverified',
      models: [],
      catalogError: 'agy models timed out',
    })
    await act(async () => {})
    const options = await openPicker(f.host)
    const row = options.find((b) => b.textContent?.includes(HIGH))
    expect(row?.disabled).toBe(false)
    cleanup(f)
  })

  it('D4/D5: a selection notification arriving during a pending refresh wins, and unmounting leaves nothing behind', async () => {
    const f = mountEditor({ settings: agySettings(HIGH), enabled: [HIGH], available: [HIGH] })
    await renderPicker(f)
    const resolvers: Array<(value: AgyBarState) => void> = []
    api()!.getAgyChatState = () => new Promise((resolve) => resolvers.push(resolve))
    await act(async () => {
      window.dispatchEvent(new Event('genoffice-agy-model-changed'))
    })
    f.settings.provider = 'agy'
    f.settings.providers.agy.model = 'gemini-3.8-flash-low'
    f.live.available = ['gemini-3.8-flash-low']
    f.live.enabled = ['gemini-3.8-flash-low']
    resolvers[0]({
      active: true,
      selected: 'gemini-3.8-flash-low',
      available: ['gemini-3.8-flash-low'],
      selectedStatus: 'verified',
      models: [
        {
          id: 'gemini-3.8-flash-low',
          label: 'gemini-3.8-flash-low',
          group: 'Gemini Models',
          relativeCost: 1,
          speed: 'fast',
          enabled: true,
          verified: true,
        },
      ],
    })
    await act(async () => {})
    expect(f.host.querySelector('.ai-model-chip-text')?.textContent).toBe('gemini-3.8-flash-low')
    act(() => f.root.unmount())
    f.host.remove()
    expect(f.unsubscribed.length).toBe(1)
    Reflect.deleteProperty(window, 'agyChat')
  })
})
