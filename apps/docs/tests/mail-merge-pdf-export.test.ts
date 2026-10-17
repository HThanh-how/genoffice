/**
 * The PDF half of Finish & Merge.
 *
 * A PDF is printed from the DOM, so nothing in the print path can tell whether a
 * merge field resolved: the export runner has to decide that before the print
 * job starts, and it must apply the same rule the DOCX path applies — a
 * recipient whose fields cannot be resolved produces no file.
 *
 * Only Chromium's print bridge and the pagination signal are stubbed (there is
 * no browser or layout engine in the test runner). The editor, the merge engine
 * and the export runner are the real code the Mailings tab uses.
 */
import { describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { parseDocx, type MergeValues, type ParsedDocFull } from '@genoffice/docx-engine'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { blocksToPmDoc } from '../src/renderer/editor/convert'
import {
  currentMailMergeValues,
  mailMergePreviewGeneration,
  setMailMergePreview,
} from '../src/renderer/editor/mail-merge-preview'
import { mergeFieldValue } from '../src/renderer/editor/merge-doc'
import { templateFieldInstructions } from '../src/renderer/mail-merge/validation'
import type { FileActionContext } from '../src/renderer/file-actions'
import {
  expectedPreviewFieldIds,
  printablePreviewIsCurrent,
  runMailMergeExport,
  waitForPrintablePreview,
  waitForPreviewSheets,
  type CancelToken,
} from '../src/renderer/mail-merge/export'
import { sourceFromRows } from '../src/renderer/mail-merge/data-source'
import { resolveSafeFileName } from '../src/shared/mail-merge-names'
import type { MailMergeExportOptions } from '../src/renderer/mail-merge/types'

/** What the print bridge was asked to write, and what was on screen at that moment. */
const pdfWrites: Array<{ path: string; values: MergeValues | null; overwrite?: string }> = []
/**
 * The print bridge's answer. Production returns a structured result — the writer
 * may skip a destination or write it under a different name — so the stub can be
 * swapped per test to exercise each outcome.
 */
let pdfBehaviour: (
  path: string,
  overwrite: string | undefined,
) => { ok: boolean; path?: string; name?: string; skipped?: boolean; error?: string } = (path) => ({
  ok: true,
  path,
  name: path.split('/').pop() ?? path,
})

vi.mock('../src/renderer/file-actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/file-actions')>()
  return {
    ...actual,
    exportPdf: async (ctx: FileActionContext, outPath?: string, overwrite?: string) => {
      const path = outPath ?? ''
      pdfWrites.push({
        path,
        values: ctx.editor ? currentMailMergeValues(ctx.editor.state) : null,
        overwrite,
      })
      return pdfBehaviour(path, overwrite)
    },
  }
})

