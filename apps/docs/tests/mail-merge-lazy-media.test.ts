/**
 * Lazy media end to end.
 *
 * A document with more than a megabyte of pictures is opened with its images
 * replaced by `GENOFFICE-LAZY-MEDIA` placeholders naming the source file; the
 * renderer never sees the bytes, and a save writes the placeholders straight
 * back out. Mail Merge is the case where that matters most: every merged file
 * is a brand-new package with no source to point at, so the media has to be
 * spliced back in before the file is written.
 *
 * This test runs the real pipeline: `openLazyDocx` produces the slim template,
 * `runMailMergeExport` (the runner the Finish & Merge button calls) serialises
 * each recipient, and `commitMailMergeWrite` — the body of the
 * `docs:write-mail-merge-file` handler — materialises, verifies and writes. The
 * assertions read the ZIP parts off the files that actually landed on disk.
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { crc32, deflateSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Editor } from '@tiptap/core'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { parseDocx } from '@genoffice/docx-engine'
import {
  buildDocx,
  IMAGE_PARAGRAPH_XML,
} from '../../../packages/docx-engine/tests/helpers/build-docx'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { blocksToPmDoc } from '../src/renderer/editor/convert'
import { type FileActionContext } from '../src/renderer/file-actions'
import { runMailMergeExport, type CancelToken } from '../src/renderer/mail-merge/export'
import { sourceFromRows } from '../src/renderer/mail-merge/data-source'
import type { MailMergeExportOptions } from '../src/renderer/mail-merge/types'
import { LAZY_MEDIA_MAGIC } from '../src/shared/docx-output-contract'
import { commitMailMergeWrite } from '../src/shared/mail-merge-commit'
import { containedTarget, posixRules } from '../src/shared/output-containment'
import { forgetLazyMediaOwner, materializeLazyDocx, openLazyDocx } from '../src/main/lazy-media'

const field = (instr: string) =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
  `<w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r>` +
  `<w:r><w:fldChar w:fldCharType="end"/></w:r>`

/** a real PNG big enough for lazy media to kick in (>1 MiB of browser-decodable media) */
function bigPng(width = 900, height = 900): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3))
  let i = 0
  for (let y = 0; y < height; y++) {
    raw[i++] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      raw[i++] = (x * 7 + y * 13) & 0xff
      raw[i++] = (x * 11 + y * 3) & 0xff
      raw[i++] = (x * 5 + y * 17) & 0xff
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** the exact bytes of the picture-heavy template, so "unchanged" is checkable */
function templateBytes(png: Buffer): Promise<Uint8Array> {
  return buildDocx({
    bodyXml:
      '<w:p><w:r><w:t xml:space="preserve">Dear </w:t></w:r>' +
      field('MERGEFIELD Name') +
      '</w:p>' +
      IMAGE_PARAGRAPH_XML,
    withImage: true,
    binaryParts: [
      {
        path: 'word/media/image1.png',
        base64: png.toString('base64'),
        extension: 'png',
        contentType: 'image/png',
      },
    ],
  })
}

/** the options the Finish & Merge dialog produces for a DOCX batch */
const docxOptions = (outputDir: string, batch: string): MailMergeExportOptions => ({
  format: 'docx',
  scope: 'all',
  outputDir,
  pattern: '{index}_{Name}',
  overwrite: 'rename',
  combined: false,
  batch,
})

/** the state `buildDocBytes` reads; the rest of the ribbon context is irrelevant here */
function makeCtx(editor: Editor, parsed: unknown): FileActionContext {
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

/** the main process' write handler, pointed at a real directory */
function wireDesktop(outDir: string, batch: string, live: () => boolean) {
  const grant = { dir: outDir, allocated: new Set<string>(), batch }
  Object.assign(window, {
    desktop: {
      listMailMergeOutput: async (dir: string, batchArg: string) => {
        if (dir !== outDir || batchArg !== batch) return { ok: false, error: 'not authorized' }
        return { ok: true, names: readdirSync(outDir) }
      },
      writeMailMergeFile: async (dir: string, name: string, base64: string, overwrite: string) =>
        commitMailMergeWrite(
          grant,
          dir,
          name,
          base64,
          overwrite,
          (d, p) => containedTarget(d, p, posixRules, existsSync, realpathSync),
          {
            materialize: async (bytes) => (await materializeLazyDocx(bytes)).bytes,
            isAuthorized: live,
          },
        ),
    },
  })
  return grant
}

async function openLazyTemplate(png: Buffer, path: string, wcId: number) {
  writeFileSync(path, await templateBytes(png))
  const lazy = await openLazyDocx(path, wcId)
  if (!lazy) throw new Error('the template did not open with lazy media')
  return lazy
}

describe('mail merge with a lazily opened template', () => {
  it('restores the original pictures into every merged document', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'genoffice-mm-lazy-')))
    const outDir = join(dir, 'out')
    mkdirSync(outDir)
    const png = bigPng()
    const templatePath = join(dir, 'template.docx')
    const wcId = 4242
    const lazy = await openLazyTemplate(png, templatePath, wcId)

    // the renderer really is looking at placeholders, not at the picture
    const slimZip = await JSZip.loadAsync(lazy.bytes)
    const placeholder = await slimZip.file('word/media/image1.png')!.async('nodebuffer')
    expect(placeholder.subarray(0, LAZY_MEDIA_MAGIC.length).toString('latin1')).toBe(
      LAZY_MEDIA_MAGIC,
    )

    const parsed = await parseDocx(lazy.bytes)
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc(parsed.blocks),
    })
    wireDesktop(outDir, 'batch-1', () => true)

    const source = sourceFromRows([['Name'], ['Nguyễn Văn A'], ['Bo Tran']], {
      kind: 'csv',
      label: 'recipients.csv',
      hasHeader: true,
    })
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      source,
      docxOptions(outDir, 'batch-1'),
      { cancelled: false },
      () => {},
    )
    editor.destroy()

    expect(progress.succeeded).toBe(2)
    expect(progress.failed).toBe(0)
    const names = readdirSync(outDir).sort()
    expect(names.length).toBe(2)

    for (const name of names) {
      const zip = await JSZip.loadAsync(readFileSync(join(outDir, name)))
      const media = zip.file('word/media/image1.png')
      expect(media).not.toBeNull()
      // the picture is the original bytes, byte for byte
      expect(Buffer.compare(await media!.async('nodebuffer'), png)).toBe(0)
      const documentXml = await zip.file('word/document.xml')!.async('string')
      expect(documentXml).not.toContain('MERGEFIELD')
      expect(documentXml).not.toContain('fldChar')
      // no part of the package still carries the placeholder marker
      for (const entry of zip.filter((path) => path.startsWith('word/media/'))) {
        const raw = await entry.async('nodebuffer')
        expect(raw.subarray(0, LAZY_MEDIA_MAGIC.length).toString('latin1')).not.toBe(
          LAZY_MEDIA_MAGIC,
        )
      }
    }

    // merging must not touch the template on disk
    const hashOf = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
    expect(hashOf(readFileSync(templatePath))).toBe(hashOf(await templateBytes(png)))
  })

  it('writes nothing when the source media can no longer be read', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'genoffice-mm-lazy-fail-')))
    const outDir = join(dir, 'out')
    mkdirSync(outDir)
    // a different picture than the other tests: the source registry is keyed by
    // the template's hash, so this batch's source is the one being forgotten
    const png = bigPng(700, 700)
    const templatePath = join(dir, 'template.docx')
    const wcId = 4243
    const lazy = await openLazyTemplate(png, templatePath, wcId)
    const parsed = await parseDocx(lazy.bytes)
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc(parsed.blocks),
    })

    // the tab that owns the source is gone: the placeholders have nothing to
    // resolve against, and a merged file with a broken picture is not a file the
    // user should receive
    forgetLazyMediaOwner(wcId)
    wireDesktop(outDir, 'batch-1', () => true)

    const source = sourceFromRows([['Name'], ['Huy'], ['An']], {
      kind: 'csv',
      label: 'list.csv',
      hasHeader: true,
    })
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      source,
      docxOptions(outDir, 'batch-1'),
      { cancelled: false },
      () => {},
    )
    editor.destroy()

    expect(progress.succeeded).toBe(0)
    expect(progress.failed).toBe(2)
    expect(progress.errors[0].message).toContain('picture')
    expect(readdirSync(outDir)).toEqual([])
  })

  it('stops the batch when the grant is released while a file is being prepared', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'genoffice-mm-lazy-cancel-')))
    const outDir = join(dir, 'out')
    mkdirSync(outDir)
    const png = bigPng()
    const wcId = 4244
    const lazy = await openLazyTemplate(png, join(dir, 'template.docx'), wcId)
    const parsed = await parseDocx(lazy.bytes)
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: blocksToPmDoc(parsed.blocks),
    })

    let live = true
    const cancel: CancelToken = { cancelled: false }
    wireDesktop(outDir, 'batch-1', () => live)
    const source = sourceFromRows([['Name'], ['Huy'], ['An'], ['Bo'], ['Nguyen']], {
      kind: 'csv',
      label: 'list.csv',
      hasHeader: true,
    })
    const progress = await runMailMergeExport(
      makeCtx(editor, parsed),
      source,
      docxOptions(outDir, 'batch-1'),
      cancel,
      (p) => {
        // the user closes the dialog mid-batch: the grant goes, and the
        // recipients still in flight must not commit
        if (p.done === 1) {
          live = false
          cancel.cancelled = true
        }
      },
    )
    editor.destroy()

    const written = readdirSync(outDir)
    expect(progress.succeeded).toBe(written.length)
    expect(progress.cancelled).toBe(true)
    expect(written.length).toBeLessThan(5)
    for (const name of written) {
      const zip = await JSZip.loadAsync(readFileSync(join(outDir, name)))
      expect(
        Buffer.compare(await zip.file('word/media/image1.png')!.async('nodebuffer'), png),
      ).toBe(0)
    }
  })
})
