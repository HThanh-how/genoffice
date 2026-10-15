/**
 * Mail merge recipient plumbing: CSV parsing, column naming, selection views,
 * pre-flight validation, and the two halves of the editor integration — the
 * non-destructive preview decoration and the real substitution that the save
 * pipeline writes.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { DecorationSet } from '@tiptap/pm/view'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { applyMergeValuesToPmDoc, mergeFieldValue } from '../src/renderer/editor/merge-doc'
import {
  mailMergePreviewKey,
  setMailMergeHighlight,
  setMailMergePreview,
} from '../src/renderer/editor/mail-merge-preview'
import { parseCsvRows, sniffDelimiter, trimEmptyRows } from '../src/renderer/mail-merge/csv'
import { buildColumns, sourceFromRows } from '../src/renderer/mail-merge/data-source'
import {
  DEFAULT_FILTER,
  exportRecipients,
  selectedCount,
  setSelected,
  visibleRecipients,
} from '../src/renderer/mail-merge/recipient-store'
import { templateMergeFields, validateMergeSession } from '../src/renderer/mail-merge/validation'

describe('CSV recipient source', () => {
  it('handles quoted commas, embedded newlines and doubled quotes', () => {
    const rows = parseCsvRows('Name,Note\n"Nguyen, Huy","said ""hi"""\n"a\nb",x', ',')
    expect(rows).toEqual([
      ['Name', 'Note'],
      ['Nguyen, Huy', 'said "hi"'],
      ['a\nb', 'x'],
    ])
  })

  it('sniffs a semicolon file and keeps CRLF out of the values', () => {
    const text = 'Name;City\r\nHuy;Tokyo\r\n'
    expect(sniffDelimiter(text)).toBe(';')
    expect(parseCsvRows(text, sniffDelimiter(text))).toEqual([
      ['Name', 'City'],
      ['Huy', 'Tokyo'],
    ])
  })

  it('drops trailing blank rows so a stray newline is not a recipient', () => {
    const rows = trimEmptyRows([['Name'], ['Huy'], [''], ['   ']])
    expect(rows).toEqual([['Name'], ['Huy']])
  })

  it('names columns from the header and never lets two merge fields collide', () => {
    const columns = buildColumns(['Name', '', 'Name', 'City'])
    expect(columns.map((c) => c.name)).toEqual(['Name', 'Column 2', 'Name (2)', 'City'])
  })

  it('builds recipients with stable ids and one value per column', () => {
    const source = sourceFromRows(
      [
        ['Name', 'City'],
        ['Huy', 'Tokyo'],
        ['An', 'Paris'],
      ],
      {
        kind: 'csv',
        label: 'list.csv',
        hasHeader: true,
      },
    )
    expect(source.columns.map((c) => c.name)).toEqual(['Name', 'City'])
    expect(source.recipients.map((r) => r.id)).toEqual([0, 1])
    expect(source.recipients[0].values).toEqual({ Name: 'Huy', City: 'Tokyo' })
    expect(source.recipients.every((r) => r.selected)).toBe(true)
  })
})

describe('recipient selection', () => {
  const source = sourceFromRows(
    [
      ['Name', 'Department', 'Amount'],
      ['Huy', 'Sales', '100'],
      ['An', 'Finance', '2500'],
      ['Bo', 'Sales', ''],
    ],
    { kind: 'csv', label: 'list.csv', hasHeader: true },
  )

  it('filters by search and by a single column without touching the source', () => {
    const filtered = visibleRecipients(source, {
      ...DEFAULT_FILTER,
      column: 'Department',
      operator: 'equals',
      value: 'sales',
    })
    expect(filtered.map((r) => r.values.Name)).toEqual(['Huy', 'Bo'])
    expect(source.recipients.length).toBe(3)
  })

  it('sorts numerically when the column is numeric', () => {
    const sorted = visibleRecipients(source, {
      ...DEFAULT_FILTER,
      sortColumn: 'Amount',
      sortDir: 'desc',
    })
    expect(sorted.map((r) => r.values.Name)).toEqual(['An', 'Huy', 'Bo'])
  })

  it('keeps ids stable when rows are deselected, so export runs the ticked rows only', () => {
    const deselected = setSelected(source, new Set([1]), false)
    expect(selectedCount(deselected)).toBe(2)
    expect(exportRecipients(deselected, 'selected').map((r) => r.id)).toEqual([0, 2])
    expect(exportRecipients(deselected, 'all').map((r) => r.id)).toEqual([0, 1, 2])
  })
})

describe('merge fields in the editor', () => {
  const live: Editor[] = []
  afterEach(() => {
    for (const e of live.splice(0)) e.destroy()
  })

  const field = (text: string, instr: string) => ({
    type: 'text',
    text,
    marks: [{ type: 'instrField', attrs: { instr } }],
  })

  function makeEditor() {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: {
        type: 'doc',
        content: [
          {
            type: 'docParagraph',
            content: [
              { type: 'text', text: 'Dear ' },
              field('«Name»', 'MERGEFIELD Name'),
              { type: 'text', text: ' of ' },
              field('«Department»', 'MERGEFIELD "Postal Department"'),
              { type: 'text', text: ' — ' },
              field('3', 'PAGE'),
            ],
          },
        ],
      },
    })
    live.push(editor)
    return editor
  }

  it('reads the merge fields the template references, ignoring PAGE/DATE', () => {
    const fields = templateMergeFields(makeEditor())
    expect(fields.map((f) => f.name)).toEqual(['Name', 'Postal Department'])
  })

  it('preview is a decoration: the document text is untouched', () => {
    const editor = makeEditor()
    const before = editor.state.doc.textContent
    setMailMergePreview(editor, { Name: 'Huy', 'Postal Department': 'Sales' })
    expect(editor.state.doc.textContent).toBe(before)
    const state = mailMergePreviewKey.getState(editor.state)
    expect(state?.values).toEqual({ Name: 'Huy', 'Postal Department': 'Sales' })
    expect(state?.decos).not.toBe(DecorationSet.empty)
    setMailMergePreview(editor, null)
    expect(mailMergePreviewKey.getState(editor.state)?.values).toBeNull()
    expect(mailMergePreviewKey.getState(editor.state)?.decos).toBe(DecorationSet.empty)
  })

  it('highlight works on its own, without a recipient', () => {
    const editor = makeEditor()
    setMailMergeHighlight(editor, true)
    const state = mailMergePreviewKey.getState(editor.state)
    expect(state?.highlight).toBe(true)
    expect(state?.values).toBeNull()
    expect(state?.decos).not.toBe(DecorationSet.empty)
  })

  it('substitutes the recipient value and drops the field mark, without mutating the template', () => {
    const editor = makeEditor()
    const original = editor.state.doc
    const report = { missing: [], unused: [], unsupported: 0, applied: 0 }
    const merged = applyMergeValuesToPmDoc(
      original,
      { Name: 'Huy', 'Postal Department': 'Sales' },
      report,
    )
    expect(merged.textContent).toBe('Dear Huy of Sales — 3')
    expect(original.textContent).toBe('Dear «Name» of «Department» — 3')
    expect(report.applied).toBe(2)
    // PAGE is not recipient data: it keeps its field machinery
    let pageFieldKept = false
    merged.descendants((node) => {
      if (node.isText && node.marks.some((m) => m.type.name === 'instrField')) pageFieldKept = true
    })
    expect(pageFieldKept).toBe(true)
  })

  it('reports a field the row has no column for instead of writing an empty string', () => {
    const report = { missing: [], unused: [], unsupported: 0, applied: 0 }
    expect(mergeFieldValue('MERGEFIELD City', { Name: 'Huy' }, report)).toBeNull()
    expect(report.missing).toEqual(['City'])
    expect(report.applied).toBe(0)
  })

  it('flags a template field the source has no column for before exporting', () => {
    const editor = makeEditor()
    const source = sourceFromRows([['Name'], ['Huy']], {
      kind: 'csv',
      label: 'list.csv',
      hasHeader: true,
    })
    const issues = validateMergeSession(source, templateMergeFields(editor), [])
    const errors = issues.filter((i) => i.severity === 'error')
    expect(errors.map((i) => i.key)).toContain('mailMergeMissingColumn')
    expect(errors.some((i) => i.detail === 'Postal Department')).toBe(true)
  })

  it('accepts a well-matched template', () => {
    const editor = makeEditor()
    const source = sourceFromRows(
      [
        ['Name', 'Postal Department'],
        ['Huy', 'Sales'],
        ['An', 'Finance'],
      ],
      { kind: 'csv', label: 'list.csv', hasHeader: true },
    )
    const issues = validateMergeSession(source, templateMergeFields(editor), [])
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
  })
})
