/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAiSettings } from '@genoffice/ai-provider'
import type { AiSettings } from '@genoffice/ai-provider'
import type { HomeApi } from '../src/shared/home-api'
import type {
  LocalModelApi,
  LocalModelSelectOutcome,
  LocalModelState,
} from '../src/shared/fork/local-model-api'

// confirmations are answered by the test; everything else in ui-feedback stays real
const confirm = vi.hoisted(() => ({ answer: true, messages: [] as string[] }))
vi.mock('../src/renderer/src/ui-feedback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/ui-feedback')>()
  return {
    ...actual,
    appConfirm: vi.fn(async (message: string) => {
      confirm.messages.push(message)
      return confirm.answer
    }),
  }
})

import { LocaleProvider } from '../src/renderer/src/locale'
import {
  LOCAL_MODEL_FAST_POLL_MS,
  LOCAL_MODEL_SLOW_POLL_MS,
  LocalModelSettings,
} from '../src/renderer/src/fork/LocalModelSettings'
import { SettingsModal } from '../src/renderer/src/SettingsModal'

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const TOTAL = 1_099_627_808
const st = (patch: Partial<LocalModelState> = {}): LocalModelState => ({
  status: 'not-installed',
  modelId: 'lfm3-vl-2b-q4_k_m',
  totalBytes: TOTAL,
  ...patch,
})

let host: HTMLDivElement
let root: Root
let current: LocalModelState
let calls: string[]
let api: { [K in keyof LocalModelApi]: ReturnType<typeof vi.fn> }

function install(overrides: Partial<Record<keyof LocalModelApi, (...a: never[]) => unknown>> = {}) {
  api = {
    getLocalModelState: vi.fn(async () => current),
    downloadLocalModel: vi.fn(async () => {
      calls.push('download')
      current = st({ status: 'downloading', doneBytes: 0 })
      return current
    }),
    cancelLocalModelDownload: vi.fn(async () => {
      calls.push('cancel')
      current = st()
      return current
    }),
    deleteLocalModel: vi.fn(async () => {
      calls.push('delete')
      current = st()
      return current
    }),
    selectExistingLocalModel: vi.fn(async (): Promise<LocalModelSelectOutcome> => {
      calls.push('select')
      return { ok: false, cancelled: true, state: current }
    }),
  }
  for (const [key, fn] of Object.entries(overrides)) {
    ;(api as Record<string, ReturnType<typeof vi.fn>>)[key] = vi.fn(fn as never)
  }
  window.aiOffice = { ...(window.aiOffice ?? {}), ...api } as unknown as HomeApi
}

/** lets every chained promise of an action settle */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })
}

async function mountCard(): Promise<void> {
  await act(async () => {
    root.render(createElement(LocaleProvider, { initial: 'en' }, createElement(LocalModelSettings)))
  })
  await flush()
}

const text = () => host.textContent ?? ''
const buttons = () => Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
const button = (label: string) => buttons().find((b) => b.textContent === label)
const labels = () => buttons().map((b) => b.textContent)
const status = () => host.querySelector('[data-testid="local-model-status"]')?.getAttribute('data-status')

async function click(label: string): Promise<void> {
  const target = button(label)
  if (!target) throw new Error(`no button "${label}" in [${labels().join(', ')}]`)
  await act(async () => {
    target.click()
  })
  await flush()
}

