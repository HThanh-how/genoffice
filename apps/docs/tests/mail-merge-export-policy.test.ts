/**
 * The export runner's contract: the overwrite policy the user chose, the
 * fail-closed rule that a recipient with an unresolved merge field produces no
 * file, and the preview state the editor is left in afterwards.
 *
 * `window.desktop` is stubbed so the writes are recorded rather than touching
 * the filesystem; everything else — the editor, the save pipeline, the merge
 * engine — is the real code the Mailings tab uses.
 */
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { Editor } from '@tiptap/core'
import { parseDocx, saveDocx, type ParsedDocFull } from '@genoffice/docx-engine'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { insertMergeField } from '../src/renderer/editor/merge-doc'
import {
  currentMailMergeValues,
  setMailMergePreview,
} from '../src/renderer/editor/mail-merge-preview'
import { templateMergeFields } from '../src/renderer/mail-merge/validation'
import type { FileActionContext } from '../src/renderer/file-actions'
import {
  resolveOutputName,
  runMailMergeExport,
  waitForPagination,
  type CancelToken,
} from '../src/renderer/mail-merge/export'
import { sourceFromRows } from '../src/renderer/mail-merge/data-source'
import {
  applyJobFailure,
  initialProgress,
  isFinished,
  terminalStatus,
} from '../src/renderer/mail-merge/progress'
import type { MailMergeExportOptions, MailMergeSource } from '../src/renderer/mail-merge/types'

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

/** The state buildDocBytes reads; the rest of the ribbon context is irrelevant here. */
function makeCtx(editor: Editor, parsed: ParsedDocFull): FileActionContext {
  return {
    editor,
    doc: { parsed, filePath: null, fileName: 'template.docx', hash: '' },
    inkAnnotations: [],
    inksDirty: false,
    sections: [],
    section: null,
    sectionDirty: false,
    sectionsDirty: [],
    pgNumDirtySections: [],
    trailingStartType: null,
    pgNumEdit: undefined,
    sectionHfEdits: {},
    hfLinks: {},
    titlePg: false,
    titlePgDirty: false,
    evenOddHf: false,
    evenOddHfDirty: false,
    mirrorMargins: false,
    mirrorMarginsDirty: false,
    pageColor: null,
    pageColorDirty: false,
    defaultFonts: undefined,
    styleUpserts: {},
    numberingDirty: false,
    pendingNumbering: undefined,
    commentsDirty: false,
    comments: undefined,
    protectionDirty: false,
    protection: undefined,
    writeProtectionDirty: false,
    writeProtection: undefined,
    removePersonalInfoDirty: false,
    removePersonalInfo: undefined,
    watermarkDirty: false,
    watermark: undefined,
    watermarkPicture: undefined,
    notesDirty: false,
    footnotes: undefined,
    endnotes: undefined,
    sourcesDirty: false,
    sources: undefined,
    zoteroDocumentDataDirty: false,
    zoteroDocumentData: undefined,
    themeFontsDirty: false,
    themeFonts: undefined,
    themeColorsDirty: false,
    themeColors: undefined,
    setShowPagePreview: () => {},
    setStatus: () => {},
  } as unknown as FileActionContext
}

/** A destination directory that already contains `names`, with writes recorded. */
function stubDesktop(existing: string[]) {
  const written: Array<{ name: string; overwrite: string; base64: string }> = []
  const files = [...existing]
  Object.assign(window, {
    desktop: {
      listMailMergeOutput: async () => ({ ok: true, names: [...files] }),
      writeMailMergeFile: async (dir: string, name: string, base64: string, overwrite: string) => {
        if (files.includes(name)) {
          if (overwrite === 'skip') return { ok: false, skipped: true, path: `${dir}/${name}` }
          if (overwrite === 'rename') {
            const dot = name.lastIndexOf('.')
            const base = dot > 0 ? name.slice(0, dot) : name
            const ext = dot > 0 ? name.slice(dot) : ''
            let n = 2
            while (files.includes(`${base} (${n})${ext}`)) n += 1
            const renamed = `${base} (${n})${ext}`
            files.push(renamed)
            written.push({ name: renamed, overwrite, base64 })
            return { ok: true, path: `${dir}/${renamed}` }
          }
        }
        files.push(name)
        written.push({ name, overwrite, base64 })
        return { ok: true, path: `${dir}/${name}` }
      },
    },
  })
  return written
}

