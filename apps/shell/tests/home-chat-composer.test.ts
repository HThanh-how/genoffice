// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Composer, type ComposerLabels } from '../src/renderer/src/home-chat/Composer'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const labels: ComposerLabels = {
  input: 'Message',
  placeholder: 'Ask',
  send: 'Send',
  stop: 'Stop',
  busyPlaceholder: 'Replying',
  sendHint: 'Send - Enter',
  status: '',
}

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = null
})

async function mount(props: { busy?: boolean; status?: string }) {
  const onSend = vi.fn()
  const onStop = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      createElement(Composer, {
        value: 'hello',
        busy: props.busy ?? false,
        disabled: false,
        labels: { ...labels, status: props.status ?? '' },
        inputRef: createRef<HTMLTextAreaElement>(),
        onChange: () => {},
        onSend,
        onStop,
      }),
    ),
  )
  const textarea = host.querySelector('textarea') as HTMLTextAreaElement
  return { textarea, onSend, onStop, host }
}

function enter(textarea: HTMLTextAreaElement, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...init,
  })
  textarea.dispatchEvent(event)
  return event
}

describe('home chat Composer', () => {
  it('Enter sends; Shift+Enter does not', async () => {
    const { textarea, onSend } = await mount({})
    enter(textarea, { shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    enter(textarea)
    expect(onSend).toHaveBeenCalledWith('hello')
  })

  it('does not send during IME composition (isComposing, keyCode 229, composition events)', async () => {
    const { textarea, onSend } = await mount({})
    enter(textarea, { isComposing: true })
    enter(textarea, { keyCode: 229 })
    expect(onSend).not.toHaveBeenCalled()
    await act(async () => {
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    })
    enter(textarea)
    expect(onSend).not.toHaveBeenCalled()
    await act(async () => {
      textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    })
    enter(textarea)
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('busy: icon-only stop, busy placeholder, Enter neither sends nor inserts a newline', async () => {
    const { textarea, onSend, onStop, host: el } = await mount({ busy: true })
    expect(textarea.placeholder).toBe('Replying')
    const stop = el.querySelector('button.stop') as HTMLButtonElement
    expect(stop.textContent).toBe('')
    expect(stop.getAttribute('aria-label')).toBe('Stop')
    expect(enter(textarea).defaultPrevented).toBe(true)
    expect(onSend).not.toHaveBeenCalled()
    await act(async () => stop.click())
    expect(onStop).toHaveBeenCalled()
  })

  it('has no permanent hint; the shortcut lives in the send title; status only when given', async () => {
    const idle = await mount({})
    expect(idle.host.querySelector('.hc-hint')).toBeNull()
    expect(idle.host.querySelector('button[type=submit]')?.getAttribute('title')).toBe(
      'Send - Enter',
    )
    await act(async () => root?.unmount())
    idle.host.remove()
    const loading = await mount({ status: 'Getting AI ready' })
    expect(loading.host.querySelector('.hc-hint')?.textContent).toBe('Getting AI ready')
  })
})
