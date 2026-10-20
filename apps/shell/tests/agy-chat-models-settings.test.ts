/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgyChatApi, AgyChatCatalog } from '@genoffice/ai-provider/agy-chat'
import { LocaleProvider } from '../src/renderer/src/locale'
import { AgyChatModelsSettings } from '../src/renderer/src/fork/AgyChatModelsSettings'

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

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
  vi.unstubAllGlobals()
})

describe('AgyChatModelsSettings UI consistency', () => {
  const sampleCatalog: AgyChatCatalog = {
    all: [
      { id: 'gemini-3.8-flash-high', label: 'Flash High', family: 'gemini', relativeCost: 1, speed: 'fast' },
      { id: 'gemini-3.8-flash-low', label: 'Flash Low', family: 'gemini', relativeCost: 0.5, speed: 'fast' },
    ],
    enabled: ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'],
  }

  it('clears catalog and shows unavailable error on getAgyChatCatalog failure', async () => {
    let shouldFail = false
    const mockApi: Partial<AgyChatApi> = {
      getAgyChatCatalog: vi.fn(async () => {
        if (shouldFail) throw new Error('CLI unavailable')
        return sampleCatalog
      }),
      onAgyChatModelChanged: vi.fn(() => () => {}),
    }
    vi.stubGlobal('agyChat', mockApi)

    await act(async () => {
      root.render(
        createElement(LocaleProvider, null, createElement(AgyChatModelsSettings, null)),
      )
    })
    await act(async () => {})
    expect(host.querySelectorAll('.set-switch').length).toBe(2)

    // Now fail
    shouldFail = true
    await act(async () => {
      window.dispatchEvent(new Event('genoffice-agy-model-changed'))
    })
    await act(async () => {})
    expect(host.querySelectorAll('.set-switch').length).toBe(0)
    expect(host.textContent).toContain('Check the Antigravity connection above')
  })

  it('keeps at least one model enabled and disables switch on the last model', async () => {
    const singleCatalog: AgyChatCatalog = {
      all: [
        { id: 'gemini-3.8-flash-high', label: 'Flash High', family: 'gemini', relativeCost: 1, speed: 'fast' },
      ],
      enabled: ['gemini-3.8-flash-high'],
    }
    const setAgyChatEnabledModels = vi.fn(async (ids: string[]) => ids)
    const mockApi: Partial<AgyChatApi> = {
      getAgyChatCatalog: vi.fn(async () => singleCatalog),
      setAgyChatEnabledModels,
      onAgyChatModelChanged: vi.fn(() => () => {}),
    }
    vi.stubGlobal('agyChat', mockApi)

    await act(async () => {
      root.render(
        createElement(LocaleProvider, null, createElement(AgyChatModelsSettings, null)),
      )
    })
    await act(async () => {})
    const sw = host.querySelector('.set-switch') as HTMLButtonElement | null
    expect(sw).not.toBeNull()
    expect(sw?.disabled).toBe(true)

    // Clicking disabled switch does not call IPC
    await act(async () => {
      sw?.click()
    })
    expect(setAgyChatEnabledModels).not.toHaveBeenCalled()
  })

  it('handles toggle rejection gracefully without unhandled rejection and reloads', async () => {
    let getCalls = 0
    const mockApi: Partial<AgyChatApi> = {
      getAgyChatCatalog: vi.fn(async () => {
        getCalls += 1
        return sampleCatalog
      }),
      setAgyChatEnabledModels: vi.fn(async () => {
        throw new Error('IPC failed')
      }),
      onAgyChatModelChanged: vi.fn(() => () => {}),
    }
    vi.stubGlobal('agyChat', mockApi)

    await act(async () => {
      root.render(
        createElement(LocaleProvider, null, createElement(AgyChatModelsSettings, null)),
      )
    })
    await act(async () => {})
    const initialGets = getCalls
    const switches = host.querySelectorAll('.set-switch')
    expect(switches.length).toBe(2)

    await act(async () => {
      ;(switches[0] as HTMLButtonElement).click()
    })
    await act(async () => {})
    // On rejection, toggle catches error and calls load() to reload
    expect(getCalls).toBeGreaterThan(initialGets)
  })
})
