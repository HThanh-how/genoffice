// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { AgyBarApi, AgyBarState, AgyChatBar } from '../src/AgyChatBar'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/**
 * The chat box is the other half of the contract: whatever it lets a person click must be
 * something the main process will actually accept. These tests drive the real component with an
 * asynchronous bridge so the ordering of state reads is exercised, not mocked away.
 */
const HIGH = 'gemini-3.8-flash-high'
const LOW = 'gemini-3.8-flash-low'
const PRO = 'gemini-3.1-pro-high'

function stateOf(
  selected: string,
  enabled: string[],
  available: string[],
  error?: string,
): AgyBarState {
  return {
    active: true,
    selected,
    available,
    selectedStatus: error
      ? 'unverified'
      : available.includes(selected)
        ? 'verified'
        : 'unavailable',
    models: enabled.map((id) => ({
      id,
      label: id,
      group: 'Gemini Models',
      relativeCost: 1,
      speed: 'fast',
      enabled: true,
      verified: available.includes(id),
    })),
    ...(error ? { catalogError: error } : {}),
  }
}

function mountBar(api: AgyBarApi) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const selectCalls: Array<[string, boolean]> = []
  const listeners: Array<() => void> = []
  const bridge: AgyBarApi = {
    ...api,
    selectAgyChatModel: async (id: string, activate = false) => {
      selectCalls.push([id, activate])
      return false
    },
    onAgyChatModelChanged: (handler: () => void) => {
      listeners.push(handler)
      return () => {
        const index = listeners.indexOf(handler)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
  }
  const usage = { groups: null, readAt: 0, refreshing: false, failed: false }
  bridge.getAgyChatUsage = async () => usage
  bridge.refreshAgyChatUsage = async () => usage
  bridge.onAgyChatUsage = () => () => undefined
  return { host, root, selectCalls, listeners, bridge }
}

async function openMenu(host: HTMLElement) {
  const modelButton = host.querySelector<HTMLButtonElement>('.agy-bar-model')
  expect(modelButton).not.toBeNull()
  if (modelButton!.getAttribute('aria-expanded') !== 'true')
    await act(async () => modelButton!.click())
  return Array.from(host.querySelectorAll<HTMLButtonElement>('.agy-bar-menu button'))
}

describe('the chat box only offers models the CLI confirmed (G1-G4)', () => {
  it('G1: a model the CLI no longer reports is listed but cannot be clicked', async () => {
    const f = mountBar({
      getAgyChatState: async () => stateOf(HIGH, [HIGH, PRO], [HIGH]),
    } as AgyBarApi)
    await act(async () => f.root.render(createElement(AgyChatBar, { lang: 'en', api: f.bridge })))
    await act(async () => {})
    const options = await openMenu(f.host)
    const pro = options.find((b) => b.textContent?.includes(PRO))
    expect(pro).not.toBeNull()
    expect(pro!.disabled).toBe(true)
    expect(pro!.getAttribute('aria-disabled')).toBe('true')
    await act(async () => pro!.click())
    expect(f.selectCalls).toEqual([])
    act(() => f.root.unmount())
    f.host.remove()
  })

  it('G2: a catalog failure leaves nothing in the menu clickable', async () => {
    const f = mountBar({
      getAgyChatState: async () => stateOf(HIGH, [HIGH, PRO], [], 'agy models timed out'),
    } as AgyBarApi)
    await act(async () => f.root.render(createElement(AgyChatBar, { lang: 'en', api: f.bridge })))
    await act(async () => {})
    const options = await openMenu(f.host)
    expect(options.length).toBe(2)
    for (const option of options) expect(option.disabled).toBe(true)
    await act(async () => {
      for (const option of options) option.click()
    })
    expect(f.selectCalls).toEqual([])
    act(() => f.root.unmount())
    f.host.remove()
  })

  it('G3: a standalone editor with no Antigravity handler renders nothing to click', async () => {
    const f = mountBar({
      getAgyChatState: async () => {
        throw new Error('No handler found for channel agyChat:state')
      },
    } as AgyBarApi)
    await act(async () => f.root.render(createElement(AgyChatBar, { lang: 'en', api: f.bridge })))
    await act(async () => {})
    // fail closed: the bar never falls back to a hardcoded model list, so there is no model
    // chip and no way to reach the generic settings write from here
    expect(f.host.querySelector('.agy-bar-model')).toBeNull()
    expect(f.host.querySelector('.agy-bar-menu')).toBeNull()
    expect(f.selectCalls).toEqual([])
    act(() => f.root.unmount())
    f.host.remove()
  })

  it('G4: a confirmed model becomes clickable again when the catalog recovers', async () => {
    let current = stateOf(HIGH, [HIGH], [], 'agy models timed out')
    const f = mountBar({
      getAgyChatState: async () => current,
    } as AgyBarApi)
    await act(async () => f.root.render(createElement(AgyChatBar, { lang: 'en', api: f.bridge })))
    await act(async () => {})
    const first = await openMenu(f.host)
    expect(first[0]?.disabled).toBe(true)
    await act(async () => {
      current = stateOf(HIGH, [HIGH], [HIGH])
      for (const listener of f.listeners) listener()
    })
    await act(async () => {})
    const second = await openMenu(f.host)
    expect(second[0]?.disabled).toBe(false)
    act(() => f.root.unmount())
    f.host.remove()
  })

  it('G5: swapping the bridge does not stop the bar from reading the current state', async () => {
    const first = mountBar({
      getAgyChatState: async () => stateOf(HIGH, [HIGH], [HIGH]),
    } as AgyBarApi)
    await act(async () =>
      first.root.render(createElement(AgyChatBar, { lang: 'en', api: first.bridge })),
    )
    await act(async () => {})
    // the host replaces the bridge (a different api object) while the bar stays mounted
    const second = mountBar({
      getAgyChatState: async () => stateOf(LOW, [LOW], [LOW]),
    } as AgyBarApi)
    await act(async () =>
      first.root.render(createElement(AgyChatBar, { lang: 'en', api: second.bridge })),
    )
    await act(async () => {})
    const options = await openMenu(first.host)
    expect(options.length).toBe(1)
    expect(options[0]!.textContent).toContain(LOW)
    expect(options[0]?.disabled).toBe(false)
    act(() => first.root.unmount())
    first.host.remove()
  })
})

describe('the chat box ignores a state read that finished too late (D9-D11)', () => {
  it('D9: an older state read resolving after a newer one cannot restore stale options', async () => {
    const resolvers: Array<(value: AgyBarState) => void> = []
    const f = mountBar({
      getAgyChatState: () => new Promise<AgyBarState>((resolve) => resolvers.push(resolve)),
    } as AgyBarApi)
    await act(async () => f.root.render(createElement(AgyChatBar, { lang: 'en', api: f.bridge })))
    await act(async () => {})
    await act(async () => {
      for (const listener of f.listeners) listener()
      for (const listener of f.listeners) listener()
    })
    expect(resolvers.length).toBe(3) // the mount read plus the two notifications
    // the newest refresh answers first with a failed catalog
    resolvers[2](stateOf(HIGH, [HIGH, PRO], [], 'agy models timed out'))
    await act(async () => {})
    // the oldest answers afterwards with the old, confirmed list
    resolvers[0](stateOf(HIGH, [HIGH, PRO], [HIGH, PRO]))
    await act(async () => {})
    const options = await openMenu(f.host)
    expect(options.every((b) => b.disabled)).toBe(true)
    act(() => f.root.unmount())
    f.host.remove()
  })

  it('D10: a newer successful read is not erased by an older failure', async () => {
    const resolvers: Array<(value: AgyBarState) => void> = []
    const f = mountBar({
      getAgyChatState: () => new Promise<AgyBarState>((resolve) => resolvers.push(resolve)),
    } as AgyBarApi)
    await act(async () => f.root.render(createElement(AgyChatBar, { lang: 'en', api: f.bridge })))
    await act(async () => {})
    await act(async () => {
      for (const listener of f.listeners) listener()
    })
    expect(resolvers.length).toBe(2)
    resolvers[1](stateOf(HIGH, [HIGH], [HIGH]))
    await act(async () => {})
    resolvers[0](stateOf(HIGH, [HIGH], [], 'agy models timed out'))
    await act(async () => {})
    const options = await openMenu(f.host)
    expect(options[0]?.disabled).toBe(false)
    act(() => f.root.unmount())
    f.host.remove()
  })

  it('D11: unmounting while a read is pending leaves no listener behind', async () => {
    const resolvers: Array<(value: AgyBarState) => void> = []
    const f = mountBar({
      getAgyChatState: () => new Promise<AgyBarState>((resolve) => resolvers.push(resolve)),
    } as AgyBarApi)
    await act(async () => f.root.render(createElement(AgyChatBar, { lang: 'en', api: f.bridge })))
    await act(async () => {})
    act(() => f.root.unmount())
    f.host.remove()
    expect(f.listeners.length).toBe(0)
    // the pending read resolves after the component is gone: nothing is rendered, nothing throws
    resolvers[0](stateOf(LOW, [LOW], [LOW]))
    await act(async () => {})
    expect(f.host.querySelector('.agy-bar-model')).toBeNull()
  })

  it('D12: a failed state read after a successful earlier read marks selectedStatus as unverified and sets catalogError', async () => {
    let shouldFail = false
    const f = mountBar({
      getAgyChatState: async () => {
        if (shouldFail) throw new Error('connection lost')
        return {
          ...stateOf(HIGH, [HIGH], [HIGH]),
          selectedStatus: 'verified',
        }
      },
    } as AgyBarApi)
    await act(async () => f.root.render(createElement(AgyChatBar, { lang: 'en', api: f.bridge })))
    await act(async () => {})
    const chip = f.host.querySelector('.agy-bar-model')
    expect(chip).not.toBeNull()
    expect(chip?.getAttribute('data-status')).toBe('verified')

    // Subsequent read fails
    shouldFail = true
    await act(async () => {
      for (const listener of f.listeners) listener()
    })
    await act(async () => {})
    // The bar model button should show unverified status
    expect(chip?.getAttribute('data-status')).toBe('unverified')
    act(() => f.root.unmount())
    f.host.remove()
  })
})
