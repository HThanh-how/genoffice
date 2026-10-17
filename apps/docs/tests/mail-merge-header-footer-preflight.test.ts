/**
 * The GUI decision path: preflight and serializer must agree.
 *
 * `validateMergeSession()` is what the Mail Merge dialog runs before a batch
 * starts. `runMailMergeExport()` is what actually writes the files. If the
 * preflight reads the *template as first parsed* while the writer reads the
 * *current header/footer state*, the two disagree: a header the user regenerated
 * in the header editor merges correctly, yet the dialog refuses the batch.
 *
 * Every case here goes through both halves — the real preflight, then the real
 * `buildDocBytes` — and reads the header/footer XML back out of the produced zip.
 */
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { parseDocx, readSections, type ParsedDocFull } from '@genoffice/docx-engine'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { blocksToPmDoc } from '../src/renderer/editor/convert'
import { buildDocBytes, type FileActionContext } from '../src/renderer/file-actions'
import { editKey } from '../src/renderer/hf-sections'
import { hfSaveOptions } from '../src/renderer/hf-sections'
import { runMailMergeExport } from '../src/renderer/mail-merge/export'
import { sourceFromRows } from '../src/renderer/mail-merge/data-source'
import {
  templateMergeFields,
  unmergeableHeaderFooterFields,
  validateMergeSession,
} from '../src/renderer/mail-merge/validation'
import type { MailMergeExportOptions, MailMergeSource } from '../src/renderer/mail-merge/types'

const field = (instr: string, display: string) =>
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
  `<w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r>` +
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
  `<w:r><w:t xml:space="preserve">${display}</w:t></w:r>` +
  '<w:r><w:fldChar w:fldCharType="end"/></w:r>'

const PAGE_FIELD =
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
  '<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>' +
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
  '<w:r><w:t>1</w:t></w:r>' +
  '<w:r><w:fldChar w:fldCharType="end"/></w:r>'

const HDR_NS =
  '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'

const FTR_NS =
  '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'

const HF_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.'

/** a two-section document: section 1 owns header1/footer1, section 2 header2/footer2 */
async function docWithHeaders(
  header1: string,
  footer1: string,
  header2: string,
  footer2: string,
): Promise<Uint8Array> {
  return buildDocx({
    bodyXml:
      // a section break paragraph carries section 1's sectPr and its references
      '<w:p><w:pPr><w:sectPr>' +
      '<w:headerReference w:type="default" r:id="rId100"/>' +
      '<w:footerReference w:type="default" r:id="rId101"/>' +
      '<w:pgSz w:w="11906" w:h="16838"/>' +
      '</w:sectPr></w:pPr><w:r><w:t xml:space="preserve">First section body</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t xml:space="preserve">Second section body</w:t></w:r></w:p>',
    sectPrExtra:
      '<w:headerReference w:type="default" r:id="rId102"/>' +
      '<w:footerReference w:type="default" r:id="rId103"/>',
    extraRels:
      '<Relationship Id="rId100" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' +
      '<Relationship Id="rId101" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' +
      '<Relationship Id="rId102" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header2.xml"/>' +
      '<Relationship Id="rId103" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer2.xml"/>',
    extraParts: [
      {
        path: 'word/header1.xml',
        xml: HDR_NS + header1 + '</w:hdr>',
        contentType: HF_CONTENT_TYPE + 'header+xml',
      },
      {
        path: 'word/footer1.xml',
        xml: FTR_NS + footer1 + '</w:ftr>',
        contentType: HF_CONTENT_TYPE + 'footer+xml',
      },
      {
        path: 'word/header2.xml',
        xml: HDR_NS + header2 + '</w:hdr>',
        contentType: HF_CONTENT_TYPE + 'header+xml',
      },
      {
        path: 'word/footer2.xml',
        xml: FTR_NS + footer2 + '</w:ftr>',
        contentType: HF_CONTENT_TYPE + 'footer+xml',
      },
    ],
  })
}