async function templateWith(xml: string) {
  const bytes = await buildDocx({ bodyXml: xml })
  const parsed = await parseDocx(bytes)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks),
  })
  return { bytes, parsed, editor }
}

const options = (overwrite: MailMergeExportOptions['overwrite']): MailMergeExportOptions => ({
  format: 'docx',
  scope: 'all',
  outputDir: '/out',
  pattern: '{index}_{Name}',
  overwrite,
  combined: false,
})

const noCancel: CancelToken = { cancelled: false }

describe('overwrite policy', () => {
  it('decides the file name from the files that really exist in the directory', () => {
    const taken = new Set(['0001_Huy.docx'])
    expect(resolveOutputName('0001_Huy.docx', taken, 'skip')).toEqual({
      name: '0001_Huy.docx',
      skipped: true,
    })
    expect(resolveOutputName('0001_Huy.docx', taken, 'rename')).toEqual({
      name: '0001_Huy (2).docx',
      skipped: false,
    })
    expect(resolveOutputName('0001_Huy.docx', taken, 'overwrite')).toEqual({
      name: '0001_Huy.docx',
      skipped: false,
    })
    // a name nobody has used is written as-is under every policy
    expect(resolveOutputName('0002_An.docx', taken, 'skip').skipped).toBe(false)
  })

  it('replaces an existing file when the user chose overwrite', async () => {
    const { parsed, editor } = await templateWith(
      '<w:p>' + field('MERGEFIELD Name', null) + '</w:p>',
    )
    const written = stubDesktop(['1_Huy.docx'])
    const source = sourceFromRows([['Name'], ['Huy'], ['An']], {
      kind: 'csv',
      label: 'list.csv',
      hasHeader: true,
    })
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      source,
      options('overwrite'),
      noCancel,
      () => {},
    )
    editor.destroy()
    expect(written.map((w) => w.name)).toEqual(['1_Huy.docx', '2_An.docx'])
    expect(progress.succeeded).toBe(2)
    expect(progress.skipped).toBe(0)
  })

  it('leaves an existing file alone when the user chose skip', async () => {
    const { parsed, editor } = await templateWith(
      '<w:p>' + field('MERGEFIELD Name', null) + '</w:p>',
    )
    const written = stubDesktop(['1_Huy.docx'])
    const source = sourceFromRows([['Name'], ['Huy'], ['An']], {
      kind: 'csv',
      label: 'list.csv',
      hasHeader: true,
    })
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      source,
      options('skip'),
      noCancel,
      () => {},
    )
    editor.destroy()
    expect(written.map((w) => w.name)).toEqual(['2_An.docx'])
    expect(progress.skipped).toBe(1)
    expect(progress.succeeded).toBe(1)
    expect(progress.done).toBe(2)
  })

  it('renames around an existing file when the user chose rename', async () => {
    const { parsed, editor } = await templateWith(
      '<w:p>' + field('MERGEFIELD Name', null) + '</w:p>',
    )
    const written = stubDesktop(['1_Huy.docx'])
    const source = sourceFromRows([['Name'], ['Huy'], ['An']], {
      kind: 'csv',
      label: 'list.csv',
      hasHeader: true,
    })
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      source,
      options('rename'),
      noCancel,
      () => {},
    )
    editor.destroy()
    expect(written.map((w) => w.name)).toEqual(['1_Huy (2).docx', '2_An.docx'])
    expect(progress.succeeded).toBe(2)
  })
})