const field = (instr: string, cached: string | null) =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
  `<w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r>` +
  (cached === null
    ? ''
    : `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
      `<w:r><w:t xml:space="preserve">${cached}</w:t></w:r>`) +
  `<w:r><w:fldChar w:fldCharType="end"/></w:r>`

function makeCtx(editor: Editor, parsed: ParsedDocFull): FileActionContext {
  return {
    editor,
    doc: { parsed, filePath: null, fileName: 'template.docx', hash: '' },
    sections: [],
    section: null,
    setStatus: () => {},
    setShowPagePreview: () => {},
  } as unknown as FileActionContext
}

function stubDesktop(existing: string[] = []) {
  const files = [...existing]
  Object.assign(window, {
    desktop: {
      listMailMergeOutput: async () => ({ ok: true, names: [...files] }),
      writeMailMergeFile: async (dir: string, name: string) => {
        files.push(name)
        return { ok: true, path: `${dir}/${name}` }
      },
    },
  })
}

/**
 * The print sheets Chromium prints are clones of the editor DOM taken when the
 * pagination preview measures. The test runner has no layout engine, so the
 * clone is simulated: a `.pv-page` stack that re-clones the preview's value
 * widgets when the preview generation changes.
 *
 * `reclone: false` reproduces the P0 shape — a snapshot taken when the preview
 * opened and never refreshed — so the export must refuse to print it.
 */
function fakePrintSheets(editor: Editor, reclone = true, droppedFieldIds: string[] = []) {
  document.querySelectorAll('.pagination-preview').forEach((el) => el.remove())
  const root = document.createElement('div')
  root.className = 'pagination-preview'
  const page = document.createElement('div')
  page.className = 'pv-page'
  root.appendChild(page)
  document.body.appendChild(root)
  const render = () => {
    page.innerHTML = ''
    const values = currentMailMergeValues(editor.state)
    if (!values) return
    for (const [index, instr] of templateFieldInstructions(editor).entries()) {
      if (droppedFieldIds.includes(String(index))) continue
      const report = { missing: [], unused: [], unsupported: 0, applied: 0 }
      const value = mergeFieldValue(instr, values, report)
      if (value === null) continue
      const span = document.createElement('span')
      span.className = 'mm-field-preview-value'
      span.dataset.mmPreviewKey = String(mailMergePreviewGeneration())
      span.dataset.mmFieldId = String(index)
      span.textContent = value
      page.appendChild(span)
    }
  }
  render()
  if (!reclone) return () => root.remove()
  editor.on('transaction', render)
  return () => {
    editor.off('transaction', render)
    root.remove()
  }
}

async function templateWith(xml: string) {
  const bytes = await buildDocx({ bodyXml: xml })
  const parsed = await parseDocx(bytes)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks),
  })
  return { parsed, editor }
}

const pdfOptions = (pattern: string): MailMergeExportOptions => ({
  format: 'pdf',
  scope: 'all',
  outputDir: '/out',
  pattern,
  overwrite: 'rename',
  combined: false,
})

const noCancel: CancelToken = { cancelled: false }

describe('pdf export validation', () => {
  it('prints one PDF per recipient with that recipient on screen', async () => {
    pdfWrites.length = 0
    const { parsed, editor } = await templateWith(
      '<w:p><w:r><w:t xml:space="preserve">Dear </w:t></w:r>' +
        field('MERGEFIELD "Full Name"', null) +
        '</w:p>',
    )
    stubDesktop([])
    const stop = fakePrintSheets(editor)
    const source = sourceFromRows([['Full Name'], ['Nguyễn Văn A'], ['Bo Tran']], {
      kind: 'csv',
      label: 'list.csv',
      hasHeader: true,
    })
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      source,
      pdfOptions('{index}_{Full Name}'),
      noCancel,
      () => {},
    )
    stop()
    editor.destroy()

    expect(progress.errors).toEqual([])
    expect(progress.succeeded).toBe(2)
    expect(progress.failed).toBe(0)
    expect(progress.status).toBe('completed')
    expect(pdfWrites.map((w) => w.path)).toEqual(['/out/1_Nguyễn Văn A.pdf', '/out/2_Bo Tran.pdf'])
    // each print job saw its own recipient, not the previous one
    expect(pdfWrites.map((w) => w.values?.['Full Name'])).toEqual(['Nguyễn Văn A', 'Bo Tran'])
  })

  it('merges a valid IF field whose column the row has', async () => {
    pdfWrites.length = 0
    const { parsed, editor } = await templateWith(
      '<w:p><w:r><w:t xml:space="preserve">Status: </w:t></w:r></w:p>',
    )
    // the field is inserted through the editor model, the way the Mailings tab
    // does; a Word-authored IF in a byte-preserved paragraph is a different,
    // documented limitation
    editor
      .chain()
      .focus()
      .insertContent({
        type: 'text',
        text: '«Status»',
        marks: [{ type: 'instrField', attrs: { instr: 'IF «Status» = "vip" "VIP guest" ""' } }],
      })
      .run()
    stubDesktop([])
    const stop = fakePrintSheets(editor)
    const source = sourceFromRows(
      [
        ['Name', 'Status'],
        ['Huy', 'vip'],
        ['An', ''],
      ],
      { kind: 'csv', label: 'list.csv', hasHeader: true },
    )
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      source,
      pdfOptions('{index}_{Name}'),
      noCancel,
      () => {},
    )
    stop()
    editor.destroy()

    expect(progress.errors).toEqual([])
    expect(progress.succeeded).toBe(2)
    expect(progress.failed).toBe(0)
    expect(pdfWrites[0].values).toEqual({ Name: 'Huy', Status: 'vip' })
    // an empty cell is not a failure: the IF takes its else branch (nothing)
    expect(pdfWrites[1].values).toEqual({ Name: 'An', Status: '' })
  })

  it('refuses a PDF for an IF field whose column the source does not have', async () => {
    pdfWrites.length = 0
    const { parsed, editor } = await templateWith(
      '<w:p><w:r><w:t xml:space="preserve">Status: </w:t></w:r></w:p>',
    )
    editor
      .chain()
      .focus()
      .insertContent({
        type: 'text',
        text: '«Status»',
        marks: [{ type: 'instrField', attrs: { instr: 'IF «Status» = "vip" "VIP guest"' } }],
      })
      .run()
    stubDesktop([])
    const stop = fakePrintSheets(editor)
    const source = sourceFromRows([['Name'], ['Huy']], {
      kind: 'csv',
      label: 'list.csv',
      hasHeader: true,
    })
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      source,
      pdfOptions('{index}_{Name}'),
      noCancel,
      () => {},
    )
    stop()
    editor.destroy()

    expect(pdfWrites.length).toBe(0)
    expect(progress.succeeded).toBe(0)
    expect(progress.failed).toBe(1)
    expect(progress.errors[0].message).toContain('Status')
    expect(progress.status).toBe('completed_with_errors')
  })

  it('refuses a PDF for an IF the merge model cannot parse', async () => {
    pdfWrites.length = 0
    const { parsed, editor } = await templateWith(
      '<w:p><w:r><w:t xml:space="preserve">Status: </w:t></w:r></w:p>',
    )
    editor
      .chain()
      .focus()
      .insertContent({
        type: 'text',
        text: '«Status»',
        // an operator with nothing after it: there is no branch to print, so the
        // merge refuses the recipient instead of writing a field Word would
        // re-evaluate on open
        marks: [{ type: 'instrField', attrs: { instr: 'IF Status =' } }],
      })
      .run()
    stubDesktop([])
    const stop = fakePrintSheets(editor)
    const source = sourceFromRows([['Name'], ['Huy']], {
      kind: 'csv',
      label: 'list.csv',
      hasHeader: true,
    })
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      source,
      pdfOptions('{index}_{Name}'),
      noCancel,
      () => {},
    )
    stop()
    editor.destroy()

    expect(pdfWrites.length).toBe(0)
    expect(progress.failed).toBe(1)
    expect(progress.errors[0].message).toContain('could not be merged')
    expect(progress.status).toBe('completed_with_errors')
  })

  it('treats a bare word in an IF comparison as a literal, not a missing column', async () => {
    pdfWrites.length = 0
    const { parsed, editor } = await templateWith(
      '<w:p><w:r><w:t xml:space="preserve">Status: </w:t></w:r></w:p>',
    )
    editor
      .chain()
      .focus()
      .insertContent({
        type: 'text',
        text: '«Status»',
        // Word writes `IF Status = "vip" "VIP guest"`: `Status` is the text
        // "Status", not a column. The condition is false for every recipient, so
        // the field prints nothing — it is not an error, and the export must not
        // be refused for a template Word merges without complaint.
        marks: [{ type: 'instrField', attrs: { instr: 'IF Status = "vip" "VIP guest"' } }],
      })
      .run()
    stubDesktop([])
    const stop = fakePrintSheets(editor)
    const source = sourceFromRows([['Name'], ['Huy']], {
      kind: 'csv',
      label: 'list.csv',
      hasHeader: true,
    })
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      source,
      pdfOptions('{index}_{Name}'),
      noCancel,
      () => {},
    )
    stop()
    editor.destroy()

    expect(pdfWrites.length).toBe(1)
    expect(progress.failed).toBe(0)
    expect(progress.status).toBe('completed')
  })

  it('fails the job when the preview never produces print sheets', async () => {
    pdfWrites.length = 0
    const { parsed, editor } = await templateWith(
      '<w:p><w:r><w:t xml:space="preserve">Dear </w:t></w:r></w:p>',
    )
    stubDesktop([])
    // no pagination preview: nothing has been cloned, so there is nothing to print
    document.querySelectorAll('.pagination-preview').forEach((el) => el.remove())
    const source = sourceFromRows([['Name'], ['Huy']], {
      kind: 'csv',
      label: 'list.csv',
      hasHeader: true,
    })
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      source,
      { ...pdfOptions('{index}_{Name}'), format: 'pdf' },
      { cancelled: false },
      () => {},
    )
    editor.destroy()
    expect(pdfWrites.length).toBe(0)
    expect(progress.status).toBe('failed')
    expect(progress.errors[0].message).toContain('layout never settled')
  }, 25_000)
})

describe('printable preview readiness', () => {
  /** A clone of the print sheets, exactly as the pagination preview builds them. */
  function sheets(html: string) {
    document.querySelectorAll('.pagination-preview').forEach((el) => el.remove())
    const root = document.createElement('div')
    root.className = 'pagination-preview'
    const page = document.createElement('div')
    page.className = 'pv-page'
    page.innerHTML = html
    root.appendChild(page)
    document.body.appendChild(root)
    return root
  }

  it('refuses sheets that carry no recipient at all', () => {
    sheets('')
    // a template with a merge field whose clone has no value widget is a clone
    // taken before this recipient was put on screen
    expect(printablePreviewIsCurrent(1, ['0'])).toBe(false)
    // a template with no merge field at all needs no stamp: the sheets are the
    // document, and printing it is not a recipient-isolation question
    expect(printablePreviewIsCurrent(1, [])).toBe(true)
  })

  it('refuses sheets stamped with the recipient that was on screen before', () => {
    sheets(
      '<span class="mm-field-preview-value" data-mm-preview-key="4" data-mm-field-id="0">Bo Tran</span>',
    )
    expect(printablePreviewIsCurrent(5, ['0'])).toBe(false)
    expect(printablePreviewIsCurrent(4, ['0'])).toBe(true)
  })

  it('accepts sheets stamped with the recipient being printed', () => {
    sheets(
      '<span class="mm-field-preview-value" data-mm-preview-key="5" data-mm-field-id="0">Nguyễn Văn A</span>',
    )
    expect(printablePreviewIsCurrent(5, ['0'])).toBe(true)
  })

  it('refuses a clone that kept only one of three fields', () => {
    sheets(
      '<span class="mm-field-preview-value" data-mm-preview-key="7" data-mm-field-id="0">Ada</span>',
    )
    // the old rule ("every widget found is current") accepted this: the single
    // widget present is stamped 7. Address and AccountNumber never made it onto
    // the sheet Chromium prints.
    expect(printablePreviewIsCurrent(7, ['0', '1', '2'])).toBe(false)
  })

  it('refuses a clone with one current and one stale widget', () => {
    sheets(
      '<span class="mm-field-preview-value" data-mm-preview-key="7" data-mm-field-id="0">Ada</span>' +
        '<span class="mm-field-preview-value" data-mm-preview-key="6" data-mm-field-id="1">Bo</span>',
    )
    expect(printablePreviewIsCurrent(7, ['0', '1'])).toBe(false)
  })

  it('refuses a clone whose only widget is stale even when nothing else is stamped', () => {
    sheets(
      '<span class="mm-field-preview-value" data-mm-preview-key="6" data-mm-field-id="0">Bo</span>',
    )
    expect(printablePreviewIsCurrent(7, ['0'])).toBe(false)
  })

  it('accepts a field that appears twice, and one repeated across sheets', () => {
    document.querySelectorAll('.pagination-preview').forEach((el) => el.remove())
    const root = document.createElement('div')
    root.className = 'pagination-preview'
    const first = document.createElement('div')
    first.className = 'pv-page'
    first.innerHTML =
      '<span class="mm-field-preview-value" data-mm-preview-key="7" data-mm-field-id="0">Ada</span>'
    const second = document.createElement('div')
    second.className = 'pv-page'
    second.innerHTML =
      '<span class="mm-field-preview-value" data-mm-preview-key="7" data-mm-field-id="1">London</span>' +
      '<span class="mm-field-preview-value" data-mm-preview-key="7" data-mm-field-id="1">London</span>'
    root.appendChild(first)
    root.appendChild(second)
    document.body.appendChild(root)
    expect(printablePreviewIsCurrent(7, ['0', '1'])).toBe(true)
    expect(printablePreviewIsCurrent(7, ['0', '1', '2'])).toBe(false)
  })

  it('a field the clone hid is still a field the print carries', () => {
    sheets(
      '<span class="mm-field-preview-value" data-mm-preview-key="7" data-mm-field-id="0" style="visibility:hidden">Ada</span>',
    )
    expect(printablePreviewIsCurrent(7, ['0'])).toBe(true)
  })

  it('a sheet cloned before the preview opened never becomes current', async () => {
    const { parsed, editor } = await templateWith(
      '<w:p>' + field('MERGEFIELD Name', null) + '</w:p>',
    )
    const stop = fakePrintSheets(editor, false)
    const generation = setMailMergePreview(editor, { Name: 'Huy' })
    expect(await waitForPrintablePreview(generation, expectedPreviewFieldIds(editor), 600)).toBe(
      false,
    )
    stop()
    editor.destroy()
    void parsed
  })

  it('becomes current once the clone re-measures for the new recipient', async () => {
    const { parsed, editor } = await templateWith(
      '<w:p>' + field('MERGEFIELD Name', null) + '</w:p>',
    )
    const stop = fakePrintSheets(editor)
    const generation = setMailMergePreview(editor, { Name: 'Huy' })
    expect(await waitForPrintablePreview(generation, expectedPreviewFieldIds(editor), 2000)).toBe(
      true,
    )
    stop()
    editor.destroy()
    void parsed
  })

  it('waits for the preview to mount before printing anything', async () => {
    document.querySelectorAll('.pagination-preview').forEach((el) => el.remove())
    expect(await waitForPreviewSheets(400)).toBe(false)
    sheets('')
    expect(await waitForPreviewSheets(1000)).toBe(true)
  })
})

describe("the PDF writer's real outcome reaches the batch", () => {
  /** A stub that mirrors the main process writer: same policy, same names. */
  function writerBehaviour(files: string[], allocated: Set<string>) {
    pdfBehaviour = (path: string, overwrite: string | undefined) => {
      const name = path.split('/').pop() ?? path
      const decision = resolveSafeFileName(
        name,
        overwrite === 'skip' || overwrite === 'rename' || overwrite === 'overwrite'
          ? overwrite
          : 'overwrite',
        (candidate) => files.includes(candidate),
        allocated,
      )
      if (!decision.name) return { ok: false, error: 'invalid file name' }
      if (decision.skipped)
        return { ok: false, skipped: true, path: `/out/${decision.name}`, name: decision.name }
      files.push(decision.name)
      allocated.add(decision.name)
      return { ok: true, path: `/out/${decision.name}`, name: decision.name }
    }
  }

  async function runPdfBatch(overwrite: MailMergeExportOptions['overwrite'], names: string[]) {
    pdfWrites.length = 0
    const files: string[] = []
    const allocated = new Set<string>()
    writerBehaviour(files, allocated)
    const { parsed, editor } = await templateWith(
      '<w:p><w:r><w:t xml:space="preserve">Dear </w:t></w:r>' +
        field('MERGEFIELD Name', null) +
        '</w:p>',
    )
    stubDesktop([])
    const stop = fakePrintSheets(editor)
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      sourceFromRows([['Name'], ...names.map((n) => [n])], {
        kind: 'csv',
        label: 'list.csv',
        hasHeader: true,
      }),
      {
        format: 'pdf',
        scope: 'all',
        outputDir: '/out',
        pattern: '{Name}',
        overwrite,
        combined: false,
      },
      noCancel,
      () => {},
    )
    stop()
    editor.destroy()
    return { progress, files }
  }

  it('counts a skipped destination as skipped, not as a produced file', async () => {
    const { progress, files } = await runPdfBatch('skip', ['Huy', 'An'])
    expect(progress.succeeded).toBe(2)
    expect(progress.skipped).toBe(0)
    expect(files).toEqual(['Huy.pdf', 'An.pdf'])
  })

  it('reports a writer skip as skipped and never as succeeded', async () => {
    pdfWrites.length = 0
    const { parsed, editor } = await templateWith(
      '<w:p>' + field('MERGEFIELD Name', null) + '</w:p>',
    )
    stubDesktop([])
    const stop = fakePrintSheets(editor)
    pdfBehaviour = (path) => ({
      ok: false,
      skipped: true,
      path,
      name: path.split('/').pop() ?? path,
    })
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      sourceFromRows([['Name'], ['Huy'], ['An']], { kind: 'csv', label: 'l.csv', hasHeader: true }),
      {
        format: 'pdf',
        scope: 'all',
        outputDir: '/out',
        pattern: '{Name}',
        overwrite: 'skip',
        combined: false,
      },
      noCancel,
      () => {},
    )
    stop()
    editor.destroy()
    expect(progress.succeeded).toBe(0)
    expect(progress.skipped).toBe(2)
    expect(progress.failed).toBe(0)
    // the user chose "skip existing files": a destination that already existed is
    // not an error, so the batch is complete rather than "with errors"
    expect(progress.status).toBe('completed')
  })

  it('records the name the writer actually used when it renames', async () => {
    pdfWrites.length = 0
    const files: string[] = []
    const allocated = new Set<string>()
    writerBehaviour(files, allocated)
    const { parsed, editor } = await templateWith(
      '<w:p>' + field('MERGEFIELD Name', null) + '</w:p>',
    )
    stubDesktop([])
    const stop = fakePrintSheets(editor)
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      sourceFromRows([['Name'], ['Huy'], ['Huy']], {
        kind: 'csv',
        label: 'l.csv',
        hasHeader: true,
      }),
      {
        format: 'pdf',
        scope: 'all',
        outputDir: '/out',
        pattern: '{Name}',
        overwrite: 'overwrite',
        combined: false,
      },
      noCancel,
      () => {},
    )
    stop()
    editor.destroy()
    expect(progress.succeeded).toBe(2)
    expect(progress.failed).toBe(0)
    expect(files).toEqual(['Huy.pdf', 'Huy (2).pdf'])
    expect(new Set(files).size).toBe(2)
  })

  it("reports the writer's error rather than a generic failure", async () => {
    pdfWrites.length = 0
    const { parsed, editor } = await templateWith(
      '<w:p>' + field('MERGEFIELD Name', null) + '</w:p>',
    )
    stubDesktop([])
    const stop = fakePrintSheets(editor)
    pdfBehaviour = () => ({ ok: false, error: 'Chromium refused the print job' })
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      sourceFromRows([['Name'], ['Huy']], { kind: 'csv', label: 'l.csv', hasHeader: true }),
      {
        format: 'pdf',
        scope: 'all',
        outputDir: '/out',
        pattern: '{Name}',
        overwrite: 'overwrite',
        combined: false,
      },
      noCancel,
      () => {},
    )
    stop()
    editor.destroy()
    expect(progress.succeeded).toBe(0)
    expect(progress.failed).toBe(1)
    expect(progress.errors[0].message).toBe('Chromium refused the print job')
  })

  it('passes the batch overwrite policy through to the print bridge', async () => {
    pdfWrites.length = 0
    pdfBehaviour = (path) => ({ ok: true, path, name: path.split('/').pop() ?? path })
    const { parsed, editor } = await templateWith(
      '<w:p>' + field('MERGEFIELD Name', null) + '</w:p>',
    )
    stubDesktop([])
    const stop = fakePrintSheets(editor)
    await runMailMergeExport(
      makeCtx(editor, parsed),
      sourceFromRows([['Name'], ['Huy']], { kind: 'csv', label: 'l.csv', hasHeader: true }),
      {
        format: 'pdf',
        scope: 'all',
        outputDir: '/out',
        pattern: '{Name}',
        overwrite: 'rename',
        combined: false,
      },
      noCancel,
      () => {},
    )
    stop()
    editor.destroy()
    expect(pdfWrites[0].overwrite).toBe('rename')
  })
})

describe('a print clone that lost a field is refused before Chromium prints', () => {
  it('writes no PDF when only one of three fields reached the sheets', async () => {
    pdfWrites.length = 0
    const { parsed, editor } = await templateWith(
      '<w:p>' +
        field('MERGEFIELD Name', '«Name»') +
        '</w:p>' +
        '<w:p>' +
        field('MERGEFIELD Address', '«Address»') +
        '</w:p>' +
        '<w:p>' +
        field('MERGEFIELD AccountNumber', '«AccountNumber»') +
        '</w:p>',
    )
    stubDesktop([])
    // the clone re-measures for the recipient, but two of the three widgets never
    // make it onto the printed sheets
    const stop = fakePrintSheets(editor, true, ['1', '2'])
    const source = sourceFromRows(
      [
        ['Name', 'Address', 'AccountNumber'],
        ['Ada', '123 Nguyễn Huệ', 'A-1'],
      ],
      { kind: 'csv', label: 'list.csv', hasHeader: true },
    )
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      source,
      pdfOptions('{index}_{Name}'),
      noCancel,
      () => {},
    )
    stop()
    editor.destroy()

    expect(pdfWrites.length).toBe(0)
    expect(progress.succeeded).toBe(0)
    expect(progress.failed).toBe(1)
    expect(progress.errors.some((e) => e.message.includes('did not update'))).toBe(true)
  }, 40_000)

  it('prints when every field the template references is on the sheets', async () => {
    pdfWrites.length = 0
    const { parsed, editor } = await templateWith(
      '<w:p>' +
        field('MERGEFIELD Name', '«Name»') +
        '</w:p>' +
        '<w:p>' +
        field('MERGEFIELD Address', '«Address»') +
        '</w:p>' +
        '<w:p>' +
        field('MERGEFIELD AccountNumber', '«AccountNumber»') +
        '</w:p>',
    )
    stubDesktop([])
    const stop = fakePrintSheets(editor)
    const source = sourceFromRows(
      [
        ['Name', 'Address', 'AccountNumber'],
        ['Ada', '123 Nguyễn Huệ', 'A-1'],
      ],
      { kind: 'csv', label: 'list.csv', hasHeader: true },
    )
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      source,
      pdfOptions('{index}_{Name}'),
      noCancel,
      () => {},
    )
    stop()
    editor.destroy()
    expect(progress.succeeded).toBe(1)
    expect(pdfWrites.length).toBe(1)
  })
})
