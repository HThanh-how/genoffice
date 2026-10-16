/**
 * A merge field that spans several ProseMirror text nodes is still one field.
 *
 * Word writes a field's cached result as several runs when the text carries
 * different formatting, and the parser keeps those runs separate. Substituting
 * every fragment with the recipient's value would print the name three times in
 * the merged document — the test asserts the whole span is replaced once, and
 * that the surrounding template text and the template itself are untouched.
 */
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { Editor } from '@tiptap/core'
import { parseDocx, saveDocx } from '@genoffice/docx-engine'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { applyMergeValuesToPmDoc, insertMergeField } from '../src/renderer/editor/merge-doc'
import { referencedColumnNames, validateMergeSession } from '../src/renderer/mail-merge/validation'
import { sourceFromRows } from '../src/renderer/mail-merge/data-source'

async function editorFrom(xml: string): Promise<Editor> {
  const parsed = await parseDocx(await buildDocx({ bodyXml: xml }))
  return new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks),
  })
}

function docText(doc: { textContent: string }): string {
  return doc.textContent
}

describe('a merge field split across text nodes', () => {
  it('replaces the whole span once, not once per fragment', async () => {
    const editor = await editorFrom(
      '<w:p><w:r><w:t xml:space="preserve">Dear </w:t></w:r><w:r><w:t xml:space="preserve"> thanks.</w:t></w:r></w:p>',
    )
    editor
      .chain()
      .focus()
      .insertContent([
        {
          type: 'text',
          text: 'Nguy',
          marks: [{ type: 'instrField', attrs: { instr: 'MERGEFIELD Name' } }],
        },
        {
          type: 'text',
          text: 'en',
          marks: [{ type: 'instrField', attrs: { instr: 'MERGEFIELD Name' } }],
        },
        {
          type: 'text',
          text: ' Văn',
          marks: [{ type: 'instrField', attrs: { instr: 'MERGEFIELD Name' } }],
        },
      ])
      .run()
    const report = { missing: [], unused: [], unsupported: 0, applied: 0 }
    const merged = applyMergeValuesToPmDoc(editor.state.doc, { Name: 'Nguyen Van' }, report)
    expect(docText(merged)).toBe('Nguyen VanDear  thanks.')
    expect(report.applied).toBe(1)
    // the template is never modified
    expect(docText(editor.state.doc)).toBe('Nguyen VănDear  thanks.')
    editor.destroy()
  })

  it('leaves adjacent fields with different instructions separate', async () => {
    const editor = await editorFrom('<w:p><w:r><w:t xml:space="preserve">AB</w:t></w:r></w:p>')
    editor
      .chain()
      .focus()
      .insertContent([
        {
          type: 'text',
          text: 'A',
          marks: [{ type: 'instrField', attrs: { instr: 'MERGEFIELD First' } }],
        },
        {
          type: 'text',
          text: 'B',
          marks: [{ type: 'instrField', attrs: { instr: 'MERGEFIELD Last' } }],
        },
      ])
      .run()
    const report = { missing: [], unused: [], unsupported: 0, applied: 0 }
    const merged = applyMergeValuesToPmDoc(
      editor.state.doc,
      { First: 'Huy', Last: 'Thanh' },
      report,
    )
    expect(docText(merged)).toBe('HuyThanhAB')
    expect(report.applied).toBe(2)
    editor.destroy()
  })

  it('deletes a field that merges to nothing', async () => {
    const editor = await editorFrom(
      '<w:p><w:r><w:t xml:space="preserve">Line: </w:t></w:r><w:r><w:t xml:space="preserve"> end</w:t></w:r></w:p>',
    )
    editor
      .chain()
      .focus()
      .insertContent([
        {
          type: 'text',
          text: 'ab',
          marks: [{ type: 'instrField', attrs: { instr: 'MERGEFIELD Address' } }],
        },
      ])
      .run()
    const report = { missing: [], unused: [], unsupported: 0, applied: 0 }
    const merged = applyMergeValuesToPmDoc(editor.state.doc, { Address: '' }, report)
    expect(docText(merged)).toBe('Line:  end')
    editor.destroy()
  })

  it('inserts a real field through the editor rather than literal text', async () => {
    const editor = await editorFrom('<w:p><w:r><w:t xml:space="preserve">Dear </w:t></w:r></w:p>')
    expect(insertMergeField(editor, 'Postal Address')).toBe(true)
    let found = ''
    editor.state.doc.descendants((node) => {
      if (!node.isText) return
      const mark = node.marks.find((m) => m.type.name === 'instrField')
      if (mark) found = String(mark.attrs.instr ?? '')
    })
    expect(found).toBe('MERGEFIELD "Postal Address"')
    editor.destroy()
  })
  it('serializes a split field as one plain run in the saved docx', async () => {
    // Word stores a field's cached result as several runs when the text carries
    // different formatting; the merged file must contain the recipient once, as
    // ordinary text, with no field machinery left behind
    const bytes = await buildDocx({
      bodyXml:
        '<w:p><w:r><w:t xml:space="preserve">Dear </w:t></w:r>' +
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
        '<w:r><w:instrText xml:space="preserve"> MERGEFIELD Name </w:instrText></w:r>' +
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
        '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Ngu</w:t></w:r>' +
        '<w:r><w:t xml:space="preserve">en</w:t></w:r>' +
        '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
        '<w:r><w:t xml:space="preserve">,</w:t></w:r></w:p>',
    })
    const parsed = await parseDocx(bytes)
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc(parsed.blocks),
    })
    const report = { missing: [], unused: [], unsupported: 0, applied: 0 }
    const merged = applyMergeValuesToPmDoc(editor.state.doc, { Name: 'Nguyen Van' }, report)
    expect(docText(merged)).toBe('Dear Nguyen Van,')
    expect(report.applied).toBe(1)
    const plan = pmDocToSavePlan(merged.toJSON() as PmNode, parsed.blocks)
    const out = await saveDocx(parsed, plan.saveBlocks)
    const xml = await (await JSZip.loadAsync(out)).file('word/document.xml')!.async('string')
    expect((xml.match(/Nguyen Van/g) ?? []).length).toBe(1)
    expect(xml).not.toContain('MERGEFIELD')
    expect(xml).not.toContain('fldChar')
    editor.destroy()
  })
})

