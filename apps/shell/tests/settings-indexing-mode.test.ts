/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HomeApi } from '../src/shared/home-api'
import type { IndexingMode, IndexingModeState } from '../src/shared/fork/indexing-mode'
import { LocaleProvider } from '../src/renderer/src/locale'
import { IndexingModeSettings } from '../src/renderer/src/fork/IndexingModeSettings'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const idleState: IndexingModeState = {
  mode: 'balanced',
  pauseOnBattery: true,
  effective: { tier: 'idle', paused: false, threads: 4, cpuShare: 1, onBattery: false },
}

async function render(lang: 'en' | 'vi', api: Partial<HomeApi>) {
  window.aiOffice = api as HomeApi
  await act(async () => {
    root.render(
      createElement(LocaleProvider, { initial: lang }, createElement(IndexingModeSettings)),
    )
    await Promise.resolve()
  })
}

describe('IndexingModeSettings', () => {
  it('shows three radio cards, the live status and the battery switch (Vietnamese)', async () => {
    await render('vi', { getIndexingModeState: async () => idleState })
    const radios = [...host.querySelectorAll<HTMLInputElement>('input[type=radio]')]
    expect(radios.map((r) => r.value)).toEqual(['light', 'balanced', 'fast'])
    expect(radios.map((r) => r.checked)).toEqual([false, true, false])
    expect(host.textContent).toContain('Nhẹ')
    expect(host.textContent).toContain('Cân bằng')
    expect(host.textContent).toContain('Nhanh')
    expect(host.querySelector('[role=status]')?.textContent).toBe(
      'Đang chạy nhanh (4 luồng) vì máy đang rảnh và cắm điện',
    )
    const toggle = host.querySelector<HTMLButtonElement>('button[role=switch]')!
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe('Tạm dừng khi dùng pin')
  })

  it('shows the pause reason', async () => {
    await render('en', {
      getIndexingModeState: async () => ({
        ...idleState,
        effective: {
          tier: 'paused',
          paused: true,
          pauseReason: 'battery-saver',
          threads: 1,
          cpuShare: 0,
          onBattery: true,
        },
      }),
    })
    expect(host.querySelector('[role=status]')?.textContent).toBe('Paused: battery saver is on')
  })

  it('persists a mode change and reverts when saving fails', async () => {
    const setIndexingMode = vi
      .fn<(mode: IndexingMode) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    await render('en', { getIndexingModeState: async () => idleState, setIndexingMode })
    const radio = (mode: string) =>
      host.querySelector<HTMLInputElement>(`input[type=radio][value=${mode}]`)!
    await act(async () => {
      radio('fast').click()
      await Promise.resolve()
    })
    expect(setIndexingMode).toHaveBeenLastCalledWith('fast')
    expect(radio('fast').checked).toBe(true)
    await act(async () => {
      radio('light').click()
      await Promise.resolve()
    })
    expect(setIndexingMode).toHaveBeenLastCalledWith('light')
    expect(radio('fast').checked).toBe(true) // the second save failed: back to the stored mode
  })

  it('toggles pause on battery', async () => {
    const setPause = vi.fn<(value: boolean) => Promise<boolean>>().mockResolvedValue(true)
    await render('en', {
      getIndexingModeState: async () => idleState,
      setPauseIndexingOnBattery: setPause,
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[role=switch]')!.click()
      await Promise.resolve()
    })
    expect(setPause).toHaveBeenCalledWith(false)
    expect(host.querySelector('button[role=switch]')?.getAttribute('aria-checked')).toBe('false')
  })

  it('renders nothing when the API is unavailable', async () => {
    await render('en', {})
    expect(host.innerHTML).toBe('')
  })
})
