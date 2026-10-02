import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClipboardHistoryItems } from '../src/renderer/components/ClipboardHistoryItems'

let root: Root | undefined
let container: HTMLElement | undefined
const priorDesktop = (window as unknown as { desktop?: unknown }).desktop

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = undefined
  container = undefined
  if (priorDesktop === undefined) delete (window as unknown as { desktop?: unknown }).desktop
  else (window as unknown as { desktop: unknown }).desktop = priorDesktop
})

function fakeEditor() {
  const pasteText = vi.fn()
  const focus = vi.fn()
  return { editor: { view: { pasteText, focus } } as unknown as Editor, pasteText, focus }
}

async function mount(
  history: { enabled: boolean; items: unknown[] },
  variant: 'ctx' | 'ribbon',
  wrap = (action: () => void) => action,
  editor = fakeEditor().editor,
) {
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: {
      getClipboardHistoryEnabled: () => Promise.resolve(history.enabled),
      getClipboardHistory: () => Promise.resolve(history.items),
      restoreClipboardHistoryImage: () => Promise.resolve(true),
    },
  })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      createElement(ClipboardHistoryItems, { editor, lang: 'en', variant, wrap, limit: 2 }),
    )
    await Promise.resolve()
  })
  return container
}

describe('paste from history', () => {
  it('lists what was copied in the Paste dropdown and pastes the one that is picked', async () => {
    const { editor, pasteText, focus } = fakeEditor()
    const wrapped = vi.fn((action: () => void) => action)
    const view = await mount(
      {
        enabled: true,
        items: [
          { id: '1', kind: 'text', text: 'Giấy ra viện\n  của ông Công', sensitive: false },
          { id: '2', kind: 'text', text: 'second', sensitive: false },
          { id: '3', kind: 'text', text: 'third (beyond the limit)', sensitive: false },
        ],
      },
      'ribbon',
      wrapped,
      editor,
    )
    const buttons = [...view.querySelectorAll('button')]
    // newest first, white space tidied, at most `limit` entries, each a menu item of the dropdown
    expect(buttons.map((b) => b.textContent)).toEqual(['Giấy ra viện của ông Công', 'second'])
    expect(buttons.every((b) => b.getAttribute('role') === 'menuitem')).toBe(true)

    await act(async () => buttons[0]!.click())
    expect(wrapped).toHaveBeenCalled()
    expect(focus).toHaveBeenCalled()
    expect(pasteText).toHaveBeenCalledWith('Giấy ra viện\n  của ông Công')
  })

  it('hides the text of a sensitive entry', async () => {
    const view = await mount(
      { enabled: true, items: [{ id: '1', kind: 'text', text: 'hunter2', sensitive: true }] },
      'ribbon',
    )
    expect(view.textContent).toBe('••••••••••')
  })

  it('says so when history is off or empty, instead of showing an empty list', async () => {
    const off = await mount({ enabled: false, items: [] }, 'ribbon')
    const offText = off.textContent
    expect(offText).toBeTruthy()
    expect(off.querySelector('button')!.disabled).toBe(true)
    act(() => root!.unmount())
    container!.remove()

    const empty = await mount({ enabled: true, items: [] }, 'ribbon')
    expect(empty.querySelector('button')!.disabled).toBe(true)
    expect(empty.textContent).not.toBe(offText)
  })

  it('uses the right-click menu look in the context menu', async () => {
    const view = await mount(
      { enabled: true, items: [{ id: '1', kind: 'text', text: 'hello', sensitive: false }] },
      'ctx',
    )
    const button = view.querySelector('button')!
    expect(button.className).toContain('ctx-item')
    expect(button.getAttribute('role')).toBeNull()
  })
})
