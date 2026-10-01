/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HomeApi } from '../src/shared/home-api'
import type { ClipboardSuggestion } from '../src/shared/clipboard-suggest-api'
import { CLIPBOARD_VISIBLE_MS } from '../src/shared/clipboard-suggest-api'
import { LocaleProvider, useI18n } from '../src/renderer/src/locale'
import { SettingsModal } from '../src/renderer/src/SettingsModal'
import { ClipboardSuggest } from '../src/renderer/src/ClipboardSuggest'
import { CHAT_PREFILL_EVENT } from '../src/renderer/src/chat-events'
import type { ChatPrefillDetail } from '../src/renderer/src/chat-events'

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
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
  vi.useRealTimers()
})

async function click(button: Element): Promise<void> {
  await act(async () => {
    ;(button as HTMLButtonElement).click()
    await Promise.resolve()
  })
}

describe('Settings clipboard suggestions', () => {
  it('is off by default and flips only after persistence succeeds', async () => {
    const persist = vi
      .fn<(enabled: boolean) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    window.aiOffice = {
      getTheme: async () => 'system',
      getDefaultSaveDir: async () => '',
      getAnalyticsEnabled: async () => true,
      setAnalyticsEnabled: async () => true,
      getClipboardSuggestEnabled: async () => false,
      setClipboardSuggestEnabled: persist,
      getUpdateChannel: async () => 'stable',
      getAppVersion: async () => '1.0.0',
      githubStars: async () => null,
    } as unknown as HomeApi

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
    const general = Array.from(host.querySelectorAll<HTMLButtonElement>('.set-nav-item')).find(
      (b) => b.textContent?.includes('General'),
    )
    await click(general!)

    const toggle = host.querySelector<HTMLButtonElement>(
      '.set-switch[aria-label="Suggest actions for what I copy"]',
    )
    expect(toggle?.getAttribute('aria-checked')).toBe('false')
    expect(host.textContent).toContain('nothing is sent to any AI until you click')

    await click(toggle!)
    expect(persist).toHaveBeenLastCalledWith(true)
    expect(toggle?.getAttribute('aria-checked')).toBe('false')
    await click(toggle!)
    expect(toggle?.getAttribute('aria-checked')).toBe('true')
  })
})

describe('ClipboardSuggest chip', () => {
  const suggestion: ClipboardSuggestion = {
    id: 'abc',
    kind: 'longText',
    preview: 'A long paragraph about the quarterly plan…',
    actions: ['summarize', 'translate', 'rewrite'],
    truncated: false,
  }

  function mount(api: Partial<HomeApi>, lang: 'en' | 'vi' = 'en') {
    function Probe() {
      const i18n = useI18n()
      return createElement(ClipboardSuggest, { api: api as HomeApi, i18n })
    }
    return act(async () => {
      root.render(createElement(LocaleProvider, { initial: lang }, createElement(Probe)))
      await Promise.resolve()
    })
  }

  it('renders nothing when there is no suggestion', async () => {
    await mount({
      getClipboardSuggestion: async () => null,
      onClipboardSuggestion: () => () => {},
    })
    expect(host.querySelector('.clip-suggest')).toBeNull()
  })

  it('prefills the chat (without sending) with the full text on click and then dismisses', async () => {
    const dismiss = vi.fn(async () => {})
    const fetchText = vi.fn(async () => 'FULL TEXT BODY')
    const events: ChatPrefillDetail[] = []
    const listener = (e: Event) => events.push((e as CustomEvent<ChatPrefillDetail>).detail)
    window.addEventListener(CHAT_PREFILL_EVENT, listener)
    await mount({
      getClipboardSuggestion: async () => suggestion,
      onClipboardSuggestion: () => () => {},
      getClipboardSuggestionText: fetchText,
      dismissClipboardSuggestion: dismiss,
    })
    expect(host.querySelector('.clip-suggest')).not.toBeNull()
    expect(fetchText).not.toHaveBeenCalled() // nothing is read until a click
    const buttons = Array.from(host.querySelectorAll('.clip-suggest-action'))
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Summarize',
      'Translate to English',
      'Rewrite',
    ])
    await click(buttons[0])
    window.removeEventListener(CHAT_PREFILL_EVENT, listener)
    expect(fetchText).toHaveBeenCalledWith('abc')
    expect(events).toEqual([{ text: 'Summarize:\n\nFULL TEXT BODY', send: false }])
    expect(dismiss).toHaveBeenCalledWith('abc')
    expect(host.querySelector('.clip-suggest')).toBeNull()
  })

  it('"Turn off" disables the feature; Escape dismisses; chip auto-hides', async () => {
    vi.useFakeTimers()
    const setEnabled = vi.fn(async () => true)
    const dismiss = vi.fn(async () => {})
    await mount({
      getClipboardSuggestion: async () => suggestion,
      onClipboardSuggestion: () => () => {},
      setClipboardSuggestEnabled: setEnabled,
      dismissClipboardSuggestion: dismiss,
    })
    await act(async () => {
      vi.advanceTimersByTime(CLIPBOARD_VISIBLE_MS + 10)
    })
    expect(host.querySelector('.clip-suggest')).toBeNull()

    await mount({
      getClipboardSuggestion: async () => ({ ...suggestion, id: 'def' }),
      onClipboardSuggestion: () => () => {},
      setClipboardSuggestEnabled: setEnabled,
      dismissClipboardSuggestion: dismiss,
    })
    const chip = host.querySelector('.clip-suggest')!
    await act(async () => {
      chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(dismiss).toHaveBeenCalledWith('def')
    expect(host.querySelector('.clip-suggest')).toBeNull()

    await mount({
      getClipboardSuggestion: async () => ({ ...suggestion, id: 'ghi' }),
      onClipboardSuggestion: () => () => {},
      setClipboardSuggestEnabled: setEnabled,
      dismissClipboardSuggestion: dismiss,
    })
    await click(host.querySelector('.clip-suggest-off')!)
    expect(setEnabled).toHaveBeenCalledWith(false)
    expect(host.querySelector('.clip-suggest')).toBeNull()
  })

  it('localizes labels (Vietnamese)', async () => {
    await mount(
      {
        getClipboardSuggestion: async () => suggestion,
        onClipboardSuggestion: () => () => {},
      },
      'vi',
    )
    const labels = Array.from(host.querySelectorAll('.clip-suggest-action')).map(
      (b) => b.textContent,
    )
    expect(labels[0]).toBe('Tóm tắt')
    expect(labels[1]).toMatch(/^Dịch sang /)
  })
})
