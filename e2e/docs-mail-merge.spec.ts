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
async function answerSourceDialog(app: ElectronApplication, csvPath: string | string[]) {
  const paths = Array.isArray(csvPath) ? csvPath : [csvPath]
  await app.evaluate(({ dialog }, files) => {
    let picked = 0
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
        const path = files[Math.min(picked, files.length - 1)]
        picked += 1
        return { canceled: false, filePaths: [path] }
      }
      return original(parentOrOptions as never, options as never)
    }
  }, paths)
}

/**
 * A payload the output contract will accept.
 *
 * A grant test that is refused because its bytes are not a .docx proves nothing
 * about authorization: the request would have been refused with the grant live.
 * The positive and negative writes in the lifecycle test differ only in whether
 * the batch that owns the folder is still the batch the request names.
 */
async function docxBase64(text: string): Promise<string> {
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
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t xml:space="preserve">' +
      text +
      '</w:t></w:r></w:p></w:body></w:document>',
  )
  return (await zip.generateAsync({ type: 'base64' })) as string
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

/** flatten Chromium's per-run text spans into one readable line */
function flatten(items: unknown[]): string {
  return items
    .map((it) => String((it as { str?: string }).str ?? ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Chromium splits a printed line into one text span per run, so the extracted
 * text has spaces where the document has none ("A-ONLY- 901"). The page is kept
 * in both readable and space-free form so an assertion can use whichever it
 * needs without hiding a real difference.
 */
async function pdfPages(path: string): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)) }).promise
  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    pages.push(flatten(content.items))
  }
  return pages
}