beforeEach(() => {
  calls = []
  confirm.answer = true
  confirm.messages = []
  current = st()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('LocalModelSettings card', () => {
  it('shows the model and the not-installed actions', async () => {
    install()
    await mountCard()
    expect(host.querySelector('[data-testid="local-model-name"]')?.textContent).toBe(
      'LFM3-VL-2B-Q4_K_M · 1.10 GB',
    )
    expect(status()).toBe('not-installed')
    expect(text()).toContain('Not installed')
    expect(labels()).toEqual(['Download', 'Select existing file…'])
  })

  it('offers to resume a partial download', async () => {
    current = st({ partialBytes: 312_000_000 })
    install()
    await mountCard()
    expect(text()).toContain('312 MB already downloaded')
    expect(button('Resume download')).toBeDefined()
  })

  it('starts a download and shows progress with a cancel action', async () => {
    install({
      downloadLocalModel: async () => {
        calls.push('download')
        current = st({ status: 'downloading', doneBytes: 549_813_904 })
        return current
      },
    })
    await mountCard()
    await click('Download')
    expect(calls).toEqual(['download'])
    expect(status()).toBe('downloading')
    expect(host.querySelector('progress')?.getAttribute('value')).toBe('549813904')
    expect(text()).toContain('550 MB of 1.10 GB (50%)')
    expect(labels()).toEqual(['Cancel download'])
  })

  it('cancels only after confirmation', async () => {
    current = st({ status: 'downloading', doneBytes: 1_000_000 })
    install()
    await mountCard()
    confirm.answer = false
    await click('Cancel download')
    expect(calls).toEqual([])
    confirm.answer = true
    await click('Cancel download')
    expect(calls).toEqual(['cancel'])
    expect(status()).toBe('not-installed')
  })

  it('shows a downloaded model with re-download and delete', async () => {
    current = st({ status: 'ready', source: 'downloaded', path: 'C:/u/local-models/x.gguf' })
    install()
    await mountCard()
    expect(text()).toContain('Ready')
    expect(text()).toContain('Downloaded by GenOffice')
    expect(labels()).toEqual(['Re-download', 'Delete model'])
    await click('Delete model')
    expect(confirm.messages[0]).toContain('Delete the downloaded model?')
    expect(calls).toEqual(['delete'])
    expect(status()).toBe('not-installed')
  })

  it('says a chosen file is only forgotten, not deleted', async () => {
    current = st({ status: 'ready', source: 'selected', path: 'D:\\models\\my-copy.gguf' })
    install()
    await mountCard()
    expect(text()).toContain('Your file: D:\\models\\my-copy.gguf')
    await click('Delete model')
    expect(confirm.messages[0]).toContain('Your file stays where it is')
  })

  describe('re-download', () => {
    beforeEach(() => {
      current = st({ status: 'ready', source: 'downloaded', path: 'C:/u/x.gguf' })
    })

    it('deletes first, then downloads', async () => {
      install()
      await mountCard()
      await click('Re-download')
      expect(calls).toEqual(['delete', 'download'])
      expect(status()).toBe('downloading')
    })

    it('does not download when the delete call fails', async () => {
      install({
        deleteLocalModel: async () => {
          calls.push('delete')
          throw new Error('EBUSY')
        },
      })
      await mountCard()
      await click('Re-download')
      expect(calls).toEqual(['delete'])
      expect(text()).toContain('could not be deleted, so no new download was started')
    })

    it('does not download when the model is still there after the delete', async () => {
      install({
        deleteLocalModel: async () => {
          calls.push('delete')
          return current // still ready
        },
      })
      await mountCard()
      await click('Re-download')
      expect(calls).toEqual(['delete'])
      expect(text()).toContain('could not be deleted')
    })

    it('does nothing when the confirmation is declined', async () => {
      install()
      await mountCard()
      confirm.answer = false
      await click('Re-download')
      expect(calls).toEqual([])
    })
  })

  describe('select existing file', () => {
    it('shows "verifying" while the file is hashed and disables the buttons', async () => {
      let finish!: (outcome: LocalModelSelectOutcome) => void
      install({
        selectExistingLocalModel: () =>
          new Promise<LocalModelSelectOutcome>((resolve) => {
            finish = resolve
          }),
      })
      await mountCard()
      await click('Select existing file…')
      expect(text()).toContain('Verifying the file…')
      expect(buttons().every((b) => b.disabled)).toBe(true)
      current = st({ status: 'ready', source: 'selected', path: 'D:\\m.gguf' })
      await act(async () => finish({ ok: true, state: current }))
      await flush()
      expect(status()).toBe('ready')
      expect(text()).not.toContain('Verifying')
    })

    it('shows why a wrong file was refused', async () => {
      install({
        selectExistingLocalModel: async (): Promise<LocalModelSelectOutcome> => {
          current = st({
            status: 'error',
            error: { code: 'wrong-model', message: 'other.gguf is not LFM3-VL-2B-Q4_K_M.gguf' },
          })
          return { ok: false, error: current.error!, state: current }
        },
      })
      await mountCard()
      await click('Select existing file…')
      expect(status()).toBe('error')
      expect(text()).toContain('other.gguf is not LFM3-VL-2B-Q4_K_M.gguf')
    })

    it('changes nothing when the dialog is closed', async () => {
      install()
      await mountCard()
      await click('Select existing file…')
      expect(calls).toEqual(['select'])
      expect(status()).toBe('not-installed')
      expect(host.querySelector('[role="alert"]')).toBeNull()
    })
  })

  it('shows an error with resume, select and delete when bytes remain', async () => {
    current = st({
      status: 'error',
      partialBytes: 40_000_000,
      error: { code: 'network', message: 'The host is unreachable or too slow.' },
    })
    install()
    await mountCard()
    expect(text()).toContain('The host is unreachable or too slow.')
    expect(labels()).toEqual(['Resume download', 'Select existing file…', 'Delete model'])
  })

  it('polls fast while downloading, slowly otherwise, and stops when unmounted', async () => {
    vi.useFakeTimers()
    current = st({ status: 'downloading', doneBytes: 0 })
    install()
    await mountCard()
    const polls = () => api.getLocalModelState.mock.calls.length
    const start = polls()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOCAL_MODEL_FAST_POLL_MS)
    })
    expect(polls()).toBe(start + 1)

    current = st({ status: 'ready', source: 'downloaded', path: 'C:/x' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOCAL_MODEL_FAST_POLL_MS) // picks up "ready"
    })
    const afterReady = polls()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOCAL_MODEL_SLOW_POLL_MS - 100)
    })
    expect(polls()).toBe(afterReady)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(polls()).toBe(afterReady + 1)

    act(() => root.unmount())
    const atUnmount = polls()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOCAL_MODEL_SLOW_POLL_MS * 3)
    })
    expect(polls()).toBe(atUnmount)
    root = createRoot(host) // afterEach unmounts again
  })
})