describe('fail-closed export', () => {
  it('writes nothing for a recipient whose row is missing a column the template uses', async () => {
    const { parsed, editor } = await templateWith(
      '<w:p>' + field('MERGEFIELD Name', null) + ' ' + field('MERGEFIELD City', null) + '</w:p>',
    )
    const written = stubDesktop([])
    const source: MailMergeSource = {
      kind: 'csv',
      label: 'list.csv',
      columns: [{ name: 'Name', header: 'Name' }],
      recipients: [
        { id: 0, values: { Name: 'Huy' }, selected: true },
        { id: 1, values: { Name: 'An', City: 'Paris' }, selected: true },
      ],
      hasHeader: true,
    }
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      source,
      options('rename'),
      noCancel,
      () => {},
    )
    editor.destroy()
    expect(written.map((w) => w.name)).toEqual(['2_An.docx'])
    expect(progress.failed).toBe(1)
    expect(progress.succeeded).toBe(1)
    expect(progress.done).toBe(2)
    expect(progress.errors[0].recipient).toBe('1_Huy.docx')
    expect(progress.errors[0].message).toContain('City')
    expect(progress.status).toBe('completed_with_errors')
  })

  it('accepts an empty cell in an optional column', async () => {
    const { parsed, editor } = await templateWith(
      '<w:p>' + field('MERGEFIELD Name', null) + ' ' + field('MERGEFIELD Note', null) + '</w:p>',
    )
    const written = stubDesktop([])
    const source = sourceFromRows(
      [
        ['Name', 'Note'],
        ['Huy', ''],
        ['An', 'vip'],
      ],
      { kind: 'csv', label: 'list.csv', hasHeader: true },
    )
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      source,
      options('rename'),
      noCancel,
      () => {},
    )
    editor.destroy()
    expect(written.length).toBe(2)
    expect(progress.failed).toBe(0)
    expect(progress.status).toBe('completed')
  })

  it('refuses a recipient whose field instruction cannot be resolved', async () => {
    const { parsed, editor } = await templateWith(
      '<w:p>' + field('IF «Name» = "x" "a"', null) + '</w:p>',
    )
    const written = stubDesktop([])
    const source = sourceFromRows([['Name'], ['Huy']], {
      kind: 'csv',
      label: 'list.csv',
      hasHeader: true,
    })
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      source,
      options('rename'),
      noCancel,
      () => {},
    )
    editor.destroy()
    expect(written.length).toBe(0)
    expect(progress.failed).toBe(1)
    expect(progress.errors[0].message).toContain('cannot rewrite')
    expect(progress.errors[0].message).toContain('IF')
    expect(progress.status).toBe('completed_with_errors')
  })

  it('refuses a recipient whose merge field instruction cannot be parsed', async () => {
    const { parsed, editor } = await templateWith(
      '<w:p><w:r><w:t xml:space="preserve">Dear </w:t></w:r></w:p>',
    )
    editor
      .chain()
      .focus()
      .insertContent({
        type: 'text',
        text: '«Name»',
        marks: [{ type: 'instrField', attrs: { instr: 'MERGEFIELD' } }],
      })
      .run()
    const written = stubDesktop([])
    const source = sourceFromRows([['Name'], ['Huy']], {
      kind: 'csv',
      label: 'list.csv',
      hasHeader: true,
    })
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      source,
      options('rename'),
      noCancel,
      () => {},
    )
    editor.destroy()
    expect(written.length).toBe(0)
    expect(progress.failed).toBe(1)
    expect(progress.errors[0].message).toContain('could not be merged')
    expect(progress.status).toBe('completed_with_errors')
  })

  it('reports a terminal status when the document is not open', async () => {
    stubDesktop([])
    const source = sourceFromRows([['Name'], ['Huy']], {
      kind: 'csv',
      label: 'list.csv',
      hasHeader: true,
    })
    const progress = await runMailMergeExport(
      { editor: null, doc: null } as unknown as FileActionContext,
      source,
      options('rename'),
      noCancel,
      () => {},
    )
    expect(progress.status).toBe('failed')
    expect(progress.failed).toBe(1)
    expect(isFinished(progress)).toBe(true)
  })
})

describe('preview state after a batch', () => {
  it('restores the preview the editor had before the export', async () => {
    const { parsed, editor } = await templateWith(
      '<w:p>' + field('MERGEFIELD Name', null) + '</w:p>',
    )
    stubDesktop([])
    setMailMergePreview(editor, { Name: 'Someone else' })
    const source = sourceFromRows([['Name'], ['Huy'], ['An']], {
      kind: 'csv',
      label: 'list.csv',
      hasHeader: true,
    })
    await runMailMergeExport(makeCtx(editor, parsed), source, options('rename'), noCancel, () => {})
    expect(currentMailMergeValues(editor.state)).toEqual({ Name: 'Someone else' })
    editor.destroy()
  })

  it('leaves no recipient on screen when the editor had no preview', async () => {
    const { parsed, editor } = await templateWith(
      '<w:p>' + field('MERGEFIELD Name', null) + '</w:p>',
    )
    stubDesktop([])
    const source = sourceFromRows([['Name'], ['Huy'], ['An']], {
      kind: 'csv',
      label: 'list.csv',
      hasHeader: true,
    })
    await runMailMergeExport(makeCtx(editor, parsed), source, options('rename'), noCancel, () => {})
    expect(currentMailMergeValues(editor.state)).toBeNull()
    editor.destroy()
  })
})

