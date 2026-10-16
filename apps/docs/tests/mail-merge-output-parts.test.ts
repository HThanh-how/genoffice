/**
 * What actually lands in the exported .docx.
 *
 * `saveDocx()` returning bytes is not the end of the story: header and footer
 * parts the user never opened in the header editor, footnote bodies and the text
 * inside a textbox are copied from the template byte-for-byte, so a MERGEFIELD
 * sitting in one of them is written out raw and Word prints «Name» for every
 * recipient. These tests unzip the produced file and read the parts, and check
 * that a placement the merge cannot reach is refused rather than silently
 * emitted.
 */
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { Editor } from '@tiptap/core'
import { parseDocx } from '@genoffice/docx-engine'
import { buildDocx, TINY_PNG_BASE64 } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { blocksToPmDoc } from '../src/renderer/editor/convert'
import { runMailMergeExport, type CancelToken } from '../src/renderer/mail-merge/export'
import { sourceFromRows } from '../src/renderer/mail-merge/data-source'
import { checkMergedDocx } from '../src/shared/docx-output-contract'
import { lazyMediaPlaceholder } from '@genoffice/docx-engine/lazy-media'
import type { FileActionContext } from '../src/renderer/file-actions'
import type { MailMergeExportProgress } from '../src/renderer/mail-merge/types'

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

/** a complex field whose instruction Word splits across two w:instrText runs */
const splitField = (name: string) =>
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
  '<w:r><w:instrText xml:space="preserve"> MERGEFIELD </w:instrText></w:r>' +
  '<w:r><w:instrText xml:space="preserve">' + name + ' \\* MERGEFORMAT</w:instrText></w:r>' +
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
  '<w:r><w:t xml:space="preserve">«' + name + '»</w:t></w:r>' +
  '<w:r><w:fldChar w:fldCharType="end"/></w:r>'

const simpleField = (name: string) =>
  `<w:fldSimple w:instr=" MERGEFIELD ${name} "><w:r><w:t xml:space="preserve">«${name}»</w:t></w:r></w:fldSimple>`

/** word/header1.xml / word/footer1.xml, referenced by the matching sectPr */
const hfPart = (kind: 'header' | 'footer', instr: string) => ({
  path: `word/${kind}1.xml`,
  xml: `${XML_DECL}<w:${kind} xmlns:w="${W_NS}"><w:p>${instr}</w:p></w:${kind}>`,
  contentType: `application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml`,
})
const hfRel = (kind: 'header' | 'footer', id: string) =>
  `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}" Target="${kind}1.xml"/>`