describe('Settings → AI Model with provider "local"', () => {
  function installSettings(provider: AiSettings['provider']) {
    const settings = defaultAiSettings(undefined, false)
    settings.provider = provider
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
        { id: 'gemini', label: 'Gemini', models: ['gemini-3.8-flash'], defaultModel: 'gemini-3.8-flash', keyPlaceholder: 'AIza...', defaultBaseUrl: '' },
        { id: 'local', label: 'Local (llama.cpp)', models: ['lfm3-vl-2b-q4_k_m'], defaultModel: 'lfm3-vl-2b-q4_k_m', keyPlaceholder: '', needsCliPath: true, defaultBaseUrl: '' },
      ],
      getAiSettings: async () => settings,
      setAiSettings: vi.fn(async () => undefined),
      getProviderModels: async () => ({ models: [], defaultModel: '' }),
      getGeminiModels: async () => [],
    } as unknown as HomeApi
    install()
  }

  async function openAiPane(): Promise<void> {
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
    })
    await flush()
    const nav = Array.from(host.querySelectorAll<HTMLButtonElement>('.set-nav-item')).find((b) =>
      b.textContent?.includes('AI Model'),
    )
    await act(async () => nav!.click())
    await flush()
  }

  it('shows the local model card and hides the API key and Base URL fields', async () => {
    installSettings('local')
    await openAiPane()
    expect(host.querySelector('section[aria-label="Local AI model"]')).not.toBeNull()
    expect(host.querySelector('#set-ai-key')).toBeNull()
    expect(host.querySelector('#set-ai-base-url')).toBeNull()
    expect(host.querySelector('.set-model-discovery')).toBeNull()
  })

  it('leaves other providers unchanged: key and Base URL shown, no local card', async () => {
    installSettings('gemini')
    await openAiPane()
    expect(host.querySelector('section[aria-label="Local AI model"]')).toBeNull()
    expect(host.querySelector('#set-ai-key')).not.toBeNull()
    expect(host.querySelector('#set-ai-base-url')).not.toBeNull()
  })
})
