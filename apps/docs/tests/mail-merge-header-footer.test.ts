/**
 * Header and footer fields: what the preflight says versus what is written.
 *
 * Mail Merge refuses a batch when a merge field sits in a header or footer part
 * the merge cannot reach. The claim has to be about the bytes the save pipeline
 * actually produces, not about the template as it was first parsed: a header the
 * user opened in the header editor is regenerated from the edited content and
 * goes through the same field resolution as the body.
 *
 * These tests build a real .docx with a real header part, run the real
 * `buildDocBytes` (the same half of save the merge uses), and read the header
 * XML back out of the resulting zip.
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
import { validateMergeSession, templateMergeFields } from '../src/renderer/mail-merge/validation'
import { runMailMergeExport, type CancelToken } from '../src/renderer/mail-merge/export'
import { sourceFromRows } from '../src/renderer/mail-merge/data-source'
import type { MailMergeExportOptions } from '../src/renderer/mail-merge/types'

const field = (instr: string) =>
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
  `<w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r>` +
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
  '<w:r><w:t xml:space="preserve">«Full Name»</w:t></w:r>' +
  '<w:r><w:fldChar w:fldCharType="end"/></w:r>'

const HEADER_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:p><w:r><w:t xml:space="preserve">Account for </w:t></w:r>' +
  field('MERGEFIELD "Full Name"') +
  '</w:p></w:hdr>'

const FOOTER_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:p><w:r><w:t xml:space="preserve">Sent to </w:t></w:r>' +
  field('MERGEFIELD "Full Name"') +
  '</w:p></w:ftr>'

async function docWithHeaderAndFooter(): Promise<Uint8Array> {
  return buildDocx({
    bodyXml: '<w:p><w:r><w:t xml:space="preserve">Body text</w:t></w:r></w:p>',
    sectPrExtra:
      '<w:headerReference w:type="default" r:id="rId100"/>' +
      '<w:footerReference w:type="default" r:id="rId101"/>',
    extraRels:
      '<Relationship Id="rId100" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' +
      '<Relationship Id="rId101" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>',
    extraParts: [
      {
        path: 'word/header1.xml',
        xml: HEADER_XML,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
      },
      {
        path: 'word/footer1.xml',
        xml: FOOTER_XML,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml',
      },
    ],
  })
}

async function partOf(bytes: Uint8Array | Buffer, path: string): Promise<string | null> {
  const zip = await JSZip.loadAsync(bytes)
  const file = zip.file(path)
  return file ? await file.async('string') : null
}

async function openDoc(): Promise<{ parsed: ParsedDocFull; editor: Editor }> {
  const parsed = await parseDocx(await docWithHeaderAndFooter())
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
    // the real section model, so the preflight sees the same header/footer
    // references the writer resolves
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

const sectionEndOf = (parsed: ParsedDocFull): number =>
  parsed.blocks.find((b) => (b.originalXml ?? '').includes('<w:sectPr'))?.docxIndex ?? 0

describe('what the merge actually writes into header and footer parts', () => {
  it('copies an untouched header part verbatim, field and all', async () => {
    const { parsed, editor } = await openDoc()
    const bytes = await buildDocBytes(ctxFor(editor, parsed))
    const header = await partOf(bytes!, 'word/header1.xml')
    expect(header).toContain('MERGEFIELD')
    editor.destroy()
  })

  it('writes the recipient into a header the user edited in the header editor', async () => {
    const { parsed, editor } = await openDoc()
    const end = sectionEndOf(parsed)
    const ctx = ctxFor(editor, parsed, {
      [editKey(end, 'header', 'default')]: { text: 'Account for Huy Tran' },
    })
    const bytes = await buildDocBytes(ctx, {
      values: { 'Full Name': 'Huy Tran' },
      report: { missing: [], unused: [], unsupported: 0, applied: 1 },
    })
    const header = await partOf(bytes!, 'word/header1.xml')
    expect(header).toContain('Account for Huy Tran')
    expect(header).not.toContain('MERGEFIELD')
    expect(header).not.toContain('«Full Name»')
    editor.destroy()
  })

  it('resolves a field the user typed into the header editor', async () => {
    const { parsed, editor } = await openDoc()
    const end = sectionEndOf(parsed)
    const ctx = ctxFor(editor, parsed, {
      [editKey(end, 'footer', 'default')]: {
        text: 'Sent to «Full Name»',
        paras: [
          {
            runs: [
              { text: 'Sent to ' },
              { text: '«Full Name»', instrField: 'MERGEFIELD "Full Name"' },
            ],
          },
        ],
      },
    })
    const bytes = await buildDocBytes(ctx, {
      values: { 'Full Name': 'Bo Tran' },
      report: { missing: [], unused: [], unsupported: 0, applied: 1 },
    })
    const footer = await partOf(bytes!, 'word/footer1.xml')
    expect(footer).toContain('Bo Tran')
    expect(footer).not.toContain('MERGEFIELD')
    editor.destroy()
  })

  it('refuses a batch whose header field the merge cannot reach, before writing anything', async () => {
    const { parsed, editor } = await openDoc()
    const written: string[] = []
    Object.assign(window, {
      desktop: {
        listMailMergeOutput: async () => ({ ok: true, names: [] }),
        writeMailMergeFile: async (_dir: string, name: string) => {
          written.push(name)
          return { ok: true, path: `/out/${name}` }
        },
      },
    })
    const source = sourceFromRows([['Full Name'], ['Alpha'], ['Beta']], {
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
    const cancel: CancelToken = { cancelled: false }
    const progress = await runMailMergeExport(
      ctxFor(editor, parsed),
      source,
      options,
      cancel,
      () => {},
    )
    editor.destroy()

    // the output contract is the safety net: a field copied from the template
    // header is refused for every recipient, and nothing reaches the disk
    expect(written).toEqual([])
    expect(progress.succeeded).toBe(0)
    expect(
      progress.errors.some(
        (e) => /header|footer/i.test(e.message) && /cannot reach|resolve/i.test(e.message),
      ),
    ).toBe(true)
  })

  it('does not block a batch whose header was regenerated by the header editor', async () => {
    const { parsed, editor } = await openDoc()
    // the preflight reads the parsed model; the safety net reads the bytes. A
    // header the user regenerated is merged, so the batch must succeed.
    const end = sectionEndOf(parsed)
    const ctx = ctxFor(editor, parsed, {
      [editKey(end, 'header', 'default')]: { text: 'Account for Huy Tran' },
      [editKey(end, 'footer', 'default')]: { text: 'Sent to Huy Tran' },
    })
    const written: string[] = []
    Object.assign(window, {
      desktop: {
        listMailMergeOutput: async () => ({ ok: true, names: [] }),
        writeMailMergeFile: async (_dir: string, name: string) => {
          written.push(name)
          return { ok: true, path: `/out/${name}` }
        },
      },
    })
    const source = sourceFromRows([['Full Name'], ['Alpha'], ['Beta']], {
      kind: 'csv',
      label: 'list.csv',
      hasHeader: true,
    })
    const progress = await runMailMergeExport(
      ctx,
      source,
      {
        format: 'docx',
        scope: 'all',
        outputDir: '/out',
        pattern: '{index}_{Full Name}',
        overwrite: 'rename',
        combined: false,
      },
      { cancelled: false },
      () => {},
    )
    editor.destroy()
    expect(progress.succeeded).toBe(2)
    expect(written.length).toBe(2)
  })
})
