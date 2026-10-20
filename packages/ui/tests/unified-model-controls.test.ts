// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { defaultAiSettings } from '@genoffice/ai-provider'
import { AiComposer } from '../src/AiComposer'
import { AiModelPicker } from '../src/AiModelPicker'
import type { AgyBarApi } from '../src/AgyChatBar'
import { aiModelPickerGroups, withAiModelSelection } from '../src/ai-model-picker-options'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const host = document.createElement('div')
const root = createRoot(host)
document.body.appendChild(host)

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  Reflect.deleteProperty(window, 'agyChat')
})

it('an Antigravity editor composer has exactly one model selector alongside usage', async () => {
  const settings = defaultAiSettings()
  settings.provider = 'agy'
  settings.providers.agy = { apiKey: '', model: 'gemini-flash', cliPath: '/fixture/agy' }
  const mediaBeforeSelection = structuredClone(settings.media)
  expect(withAiModelSelection(settings, { provider: 'agy', model: 'gemini-flash' }).media).toEqual(
    mediaBeforeSelection,
  )
  const liveModels = [{ id: 'gemini-flash', label: 'Gemini Flash' }]
  expect(aiModelPickerGroups(settings, false, liveModels).map((group) => group.id)).toEqual(['agy'])
  const usage = { groups: null, readAt: Date.now(), refreshing: false, failed: false }
  const agy: AgyBarApi = {
    getAgyChatState: async () => ({
      active: true,
      selected: 'gemini-flash',
      models: [
        {
          id: 'gemini-flash',
          label: 'Gemini Flash',
          group: 'flash',
          relativeCost: 1,
          speed: 'fast',
        },
      ],
    }),
    selectAgyChatModel: async () => true,
    getAgyChatUsage: async () => usage,
    refreshAgyChatUsage: async () => usage,
    onAgyChatUsage: () => () => {},
  }
  Object.assign(window, { agyChat: agy })
  const bridge = { getSettings: async () => settings, setSettings: async () => {} }
  await act(async () =>
    root.render(
      createElement(AiComposer, {
        value: '',
        busy: false,
        placeholder: 'Ask',
        hintIdle: 'Enter to send',
        hintBusy: 'Working',
        sendLabel: 'Send',
        stopLabel: 'Stop',
        lang: 'en',
        onChange: () => {},
        onSend: () => {},
        onStop: () => {},
        footerStart: createElement(AiModelPicker, { bridge, lang: 'en' }),
      }),
    ),
  )
  expect(host.querySelectorAll('button[aria-haspopup="listbox"]')).toHaveLength(1)
  expect(host.querySelector('.agy-bar-usage')).not.toBeNull()
})

it('T37: the Antigravity chip shows the model the chat box is actually using, and follows another window', async () => {
  const host2 = document.createElement('div')
  document.body.appendChild(host2)
  const root2 = createRoot(host2)
  const settings = defaultAiSettings()
  settings.provider = 'agy'
  settings.providers.agy = { apiKey: '', model: '', cliPath: '/fixture/agy' }

  let enabled = ['gemini-3.8-flash-high', 'gemini-3.8-flash-low']
  let selected = 'gemini-3.8-flash-high'
  const listeners: Array<() => void> = []
  const usage = { groups: null, readAt: 0, refreshing: false, failed: false }
  const agy: AgyBarApi = {
    getAgyChatState: async () => ({
      active: true,
      selected,
      selectedStatus: 'verified',
      available: enabled,
      models: enabled.map((id) => ({
        id,
        label: id,
        group: 'Gemini Models',
        relativeCost: 1,
        speed: 'fast',
        enabled: true,
        // the real chat box state always says whether the CLI confirmed the model
        verified: true,
      })),
    }),
    selectAgyChatModel: async () => true,
    getAgyChatUsage: async () => usage,
    refreshAgyChatUsage: async () => usage,
    onAgyChatUsage: () => () => {},
    onAgyChatModelChanged: (handler) => {
      listeners.push(handler)
      return () => {
        const at = listeners.indexOf(handler)
        if (at >= 0) listeners.splice(at, 1)
      }
    },
  }
  Object.assign(window, { agyChat: agy })
  const bridge = { getSettings: async () => settings, setSettings: async () => {} }
  await act(async () => root2.render(createElement(AiModelPicker, { bridge, lang: 'en' })))
  expect(host2.querySelector('.ai-model-chip-text')?.textContent).toBe('gemini-3.8-flash-high')

  // another window switched the model and trimmed the enabled list
  selected = 'gemini-3.8-flash-low'
  enabled = ['gemini-3.8-flash-low']
  await act(async () => {
    for (const listener of listeners) listener()
  })
  expect(host2.querySelector('.ai-model-chip-text')?.textContent).toBe('gemini-3.8-flash-low')
  expect(
    aiModelPickerGroups(settings, false, [
      { id: 'gemini-3.8-flash-low', label: 'Low', enabled: true, verified: true },
    ]).map((g) => g.id),
  ).toEqual(['agy'])
  await act(async () => root2.unmount())
  host2.remove()
})
