/**
 * The recipient picker is asynchronous, so the list on screen and the source the
 * user submits have to be the same thing.
 *
 * These tests drive the real dialog through the DOM with a stubbed desktop bridge:
 * a slow read that lands after a newer one, a header toggle after the file is
 * already loaded, a tab switch mid-read, and a read that fails. In every case the
 * source handed to Mail Merge is the one the dialog is showing.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RecipientPickerDialog } from '../src/renderer/components/mail-merge/RecipientPickerDialog'
import type { MailMergeSource } from '../src/renderer/mail-merge/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')

interface PickFile {
  base64: string
  path: string
  delayMs?: number
  error?: string
}

function stubDesktop(picks: PickFile[]) {
  let index = 0
  Object.assign(window, {
    desktop: {
      pickMailMergeSource: async () => {
        const file = picks[index++]
        if (!file) return null
        if (file.delayMs) await new Promise((resolve) => setTimeout(resolve, file.delayMs))
        return file.error
          ? { ok: false, error: file.error }
          : { ok: true, base64: file.base64, path: file.path }
      },
      listSheetTabs: async () => [],
      readSheetGrid: async () => ({ ok: false, error: 'no spreadsheet is open' }),
    },
  })
}

let container: HTMLElement | undefined
let root: Root | undefined

function renderDialog(picks: PickFile[]): MailMergeSource[] {
  const applied: MailMergeSource[] = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  stubDesktop(picks)
  act(() => {
    root!.render(
      createElement(RecipientPickerDialog, {
        source: null,
        preferredKind: 'csv',
        onClose: () => {},
        onApply: (source) => applied.push(source),
      }),
    )
  })
  return applied
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const pickButton = () =>
  container!.querySelector('.mail-merge-picker .btn-ghost') as HTMLElement | null
const applyButton = () =>
  container!.querySelector('.modal-actions .btn-primary') as HTMLElement | null
const headerToggle = () =>
  container!.querySelector('.mm-header-toggle input') as HTMLInputElement | null
const metaText = () => container!.querySelector('.mm-picker-meta')?.textContent ?? ''
const rowCount = () => container!.querySelectorAll('.mm-recipient-row').length

function click(element: HTMLElement | null) {
  if (!element) throw new Error('expected an element in the dialog')
  act(() => {
    element.click()
  })
}

afterEach(() => {
  root?.unmount()
  container?.remove()
  root = undefined
  container = undefined
})

describe('recipient picker async state', () => {
  it('keeps the newest read when an older one finishes later', async () => {
    const applied = renderDialog([
      { base64: b64('Name\nSlow\nHuy'), path: 'slow.csv', delayMs: 300 },
      { base64: b64('Name\nFast\nAn'), path: 'fast.csv' },
    ])
    const button = pickButton()
    // both requests are in flight at once: the second one is the user's latest choice
    act(() => {
      button!.click()
      button!.click()
    })
    await settle(400)
    expect(metaText()).toContain('fast.csv')
    expect(rowCount()).toBe(2)
    click(applyButton())
    expect(applied.length).toBe(1)
    expect(applied[0].label).toBe('fast.csv')
    expect(applied[0].recipients.map((r) => r.values.Name)).toEqual(['Fast', 'An'])
  })

  it('rebuilds the columns when the header toggle changes after the file is loaded', async () => {
    const applied = renderDialog([
      { base64: b64('Name,City\nHuy,Tokyo\nAn,Paris'), path: 'list.csv' },
    ])
    click(pickButton())
    await settle(50)
    expect(metaText()).toContain('list.csv')
    expect(rowCount()).toBe(2)

    const toggle = headerToggle()
    click(toggle)
    await settle(50)

    // without a header row every line is a recipient, and the columns are unnamed
    expect(rowCount()).toBe(3)
    click(applyButton())
    expect(applied.length).toBe(1)
    expect(applied[0].columns.map((c) => c.name)).toEqual(['Column 1', 'Column 2'])
    expect(applied[0].recipients.map((r) => r.values['Column 1'])).toEqual(['Name', 'Huy', 'An'])
  })

  it('leaves the confirmed source in place when a later read fails', async () => {
    const applied = renderDialog([
      { base64: b64('Name\nHuy'), path: 'good.csv' },
      { base64: '', path: 'bad.csv', error: 'the file could not be read' },
    ])
    click(pickButton())
    await settle(50)
    click(pickButton())
    await settle(50)
    expect(container!.querySelector('.modal-error')?.textContent).toContain('could not be read')
    // the list still shows the source that loaded, and Apply submits that one
    expect(metaText()).toContain('good.csv')
    expect(rowCount()).toBe(1)
    click(applyButton())
    expect(applied.length).toBe(1)
    expect(applied[0].label).toBe('good.csv')
  })

  it('does not let a tab switch resurrect a read for the tab the user left', async () => {
    const applied = renderDialog([{ base64: b64('Name\nHuy\nAn'), path: 'list.csv', delayMs: 250 }])
    act(() => {
      pickButton()!.click()
    })
    // the user moves to the spreadsheet tab before the CSV read lands
    act(() => {
      ;(container!.querySelectorAll('.mm-source-tab')[1] as HTMLElement).click()
    })
    await settle(350)
    expect(metaText()).toBe('')
    expect(rowCount()).toBe(0)
    click(applyButton())
    expect(applied.length).toBe(0)
  })
})