async function partOf(bytes: Uint8Array | Buffer, path: string): Promise<string | null> {
  const zip = await JSZip.loadAsync(bytes)
  const file = zip.file(path)
  return file ? await file.async('string') : null
}

async function openDoc(
  bytes: Uint8Array | Promise<Uint8Array>,
): Promise<{ parsed: ParsedDocFull; editor: Editor }> {
  const parsed = await parseDocx(await bytes)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks),
  })
  return { parsed, editor }
}

function ctxFor(
  editor: Editor,
  parsed: ParsedDocFull,
  hfEdits: Record<string, unknown> = {},
): FileActionContext {
  return {
    editor,
    doc: { parsed, filePath: null, fileName: 'template.docx', hash: '' },
    sections: readSections(parsed),
    section: null,
    sectionDirty: false,
    sectionsDirty: [],
    trailingStartType: null,
    pgNumDirtySections: [],
    sectionHfEdits: hfEdits,
    hfLinks: {},
    hfVariants: {},
    hfVariantsDirty: [],
    inkAnnotations: [],
    inksDirty: false,
    styleUpserts: {},
    pendingNumbering: {},
    numberingDirty: false,
    pageColorDirty: false,
    commentsDirty: false,
    protectionDirty: false,
    writeProtectionDirty: false,
    removePersonalInfoDirty: false,
    watermarkDirty: false,
    notesDirty: false,
    sourcesDirty: false,
    themeFontsDirty: false,
    themeColorsDirty: false,
    titlePgDirty: false,
    evenOddHfDirty: false,
    mirrorMarginsDirty: false,
    setStatus: () => {},
    setShowPagePreview: () => {},
  } as unknown as FileActionContext
}

/** the exact call the Mail Merge dialog makes before a batch starts */
function preflight(ctx: FileActionContext, source: MailMergeSource): string[] {
  const parsed = ctx.doc?.parsed ?? null
  return validateMergeSession(
    source,
    templateMergeFields(ctx.editor!),
    parsed?.blocks ?? [],
    ctx.editor,
    'all',
    parsed,
    {
      sections: ctx.sections,
      options: hfSaveOptions({
        sections: ctx.sections,
        edits: ctx.sectionHfEdits,
        links: ctx.hfLinks,
      }),
      watermarkDirty: ctx.watermarkDirty,
    },
  )
    .filter((issue) => issue.severity === 'error')
    .map((issue) => `${issue.key}:${issue.detail ?? ''}`)
}

function fakeDesktop(written: string[]) {
  Object.assign(window, {
    desktop: {
      listMailMergeOutput: async () => ({ ok: true, names: [] }),
      writeMailMergeFile: async (_dir: string, name: string) => {
        written.push(name)
        return { ok: true, path: `/out/${name}` }
      },
    },
  })
}

const source = (): MailMergeSource =>
  sourceFromRows([['Full Name', 'City'], ['Ada Lovelace', 'London'], ['Grace Hopper', 'New York']], {
    kind: 'csv',
    label: 'list.csv',
    hasHeader: true,
  })

const options: MailMergeExportOptions = {
  format: 'docx',
  scope: 'all',
  outputDir: '/out',
  pattern: '{index}_{Full Name}',
  overwrite: 'rename',
  combined: false,
}

const MERGEFIELD_IN = (name: string) => `<w:r><w:t>${name}</w:t></w:r>`

