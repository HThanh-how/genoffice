import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl } from './helpers'

/**
 * Mailings tab, end to end in the real app.
 *
 * The Docs editor is not the shell window: it is a separate WebContentsView at
 * `genoffice-app://docs/index.html?mode=tab`, so every assertion here runs on
 * the page `waitForPageWithUrl(app, '://docs/')` returns — the same helper the
 * other Docs E2E tests use.
 *
 * The source picker is not stubbed in the renderer. `window.desktop` comes from
 * `contextBridge.exposeInMainWorld`, so its properties cannot be reassigned from
 * the page; instead the test answers the *native* open dialog with a real CSV
 * fixture, which leaves `docs:pick-mail-merge-source` — the size check, the
 * file read, the base64 — running exactly as production does. The output
 * directory uses the harness affordance the export-image picker already has.
 */

const field = (instr: string) =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
  `<w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r>` +
  `<w:r><w:fldChar w:fldCharType="end"/></w:r>`

async function templateDocx(bodyXml: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  )
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      bodyXml +
      '</w:body></w:document>',
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

const BODY =
  '<w:p><w:r><w:t xml:space="preserve">Dear </w:t></w:r>' +
  field('MERGEFIELD "Full Name"') +
  '<w:r><w:t xml:space="preserve"> of </w:t></w:r>' +
  field('MERGEFIELD "Postal Address"') +
  '</w:p>'

const CSV =
  '"Full Name","Postal Address"\n' +
  '"Nguyễn Văn A","123 Nguyễn Huệ"\n' +
  '"Bo Tran",""\n' +
  '"An Nguyen","45 Lê Lai, a deliberately long address that wraps onto the next line"\n'

/**
 * Answer the native "open file" dialog with the fixture.
 *
 * Only the mail-merge source picker is intercepted (an `openFile` dialog whose
 * filter offers csv); every other dialog keeps its real behaviour. The renderer
 * still calls the real `docs:pick-mail-merge-source` IPC, and the main process
 * still stats the file, enforces its size limit and reads it.
 */
async function answerSourceDialog(app: ElectronApplication, csvPath: string) {
  await app.evaluate(({ dialog }, path) => {
    const original = dialog.showOpenDialog.bind(dialog)
    dialog.showOpenDialog = async (parentOrOptions: unknown, options?: unknown) => {
      const opts = (options ?? parentOrOptions) as {
        properties?: string[]
        filters?: Array<{ extensions?: string[] }>
      }
      if (
        opts?.properties?.includes('openFile') &&
        opts?.filters?.[0]?.extensions?.includes('csv')
      ) {
        return { canceled: false, filePaths: [path] }
      }
      return original(parentOrOptions as never, options as never)
    }
  }, csvPath)
}

/** the Docs renderer page, ready for ribbon interaction */
async function docsPage(app: ElectronApplication): Promise<Page> {
  const page = await waitForPageWithUrl(app, '://docs/')
  // prove the assertions are not running against the shell window
  if (!page.url().includes('://docs/')) {
    throw new Error(`expected the Docs renderer, got ${page.url()}`)
  }
  await page.waitForFunction(
    () => Boolean((window as unknown as { __aidocs?: { editor?: unknown } }).__aidocs?.editor),
    undefined,
    { timeout: 30_000 },
  )
  await page.locator('.ribbon-tab', { hasText: 'Mailings' }).waitFor({ timeout: 30_000 })
  return page
}

async function documentXml(path: string): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(path))
  return await zip.file('word/document.xml')!.async('string')
}

