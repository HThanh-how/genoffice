/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { BootErrorScreen, RootErrorBoundary, bootErrorStrings } from '../src/renderer/src/BootError'
import { strings } from '../src/renderer/src/strings'
import { HOME_CHANNELS } from '../src/shared/home-api'
import { INTEGRATIONS_CHANNELS } from '../src/shared/integrations-api'
import { loadShellPreload } from './helpers/preload-harness'

/**
 * A shell window that throws while it boots used to stay white: nothing caught the exception, so the person saw an
 * empty frame and we saw nothing. These tests boot the real renderer entry (main.tsx) on top of the real preload
 * surface and check both outcomes — it paints Home, and when a start-up call is missing it shows the error screen.
 */

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  document.documentElement.lang = 'en'
  // jsdom lacks the layout APIs Home touches on mount
  Element.prototype.scrollTo ??= function scrollTo(): void {}
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
  document.body.innerHTML = ''
  delete (window as { aiOffice?: unknown }).aiOffice
  delete (window as { aiOfficeTabs?: unknown }).aiOfficeTabs
})

/** what an idle main process answers on the channels Home indexes into as soon as it mounts */
const IDLE_MAIN: Record<string, unknown> = {
  [HOME_CHANNELS.folderRoots]: [],
  [INTEGRATIONS_CHANNELS.status]: { agents: [] },
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
  throw new Error(
    `timed out waiting for ${label}; #root = ${document.getElementById('root')?.innerHTML.slice(0, 300)}`,
  )
}

describe('shell renderer boot', () => {
  it('paints the home frame on the real preload surface', async () => {
    await loadShellPreload(window as unknown as Record<string, unknown>, IDLE_MAIN)
    await import('../src/renderer/src/main')
    await waitFor(() => !!document.querySelector('.app-frame'), 'the app frame')
    expect(document.querySelector('.boot-error')).toBeNull()
  })

  it('shows the error screen, not a blank window, when a start-up preload call is missing', async () => {
    await loadShellPreload(window as unknown as Record<string, unknown>, IDLE_MAIN)
    // the shape of a bad merge: the API object exists but a method the entry calls first is gone
    delete (window.aiOffice as unknown as Record<string, unknown>).getLanguage
    await import('../src/renderer/src/main')
    await waitFor(() => !!document.querySelector('.boot-error'), 'the error screen')
    const root = document.getElementById('root')!
    expect(root.textContent).toContain('getLanguage')
    expect(root.textContent).toContain(strings.en.bootErrorTitle)
    expect(root.querySelectorAll('button')).toHaveLength(2)
  })

  it('shows the error screen when window.aiOffice is absent altogether (preload did not load)', async () => {
    await import('../src/renderer/src/main')
    await waitFor(() => !!document.querySelector('.boot-error'), 'the error screen')
    // the entry's first call reads a property of the missing API object
    expect(document.getElementById('root')!.textContent).toMatch(/reading 'getLanguage'/)
  })
})

describe('RootErrorBoundary and the error screen', () => {
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

  function Boom(): never {
    throw new Error('Cannot read properties of undefined (reading recents)')
  }

  it('replaces a throwing subtree with the error screen carrying the message', () => {
    act(() => {
      root.render(createElement(RootErrorBoundary, { lang: 'en', children: createElement(Boom) }))
    })
    expect(host.querySelector('.boot-error')).not.toBeNull()
    expect(host.textContent).toContain('Cannot read properties of undefined (reading recents)')
  })

  it('renders healthy children untouched', () => {
    act(() => {
      root.render(
        createElement(RootErrorBoundary, { children: createElement('p', { id: 'ok' }, 'fine') }),
      )
    })
    expect(host.querySelector('#ok')?.textContent).toBe('fine')
    expect(host.querySelector('.boot-error')).toBeNull()
  })

  it('copies the full error text and reloads on demand', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const onReload = vi.fn()
    const error = new Error('boom')
    act(() => {
      root.render(createElement(BootErrorScreen, { error, lang: 'en', onReload }))
    })
    const [copy, reload] = [...host.querySelectorAll('button')]
    await act(async () => {
      copy!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(writeText).toHaveBeenCalledTimes(1)
    expect((writeText.mock.calls[0] as unknown as [string])[0]).toContain('Error: boom')
    expect(copy!.textContent).toBe(strings.en.bootErrorCopied)
    act(() => {
      reload!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('has its text in every UI language and falls back to English for an unknown one', () => {
    for (const lang of Object.keys(strings)) {
      const words = bootErrorStrings(lang)
      expect(words.bootErrorTitle.length, lang).toBeGreaterThan(0)
      expect(words).toBe((strings as Record<string, unknown>)[lang])
    }
    expect(bootErrorStrings('xx-YY')).toBe(strings.en)
    expect(bootErrorStrings('ja-JP')).toBe(strings.ja)
  })
})
