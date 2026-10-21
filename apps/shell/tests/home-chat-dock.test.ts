// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement } from 'react'
import { HomeChat } from '../src/renderer/src/HomeChat'
import { HOME_SEARCH_EVENT } from '../src/renderer/src/home-chat/dock-logic'
import { pickSlot } from '../src/renderer/src/home-chat/dock-slot'
import type { HomeApi } from '../src/shared/home-api'
import type { I18n } from '../src/renderer/src/locale'

const SLOT = 'home-assistant-slot'

const api = {
  getAiSettings: async () => ({ provider: 'openai', providers: {} }),
  setAiSettings: async () => undefined,
  onAiSettingsChanged: () => () => undefined,
  homeChatList: async () => [],
  homeChatSave: async () => null,
  getSettings: async () => ({}),
  kbList: async () => [],
} as unknown as HomeApi
const i18n = { lang: 'en', t: (key: string) => key } as I18n

const addSlot = (): HTMLElement => {
  const slot = document.createElement('div')
  slot.id = SLOT
  document.body.append(slot)
  return slot
}
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 40)))

let root: Root | null = null
let host: HTMLElement | null = null
const mount = async (props: Record<string, unknown> = {}) => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(createElement(HomeChat, { api, i18n, ...props })))
  await flush()
}
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  host?.remove()
  host = null
  document.getElementById(SLOT)?.remove()
})

describe('pickSlot', () => {
  it('keeps a node that is still attached', () => {
    const slot = addSlot()
    expect(pickSlot(document, SLOT, slot)).toBe(slot)
  })

  it('never returns a node that was detached', () => {
    const stale = addSlot()
    stale.remove()
    expect(pickSlot(document, SLOT, stale)).toBeNull()
    const fresh = addSlot()
    expect(pickSlot(document, SLOT, stale)).toBe(fresh)
  })
})

describe('Home dock', () => {
  it('is a plain field with a send button and a model row, and nothing floats', async () => {
    const slot = addSlot()
    await mount()
    const dock = slot.querySelector('.ask-dock')
    expect(dock).not.toBeNull()
    expect(dock!.querySelector(':scope > form.ask-form input')).not.toBeNull()
    expect(dock!.querySelector(':scope > form.ask-form button.ask-send')).not.toBeNull()
    expect(dock!.querySelector(':scope > .ask-extra')).not.toBeNull()
    for (const gone of ['.ask-intro', '.ask-bar', '.ask-glow', '.ask-ring']) {
      expect(dock!.querySelector(gone)).toBeNull()
    }
    expect(document.querySelector('.home-chat-launcher, .hc-dock, .home-chat-panel')).toBeNull()
  })

  it('follows the slot when the view re-mounts it without any prop changing', async () => {
    const first = addSlot()
    await mount()
    expect(first.querySelector('.ask-dock')).not.toBeNull()

    first.remove()
    const second = addSlot()
    await flush()
    expect(second.querySelector('.ask-dock')).not.toBeNull()
    expect(document.querySelectorAll('.ask-dock')).toHaveLength(1)
  })

  it('comes back when the slot appears after the chat has mounted', async () => {
    await mount()
    expect(document.querySelector('.ask-dock')).toBeNull()
    const slot = addSlot()
    await flush()
    expect(slot.querySelector('.ask-dock')).not.toBeNull()
  })

  it('hands a sent question to the Ask AI page', async () => {
    const slot = addSlot()
    const onOpenAskWorkspace = vi.fn()
    await mount({ onOpenAskWorkspace })
    const input = slot.querySelector<HTMLInputElement>('.ask-form input')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(input, 'What is in budget.xlsx?')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      slot
        .querySelector('.ask-form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(onOpenAskWorkspace).toHaveBeenCalledTimes(1)
  })

  it('runs the Home search as you type, offers Ask AI, and ends the search when cleared', async () => {
    const slot = addSlot()
    await mount()
    const seen: Array<{ q: string; source?: string }> = []
    const listener = (event: Event) => seen.push((event as CustomEvent).detail)
    window.addEventListener(HOME_SEARCH_EVENT, listener)
    const input = slot.querySelector<HTMLInputElement>('.ask-form input')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    const type = async (value: string) => {
      await act(async () => {
        setValue.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => new Promise((resolve) => setTimeout(resolve, 300)))
    }
    try {
      await type('budget')
      expect(seen).toEqual([{ q: 'budget', source: 'dock' }])
      // no results list of its own: Home shows them, the box only offers Ask AI
      expect(slot.querySelector('.ask-hit')).toBeNull()
      await type('why is budget late?')
      expect(seen.at(-1)).toEqual({ q: '', source: 'dock' })
      await type('budget')
      await type('')
      expect(seen.at(-1)).toEqual({ q: '', source: 'dock' })
      const before = seen.length
      await type('')
      expect(seen).toHaveLength(before)
    } finally {
      window.removeEventListener(HOME_SEARCH_EVENT, listener)
    }
  })

  it('hides the model and usage row while a search is typed, and brings it back when cleared', async () => {
    const slot = addSlot()
    await mount()
    const input = slot.querySelector<HTMLInputElement>('.ask-form input')!
    const extra = () => slot.querySelector('.ask-extra')
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    const type = async (value: string) => {
      await act(async () => {
        setValue.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    expect(extra()).not.toBeNull()
    expect(extra()!.classList.contains('is-hidden')).toBe(false)
    await type('budget')
    expect(extra()).not.toBeNull()
    expect(extra()!.classList.contains('is-hidden')).toBe(true)
    await type('')
    expect(extra()!.classList.contains('is-hidden')).toBe(false)
  })

  it('shows the chat panel only on the Ask AI page', async () => {
    addSlot()
    await mount({ workspaceActive: true, suppressDock: true })
    expect(document.querySelector('.home-chat-panel')).not.toBeNull()
    expect(document.querySelector('.ask-dock')).toBeNull()
  })
})