test.describe('docs mailings tab', () => {
  test('preview, error check and batch export of multi-word columns', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'genoffice-e2e-mailmerge-')))
    const outDir = join(dir, 'out')
    mkdirSync(outDir)
    const csvPath = join(dir, 'recipients.csv')
    writeFileSync(csvPath, CSV)
    const docPath = join(dir, 'template.docx')
    writeFileSync(docPath, await templateDocx(BODY))
    const templateBefore = readFileSync(docPath)

    const launched = await launchShell({
      openFile: docPath,
      onboardingSeen: true,
      videoDir: 'mail-merge',
      env: { GENOFFICE_TEST_EXPORT_DIR: outDir },
    })
    await answerSourceDialog(launched.app, csvPath)
    const page = await docsPage(launched.app)

    await page.locator('.ribbon-tab', { hasText: 'Mailings' }).click()
    await page.getByRole('button', { name: 'Start Mail Merge' }).click()
    await page.getByRole('button', { name: 'Choose file…' }).click()

    // the picker shows the quoted column names exactly as the CSV wrote them
    await expect(page.locator('.mm-recipient-head')).toContainText('Full Name')
    await expect(page.locator('.mm-recipient-head')).toContainText('Postal Address')
    await expect(page.locator('.mm-picker-meta')).toContainText('3 recipients, 3 selected')

    await page.getByRole('button', { name: 'Use selected (3)' }).click()
    await page.getByRole('button', { name: 'Preview Results' }).click()
    await expect(page.locator('.mm-field-preview-value').first()).toContainText('Nguyễn Văn A')
    await expect(page.locator('.mm-field-preview-value').nth(1)).toContainText('123 Nguyễn Huệ')
    // the widget sits beside the hidden placeholder, so the merged text reads
    // like the sentence Word would print
    await expect(page.locator('.ProseMirror')).toContainText('Dear Nguyễn Văn A')

    await page.getByRole('button', { name: 'Check for Errors' }).click()
    // Bo Tran's address really is empty: Word reports empty values as a warning,
    // not a blocker, so the batch may still continue
    await expect(page.locator('.mm-issue.warning').first()).toContainText('Empty values')
    await expect(page.locator('.mm-issue.warning').first()).toContainText('Postal Address')
    await expect(
      page.locator('.mail-merge-validation').getByRole('button', { name: 'Continue', exact: true }),
    ).toBeEnabled()
    // the check dialog offers Cancel and Continue, not Close
    await page.getByRole('button', { name: 'Cancel' }).click()

    await page.getByRole('button', { name: 'Finish & Merge' }).click()
    // the ribbon dropdown is a menu-button listbox: its rows are options, not buttons
    await page.getByRole('option', { name: 'Export as Word documents' }).click()
    await page.getByRole('button', { name: 'Browse…' }).click()
    await page.getByRole('button', { name: 'Export 3 files' }).click()

    await expect(page.locator('.mail-merge-progress h2')).toContainText('Export completed')
    await page.getByRole('button', { name: 'Close' }).click()

    const names = readdirSync(outDir)
      .filter((n) => n.endsWith('.docx'))
      .sort()
    expect(names.length).toBe(3)
    for (const name of names) {
      const xml = await documentXml(join(outDir, name))
      // a merged file carries plain runs, not a field Word would re-evaluate
      expect(xml).not.toContain('MERGEFIELD')
      expect(xml).not.toContain('fldChar')
    }
    const first = await documentXml(join(outDir, names[0]))
    expect(first).toContain('Nguyễn Văn A')
    expect(first).toContain('123 Nguyễn Huệ')

    // the batch's directory grant is gone once the dialog closes: a late write
    // from the same renderer is refused by the main process
    const lateWrite = await page.evaluate(
      (out) => window.desktop.writeMailMergeFile(out, 'late.docx', btoa('x'), 'overwrite'),
      outDir,
    )
    expect(lateWrite.ok).toBe(false)
    expect(lateWrite.error).toContain('authorized')

    // the template on disk is untouched by the merge
    expect(Buffer.compare(readFileSync(docPath), templateBefore)).toBe(0)

    await closeAndSaveVideo(launched, 'mail-merge')
  })

  test('a missing column is reported and blocks the export', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'genoffice-e2e-mailmerge-err-')))
    const outDir = join(dir, 'out')
    mkdirSync(outDir)
    const csvPath = join(dir, 'partial.csv')
    writeFileSync(csvPath, '"Full Name"\n"Huy"\n')
    const docPath = join(dir, 'template.docx')
    writeFileSync(docPath, await templateDocx(BODY))

    const launched = await launchShell({
      openFile: docPath,
      onboardingSeen: true,
      videoDir: 'mail-merge-error',
      env: { GENOFFICE_TEST_EXPORT_DIR: outDir },
    })
    await answerSourceDialog(launched.app, csvPath)
    const page = await docsPage(launched.app)

    await page.locator('.ribbon-tab', { hasText: 'Mailings' }).click()
    await page.getByRole('button', { name: 'Start Mail Merge' }).click()
    await page.getByRole('button', { name: 'Choose file…' }).click()
    await page.getByRole('button', { name: 'Use selected (1)' }).click()

    await page.getByRole('button', { name: 'Check for Errors' }).click()
    await expect(page.locator('.mm-issue.error').first()).toContainText('Missing source column')
    await expect(page.locator('.mm-issue.error').first()).toContainText('Postal Address')
    await page.getByRole('button', { name: 'Cancel' }).click()

    // Finish & Merge must not write a document that still contains «Postal Address»
    await page.getByRole('button', { name: 'Finish & Merge' }).click()
    await page.getByRole('option', { name: 'Export as Word documents' }).click()
    await page.getByRole('button', { name: 'Browse…' }).click()
    await page.getByRole('button', { name: 'Export 1 files' }).click()

    await expect(page.locator('.mail-merge-validation')).toContainText('Missing source column')
    await page.getByRole('button', { name: 'Cancel' }).click()
    expect(readdirSync(outDir).filter((n) => n.endsWith('.docx')).length).toBe(0)

    await closeAndSaveVideo(launched, 'mail-merge-error')
  })

  test('Finish & Merge writes one real PDF per recipient', async () => {
    // every recipient is printed from a layout measured with that recipient's
    // own text: two Chromium print jobs plus the pagination passes take longer
    // than the default 90s budget
    test.setTimeout(240_000)
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'genoffice-e2e-mailmerge-pdf-')))
    const outDir = join(dir, 'out')
    mkdirSync(outDir)
    const docPath = join(dir, 'template.docx')
    // a short row and a row long enough to push the document onto a second page:
    // the printed pages must be measured with that recipient's text, not the
    // template's
    const body =
      '<w:p><w:r><w:t xml:space="preserve">Dear </w:t></w:r>' +
      field('MERGEFIELD "Full Name"') +
      '<w:r><w:t xml:space="preserve"> of </w:t></w:r>' +
      field('MERGEFIELD "Postal Address"') +
      '</w:p>' +
      '<w:p><w:r><w:t xml:space="preserve">Account reference for the address above.</w:t></w:r></w:p>'
    writeFileSync(docPath, await templateDocx(body))

    const csvPath = join(dir, 'recipients.csv')
    writeFileSync(
      csvPath,
      '"Full Name","Postal Address"\n' +
        '"Bo Tran",""\n' +
        '"Nguyễn Văn A","123 Nguyễn Huệ, Da Nang, a deliberately long address that has to wrap onto another line to fit the page"\n',
    )

    const launched = await launchShell({
      openFile: docPath,
      onboardingSeen: true,
      videoDir: 'mail-merge-pdf',
      env: { GENOFFICE_TEST_EXPORT_DIR: outDir },
    })
    await answerSourceDialog(launched.app, csvPath)
    const page = await docsPage(launched.app)

    await page.locator('.ribbon-tab', { hasText: 'Mailings' }).click()
    await page.getByRole('button', { name: 'Start Mail Merge' }).click()
    await page.getByRole('button', { name: 'Choose file…' }).click()
    await page.getByRole('button', { name: 'Use selected (2)' }).click()
    await page.getByRole('button', { name: 'Preview Results' }).click()
    await expect(page.locator('.mm-field-preview-value').first()).toContainText('Bo Tran')

    await page.getByRole('button', { name: 'Finish & Merge' }).click()
    await page.getByRole('option', { name: 'Export as PDF' }).click()
    await page.getByRole('button', { name: 'Browse…' }).click()
    await page.getByRole('button', { name: 'Export 2 files' }).click()

    // each recipient's PDF is printed from a layout measured with that
    // recipient's own text, so the batch takes a pagination pass per row
    await expect(page.locator('.mail-merge-progress h2')).toContainText('Export completed', {
      timeout: 90_000,
    })
    await page.getByRole('button', { name: 'Close' }).click()

    // the default pattern is `{index}_{<first column>}`, and the index is padded
    // to the width of the largest index in the batch: two recipients, one digit
    const names = readdirSync(outDir)
      .filter((n) => n.endsWith('.pdf'))
      .sort()
    expect(names).toEqual(['1_Bo Tran.pdf', '2_Nguyễn Văn A.pdf'])

    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const texts: string[][] = []
    for (const name of names) {
      const doc = await pdfjs.getDocument({
        data: new Uint8Array(readFileSync(join(outDir, name))),
      }).promise
      const pages: string[] = []
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i)
        const content = await page.getTextContent()
        pages.push(
          content.items
            .filter((it) => typeof (it as { str?: string }).str === 'string')
            .map((it) => String((it as { str: string }).str))
            .join(' '),
        )
      }
      texts.push(pages)
    }

    const [short, long] = texts
    // Chromium wrote real pages, not a stub: each file is a PDF whose text is the
    // recipient's own, and the long address changes the pagination
    expect(short.length).toBe(1)
    expect(long.length).toBeGreaterThanOrEqual(1)
    expect(short.join(' ')).toContain('Dear Bo Tran')
    expect(long.join(' ')).toContain('Nguyễn Văn A')
    expect(long.join(' ')).toContain('123 Nguyễn Huệ')
    // nothing of the template or the preview chrome reaches the printed page
    for (const text of [...short, ...long]) {
      expect(text).not.toContain('«Full Name»')
      expect(text).not.toContain('MERGEFIELD')
    }

    await closeAndSaveVideo(launched, 'mail-merge-pdf')
  })
})
