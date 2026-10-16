/**
 * The export dialog's file-name pattern is validated with the same grammar the
 * engine expands.
 *
 * A token the source has no column for used to vanish silently from every file
 * name. The dialog now defaults to the source's own first column, and the check
 * it runs is `validateFileNamePattern` — the same token list `buildOutputFileName`
 * reads — so the dialog can never accept a pattern that loses a token on the way
 * to disk.
 */
import { describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MailMergeExportDialog } from '../src/renderer/components/mail-merge/MailMergeDialogs'
import { sourceFromRows } from '../src/renderer/mail-merge/data-source'
import { validateFileNamePattern } from '../src/renderer/mail-merge/validation'
import type { MailMergeSource } from '../src/renderer/mail-merge/types'
import { buildOutputFileName } from '@genoffice/docx-engine'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function openDialog(source: MailMergeSource) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      createElement(MailMergeExportDialog, {
        source,
        format: 'docx',
        onClose: () => {},
        onStart: () => {},
      }),
    )
  })
  return { container, root }
}

/** the pattern field, identified by the placeholder the dialog shows for it */
const patternInput = (container: HTMLElement): HTMLInputElement | undefined =>
  [...container.querySelectorAll('.mail-merge-export input')].find(
    (input) => input.getAttribute('placeholder') === '{index}_{Name}',
  ) as HTMLInputElement | undefined

describe('export file-name pattern', () => {
  it('defaults to a token the source actually has', () => {
    const source = sourceFromRows(
      [
        ['Full Name', 'Postal Address'],
        ['Nguyễn Văn A', '123 Nguyễn Huệ'],
      ],
      { kind: 'csv', label: 'list.csv', hasHeader: true },
    )
    const { container, root } = openDialog(source)
    // a literal `{Name}` would be an unknown token for this source and silently
    // disappear from every file name
    expect(patternInput(container)?.value).toBe('{index}_{Full Name}')
    expect(container.querySelector('.modal-error')).toBeNull()
    root.unmount()
    container.remove()
  })

  it('defaults to the index alone when the source has no columns', () => {
    const source: MailMergeSource = {
      kind: 'csv',
      label: 'empty.csv',
      columns: [],
      recipients: [],
      hasHeader: true,
    }
    const { container, root } = openDialog(source)
    expect(patternInput(container)?.value).toBe('{index}')
    root.unmount()
    container.remove()
  })

  it("reports the token it cannot resolve, using the engine's own grammar", () => {
    const columns = ['Full Name', 'Postal Address']
    expect(validateFileNamePattern('{index}_{Nickname}', columns)).toEqual({
      valid: false,
      unknown: ['Nickname'],
    })
    // every form the engine expands is accepted, and the engine expands exactly
    // what the dialog accepts
    for (const pattern of [
      '{index}',
      '{1index}_{Full Name}',
      '{ Postal Address }',
      '{index}_{Full Name}',
    ]) {
      expect(validateFileNamePattern(pattern, columns).valid).toBe(true)
    }
    const name = buildOutputFileName({
      pattern: '{1index}_{Full Name}',
      index: 3,
      total: 10,
      values: { 'Full Name': 'Huy' },
      extension: 'docx',
    })
    expect(name).toBe('03_Huy.docx')
  })
})