describe('validation reads the same field semantics as the engine', () => {
  it('does not ask for a column that only appears in an IF literal', () => {
    const instr = 'IF «Status» = "vip" "Xin chào «Khách VIP»" ""'
    expect(referencedColumnNames(instr)).toEqual(['Status'])
  })

  it('reports an IF the merge model cannot evaluate as an error', async () => {
    const editor = await editorFrom('<w:p><w:r><w:t xml:space="preserve">x</w:t></w:r></w:p>')
    editor
      .chain()
      .focus()
      .insertContent({
        type: 'text',
        text: 'y',
        marks: [{ type: 'instrField', attrs: { instr: 'IF «Status» = ' } }],
      })
      .run()
    const source = sourceFromRows([['Status'], ['vip']], {
      kind: 'csv',
      label: 'list.csv',
      hasHeader: true,
    })
    const issues = validateMergeSession(source, [], [], editor)
    expect(issues.some((issue) => issue.key === 'mailMergeUnsupportedField')).toBe(true)
    editor.destroy()
  })

  it('does not flag a well-formed IF as unsupported', async () => {
    const editor = await editorFrom('<w:p><w:r><w:t xml:space="preserve">x</w:t></w:r></w:p>')
    editor
      .chain()
      .focus()
      .insertContent({
        type: 'text',
        text: 'y',
        marks: [
          {
            type: 'instrField',
            attrs: { instr: 'IF «Status» = "vip" "Xin chào «Khách VIP»" ""' },
          },
        ],
      })
      .run()
    const source = sourceFromRows([['Status'], ['vip']], {
      kind: 'csv',
      label: 'list.csv',
      hasHeader: true,
    })
    const issues = validateMergeSession(source, [], [], editor)
    expect(issues.some((issue) => issue.key === 'mailMergeUnsupportedField')).toBe(false)
    editor.destroy()
  })
})