/** the same page with Chromium's run boundaries removed */
const compact = (text: string) => text.replace(/\s+/g, '')

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

    // The batch's directory grant is gone once the dialog closes. The check has
    // to be a real lifecycle check: a write refused because its bytes are not a
    // .docx would be refused with the grant live, so it proves nothing. Every
    // request below uses a valid payload and a token minted by the real picker;
    // only the liveness of the batch differs.
    const payload = await docxBase64('Grant lifecycle probe')
    const lifecycle = await page.evaluate(
      async ([out, body]) => {
        const pickA = await window.desktop.pickMailMergeOutputDir()
        const first = await window.desktop.writeMailMergeFile(
          out,
          'grant-a.docx',
          body,
          'overwrite',
          pickA?.batch,
        )
        // a release names the batch it owns; a release with no token is refused
        // rather than revoking whatever the tab currently holds
        const noToken = await window.desktop.releaseMailMergeDir()
        const releasedA = await window.desktop.releaseMailMergeDir(pickA?.batch)
        const afterRelease = await window.desktop.writeMailMergeFile(
          out,
          'grant-b.docx',
          body,
          'overwrite',
          pickA?.batch,
        )
        const pickB = await window.desktop.pickMailMergeOutputDir()
        // releasing the batch that already let go of the folder is idempotent,
        // and it cannot touch the batch that now owns it
        const repeatRelease = await window.desktop.releaseMailMergeDir(pickA?.batch)
        const staleA = await window.desktop.writeMailMergeFile(
          out,
          'grant-c.docx',
          body,
          'overwrite',
          pickA?.batch,
        )
        const liveB = await window.desktop.writeMailMergeFile(
          out,
          'grant-d.docx',
          body,
          'overwrite',
          pickB?.batch,
        )
        const releasedB = await window.desktop.releaseMailMergeDir(pickB?.batch)
        const staleB = await window.desktop.writeMailMergeFile(
          out,
          'grant-e.docx',
          body,
          'overwrite',
          pickB?.batch,
        )
        return {
          batchA: pickA?.batch,
          batchB: pickB?.batch,
          noToken,
          releasedA,
          repeatRelease,
          releasedB,
          first,
          afterRelease,
          staleA,
          liveB,
          staleB,
        }
      },
      [outDir, payload],
    )

    expect(typeof lifecycle.batchA).toBe('string')
    expect(typeof lifecycle.batchB).toBe('string')
    expect(lifecycle.batchA).not.toBe(lifecycle.batchB)
    // release is batch-specific: without a token nothing is revoked, the owning
    // batch releases cleanly, and releasing it again is a no-op rather than an error
    expect(lifecycle.noToken.ok).toBe(false)
    expect(lifecycle.noToken.error).toContain('batch')
    expect(lifecycle.releasedA.ok).toBe(true)
    // a stale release cannot revoke the batch that now owns the folder
    expect(lifecycle.repeatRelease.ok).toBe(false)
    expect(lifecycle.repeatRelease.error).toContain('no longer owns')
    expect(lifecycle.releasedB.ok).toBe(true)
    // the live batch writes, and it writes a real document
    expect(lifecycle.first.ok).toBe(true)
    expect(lifecycle.liveB.ok).toBe(true)
    // released and superseded batches are refused for authorization, not for
    // their payload
    for (const refused of [lifecycle.afterRelease, lifecycle.staleA, lifecycle.staleB]) {
      expect(refused.ok).toBe(false)
      expect(refused.error).toContain('authorized')
      expect(refused.error).not.toContain('docx')
    }
    const docxOnDisk = readdirSync(outDir).filter((n) => n.endsWith('.docx'))
    expect(docxOnDisk).toContain('grant-a.docx')
    expect(docxOnDisk).toContain('grant-d.docx')
    for (const refused of ['grant-b.docx', 'grant-c.docx', 'grant-e.docx']) {
      expect(docxOnDisk).not.toContain(refused)
    }

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

  test('Finish & Merge writes one real PDF per recipient, and only that recipient', async () => {
    // every recipient is printed from a layout measured with that recipient's
    // own text: three Chromium print jobs plus the pagination passes take longer
    // than the default 90s budget
    test.setTimeout(300_000)
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'genoffice-e2e-mailmerge-pdf-')))
    const outDir = join(dir, 'out')
    mkdirSync(outDir)
    const docPath = join(dir, 'template.docx')
    // one short row, one row long enough to push the document onto a second page,
    // and one blank field: the printed pages must be measured with each
    // recipient's own text, not the template's
    const body =
      '<w:p><w:r><w:t xml:space="preserve">Dear </w:t></w:r>' +
      field('MERGEFIELD "Full Name"') +
      '<w:r><w:t xml:space="preserve"> of </w:t></w:r>' +
      field('MERGEFIELD "Postal Address"') +
      '</w:p>' +
      '<w:p><w:r><w:t xml:space="preserve">Account reference for the address above.</w:t></w:r></w:p>'
    writeFileSync(docPath, await templateDocx(body))

    const csvPath = join(dir, 'recipients.csv')
    // Beta's address is long enough to spill the document onto a second sheet:
    // the batch has to measure the page breaks with each recipient's own text.
    const longAddress = 'B-ONLY-802 '.repeat(700)
    writeFileSync(
      csvPath,
      '"Full Name","Postal Address"\n' +
        '"Alpha Recipient","A-ONLY-901"\n' +
        `"Beta Recipient","${longAddress}"\n` +
        '"Gamma Recipient",""\n',
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
    await page.getByRole('button', { name: 'Use selected (3)' }).click()
    await page.getByRole('button', { name: 'Preview Results' }).click()
    await expect(page.locator('.mm-field-preview-value').first()).toContainText('Alpha Recipient')

    await page.getByRole('button', { name: 'Finish & Merge' }).click()
    await page.getByRole('option', { name: 'Export as PDF' }).click()
    await page.getByRole('button', { name: 'Browse…' }).click()
    await page.getByRole('button', { name: 'Export 3 files' }).click()

    // each recipient's PDF is printed from a layout measured with that
    // recipient's own text, so the batch takes a pagination pass per row
    await expect(page.locator('.mail-merge-progress h2')).toContainText('Export completed', {
      timeout: 120_000,
    })
    await page.getByRole('button', { name: 'Close' }).click()

    // the default pattern is `{index}_{<first column>}`, and the index is padded
    // to the width of the largest index in the batch: three recipients, one digit
    const names = readdirSync(outDir)
      .filter((n) => n.endsWith('.pdf'))
      .sort()
    expect(names).toEqual([
      '1_Alpha Recipient.pdf',
      '2_Beta Recipient.pdf',
      '3_Gamma Recipient.pdf',
    ])

    const pages: Record<string, string[]> = {}
    for (const name of names) pages[name] = await pdfPages(join(outDir, name))
    const texts: Record<string, string> = {}
    const tight: Record<string, string> = {}
    for (const [name, page] of Object.entries(pages)) {
      texts[name] = page.join(' ')
      tight[name] = compact(page.join(' '))
    }

    // Each file carries its own recipient and none of the others. This is the
    // privacy claim: a batch that printed the first row onto every sheet would
    // still "produce three PDFs".
    expect(texts['1_Alpha Recipient.pdf']).toContain('Dear Alpha Recipient')
    expect(tight['1_Alpha Recipient.pdf']).toContain('A-ONLY-901')
    expect(tight['1_Alpha Recipient.pdf']).not.toContain('B-ONLY-802')
    expect(tight['1_Alpha Recipient.pdf']).not.toContain('C-ONLY-703')
    expect(texts['1_Alpha Recipient.pdf']).not.toContain('Beta Recipient')
    expect(texts['1_Alpha Recipient.pdf']).not.toContain('Gamma Recipient')

    expect(texts['2_Beta Recipient.pdf']).toContain('Dear Beta Recipient')
    expect(tight['2_Beta Recipient.pdf']).toContain('B-ONLY-802')
    expect(tight['2_Beta Recipient.pdf']).not.toContain('A-ONLY-901')
    expect(tight['2_Beta Recipient.pdf']).not.toContain('C-ONLY-703')
    expect(texts['2_Beta Recipient.pdf']).not.toContain('Alpha Recipient')
    expect(texts['2_Beta Recipient.pdf']).not.toContain('Gamma Recipient')

    expect(texts['3_Gamma Recipient.pdf']).toContain('Dear Gamma Recipient')
    expect(tight['3_Gamma Recipient.pdf']).not.toContain('A-ONLY-901')
    expect(tight['3_Gamma Recipient.pdf']).not.toContain('B-ONLY-802')
    expect(texts['3_Gamma Recipient.pdf']).not.toContain('Alpha Recipient')
    expect(texts['3_Gamma Recipient.pdf']).not.toContain('Beta Recipient')

    // nothing of the template placeholder or the preview chrome reaches paper
    for (const text of Object.values(texts)) {
      expect(text).not.toContain('«Full Name»')
      expect(text).not.toContain('MERGEFIELD')
    }

    // the long address really did change the pagination: the short recipient
    // fits on one sheet, the wrapped one does not
    const shortPages = pages['1_Alpha Recipient.pdf']
    const longPages = pages['2_Beta Recipient.pdf']
    expect(shortPages.length).toBe(1)
    expect(longPages.length).toBeGreaterThan(shortPages.length)

    await closeAndSaveVideo(launched, 'mail-merge-pdf')
  })

  test('a second batch in the same folder isolates recipients in the opposite order', async () => {
    test.setTimeout(300_000)
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'genoffice-e2e-mailmerge-pdf2-')))
    const outDir = join(dir, 'out')
    mkdirSync(outDir)
    const docPath = join(dir, 'template.docx')
    writeFileSync(docPath, await templateDocx(BODY))

    // the same three rows, reversed: the batch that runs second must not inherit
    // the first recipient the preview was showing when the preview opened
    const csvPath = join(dir, 'recipients.csv')
    writeFileSync(
      csvPath,
      '"Full Name","Postal Address"\n' +
        '"Gamma Recipient","C-ONLY-703"\n' +
        '"Beta Recipient","B-ONLY-802"\n' +
        '"Alpha Recipient","A-ONLY-901"\n',
    )

    const launched = await launchShell({
      openFile: docPath,
      onboardingSeen: true,
      videoDir: 'mail-merge-pdf-order',
      env: { GENOFFICE_TEST_EXPORT_DIR: outDir },
    })
    await answerSourceDialog(launched.app, csvPath)
    const page = await docsPage(launched.app)

    await page.locator('.ribbon-tab', { hasText: 'Mailings' }).click()
    await page.getByRole('button', { name: 'Start Mail Merge' }).click()
    await page.getByRole('button', { name: 'Choose file…' }).click()
    await page.getByRole('button', { name: 'Use selected (3)' }).click()
    // preview is deliberately left OFF: the batch has to put each recipient on
    // screen itself, starting from no recipient at all
    await page.getByRole('button', { name: 'Finish & Merge' }).click()
    await page.getByRole('option', { name: 'Export as PDF' }).click()
    await page.getByRole('button', { name: 'Browse…' }).click()
    await page.getByRole('button', { name: 'Export 3 files' }).click()
    await expect(page.locator('.mail-merge-progress h2')).toContainText('Export completed', {
      timeout: 120_000,
    })
    await page.getByRole('button', { name: 'Close' }).click()

    const names = readdirSync(outDir)
      .filter((n) => n.endsWith('.pdf'))
      .sort()
    expect(names).toEqual([
      '1_Gamma Recipient.pdf',
      '2_Beta Recipient.pdf',
      '3_Alpha Recipient.pdf',
    ])

    for (const [name, marker] of [
      ['1_Gamma Recipient.pdf', 'C-ONLY-703'],
      ['2_Beta Recipient.pdf', 'B-ONLY-802'],
      ['3_Alpha Recipient.pdf', 'A-ONLY-901'],
    ]) {
      const text = compact((await pdfPages(join(outDir, name))).join(' '))
      expect(text).toContain(marker)
      for (const other of ['A-ONLY-901', 'B-ONLY-802', 'C-ONLY-703']) {
        if (other !== marker) expect(text).not.toContain(other)
      }
    }

    await closeAndSaveVideo(launched, 'mail-merge-pdf-order')
  })

  test('two genuine batches in one session, one folder, one renderer', async () => {
    test.setTimeout(420_000)
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'genoffice-e2e-mailmerge-two-')))
    const outDir = join(dir, 'out')
    mkdirSync(outDir)
    const docPath = join(dir, 'template.docx')
    writeFileSync(docPath, await templateDocx(BODY))
    const templateBefore = readFileSync(docPath)

    const csvA = join(dir, 'recipients-a.csv')
    writeFileSync(
      csvA,
      '"Full Name","Postal Address"\n' +
        '"Alpha Recipient","A-ONLY-901"\n' +
        '"Beta Recipient","B-ONLY-802"\n' +
        '"Gamma Recipient","C-ONLY-703"\n',
    )
    const csvB = join(dir, 'recipients-b.csv')
    writeFileSync(
      csvB,
      '"Full Name","Postal Address"\n' +
        '"Gamma Recipient","C-ONLY-703"\n' +
        '"Beta Recipient","B-ONLY-802"\n' +
        '"Alpha Recipient","A-ONLY-901"\n',
    )

    const launched = await launchShell({
      openFile: docPath,
      onboardingSeen: true,
      videoDir: 'mail-merge-two-batches',
      env: { GENOFFICE_TEST_EXPORT_DIR: outDir },
    })
    await answerSourceDialog(launched.app, [csvA, csvB])
    const page = await docsPage(launched.app)

    await page.locator('.ribbon-tab', { hasText: 'Mailings' }).click()
    await page.getByRole('button', { name: 'Start Mail Merge' }).click()
    await page.getByRole('button', { name: 'Choose file…' }).click()
    await page.getByRole('button', { name: 'Use selected (3)' }).click()
    // batch 1 runs with the preview on screen
    await page.getByRole('button', { name: 'Preview Results' }).click()
    await expect(page.locator('.mm-field-preview-value').first()).toContainText('Alpha Recipient')

    // a token minted before the export's own directory pick: the export supersedes
    // it, so it must not authorise a write afterwards
    const superseded = await page.evaluate(() =>
      window.desktop.pickMailMergeOutputDir().then((p) => p?.batch),
    )
    expect(typeof superseded).toBe('string')

    await page.getByRole('button', { name: 'Finish & Merge' }).click()
    await page.getByRole('option', { name: 'Export as Word documents' }).click()
    await page.getByRole('button', { name: 'Browse…' }).click()
    await page.getByRole('button', { name: 'Export 3 files' }).click()
    await expect(page.locator('.mail-merge-progress h2')).toContainText('Export completed', {
      timeout: 120_000,
    })
    await page.getByRole('button', { name: 'Close' }).click()

    const docxFirst = readdirSync(outDir)
      .filter((n) => n.endsWith('.docx'))
      .sort()
    expect(docxFirst.length).toBe(3)
    for (const name of docxFirst) {
      const xml = await documentXml(join(outDir, name))
      expect(xml).not.toContain('MERGEFIELD')
    }

    // the batch that just finished no longer owns the folder
    const payload = await docxBase64('second batch probe')
    const stale = await page.evaluate(
      ([out, body, token]) =>
        window.desktop.writeMailMergeFile(out, 'stale-batch.docx', body, 'overwrite', token),
      [outDir, payload, superseded],
    )
    expect(stale.ok).toBe(false)
    expect(stale.error).toContain('authorized')
    expect(readdirSync(outDir)).not.toContain('stale-batch.docx')

    // batch 2: a different source, the same folder, the same renderer, preview off
    await page.getByRole('button', { name: 'Start Mail Merge' }).click()
    // the picker says "Choose file…" for a first source and "Choose another file…"
    // when one is already loaded
    await page.getByRole('button', { name: /Choose (another )?file/ }).click()
    await page.getByRole('button', { name: 'Use selected (3)' }).click()
    await page.getByRole('button', { name: 'Preview Results' }).click() // turn the preview off
    await page.getByRole('button', { name: 'Finish & Merge' }).click()
    await page.getByRole('option', { name: 'Export as PDF' }).click()
    await page.getByRole('button', { name: 'Browse…' }).click()
    await page.getByRole('button', { name: 'Export 3 files' }).click()
    await expect(page.locator('.mail-merge-progress h2')).toContainText('Export completed', {
      timeout: 180_000,
    })
    await page.getByRole('button', { name: 'Close' }).click()

    const pdfNames = readdirSync(outDir)
      .filter((n) => n.endsWith('.pdf'))
      .sort()
    expect(pdfNames.length).toBe(3)
    const markers: Record<string, string> = {
      'Alpha Recipient': 'A-ONLY-901',
      'Beta Recipient': 'B-ONLY-802',
      'Gamma Recipient': 'C-ONLY-703',
    }
    for (const name of pdfNames) {
      const who = name.replace(/^\d+_/, '').replace(/\.pdf$/, '')
      const marker = markers[who]
      const text = compact((await pdfPages(join(outDir, name))).join(' '))
      expect(text).toContain(`Dear${who.replace(/\s+/g, '')}`)
      expect(text).toContain(marker)
      for (const other of Object.values(markers)) {
        if (other !== marker) expect(text).not.toContain(other)
      }
    }

    // both batches wrote into the same folder: the first batch's documents are
    // still there, and the second batch did not overwrite them
    expect(readdirSync(outDir).filter((n) => n.endsWith('.docx')).length).toBe(3)

    // the editor is still usable after two batches, and the template is unchanged
    await expect(page.locator('.ProseMirror')).toContainText('Dear')
    await page.locator('.ribbon-tab', { hasText: 'Home' }).click()
    await page.locator('.ribbon-tab', { hasText: 'Mailings' }).click()
    expect(Buffer.compare(readFileSync(docPath), templateBefore)).toBe(0)

    await closeAndSaveVideo(launched, 'mail-merge-two-batches')
  })

  test('a cancelled batch writes nothing and releases the directory grant', async () => {
    test.setTimeout(240_000)
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'genoffice-e2e-mailmerge-cancel-')))
    const outDir = join(dir, 'out')
    mkdirSync(outDir)
    const docPath = join(dir, 'template.docx')
    writeFileSync(docPath, await templateDocx(BODY))
    const csvPath = join(dir, 'recipients.csv')
    writeFileSync(csvPath, '"Full Name"\n"Alpha Recipient"\n"Beta Recipient"\n"Gamma Recipient"\n')

    const launched = await launchShell({
      openFile: docPath,
      onboardingSeen: true,
      videoDir: 'mail-merge-cancel',
      env: { GENOFFICE_TEST_EXPORT_DIR: outDir },
    })
    await answerSourceDialog(launched.app, csvPath)
    const page = await docsPage(launched.app)

    await page.locator('.ribbon-tab', { hasText: 'Mailings' }).click()
    await page.getByRole('button', { name: 'Start Mail Merge' }).click()
    await page.getByRole('button', { name: 'Choose file…' }).click()
    await page.getByRole('button', { name: 'Use selected (3)' }).click()

    await page.getByRole('button', { name: 'Finish & Merge' }).click()
    await page.getByRole('option', { name: 'Export as Word documents' }).click()
    await page.getByRole('button', { name: 'Browse…' }).click()
    await page.getByRole('button', { name: 'Export 3 files' }).click()
    await page.getByRole('button', { name: 'Cancel' }).click()

    // the batch stopped: nothing on disk, and the directory grant is gone with it
    expect(readdirSync(outDir).filter((n) => n.endsWith('.docx')).length).toBe(0)

    // the grant is released with the dialog. Prove it with a write that would
    // otherwise be accepted: same folder, same valid payload, only the batch's
    // liveness changes.
    const payload = await docxBase64('cancelled batch probe')
    const grant = await page.evaluate(
      ([out, body]) =>
        window.desktop
          .pickMailMergeOutputDir()
          .then((p) =>
            window.desktop.writeMailMergeFile(
              out,
              'before-release.docx',
              body,
              'overwrite',
              p?.batch,
            ),
          ),
      [outDir, payload],
    )
    expect(grant.ok).toBe(true)
    const afterRelease = await page.evaluate(
      ([out, body]) =>
        window.desktop
          .pickMailMergeOutputDir()
          .then((p) =>
            window.desktop
              .releaseMailMergeDir(p?.batch)
              .then(() =>
                window.desktop.writeMailMergeFile(
                  out,
                  'after-release.docx',
                  body,
                  'overwrite',
                  p?.batch,
                ),
              ),
          ),
      [outDir, payload],
    )
    expect(afterRelease.ok).toBe(false)
    expect(afterRelease.error).toContain('authorized')
    expect(readdirSync(outDir)).toContain('before-release.docx')
    expect(readdirSync(outDir)).not.toContain('after-release.docx')

    await closeAndSaveVideo(launched, 'mail-merge-cancel')
  })
})