/** Run a one-recipient batch and return the bytes it asked the writer to store. */
async function mergeOnce(
  bytes: Uint8Array,
  rows: string[][],
): Promise<{ written: Array<{ name: string; bytes: Buffer }>; progress: MailMergeExportProgress }> {
  const parsed = await parseDocx(bytes)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks),
  })
  const written: Array<{ name: string; bytes: Buffer }> = []
  Object.assign(window, {
    desktop: {
      listMailMergeOutput: async () => ({ ok: true, names: [] }),
      writeMailMergeFile: async (_dir: string, name: string, base64: string) => {
        written.push({ name, bytes: Buffer.from(base64, 'base64') })
        return { ok: true, path: `/out/${name}`, name }
      },
    },
  })
  const ctx = {
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
  const progress = await runMailMergeExport(
    ctx,
    sourceFromRows(rows, { kind: 'csv', label: 'list.csv', hasHeader: true }),
    {
      format: 'docx',
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
  return { written, progress }
}

const partOf = async (bytes: Buffer, path: string): Promise<string | null> => {
  const zip = await JSZip.loadAsync(bytes)
  const file = zip.file(path)
  return file ? await file.async('string') : null
}

describe('fields the engine can reach', () => {
  it('resolves a w:fldSimple merge field in the body', async () => {
    const bytes = await buildDocx({
      bodyXml:
        '<w:p><w:r><w:t xml:space="preserve">Dear </w:t></w:r>' + simpleField('Name') + '</w:p>',
    })
    const { written, progress } = await mergeOnce(bytes, [['Name'], ['Nguyễn Văn A']])
    expect(progress.succeeded).toBe(1)
    const xml = await partOf(written[0].bytes, 'word/document.xml')
    expect(xml).toContain('Dear Nguyễn Văn A')
    expect(xml).not.toContain('MERGEFIELD')
    expect(xml).not.toContain('fldSimple')
  })

  /**
   * A field whose instruction Word splits across several w:instrText runs is not
   * modelled by the editor: the paragraph is byte-preserved, and the export path
   * serialises the editor's ProseMirror tree, so the field is written out raw.
   * The validator must say so instead of reporting a successful merge.
   */
  it('refuses a byte-preserved paragraph with a split-instruction merge field', async () => {
    const bytes = await buildDocx({
      bodyXml: '<w:p>' + splitField('City') + '</w:p>',
    })
    const { written, progress } = await mergeOnce(bytes, [['City'], ['Da Nang']])
    expect(written.length).toBe(0)
    const errors = progress.errors
    expect(errors.some((e) => e.message.includes('MERGEFIELD City'))).toBe(true)
  })
})

describe('placements the merge cannot reach', () => {
  it('refuses a template whose untouched header carries a merge field', async () => {
    const bytes = await buildDocx({
      bodyXml: '<w:p><w:r><w:t xml:space="preserve">body</w:t></w:r></w:p>',
      sectPrExtra: '<w:headerReference w:type="default" r:id="rId100"/>',
      extraRels: hfRel('header', 'rId100'),
      extraParts: [hfPart('header', simpleField('Name'))],
    })
    const { written, progress } = await mergeOnce(bytes, [['Name'], ['Huy'], ['An']])
    expect(written.length).toBe(0)
    const errors = progress.errors
    expect(errors.some((e) => e.message.includes('header1.xml'))).toBe(true)
    expect(errors.some((e) => e.message.includes('move them into the document body'))).toBe(true)
  })

  it('refuses a template whose untouched footer carries a merge field', async () => {
    const bytes = await buildDocx({
      bodyXml: '<w:p><w:r><w:t xml:space="preserve">body</w:t></w:r></w:p>',
      sectPrExtra: '<w:footerReference w:type="default" r:id="rId101"/>',
      extraRels: hfRel('footer', 'rId101'),
      extraParts: [hfPart('footer', simpleField('City'))],
    })
    const { written, progress } = await mergeOnce(bytes, [['Name', 'City'], ['Huy', 'Da Nang']])
    expect(written.length).toBe(0)
    const errors = progress.errors
    expect(errors.some((e) => e.message.includes('footer1.xml'))).toBe(true)
  })

  it('refuses a merge field inside a footnote body', async () => {
    const bytes = await buildDocx({
      bodyXml: '<w:p>' + simpleField('Name') + '</w:p>',
      extraParts: [
        {
          path: 'word/footnotes.xml',
          xml:
            `${XML_DECL}<w:footnotes xmlns:w="${W_NS}">` +
            '<w:footnote w:id="-1"><w:p><w:r><w:footnoteRef/></w:r></w:p></w:footnote>' +
            '<w:footnote w:id="1"><w:p>' + simpleField('Name') + '</w:p></w:footnote>' +
            '</w:footnotes>',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
        },
      ],
    })
    const { written, progress } = await mergeOnce(bytes, [['Name'], ['Huy']])
    expect(written.length).toBe(0)
    const errors = progress.errors
    expect(errors.some((e) => e.message.includes('footnotes.xml'))).toBe(true)
  })

  it('refuses a merge field inside a textbox', async () => {
    const bytes = await buildDocx({
      bodyXml:
        '<w:p><w:r><w:t>note </w:t></w:r>' +
        '<w:r><w:drawing><wp:inline><wp:anchor><wp:content>' +
        '<w:txbxContent><w:p>' + simpleField('City') + '</w:p></w:txbxContent>' +
        '</wp:content></wp:anchor></wp:inline></w:drawing></w:r></w:p>',
    })
    const { written, progress } = await mergeOnce(bytes, [['City'], ['Da Nang']])
    expect(written.length).toBe(0)
    const errors = progress.errors
    expect(errors.some((e) => e.message.includes('MERGEFIELD City'))).toBe(true)
  })

  it('the contract itself catches an unresolved field in a header part', async () => {
    const bytes = await buildDocx({
      bodyXml: '<w:p><w:r><w:t xml:space="preserve">body</w:t></w:r></w:p>',
      sectPrExtra: '<w:headerReference w:type="default" r:id="rId100"/>',
      extraRels: hfRel('header', 'rId100'),
      extraParts: [hfPart('header', simpleField('Name'))],
    })
    const check = await checkMergedDocx(bytes)
    expect(check.ok).toBe(false)
    expect(check.templateParts).toEqual(['word/header1.xml'])
    expect(check.unresolved).toEqual(['MERGEFIELD Name'])
  })
})

describe('media and encryption', () => {
  it('refuses a merged file whose picture is still a lazy-media placeholder', async () => {
    const bytes = await buildDocx({
      bodyXml: '<w:p><w:r><w:t>body</w:t></w:r></w:p>',
      binaryParts: [
        {
          path: 'word/media/photo.png',
          base64: Buffer.from(lazyMediaPlaceholder('a'.repeat(64))).toString('base64'),
          extension: 'png',
          contentType: 'image/png',
        },
      ],
    })
    const check = await checkMergedDocx(bytes)
    expect(check.ok).toBe(false)
    expect(check.error).toContain('could not embed its picture')
  })

  it('accepts a merged file whose picture was materialised', async () => {
    const bytes = await buildDocx({
      bodyXml: '<w:p><w:r><w:t xml:space="preserve">body</w:t></w:r></w:p>',
      binaryParts: [
        { path: 'word/media/photo.png', base64: TINY_PNG_BASE64, extension: 'png', contentType: 'image/png' },
      ],
    })
    const check = await checkMergedDocx(bytes)
    expect(check.ok).toBe(true)
  })

  it('a merged output is a plain zip: the writer does not encrypt it', async () => {
    const bytes = await buildDocx({ bodyXml: '<w:p>' + simpleField('Name') + '</w:p>' })
    const { written } = await mergeOnce(bytes, [['Name'], ['Huy']])
    const zip = await JSZip.loadAsync(written[0].bytes)
    expect(zip.file('word/document.xml')).not.toBeNull()
  })
})
