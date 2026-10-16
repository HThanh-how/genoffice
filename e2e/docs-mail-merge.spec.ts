import { test, expect } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { launchShell, closeAndSaveVideo } from './helpers'

/**
 * Mailings tab, end to end in the real app: a template whose merge fields name
 * columns containing spaces, a CSV source, live preview, the error check, and
 * Finish & Merge writing one .docx per recipient into the chosen directory.
 *
 * The native OS file dialog cannot be driven by Playwright, so only the source
 * picker is stubbed. The output directory comes from GENOFFICE_TEST_EXPORT_DIR
 * (the same affordance the export-image picker already uses), and the writes go
 * through the real main-process handler — the assertions read the files off disk.
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

async function documentXml(path: string): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(path))
  return (await zip.file('word/document.xml')!.async('string'))
}

test.describe('docs mailings tab', () => {
  test('preview, error check and batch export of multi-word columns', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'genoffice-e2e-mailmerge-')))
    const outDir = join(dir, 'out')
    mkdirSync(outDir)
    const docPath = join(dir, 'template.docx')
    writeFileSync(docPath, await templateDocx(BODY))

    const { app, page } = await launchShell({
      openFile: docPath,
      onboardingSeen: true,
      videoDir: 'mail-merge',
      env: { GENOFFICE_TEST_EXPORT_DIR: outDir },
    })

    await page.evaluate((csv) => {
      const bytes = new TextEncoder().encode(csv)
      let bin = ''
      for (const b of bytes) bin += String.fromCharCode(b)
      window.desktop.pickMailMergeSource = async () => ({
        ok: true,
        path: '/tmp/recipients.csv',
        base64: btoa(bin),
      })
    }, CSV)

    await page.locator('.ribbon-tab', { hasText: 'Mailings' }).click()
    await page.getByRole('button', { name: 'Start Mail Merge' }).click()
    await page.getByRole('button', { name: 'Choose file…' }).click()

    // the picker shows the quoted column names exactly as the CSV wrote them
    await expect(page.locator('.mm-recipient-head')).toContainText('Full Name')
    await expect(page.locator('.mm-recipient-head')).toContainText('Postal Address')
    await expect(page.locator('.mm-picker-meta')).toContainText('Recipients 3, selected 3')

    await page.getByRole('button', { name: 'Use selected (3)' }).click()
    await page.getByRole('button', { name: 'Preview Results' }).click()
    await expect(page.locator('.mm-field-preview-value').first()).toContainText('Nguyễn Văn A')
    await expect(page.locator('.ProseMirror')).toContainText(
      'Dear Nguyễn Văn A of 123 Nguyễn Huệ',
    )

    await page.getByRole('button', { name: 'Check for Errors' }).click()
    await expect(page.locator('.mail-merge-validation')).toContainText('No problems')
    await page.getByRole('button', { name: 'Close' }).click()

    await page.getByRole('button', { name: 'Finish & Merge' }).click()
    await page.getByRole('button', { name: 'Export as Word documents' }).click()
    await page.getByRole('button', { name: 'Browse…' }).click()
    await page.getByRole('button', { name: 'Export 3 files' }).click()

    await expect(page.locator('.mail-merge-progress h2')).toContainText('Export completed')
    await page.getByRole('button', { name: 'Close' }).click()

    const names = readdirSync(outDir).filter((n) => n.endsWith('.docx')).sort()
    expect(names.length).toBe(3)
    const xml = await documentXml(join(outDir, names[0]))
    expect(xml).toContain('Nguyễn Văn A')
    expect(xml).toContain('123 Nguyễn Huệ')
    // a merged file carries plain runs, not a field Word would re-evaluate
    expect(xml).not.toContain('MERGEFIELD')
    expect(xml).not.toContain('fldChar')

    await closeAndSaveVideo(app, page, 'mail-merge')
  })

  test('a missing column is reported and blocks the export', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'genoffice-e2e-mailmerge-err-')))
    const outDir = join(dir, 'out')
    mkdirSync(outDir)
    const docPath = join(dir, 'template.docx')
    writeFileSync(docPath, await templateDocx(BODY))

    const { app, page } = await launchShell({
      openFile: docPath,
      onboardingSeen: true,
      videoDir: 'mail-merge-error',
      env: { GENOFFICE_TEST_EXPORT_DIR: outDir },
    })

    await page.evaluate(() => {
      window.desktop.pickMailMergeSource = async () => ({
        ok: true,
        path: '/tmp/partial.csv',
        base64: btoa('"Full Name"\n"Huy"\n'),
      })
    })

    await page.locator('.ribbon-tab', { hasText: 'Mailings' }).click()
    await page.getByRole('button', { name: 'Start Mail Merge' }).click()
    await page.getByRole('button', { name: 'Choose file…' }).click()
    await page.getByRole('button', { name: 'Use selected (1)' }).click()

    await page.getByRole('button', { name: 'Check for Errors' }).click()
    await expect(page.locator('.mm-issue.error')).toContainText('Missing source column')
    await expect(page.locator('.mm-issue.error')).toContainText('Postal Address')
    await page.getByRole('button', { name: 'Close' }).click()

    // Finish & Merge must not write a document that still contains «Postal Address»
    await page.getByRole('button', { name: 'Finish & Merge' }).click()
    await page.getByRole('button', { name: 'Export as Word documents' }).click()
    await page.getByRole('button', { name: 'Browse…' }).click()
    await page.getByRole('button', { name: 'Export 1 files' }).click()

    await expect(page.locator('.mail-merge-validation')).toContainText('Missing source column')
    expect(readdirSync(outDir).filter((n) => n.endsWith('.docx')).length).toBe(0)

    await closeAndSaveVideo(app, page, 'mail-merge-error')
  })
})
