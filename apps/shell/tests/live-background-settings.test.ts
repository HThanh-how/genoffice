/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { HomeApi } from '../src/shared/home-api'
import { emptyLiveBackgroundState } from '../src/shared/fork/live-background'
import { LiveBackgroundSettings } from '../src/renderer/src/fork/LiveBackgroundSettings'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const host = document.createElement('div')
document.body.append(host)
const root = createRoot(host)
afterEach(() => {
  act(() => root.render(null))
  vi.restoreAllMocks()
})

it('renders disabled controls when the background bridge is absent', async () => {
  window.aiOffice = {} as HomeApi
  await act(async () => { root.render(createElement(LiveBackgroundSettings, { lang: 'en' })) })
  const switches = host.querySelectorAll<HTMLButtonElement>('[role="switch"]')
  expect(switches.length).toBe(2)
  expect(Array.from(switches).every((button) => button.disabled)).toBe(true)
})

it('shows the scanning state while the workshop request is pending', async () => {
  const initial = emptyLiveBackgroundState()
  const state = { ...initial, prefs: { ...initial.prefs, enabled: true } }
  window.aiOffice = {
    getLiveBackground: async () => state,
    scanLiveBackgroundWorkshop: () => new Promise(() => {}),
  } as unknown as HomeApi
  await act(async () => { root.render(createElement(LiveBackgroundSettings, { lang: 'en' })) })
  expect(host.textContent?.toLowerCase()).toContain('scanning')
})

it('keeps the empty state when bridge requests reject', async () => {
  window.aiOffice = {
    getLiveBackground: vi.fn().mockRejectedValue(new Error('unavailable')),
    scanLiveBackgroundWorkshop: vi.fn().mockRejectedValue(new Error('unavailable')),
  } as unknown as HomeApi
  await act(async () => { root.render(createElement(LiveBackgroundSettings, { lang: 'en' })) })
  expect(host.querySelectorAll('[role="switch"]')).toHaveLength(2)
})
