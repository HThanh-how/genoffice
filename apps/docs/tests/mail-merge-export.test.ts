/**
 * End-to-end merge path: parse a real .docx template, render it in the editor,
 * substitute one recipient's values in the ProseMirror tree, run the app's own
 * save plan, and re-parse the bytes that come out. This is the chain the
 * "Finish & Merge → Word documents" button uses, so the assertion is the one
 * that matters: the file Word opens contains the recipient, not the placeholder.
 */
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { Editor } from '@tiptap/core'
import { parseDocx, saveDocx } from '@genoffice/docx-engine'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { applyMergeValuesToPmDoc } from '../src/renderer/editor/merge-doc'

const field = (instr: string, cached: string | null, rPr = '') =>
  `<w:r>${rPr}<w:fldChar w:fldCharType="begin"/></w:r>` +
  `<w:r>${rPr}<w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r>` +
  (cached === null
    ? ''
    : `<w:r>${rPr}<w:fldChar w:fldCharType="separate"/></w:r>` +
      `<w:r>${rPr}<w:t xml:space="preserve">${cached}</w:t></w:r>`) +
  `<w:r>${rPr}<w:fldChar w:fldCharType="end"/></w:r>`

const documentXmlOf = async (bytes: Uint8Array): Promise<string> =>
  (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string')

describe('mail merge export path', () => {
  it("writes the recipient's values into a real docx, body and table alike", async () => {
    const bytes = await buildDocx({
      bodyXml:
        '<w:p><w:r><w:t xml:space="preserve">Dear </w:t></w:r>' +
        field('MERGEFIELD Name \\* MERGEFORMAT', null, '<w:rPr><w:b/></w:rPr>') +
        '<w:r><w:t xml:space="preserve">,</w:t></w:r></w:p>' +
        '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>' +
        '<w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>' +
        '<w:tr><w:tc><w:p>' +
        field('MERGEFIELD Department', null) +
        '</w:p></w:tc><w:tc><w:p>' +
        field('MERGEFIELD Amount', null) +
        '</w:p></w:tc></w:tr></w:tbl>',
    })
    const parsed = await parseDocx(bytes)
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc(parsed.blocks),
    })

    const report = { missing: [], unused: [], unsupported: 0, applied: 0 }
    const merged = applyMergeValuesToPmDoc(
      editor.state.doc,
      { Name: 'Nguyễn Văn A', Department: 'Sales', Amount: '1,500' },
      report,
    )
    expect(report.applied).toBe(3)

    const plan = pmDocToSavePlan(merged.toJSON() as PmNode, parsed.blocks)
    const out = await saveDocx(parsed, plan.saveBlocks)
    const xml = await documentXmlOf(out)
    expect(xml).toContain('Nguyễn Văn A')
    expect(xml).toContain('Sales')
    expect(xml).toContain('1,500')
    expect(xml).not.toContain('MERGEFIELD')
    expect(xml).not.toContain('fldChar')

    // the merged file is a valid docx that GenOffice can read back
    const reparsed = await parseDocx(out)
    const text = reparsed.blocks
      .map((block) =>
        block.table
          ? block.table.rows
              .map((row) =>
                row
                  .map((cell) =>
                    (cell.richParas ?? []).flatMap((p) => p.runs.map((r) => r.text)).join(''),
                  )
                  .join('|'),
              )
              .join(' ')
          : (block.runs?.map((run) => run.text).join('') ?? ''),
      )
      .join(' ')
    expect(text).toContain('Dear Nguyễn Văn A,')
    expect(text).toContain('Sales|1,500')

    // the template in the editor is untouched: merge is a copy, not an edit
    expect(editor.state.doc.textContent).toContain('«Name»')
    editor.destroy()
  })

  it('leaves a field the row has no column for as the placeholder rather than blanking it', async () => {
    const bytes = await buildDocx({
      bodyXml: '<w:p>' + field('MERGEFIELD City', null) + '</w:p>',
    })
    const parsed = await parseDocx(bytes)
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc(parsed.blocks),
    })
    const report = { missing: [], unused: [], unsupported: 0, applied: 0 }
    const merged = applyMergeValuesToPmDoc(editor.state.doc, { Name: 'Huy' }, report)
    expect(report.missing).toEqual(['City'])
    expect(merged.textContent).toBe('«City»')
    editor.destroy()
  })
})