describe('H1/H2 — an untouched header or footer part is genuinely unreachable', () => {
  it('the preflight refuses a header the writer copies verbatim', async () => {
    const { parsed, editor } = await openDoc(
      docWithHeaders(
        '<w:p><w:r><w:t xml:space="preserve">Account for </w:t></w:r>' +
          field('MERGEFIELD "Full Name"', '«Full Name»') +
          '</w:p>',
        '<w:p></w:p>',
        '<w:p></w:p>',
        '<w:p></w:p>',
      ),
    )
    const ctx = ctxFor(editor, parsed)
    expect(preflight(ctx, source())).toEqual(['mailMergeUnsupportedField:MERGEFIELD "Full Name" (header/footer)'])
    editor.destroy()
  })

  it('the preflight refuses an untouched footer the same way', async () => {
    const { parsed, editor } = await openDoc(
      docWithHeaders(
        '<w:p></w:p>',
        '<w:p><w:r><w:t xml:space="preserve">Sent to </w:t></w:r>' +
          field('MERGEFIELD "Full Name"', '«Full Name»') +
          '</w:p>',
        '<w:p></w:p>',
        '<w:p></w:p>',
      ),
    )
    const ctx = ctxFor(editor, parsed)
    expect(preflight(ctx, source()).length).toBe(1)
    editor.destroy()
  })

  it('and the export really writes nothing for that batch', async () => {
    const { parsed, editor } = await openDoc(
      docWithHeaders(
        '<w:p><w:r><w:t xml:space="preserve">Account for </w:t></w:r>' +
          field('MERGEFIELD "Full Name"', '«Full Name»') +
          '</w:p>',
        '<w:p></w:p>',
        '<w:p></w:p>',
        '<w:p></w:p>',
      ),
    )
    const written: string[] = []
    fakeDesktop(written)
    const progress = await runMailMergeExport(ctxFor(editor, parsed), source(), options, {
      cancelled: false,
    }, () => {})
    expect(written).toEqual([])
    expect(progress.succeeded).toBe(0)
    // a header part the merge cannot reach is a property of the template, not of
    // the row: the batch stops at the first recipient instead of writing 10,000
    // broken files
    expect(progress.failed).toBe(1)
    expect(progress.status).toBe('failed')
    editor.destroy()
  })
})

describe('H3/H4/H5/H6 — a regenerated header/footer is merged, and the preflight knows it', () => {
  it('accepts a header the user regenerated in the header editor', async () => {
    const { parsed, editor } = await openDoc(
      docWithHeaders(
        '<w:p><w:r><w:t xml:space="preserve">Account for </w:t></w:r>' +
          field('MERGEFIELD "Full Name"', '«Full Name»') +
          '</w:p>',
        '<w:p></w:p>',
        '<w:p></w:p>',
        '<w:p></w:p>',
      ),
    )
    const sections = readSections(parsed)
    const ctx = ctxFor(editor, parsed, {
      [editKey(sections[0].lastBlockIndex, 'header', 'default')]: { text: 'Account for Ada Lovelace' },
    })
    // the whole point: the template still carries the field, the plan does not
    expect(unmergeableHeaderFooterFields(parsed, null).length).toBe(1)
    expect(preflight(ctx, source())).toEqual([])

    const written: string[] = []
    fakeDesktop(written)
    const progress = await runMailMergeExport(ctx, source(), options, { cancelled: false }, () => {})
    expect(progress.succeeded).toBe(2)
    expect(written.length).toBe(2)
    editor.destroy()
  })

  it('accepts a regenerated footer and resolves the field for each recipient', async () => {
    const { parsed, editor } = await openDoc(
      docWithHeaders(
        '<w:p></w:p>',
        '<w:p><w:r><w:t xml:space="preserve">Sent to </w:t></w:r>' +
          field('MERGEFIELD "Full Name"', '«Full Name»') +
          '</w:p>',
        '<w:p></w:p>',
        '<w:p></w:p>',
      ),
    )
    const sections = readSections(parsed)
    const ctx = ctxFor(editor, parsed, {
      [editKey(sections[0].lastBlockIndex, 'footer', 'default')]: {
        text: 'Sent to «Full Name» in «City»',
        paras: [
          {
            runs: [
              { text: 'Sent to ' },
              { text: '«Full Name»', instrField: 'MERGEFIELD "Full Name"' },
              { text: ' in ' },
              { text: '«City»', instrField: 'MERGEFIELD "City"' },
            ],
          },
        ],
      },
    })
    expect(preflight(ctx, source())).toEqual([])
    const bytes = await buildDocBytes(ctx, {
      values: { 'Full Name': 'Grace Hopper', City: 'New York' },
      report: { missing: [], unused: [], unsupported: 0, applied: 0 },
    })
    const footer = await partOf(bytes!, 'word/footer1.xml')
    expect(footer).toContain('Grace Hopper')
    expect(footer).toContain('New York')
    expect(footer).not.toContain('MERGEFIELD')
    expect(footer).not.toContain('«')
    editor.destroy()
  })

  it('does not reject a document once the user deletes the offending field', async () => {
    const { parsed, editor } = await openDoc(
      docWithHeaders(
        '<w:p><w:r><w:t xml:space="preserve">Account for </w:t></w:r>' +
          field('MERGEFIELD "Full Name"', '«Full Name»') +
          '</w:p>',
        '<w:p></w:p>',
        '<w:p></w:p>',
        '<w:p></w:p>',
      ),
    )
    const sections = readSections(parsed)
    const end = sections[0].lastBlockIndex
    // the edit drops the field entirely: nothing unreachable is left
    const ctx = ctxFor(editor, parsed, {
      [editKey(end, 'header', 'default')]: { text: 'Account', paras: [{ runs: [{ text: 'Account' }] }] },
    })
    expect(preflight(ctx, source())).toEqual([])
    editor.destroy()
  })
})