describe('multi-word merge fields through the editor', () => {
  it('refuses a column name that cannot be a merge field instead of renaming it', async () => {
    const { editor } = await templateWith(
      '<w:p><w:r><w:t xml:space="preserve">Dear </w:t></w:r></w:p>',
    )
    // a name containing a double quote cannot be a MERGEFIELD name; inserting a
    // field for it would silently point at a different column, so nothing is
    // inserted at all
    expect(insertMergeField(editor, 'He said "hi"')).toBe(false)
    expect(templateMergeFields(editor)).toEqual([])
    expect(editor.state.doc.textContent).toBe('Dear ')
    editor.destroy()
  })

  it('inserts, saves, reopens and merges a column name containing spaces', async () => {
    const { parsed, editor } = await templateWith(
      '<w:p><w:r><w:t xml:space="preserve">Dear </w:t></w:r></w:p>',
    )
    insertMergeField(editor, 'Full Name')
    insertMergeField(editor, 'Postal Address')
    // the editor model holds the quoted instruction, not a bare token
    expect(templateMergeFields(editor).map((f) => f.name)).toEqual(['Full Name', 'Postal Address'])

    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    const saved = await saveDocx(parsed, plan.saveBlocks)
    const reopened = await parseDocx(saved)

    const editor2 = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc(reopened.blocks),
    })
    const written = stubDesktop([])
    const source = sourceFromRows(
      [
        ['Full Name', 'Postal Address'],
        ['Nguyễn Văn A', '123 Nguyễn Huệ'],
      ],
      { kind: 'csv', label: 'list.csv', hasHeader: true },
    )
    const progress = await runMailMergeExport(
      makeCtx(editor2, reopened),
      source,
      { ...options('rename'), pattern: '{index}_{Full Name}' },
      noCancel,
      () => {},
    )
    editor.destroy()
    editor2.destroy()
    expect(progress.succeeded).toBe(1)
    expect(written[0].name).toBe('1_Nguyễn Văn A.docx')
    // the file the batch wrote really contains both recipient values and no
    // leftover field machinery
    const xml = await documentXmlOf(new Uint8Array(Buffer.from(written[0].base64, 'base64')))
    expect(xml).toContain('Nguyễn Văn A')
    expect(xml).toContain('123 Nguyễn Huệ')
    expect(xml).not.toContain('MERGEFIELD')
    expect(xml).not.toContain('fldChar')
  })
})

