/**
 * The picker's source must be the source the user is looking at.
 *
 * The async tests already cover a slow read landing after a newer one. These
 * cover the other half: a source that *already loaded* and then became stale
 * because the user moved to a different tab, workbook, worksheet or range
 * without loading anything new. Applying in that state used to submit the file
 * the user stopped looking at.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RecipientPickerDialog } from '../src/renderer/components/mail-merge/RecipientPickerDialog'
import type { MailMergeSource } from '../src/renderer/mail-merge/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface PickFile {
  base64: string
  path: string
  delayMs?: number
  error?: string
}

function stubDesktop(picks: PickFile[], sheetTabs: Array<{ id: string; title: string }> = []) {
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
      listSheetTabs: async () => sheetTabs,
      readSheetGrid: async () => ({ ok: false, error: 'no spreadsheet is open' }),
      releaseMailMergeDir: async () => ({ ok: true }),
    },
  })
}

let container: HTMLElement | undefined
let root: Root | undefined

function renderDialog(picks: PickFile[], sheetTabs: Array<{ id: string; title: string }> = []) {
  const applied: MailMergeSource[] = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  stubDesktop(picks, sheetTabs)
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

const pickButton = () =>
  container!.querySelector('.mail-merge-picker .btn-ghost') as HTMLElement | null
const applyButton = () => container!.querySelector('.modal-actions .btn-primary') as HTMLElement | null
const tab = (index: number) => container!.querySelectorAll('.mm-source-tab')[index] as HTMLElement
const metaText = () => container!.querySelector('.mm-picker-meta')?.textContent ?? ''
const rowCount = () => container!.querySelectorAll('.mm-recipient-row').length

function click(element: HTMLElement | null) {
  if (!element) throw new Error('expected an element in the dialog')
  act(() => {
    element.click()
  })
}

function selectValue(selector: string, value: string) {
  const select = container!.querySelector(selector) as HTMLSelectElement | null
  if (!select) throw new Error('expected a select in the dialog')
  act(() => {
    select.value = value
    select.dispatchEvent(new Event('change'))
  })
}

afterEach(() => {
  root?.unmount()
  container?.remove()
  root = undefined
  container = undefined
})

describe('picker source identity', () => {
  it('does not submit a loaded CSV after the user moves to the Excel tab', async () => {
    const applied = renderDialog([{ base64: b64('Name\nHuy\nAn'), path: 'list.csv' }])
    click(pickButton())
    await settle(50)
    expect(rowCount()).toBe(2)

    click(tab(1)) // Excel tab: nothing has been loaded there
    await settle(50)
    expect(metaText()).toBe('')
    click(applyButton())
    expect(applied.length).toBe(0)
  })

  it('does not submit a loaded CSV after the user moves to the Sheets tab', async () => {
    const applied = renderDialog([{ base64: b64('Name\nHuy\nAn'), path: 'list.csv' }])
    click(pickButton())
    await settle(50)
    expect(rowCount()).toBe(2)

    click(tab(2))
    await settle(50)
    click(applyButton())
    expect(applied.length).toBe(0)
  })

  it('keeps a source whose tab the user did not change', async () => {
    const applied = renderDialog([{ base64: b64('Name\nHuy\nAn'), path: 'list.csv' }])
    click(pickButton())
    await settle(50)
    click(tab(0)) // back to the tab the source came from
    await settle(50)
    expect(metaText()).toContain('list.csv')
    click(applyButton())
    expect(applied.length).toBe(1)
    expect(applied[0].label).toBe('list.csv')
  })

  it('drops a loaded spreadsheet source when the workbook changes', async () => {
    const applied = renderDialog([], [{ id: '1', title: 'Book A' }, { id: '2', title: 'Book B' }])
    click(tab(2))
    await settle(50)
    selectValue('select', '1')
    await settle(50)
    // no read has happened yet, so there is nothing to drop; read it, then switch
    await act(async () => {
      const readButton = container!.querySelector('.mm-source-controls .btn-ghost') as HTMLElement
      readButton.click()
    })
    await settle(50)
    selectValue('select', '2')
    await settle(50)
    click(applyButton())
    expect(applied.length).toBe(0)
  })

  it('drops a loaded source when the range changes', async () => {
    const applied = renderDialog([], [{ id: '1', title: 'Book A' }])
    click(tab(2))
    await settle(50)
    const rangeInput = container!.querySelector('input[value="A1:F1000"]') as HTMLInputElement
    act(() => {
      rangeInput.value = 'A1:B5'
      rangeInput.dispatchEvent(new Event('change'))
    })
    await settle(50)
    click(applyButton())
    expect(applied.length).toBe(0)
  })

  it('refuses a spreadsheet picked on the CSV tab', async () => {
    const applied = renderDialog([
      { base64: b64('PKfake-xlsx'), path: 'recipients.xlsx' },
    ])
    click(pickButton())
    await settle(50)
    expect(container!.querySelector('.modal-error')?.textContent).toContain('spreadsheet')
    expect(rowCount()).toBe(0)
    click(applyButton())
    expect(applied.length).toBe(0)
  })

  it('does not commit a header toggle that races a still-pending read', async () => {
    const applied = renderDialog([{ base64: b64('Name\nHuy\nAn'), path: 'list.csv', delayMs: 200 }])
    click(pickButton())
    const toggle = container!.querySelector('.mm-header-toggle input') as HTMLInputElement
    act(() => {
      toggle.click()
    })
    await settle(300)
    // the read that landed is the one the dialog is showing, and the header
    // setting it was parsed with is the one on screen
    expect(metaText()).toContain('list.csv')
    expect(rowCount()).toBe(3)
    click(applyButton())
    expect(applied.length).toBe(1)
    expect(applied[0].hasHeader).toBe(false)
  })
})
