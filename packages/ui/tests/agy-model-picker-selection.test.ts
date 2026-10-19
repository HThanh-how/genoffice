// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { defaultAiSettings, type AiSettings } from '@genoffice/ai-provider'
import { AiModelPicker } from '../src/AiModelPicker'
import { aiModelPickerGroups, aiModelPickerSelection } from '../src/ai-model-picker-options'

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
  expect(f.written[0].providers.agy.model).toBe('')
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