describe('H7 — multi-section documents are judged part by part', () => {
  it('reports only the section part the writer will not rewrite', async () => {
    const bytes = await docWithHeaders(
      '<w:p><w:r><w:t xml:space="preserve">Header one: </w:t></w:r>' +
        field('MERGEFIELD "Full Name"', '«Full Name»') +
        '</w:p>',
      '<w:p></w:p>',
      '<w:p><w:r><w:t xml:space="preserve">Header two: </w:t></w:r>' +
        field('MERGEFIELD "City"', '«City»') +
        '</w:p>',
      '<w:p></w:p>',
    )
    const { parsed, editor } = await openDoc(bytes)
    const sections = readSections(parsed)
    const ctx = ctxFor(editor, parsed, {
      [editKey(sections[0].lastBlockIndex, 'header', 'default')]: { text: 'Header one: Ada' },
    })
    const issues = preflight(ctx, source())
    expect(issues.length).toBe(1)
    expect(issues[0]).toContain('MERGEFIELD "City"')
    editor.destroy()
  })

  it('is clean when every part the document references is regenerated', async () => {
    const bytes = await docWithHeaders(
      '<w:p><w:r><w:t xml:space="preserve">Header one: </w:t></w:r>' +
        field('MERGEFIELD "Full Name"', '«Full Name»') +
        '</w:p>',
      '<w:p></w:p>',
      '<w:p><w:r><w:t xml:space="preserve">Header two: </w:t></w:r>' +
        field('MERGEFIELD "City"', '«City»') +
        '</w:p>',
      '<w:p></w:p>',
    )
    const { parsed, editor } = await openDoc(bytes)
    const sections = readSections(parsed)
    const ctx = ctxFor(editor, parsed, {
      [editKey(sections[0].lastBlockIndex, 'header', 'default')]: { text: 'Header one: Ada' },
      [editKey(sections[1].lastBlockIndex, 'header', 'default')]: { text: 'Header two: London' },
    })
    expect(preflight(ctx, source())).toEqual([])
    editor.destroy()
  })
})

