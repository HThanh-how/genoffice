/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { LocaleProvider } from '../src/renderer/src/locale'
import { LocalModelReadyCard } from '../src/renderer/src/fork/LocalModelReadyCard'
import { useLocalModelOffer } from '../src/renderer/src/fork/useLocalModelOffer'
import type { LocalModelStartup } from '../src/shared/local-model'

const notify = vi.hoisted(() => vi.fn())
vi.mock('../src/renderer/src/ui-feedback', () => ({ appNotify: notify }))
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let offered: boolean
let downloaded: () => void
let changed: () => void
let startup: (s: LocalModelStartup) => void
const api = {
  onLocalModelDownloaded: (fn: () => void) => {
    downloaded = fn
    return () => {}
  },
  onLocalModelStartup: (fn: (s: LocalModelStartup) => void) => {
    startup = fn
    return () => {}
  },
  localModelOffer: vi.fn(async () => offered),
  onLocalModelOfferChanged: (fn: () => void) => {
    changed = fn
    return () => {}
  },
  onAiSettingsChanged: () => () => {},
  localModelAnswerOffer: vi.fn(async () => {}),
  getAiSettings: vi.fn(async () => ({ provider: 'gemini', providers: { gemini: { model: 'x' } } })),
  setAiSettings: vi.fn(async () => {}),
}

function Probe() {
  const offer = useLocalModelOffer()
  return offer.visible ? createElement(LocalModelReadyCard, { offer }) : null
}
const mount = () =>
  act(async () =>
    root.render(createElement(LocaleProvider, { initial: 'en', children: createElement(Probe) })),
  )
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text)!

beforeEach(() => {
  vi.clearAllMocks()
  api.setAiSettings.mockResolvedValue(undefined)
  offered = true
  ;(window as unknown as { aiOffice: unknown }).aiOffice = api
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (window as { aiOffice?: unknown }).aiOffice
})

describe('LocalModelReadyCard', () => {
  it('toasts a finished download and shows no card without an offer', async () => {
    offered = false
    await mount()
    await act(async () => downloaded())
    expect(notify).toHaveBeenCalledWith('Local AI is downloaded', 'success')
    expect(host.textContent).toBe('')
  })

  it('appears and disappears with the offer', async () => {
    offered = false
    await mount()
    offered = true
    await act(async () => changed())
    expect(host.textContent).toContain('Use Local AI now?')
    offered = false
    await act(async () => changed())
    expect(host.textContent).toBe('')
  })

  it('Use Now saves the provider and then answers', async () => {
    await mount()
    await act(async () => button('Use Now').click())
    expect(api.setAiSettings).toHaveBeenCalledWith({
      provider: 'local',
      providers: { gemini: { model: 'x' } },
    })
    expect(api.localModelAnswerOffer).toHaveBeenCalledWith('use')
    expect(api.setAiSettings.mock.invocationCallOrder[0]).toBeLessThan(
      api.localModelAnswerOffer.mock.invocationCallOrder[0]!,
    )
    expect(host.textContent).toBe('Starting Local AI…')
  })

  it('keeps the card, unanswered, when the provider could not be saved', async () => {
    api.setAiSettings.mockRejectedValue(new Error('not saved'))
    await mount()
    await act(async () => button('Use Now').click())
    expect(api.localModelAnswerOffer).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('not saved', 'error')
    expect(button('Use Now').disabled).toBe(false)
  })

  it('follows the start: real steps, a value only while loading, then ready, then gone', async () => {
    await mount()
    offered = false
    await act(async () => button('Use Now').click())
    const bar = () => host.querySelector('progress')!
    expect(bar().hasAttribute('value')).toBe(false)
    await act(async () => startup({ phase: 'loading', percent: 40 }))
    expect(host.textContent).toBe('Loading the model into memory · 40%')
    expect(bar().getAttribute('value')).toBe('40')
    await act(async () => startup({ phase: 'preparing' }))
    expect(host.textContent).toBe('Preparing Local AI…')
    expect(bar().hasAttribute('value')).toBe(false)
    vi.useFakeTimers()
    try {
      await act(async () => startup({ phase: 'ready' }))
      expect(host.textContent).toBe('Local AI is ready to chat')
      await act(async () => vi.advanceTimersByTime(5000))
      expect(host.textContent).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('says why a start failed and stays until closed; hiding progress keeps it hidden', async () => {
    offered = false
    await mount()
    await act(async () => startup({ phase: 'starting' }))
    const close = () => host.querySelector<HTMLButtonElement>('.star-prompt-close')!.click()
    await act(async () => close())
    await act(async () => startup({ phase: 'loading', percent: 60 }))
    expect(host.textContent).toBe('')
    await act(async () => startup({ phase: 'failed', error: 'Not enough free memory.' }))
    expect(host.textContent).toContain('Not enough free memory.')
    expect(host.textContent).toContain('will try again when you send a message')
    await act(async () => close())
    expect(host.textContent).toBe('')
    expect(api.localModelAnswerOffer).not.toHaveBeenCalled()
  })

  it('Later and the close button only answer', async () => {
    await mount()
    await act(async () => button('Later').click())
    await act(async () => changed())
    await act(async () => host.querySelector<HTMLButtonElement>('.star-prompt-close')!.click())
    expect(api.localModelAnswerOffer.mock.calls).toEqual([['later'], ['later']])
    expect(api.setAiSettings).not.toHaveBeenCalled()
  })
})
