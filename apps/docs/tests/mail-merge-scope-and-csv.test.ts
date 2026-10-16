/**
 * Export scope, read-only documents, and the CSV record boundary.
 *
 * "Finish & Merge" used to be gated on at least one recipient being ticked, even
 * though the export dialog offers a scope of *all* recipients. A read-only editor
 * cannot carry the preview decorations the PDF is printed from, so printing it
 * would put the raw «Name» placeholders on the page.
 */
import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { parseDocx } from '@genoffice/docx-engine'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { blocksToPmDoc } from '../src/renderer/editor/convert'
import { sniffDelimiter, parseCsvRows } from '../src/renderer/mail-merge/csv'
import { sourceFromRows } from '../src/renderer/mail-merge/data-source'
import {
  passthroughFieldInstructions,
  validateMergeSession,
} from '../src/renderer/mail-merge/validation'
import { fieldInstructionsInXml } from '@genoffice/docx-engine'

/** a complex field whose instruction Word split across two w:instrText runs */
const splitField = (name: string) =>
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
  '<w:r><w:instrText xml:space="preserve"> MERGEFIELD </w:instrText></w:r>' +
  `<w:r><w:instrText xml:space="preserve">${name}</w:instrText></w:r>` +
  '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
import { exportRecipients } from '../src/renderer/mail-merge/recipient-store'
import { runMailMergeExport, type CancelToken } from '../src/renderer/mail-merge/export'
import type { FileActionContext } from '../src/renderer/file-actions'

const field = (instr: string) =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
  `<w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r>` +
  `<w:r><w:fldChar w:fldCharType="end"/></w:r>`

describe('export scope', () => {
  const source = sourceFromRows(
    [
      ['Name', 'City'],
      ['Huy', 'Da Nang'],
      ['An', 'Paris'],
    ],
    {
      kind: 'csv',
      label: 'list.csv',
      hasHeader: true,
    },
  )
  source.recipients.forEach((r) => (r.selected = false))

  it('exports every row when the scope is all, even with nothing ticked', () => {
    expect(exportRecipients(source, 'all').length).toBe(2)
    expect(exportRecipients(source, 'selected').length).toBe(0)
  })

  it('does not block a scope=all batch for an unticked list', async () => {
    const parsed = await parseDocx(
      await buildDocx({ bodyXml: '<w:p>' + field('MERGEFIELD Name') + '</w:p>' }),
    )
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc(parsed.blocks),
    })
    const issues = validateMergeSession(source, [], parsed.blocks, editor, 'all', parsed)
    editor.destroy()
    expect(
      issues.some((issue) => issue.key === 'mailMergeNoneSelected' && issue.severity === 'error'),
    ).toBe(false)
  })

  it('still blocks a scope=selected batch with nothing ticked', async () => {
    const parsed = await parseDocx(
      await buildDocx({ bodyXml: '<w:p>' + field('MERGEFIELD Name') + '</w:p>' }),
    )
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc(parsed.blocks),
    })
    const issues = validateMergeSession(source, [], parsed.blocks, editor, 'selected', parsed)
    editor.destroy()
    expect(
      issues.some((issue) => issue.key === 'mailMergeNoneSelected' && issue.severity === 'error'),
    ).toBe(true)
  })
})

describe('a read-only editor and PDF export', () => {
  it('refuses to print a document it cannot decorate, instead of printing placeholders', async () => {
    const parsed = await parseDocx(
      await buildDocx({ bodyXml: '<w:p>' + field('MERGEFIELD Name') + '</w:p>' }),
    )
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc(parsed.blocks),
    })
    editor.setEditable(false)
    const written: string[] = []
    Object.assign(window, {
      desktop: {
        listMailMergeOutput: async () => ({ ok: true, names: [] }),
        writeMailMergeFile: async (_d: string, name: string) => {
          written.push(name)
          return { ok: true, path: `/out/${name}`, name }
        },
      },
    })
    const ctx = {
      editor,
      doc: { parsed, filePath: null, fileName: 'template.docx', hash: '' },
      setShowPagePreview: () => {},
      setStatus: () => {},
    } as unknown as FileActionContext
    const progress = await runMailMergeExport(
      ctx,
      sourceFromRows([['Name'], ['Huy']], { kind: 'csv', label: 'x.csv', hasHeader: true }),
      {
        format: 'pdf',
        scope: 'all',
        outputDir: '/out',
        pattern: '{index}',
        overwrite: 'rename',
        combined: false,
      },
      { cancelled: false } as CancelToken,
      () => {},
    )
    editor.destroy()
    expect(written.length).toBe(0)
    expect(progress.status).toBe('failed')
    expect(progress.errors[0].message).toContain('read mode')
  })
})

describe('CSV delimiter detection', () => {
  it('uses the whole record when a quoted field contains a newline', () => {
    const text = '"Address line 1\nAddress line 2";Name\n"12 Nguyen Hue";Lan'
    const delimiter = sniffDelimiter(text)
    expect(delimiter).toBe(';')
    const rows = parseCsvRows(text, delimiter)
    expect(rows[0]).toEqual(['Address line 1\nAddress line 2', 'Name'])
    expect(rows[1]).toEqual(['12 Nguyen Hue', 'Lan'])
  })

  it('still picks a comma for an ordinary comma-separated file', () => {
    expect(sniffDelimiter('Name,City\nHuy,Da Nang')).toBe(',')
  })

  it('does not count a delimiter inside quotes', () => {
    expect(sniffDelimiter('"Huy, An";Da Nang\n"Lan, Bo";Paris')).toBe(';')
  })

  it('looks past the first record when a delimiter only appears later', () => {
    // the first physical line has no delimiter at all once the quoted newline is
    // accounted for, so a line-based sniff would default to a comma
    const text = 'Name\nHuy\tDa Nang\nAn\tParis'
    expect(sniffDelimiter(text)).toBe('\t')
  })
})

describe('byte-preserved fields are found, not missed', () => {
  /**
   * The old validator used one regex over the paragraph XML. It cannot see
   * `<w:fldSimple w:instr=" MERGEFIELD Name ">` (the instruction is an
   * attribute, not element text) and it truncates a complex field whose
   * instruction Word split across several `w:instrText` runs. The scanner the
   * validator now uses walks the XML the same way the merge engine does.
   */
  it('finds a simple field and a split complex field in a byte-preserved part', () => {
    const xml =
      '<w:p>' +
      '<w:fldSimple w:instr=" MERGEFIELD &quot;Postal Address&quot; "/>' +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> MERGEFIELD </w:instrText></w:r>' +
      '<w:r><w:instrText xml:space="preserve">City * MERGEFORMAT</w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
      '</w:p>'
    const instructions = fieldInstructionsInXml(xml).map((i) => i.trim())
    expect(instructions).toEqual(['MERGEFIELD "Postal Address"', 'MERGEFIELD City * MERGEFORMAT'])
  })

  it('reports a byte-preserved field as unmergeable rather than merged', async () => {
    const parsed = await parseDocx(
      await buildDocx({ bodyXml: '<w:p>' + splitField('City') + '</w:p>' }),
    )
    const instructions = parsed.blocks
      .filter((block) => !block.runs && !block.table)
      .flatMap((block) => fieldInstructionsInXml(block.originalXml ?? ''))
    expect(instructions.some((instr) => /MERGEFIELD\s+City/i.test(instr))).toBe(true)
    expect(passthroughFieldInstructions(parsed.blocks)).toContain('MERGEFIELD City')
  })
})