describe('H8/H9/H10/H11/H12 — the invariants the batch must keep', () => {
  it('leaves an ordinary PAGE field in an untouched header alone', async () => {
    const bytes = await docWithHeaders(
      '<w:p>' + PAGE_FIELD + '</w:p>',
      '<w:p></w:p>',
      '<w:p></w:p>',
      '<w:p></w:p>',
    )
    const { parsed, editor } = await openDoc(bytes)
    const ctx = ctxFor(editor, parsed)
    expect(preflight(ctx, source())).toEqual([])
    const written: string[] = []
    fakeDesktop(written)
    const progress = await runMailMergeExport(ctx, source(), options, { cancelled: false }, () => {})
    expect(progress.succeeded).toBe(2)
    editor.destroy()
  })

  it('preflight and serializer agree on the same document', async () => {
    const bytes = await docWithHeaders(
      '<w:p><w:r><w:t xml:space="preserve">Account for </w:t></w:r>' +
        field('MERGEFIELD "Full Name"', '«Full Name»') +
        '</w:p>',
      '<w:p></w:p>',
      '<w:p></w:p>',
      '<w:p></w:p>',
    )
    const { parsed, editor } = await openDoc(bytes)
    const ctx = ctxFor(editor, parsed)
    const blocked = preflight(ctx, source()).length > 0
    const produced = await buildDocBytes(ctx, {
      values: { 'Full Name': 'Ada', City: 'London' },
      report: { missing: [], unused: [], unsupported: 0, applied: 0 },
    })
    const header = await partOf(produced!, 'word/header1.xml')
    const serializerCanMerge = header !== null && !header.includes('MERGEFIELD')
    // the dialog must never refuse a document the serializer can merge, and
    // must never accept one it cannot
    expect(blocked).toBe(!serializerCanMerge)
    editor.destroy()
  })

  it('a successful DOCX contains no unresolved merge field anywhere', async () => {
    const bytes = await docWithHeaders(
      '<w:p></w:p>',
      '<w:p></w:p>',
      '<w:p></w:p>',
      '<w:p></w:p>',
    )
    const { parsed, editor } = await openDoc(bytes)
    const ctx = ctxFor(editor, parsed)
    const produced = await buildDocBytes(ctx, {
      values: { 'Full Name': 'Ada', City: 'London' },
      report: { missing: [], unused: [], unsupported: 0, applied: 0 },
    })
    const zip = await JSZip.loadAsync(produced!)
    for (const entry of zip.filter((p) => /^word\/(document|header\d+|footer\d+)\.xml$/.test(p))) {
      const xml = await entry.async('string')
      expect(xml).not.toMatch(/MERGEFIELD/)
    }
    editor.destroy()
  })

  it('a failed recipient produces no file at all', async () => {
    const bytes = await docWithHeaders(
      '<w:p></w:p>',
      '<w:p></w:p>',
      '<w:p></w:p>',
      '<w:p></w:p>',
    )
    const { parsed, editor } = await openDoc(bytes)
    const ctx = ctxFor(editor, parsed)
    // a body field with no matching column: the batch refuses it before writing
    const editorWithField = ctx.editor
    editorWithField.chain().focus().insertContent({
      type: 'text',
      text: '«Nope»',
      marks: [{ type: 'instrField', attrs: { instr: 'MERGEFIELD Nope' } }],
    }).run()
    const written: string[] = []
    fakeDesktop(written)
    const progress = await runMailMergeExport(ctx, source(), options, { cancelled: false }, () => {})
    expect(written).toEqual([])
    expect(progress.failed).toBe(2)
    editor.destroy()
  })

  it('the template bytes are never modified by a merge', async () => {
    const bytes = await docWithHeaders(
      '<w:p><w:r><w:t xml:space="preserve">Account for </w:t></w:r>' +
        field('MERGEFIELD "Full Name"', '«Full Name»') +
        '</w:p>',
      '<w:p></w:p>',
      '<w:p></w:p>',
      '<w:p></w:p>',
    )
    const original = new Uint8Array(bytes)
    const { parsed, editor } = await openDoc(bytes)
    const ctx = ctxFor(editor, parsed)
    await runMailMergeExport(ctx, source(), options, { cancelled: false }, () => {})
    const produced = await buildDocBytes(ctx)
    const header = await partOf(produced!, 'word/header1.xml')
    expect(header).toContain('MERGEFIELD "Full Name"')
    expect(parsed.internal.originalBytes).toEqual(original)
    editor.destroy()
  })
})
