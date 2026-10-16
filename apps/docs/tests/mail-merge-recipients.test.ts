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
import {
  parseCsvRows,
  sniffDelimiter,
  trimEmptyRows,
  unterminatedQuoteAt,
} from '../src/renderer/mail-merge/csv'
import { buildColumns, loadCsvSource, sourceFromRows } from '../src/renderer/mail-merge/data-source'
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

  it('keeps an interior blank row: it is a recipient with empty fields', () => {
    // Word reads a blank line in the middle of the data as a record whose fields
    // are all empty. Dropping it would silently lose a row the user counted.
    const rows = trimEmptyRows([['Name'], ['Huy'], [''], ['An']])
    expect(rows).toEqual([['Name'], ['Huy'], [''], ['An']])
  })

  it('does not discard values that sit beyond the declared header columns', () => {
    const source = sourceFromRows(
      [['Name'], ['Huy', 'extra city'], ['An', 'extra note', 'extra flag']],
      { kind: 'csv', label: 'list.csv', hasHeader: true },
    )
    expect(source.columns.map((c) => c.name)).toEqual(['Name', 'Column 2', 'Column 3'])
    expect(source.recipients[0].values).toEqual({
      Name: 'Huy',
      'Column 2': 'extra city',
      'Column 3': '',
    })
    expect(source.recipients[1].values).toEqual({
      Name: 'An',
      'Column 2': 'extra note',
      'Column 3': 'extra flag',
    })
  })

  it('handles a quoted field with an embedded newline and delimiter', () => {
    const rows = parseCsvRows('"Name","Address"\n"Huy","123 Lê Lai, Da Nang\nVietnam"', ',')
    expect(rows[1][1]).toBe('123 Lê Lai, Da Nang\nVietnam')
  })

  it('reads a file whose last line has no closing newline', () => {
    expect(parseCsvRows('Name,Huy\nAn,An', ',')).toEqual([
      ['Name', 'Huy'],
      ['An', 'An'],
    ])
  })

  it('detects an unterminated quote instead of pretending the row is normal', () => {
    expect(unterminatedQuoteAt('Name,"Huy', ',')).toBe(9)
    expect(unterminatedQuoteAt('Name,"Huy",x', ',')).toBeNull()
    expect(unterminatedQuoteAt('"Name","Huy"', ',')).toBeNull()
    // a quote in the middle of an unquoted field is data, not a broken quote
    expect(unterminatedQuoteAt('City,Ha"noi', ',')).toBeNull()
  })

  it('keeps a quote that sits inside an unquoted value', () => {
    expect(parseCsvRows('City,Ha"noi', ',')).toEqual([['City', 'Ha"noi']])
    expect(parseCsvRows('Name,"Alice""Jones"', ',')).toEqual([['Name', 'Alice"Jones']])
  })

  it('refuses a file whose quote never closes rather than merging nonsense', () => {
    // the parser would read everything after the open quote as one field, so the
    // batch would write one document per line of the rest of the file
    expect(() => loadCsvSource(btoa('Name,"Huy'), 'list.csv', true)).toThrow(/never closes/)
  })

  it('refuses bytes that are not UTF-8 instead of turning them into replacement chars', () => {
    // 0xC3 0x28 is an invalid sequence; a silent U+FFFD would end up printed in
    // the merged documents
    const broken = Buffer.from([0x41, 0x42, 0xc3, 0x28]).toString('base64')
    expect(() => loadCsvSource(broken, 'list.csv', false)).toThrow(/not valid UTF-8/)
  })

  it('strips a BOM and treats a whitespace-only header as unnamed columns', () => {
    const withBom = loadCsvSource(
      Buffer.from('\uFEFFName,City\nHuy,Tokyo', 'utf8').toString('base64'),
      'list.csv',
      true,
    )
    expect(withBom.columns.map((c) => c.name)).toEqual(['Name', 'City'])
    const blankHeader = loadCsvSource(
      Buffer.from('\nHuy,Tokyo', 'utf8').toString('base64'),
      'list.csv',
      true,
    )
    expect(blankHeader.columns.map((c) => c.name)).toEqual(['Column 1', 'Column 2'])
    expect(blankHeader.recipients[0].values['Column 1']).toBe('Huy')
  })

  it('names columns from the header and never lets two merge fields collide', () => {
    const columns = buildColumns(['Name', '', 'Name', 'City'])
    expect(columns.map((c) => c.name)).toEqual(['Name', 'Column 2', 'Name (2)', 'City'])
  })

  it('keeps every column distinct when a generated suffix matches a literal header', () => {
    // "Name" twice plus a header that literally reads "Name (2)": the second
    // "Name" would otherwise be named "Name (2)" and collide with the third
    const columns = buildColumns(['Name', 'Name', 'Name (2)'])
    const names = columns.map((c) => c.name)
    expect(new Set(names).size).toBe(3)
    expect(names[0]).toBe('Name')
    // the header text the user typed is preserved, suffix or not
    expect(columns.map((c) => c.header)).toEqual(['Name', 'Name', 'Name (2)'])

    const source = sourceFromRows(
      [
        ['Name', 'Name', 'Name (2)'],
        ['first', 'second', 'third'],
      ],
      { kind: 'csv', label: 'list.csv', hasHeader: true },
    )
    const values = source.recipients[0].values
    expect(Object.keys(values).length).toBe(3)
    expect(names.every((n) => n in values)).toBe(true)
    expect(Object.values(values).sort()).toEqual(['first', 'second', 'third'])
  })

  it('does not let a generated suffix collide with an earlier literal header', () => {
    const names = buildColumns(['Name (2)', 'Name', 'Name']).map((c) => c.name)
    expect(new Set(names).size).toBe(3)
    expect(names[0]).toBe('Name (2)')
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
