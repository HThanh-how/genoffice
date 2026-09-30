/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAiSettings } from '@genoffice/ai-provider'
import type { AiSettings, CodexModelCatalog } from '@genoffice/ai-provider'
import type { HomeApi } from '../src/shared/home-api'
import { LocaleProvider } from '../src/renderer/src/locale'
import { SettingsModal } from '../src/renderer/src/SettingsModal'

const DEBOUNCE_MS = 400
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let calls: Array<{
  provider: string
  config: { apiKey: string; model: string; baseUrl?: string }
  resolve: (catalog: CodexModelCatalog) => void
}>

beforeEach(() => {
  vi.useFakeTimers()
  calls = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function settings(model = ''): AiSettings {
  const value = defaultAiSettings()
  value.provider = 'mistral'
  value.providers.mistral = { apiKey: 'key-one', model }
  return value
}

function installApi(value: AiSettings): void {
  window.aiOffice = {
    getTheme: async () => 'system',
    getDefaultSaveDir: async () => '',
    getAnalyticsEnabled: async () => true,
    setAnalyticsEnabled: async () => true,
    getAiPanelPrefs: async () => ({ fontSize: 'medium', customFontSize: 14, spellcheck: true }),
    setAiPanelPrefs: async (patch: unknown) => patch,
    getUpdateChannel: async () => 'stable',
    getAppVersion: async () => '1.0.0',
    githubStars: async () => null,
    getAiProviders: () => [
      {
        id: 'mistral',
        label: 'Mistral',
        models: [],
        defaultModel: '',
        keyPlaceholder: 'key',
      },
    ],
    getAiSettings: async () => value,
    setAiSettings: async () => undefined,
    getProviderModels: (
      provider: string,
      config: { apiKey: string; model: string; baseUrl?: string },
    ) => new Promise<CodexModelCatalog>((resolve) => calls.push({ provider, config, resolve })),
  } as unknown as HomeApi
}

async function openSettings(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(SettingsModal, {
          status: null,
          loggingOut: false,
          loginWaiting: false,
          loginUrl: null,
          urlCopied: false,
          onOpenLoginUrl: vi.fn(),
          onCopyLoginUrl: vi.fn(),
          onClose: vi.fn(),
          onLogin: vi.fn(),
          onLogout: vi.fn(),
        }),
      ),
    )
    await Promise.resolve()
  })
  const nav = Array.from(host.querySelectorAll<HTMLButtonElement>('.set-nav-item')).find((button) =>
    button.textContent?.includes('AI Model'),
  )
  await click(nav!)
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click()
    await Promise.resolve()
  })
}

async function tick(ms = DEBOUNCE_MS): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function answer(index: number, models: string[]): Promise<void> {
  await act(async () => {
    calls[index]!.resolve({ models, defaultModel: '' })
    await Promise.resolve()
  })
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

async function modelOptions(): Promise<string[]> {
  const trigger = host.querySelector<HTMLButtonElement>('.gs-dd-btn[aria-label="Model"]')!
  await click(trigger)
  const options = Array.from(host.querySelectorAll<HTMLButtonElement>('.gs-dd-pop [role="option"]'))
  const labels = options.map((option) => option.getAttribute('aria-label') ?? option.textContent!)
  await click(trigger)
  return labels
}

describe('provider model discovery in Settings', () => {
  it('fetches on API-key edits and keeps a saved model pinned above the live list', async () => {
    installApi(settings('saved-model'))
    await openSettings()
    await tick()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ provider: 'mistral', config: { apiKey: 'key-one' } })

    await answer(0, ['live-a', 'live-b'])
    expect(await modelOptions()).toEqual(['saved-model', 'live-a', 'live-b'])

    await type(host.querySelector<HTMLInputElement>('#set-ai-key')!, 'key-two')
    await tick()
    expect(calls).toHaveLength(2)
    expect(calls[1]?.config.apiKey).toBe('key-two')
  })

  it('ignores an older response after a newer key request completes', async () => {
    installApi(settings())
    await openSettings()
    await tick()
    expect(calls).toHaveLength(1)

    await type(host.querySelector<HTMLInputElement>('#set-ai-key')!, 'key-two')
    await tick()
    expect(calls).toHaveLength(2)
    await answer(1, ['from-current-key'])
    await answer(0, ['stale-from-old-key'])
    expect(await modelOptions()).toEqual(['from-current-key'])
  })

  it('lets the user refresh the provider list manually', async () => {
    installApi(settings())
    await openSettings()
    await tick()
    await answer(0, ['initial'])

    const refresh = Array.from(
      host.querySelectorAll<HTMLButtonElement>('.set-model-discovery button'),
    ).find((button) => button.textContent?.toLowerCase().includes('refresh'))
    expect(refresh).toBeDefined()
    await click(refresh!)
    await tick()
    expect(calls).toHaveLength(2)
    await answer(1, ['refreshed'])
    expect(await modelOptions()).toEqual(['refreshed'])
  })
})
