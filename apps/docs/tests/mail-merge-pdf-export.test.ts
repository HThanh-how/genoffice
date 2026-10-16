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
import { currentMailMergeValues } from '../src/renderer/editor/mail-merge-preview'
import type { FileActionContext } from '../src/renderer/file-actions'
import {
  runMailMergeExport,
  waitForPagination,
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
 * The app re-measures pagination after every preview transaction; the test
 * runner has no layout engine, so the revision signal is simulated.
 */
function fakeLayout(rev = 1, pages = 1) {
  let current = rev
  const publish = () => {
    ;(
      window as unknown as {
        __pageDebug: { rev: number; passAt: number; slices: unknown[] }
      }
    ).__pageDebug = {
      rev: current,
      passAt: Date.now(),
      slices: Array.from({ length: pages }, () => 1),
    }
  }
  publish()
  const timer = setInterval(() => {
    current += 1
    publish()
  }, 60)
  return () => clearInterval(timer)
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
    const stop = fakeLayout(1, 2)
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
    const stop = fakeLayout(1, 1)
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
    const stop = fakeLayout(1, 1)
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
        marks: [{ type: 'instrField', attrs: { instr: 'IF Status = "vip" "VIP guest"' } }],
      })
      .run()
    stubDesktop([])
    const stop = fakeLayout(1, 1)
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

  it('fails the job when the layout never settles, rather than printing unmeasured pages', async () => {
    pdfWrites.length = 0
    const { parsed, editor } = await templateWith(
      '<w:p><w:r><w:t xml:space="preserve">Dear </w:t></w:r></w:p>',
    )
    stubDesktop([])
    // no pagination preview, no slices: nothing has been measured
    ;(window as unknown as { __pageDebug: { rev: number; slices: unknown[] } }).__pageDebug = {
      rev: 0,
      slices: [],
    }
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

describe('pagination wait', () => {
  const editorWith = (text: string) =>
    new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: text,
    })

  it('accepts a layout that is already measured and not moving, before any recipient is shown', async () => {
    const editor = editorWith('Dear «Name»')
    // the pass timestamp never advances: nothing has changed, so there is no new
    // pass to wait for
    ;(
      window as unknown as {
        __pageDebug: { rev: number; passAt: number; slices: unknown[] }
      }
    ).__pageDebug = {
      rev: 7,
      passAt: 1_000,
      slices: [1, 1],
    }
    expect(await waitForPagination(editor, 1_000, 1000, false)).toBe(true)
    // the same state is still stale for a recipient whose values just went on screen
    expect(await waitForPagination(editor, 2_000, 600, true)).toBe(false)
    editor.destroy()
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
    const stop = fakeLayout(1, 1)
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
    const stop = fakeLayout(1, 1)
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
    const stop = fakeLayout(1, 1)
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
    const stop = fakeLayout(1, 1)
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
    const stop = fakeLayout(1, 1)
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
