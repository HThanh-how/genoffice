// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { defaultAiSettings, type AiSettings } from '@genoffice/ai-provider'
import { AiModelPicker } from '../src/AiModelPicker'
import { aiModelPickerGroups, aiModelPickerSelection } from '../src/ai-model-picker-options'
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

  const state = () => {
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
      getAgyChatState: async () => state(),
      selectAgyChatModel: async (id: string) => {
        selectCalls.push(id)
        if (selectThrows) throw new Error('settings write failed')
        if (!fixture.enabled.includes(id)) return false
        if (!fixture.available.includes(id)) return false
        fixture.selected = id
        fixture.settings.providers.agy = {
          ...(fixture.settings.providers.agy ?? { apiKey: '', cliPath: '/fixture/agy' }),
          model: id,
        }
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

  return { host, root, bridge, written, selectCalls, state, fixture }
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
  expect(f.written.length).toBe(1)
  expect(f.written[0].provider).toBe('agy')
  // the model written with the provider is the one the validated handler just confirmed
  expect(f.written[0].providers.agy.model).toBe('gemini-3.8-flash-high')
  expect(f.written[0].providers.gemini.model).toBe('gemini-2.5-flash')
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
  // the seed is offered only because the CLI could not be reached, and nothing in it is claimed
  // to be confirmed by the CLI
  const agy = aiModelPickerGroups(f.fixture.settings, false, state.models, true).find(
    (g) => g.id === 'agy',
  )
  expect(agy?.models).toEqual(['gemini-3.8-flash-high'])
  expect(agy?.modelItems?.every((m) => m.verified === false)).toBe(true)
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
  shared,
}: {
  settings: AiSettings
  handler?: 'present' | 'missing' | 'reject' | 'throw'
  state?: 'ok' | 'reject' | 'pending'
  enabled?: string[]
  available?: string[]
  shared?: AiSettings
}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const written: AiSettings[] = []
  const selectCalls: string[] = []
  const unsubscribed: string[] = []
  // `shared` lets two mounted pickers act as two windows over one settings file
  const settings = shared ?? structuredClone(initial)
  // mutable so a test can move the CLI's answer between the render and the click
  const live = { enabled, available }

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
    api.selectAgyChatModel = async (id: string) => {
      selectCalls.push(id)
      if (handler === 'throw') throw new Error('settings write failed')
      if (handler === 'reject') return false
      if (!live.enabled.includes(id) || !live.available.includes(id)) return false
      settings.providers.agy = { ...(settings.providers.agy ?? {}), model: id }
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
    const ids = [...live.available]
    const selected = settings.providers?.agy?.model ?? ''
    if (selected && !ids.includes(selected)) ids.push(selected)
    return {
      active: settings.provider === 'agy',
      selected,
      available: live.available,
      selectedStatus: selected
        ? live.available.includes(selected)
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
    }
  }

  const bridge = {
    getSettings: async () => settings,
    setSettings: async (next: AiSettings) => {
      written.push(structuredClone(next))
      for (const key of Object.keys(next)) (settings as Record<string, unknown>)[key] = next[key]
    },
  }
  return { host, root, bridge, written, selectCalls, unsubscribed, settings, stateOf, live }
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

  it('C6: a settings write that fails rolls the provider back and reports nothing as chosen', async () => {
    const f = mountEditor({ settings: geminiFirst() })
    await renderPicker(f)
    f.bridge.setSettings = async () => {
      throw new Error('disk full')
    }
    const options = await openPicker(f.host)
    const high = options.find((b) => b.textContent?.includes('gemini-3.8-flash-high'))
    await act(async () => high!.click())
    await act(async () => {})
    expect(f.settings.provider).toBe('gemini')
    expect(f.settings.providers.agy.model).toBe('gemini-3.8-flash-high')
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
