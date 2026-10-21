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
      {
        id: 'gemini-3.8-flash-high',
        label: 'Flash High',
        family: 'gemini',
        relativeCost: 1,
        speed: 'fast',
      },
      {
        id: 'gemini-3.8-flash-low',
        label: 'Flash Low',
        family: 'gemini',
        relativeCost: 0.5,
        speed: 'fast',
      },
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
      root.render(createElement(LocaleProvider, null, createElement(AgyChatModelsSettings, null)))
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
        {
          id: 'gemini-3.8-flash-high',
          label: 'Flash High',
          family: 'gemini',
          relativeCost: 1,
          speed: 'fast',
        },
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
      root.render(createElement(LocaleProvider, null, createElement(AgyChatModelsSettings, null)))
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
      root.render(createElement(LocaleProvider, null, createElement(AgyChatModelsSettings, null)))
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
describe('the model settings panel applies toggles in order (H01-H04)', () => {
  const HIGH = 'gemini-3.8-flash-high'
  const LOW = 'gemini-3.8-flash-low'
  const catalogOf = (enabled: string[]): AgyChatCatalog => ({
    all: [
      { id: HIGH, label: 'Flash High', family: 'gemini', relativeCost: 1, speed: 'fast' },
      { id: LOW, label: 'Flash Low', family: 'gemini', relativeCost: 0.5, speed: 'fast' },
    ],
    enabled,
  })

  async function mount(api: AgyChatApi) {
    vi.stubGlobal('agyChat', api)
    await act(async () => {
      root.render(createElement(LocaleProvider, null, createElement(AgyChatModelsSettings, null)))
    })
    await act(async () => {})
    return Array.from(host.querySelectorAll<HTMLButtonElement>('.set-switch'))
  }

  it('H01: two overlapping toggles are applied in order, not from the same snapshot', async () => {
    let enabled = [HIGH, LOW]
    let call = 0
    const switches = await mount({
      getAgyChatCatalog: async () => catalogOf([...enabled]),
      setAgyChatEnabledModels: async (ids) => {
        const wait = call === 0 ? 0 : 80
        call += 1
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
        enabled = ids
        return [...enabled]
      },
      onAgyChatModelChanged: () => () => undefined,
    } as unknown as AgyChatApi)

    await act(async () => {
      switches[0].click()
      switches[1].click()
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    // Flash High was switched off first; the second click then sees only Flash Low left on and
    // refuses to switch off the last model. Nothing re-enables Flash High behind the person's back.
    expect(enabled).toEqual([LOW])
    expect(switches[0].getAttribute('aria-checked')).toBe('false')
    expect(switches[1].getAttribute('aria-checked')).toBe('true')
  })

  it('H02: a change made in another window is re-read instead of left stale', async () => {
    let enabled = [HIGH, LOW]
    const switches = await mount({
      getAgyChatCatalog: async () => catalogOf([...enabled]),
      setAgyChatEnabledModels: async (ids) => {
        enabled = ids
        return [...enabled]
      },
      onAgyChatModelChanged: (handler) => {
        handler()
        return () => undefined
      },
    } as unknown as AgyChatApi)

    await act(async () => {
      enabled = [LOW]
      window.dispatchEvent(new Event('genoffice-agy-model-changed'))
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(switches[0].getAttribute('aria-checked')).toBe('false')
    expect(switches[1].getAttribute('aria-checked')).toBe('true')
  })

  it('H03: the panel releases its listener when it is closed', async () => {
    const handlers: Array<() => void> = []
    await mount({
      getAgyChatCatalog: async () => catalogOf([HIGH]),
      setAgyChatEnabledModels: async () => null,
      onAgyChatModelChanged: (handler) => {
        handlers.push(handler)
        return () => handlers.splice(handlers.indexOf(handler), 1)
      },
    } as unknown as AgyChatApi)
    expect(handlers.length).toBe(1)
    act(() => root.unmount())
    host.remove()
    expect(handlers.length).toBe(0)
    // a later change from another window must not touch a closed panel
    window.dispatchEvent(new Event('genoffice-agy-model-changed'))
  })
})
