/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import type { StorageStartupState } from '../src/shared/fork/storage-startup'
import { LocaleProvider } from '../src/renderer/src/locale'
import { StorageStartupBanner } from '../src/renderer/src/StorageStartupBanner'
import { strings } from '../src/renderer/src/strings'

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let push: (state: StorageStartupState) => void

function installApi(initial: StorageStartupState): void {
  const listeners = new Set<(state: StorageStartupState) => void>()
  push = (state) => listeners.forEach((fn) => fn(state))
  ;(window as unknown as { aiOffice: unknown }).aiOffice = {
    getStorageStartupState: async () => initial,
    onStorageStartupChanged: (fn: (state: StorageStartupState) => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

async function mount(initial: StorageStartupState, lang: 'en' | 'vi' = 'en'): Promise<void> {
  installApi(initial)
  await act(async () => {
    root.render(
      createElement(LocaleProvider, {
        initial: lang,
        children: createElement(StorageStartupBanner),
      }),
    )
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (window as { aiOffice?: unknown }).aiOffice
})

describe('StorageStartupBanner', () => {
  it('shows the live percentage while the index is upgraded, then disappears when it is ready', async () => {
    await mount({ phase: 'migrating', percent: 42 })
    expect(host.textContent).toContain(strings.en.storageStartupTitlePercent.replace('{n}', '42'))
    expect((host.querySelector('.storage-startup-fill') as HTMLElement).style.width).toBe('42%')
    await act(async () => push({ phase: 'migrating', percent: 77 }))
    expect(host.textContent).toContain('77%')
    await act(async () => push({ phase: 'ready', percent: null }))
    expect(host.querySelector('.storage-startup')).toBeNull()
  })

  it('shows an indeterminate bar while the database is only being checked', async () => {
    await mount({ phase: 'checking', percent: null })
    expect(host.textContent).toContain(strings.en.storageStartupTitle)
    expect(host.querySelector('.storage-startup-fill.indeterminate')).not.toBeNull()
  })

  it('says so when the index stays closed this run, and is localised', async () => {
    await mount({ phase: 'unavailable', percent: null }, 'vi')
    expect(host.textContent).toContain(strings.vi.storageStartupUnavailable)
  })

  it('renders nothing when the start-up API is not there', async () => {
    delete (window as { aiOffice?: unknown }).aiOffice
    ;(window as unknown as { aiOffice: unknown }).aiOffice = {}
    await act(async () => {
      root.render(
        createElement(LocaleProvider, {
          initial: 'en',
          children: createElement(StorageStartupBanner),
        }),
      )
    })
    expect(host.querySelector('.storage-startup')).toBeNull()
  })
})