describe('duplicate file names inside one batch', () => {
  const pattern = (overwrite: MailMergeExportOptions['overwrite']): MailMergeExportOptions => ({
    format: 'docx',
    scope: 'all',
    outputDir: '/out',
    // no {index}: two recipients with the same name resolve to the same file
    pattern: '{Name}',
    overwrite,
    combined: false,
  })

  const sameNameSource = () =>
    sourceFromRows([['Name'], ['Huy'], ['Huy']], {
      kind: 'csv',
      label: 'list.csv',
      hasHeader: true,
    })

  it('gives two recipients with the same name two different files', async () => {
    const { parsed, editor } = await templateWith(
      '<w:p>' + field('MERGEFIELD Name', null) + '</w:p>',
    )
    const written = stubDesktop([])
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      sameNameSource(),
      pattern('overwrite'),
      noCancel,
      () => {},
    )
    editor.destroy()
    expect(written.map((w) => w.name)).toEqual(['Huy.docx', 'Huy (2).docx'])
    // the second recipient did not overwrite the first, even though the policy
    // says "overwrite": that policy is about files that were there before the batch
    expect(progress.succeeded).toBe(2)
    expect(progress.succeeded).toBe(written.length)
  })

  it('renames around a pre-existing file and still separates the recipients', async () => {
    const { parsed, editor } = await templateWith(
      '<w:p>' + field('MERGEFIELD Name', null) + '</w:p>',
    )
    const written = stubDesktop(['Huy.docx'])
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      sameNameSource(),
      pattern('rename'),
      noCancel,
      () => {},
    )
    editor.destroy()
    expect(written.map((w) => w.name)).toEqual(['Huy (2).docx', 'Huy (3).docx'])
    expect(progress.succeeded).toBe(written.length)
  })

  it('skips a pre-existing file for every recipient that resolves to it', async () => {
    const { parsed, editor } = await templateWith(
      '<w:p>' + field('MERGEFIELD Name', null) + '</w:p>',
    )
    const written = stubDesktop(['Huy.docx'])
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      sameNameSource(),
      pattern('skip'),
      noCancel,
      () => {},
    )
    editor.destroy()
    expect(written.length).toBe(0)
    expect(progress.skipped).toBe(2)
    expect(progress.succeeded).toBe(0)
  })

  it('overwrites a file that predates the batch but never one the batch wrote', async () => {
    const { parsed, editor } = await templateWith(
      '<w:p>' + field('MERGEFIELD Name', null) + '</w:p>',
    )
    const written = stubDesktop(['Huy.docx'])
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      sameNameSource(),
      pattern('overwrite'),
      noCancel,
      () => {},
    )
    editor.destroy()
    expect(written.map((w) => w.name)).toEqual(['Huy.docx', 'Huy (2).docx'])
    expect(progress.succeeded).toBe(written.length)
  })

  it('counts successes as the files actually written', async () => {
    const { parsed, editor } = await templateWith(
      '<w:p>' + field('MERGEFIELD Name', null) + '</w:p>',
    )
    const written = stubDesktop([])
    const source = sourceFromRows([['Name'], ['Huy'], ['An'], ['An']], {
      kind: 'csv',
      label: 'list.csv',
      hasHeader: true,
    })
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      source,
      pattern('rename'),
      noCancel,
      () => {},
    )
    editor.destroy()
    expect(written.map((w) => w.name)).toEqual(['Huy.docx', 'An.docx', 'An (2).docx'])
    expect(progress.succeeded).toBe(written.length)
    expect(progress.done).toBe(3)
  })
})

describe('pagination signal', () => {
  const editorWith = (text: string) =>
    new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: text,
    })

  it('never settles on a layout pass that predates the recipient', async () => {
    const editor = editorWith('Dear «Name»')
    // two recipients can have the same page count: a stable slice list alone
    // is not proof the current recipient was measured
    ;(window as unknown as { __pageDebug: { rev: number; slices: unknown[] } }).__pageDebug = {
      rev: 1,
      slices: [1, 1],
    }
    const settled = await waitForPagination(editor, 5, 600)
    expect(settled).toBe(false)
    editor.destroy()
  })

  it('settles once a pass commits after the preview and the page count stops moving', async () => {
    const editor = editorWith('Dear Nguyễn Văn A with a very long multiline address line')
    let rev = 1
    const timer = setInterval(() => {
      rev += 1
      ;(window as unknown as { __pageDebug: { rev: number; slices: unknown[] } }).__pageDebug = {
        rev,
        slices: [2, 2, 3],
      }
    }, 80)
    const settled = await waitForPagination(editor, 1, 4000)
    clearInterval(timer)
    expect(settled).toBe(true)
    editor.destroy()
  })
})

describe('progress terminal states', () => {
  it('a job that dies before the first recipient is finished, not still running', () => {
    const base = initialProgress(5)
    const failed = applyJobFailure(base, base, 'boom')
    expect(failed.status).toBe('failed')
    expect(failed.failed).toBe(1)
    expect(isFinished(failed)).toBe(true)
  })

  it('the status classifies every outcome', () => {
    expect(
      terminalStatus({
        total: 3,
        done: 3,
        succeeded: 3,
        failed: 0,
        skipped: 0,
        current: '',
        errors: [],
        cancelled: false,
        status: 'running',
      }),
    ).toBe('completed')
    expect(
      terminalStatus({
        total: 3,
        done: 3,
        succeeded: 2,
        failed: 1,
        skipped: 0,
        current: '',
        errors: [],
        cancelled: false,
        status: 'running',
      }),
    ).toBe('completed_with_errors')
    expect(
      terminalStatus({
        total: 3,
        done: 1,
        succeeded: 1,
        failed: 0,
        skipped: 0,
        current: '',
        errors: [],
        cancelled: true,
        status: 'running',
      }),
    ).toBe('cancelled')
  })
})
