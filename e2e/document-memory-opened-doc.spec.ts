import { test, expect, type Page } from '@playwright/test'
import JSZip from 'jszip'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { closeAndSaveVideo, launchShell, waitForPageWithUrl } from './helpers'

const OLD_PHONE = '0912345678'
const NEW_PHONE = '0987654321'

interface MemoryStatus {
  enabled: boolean
  documents: number
  chunks: number
  pending: number
  errors: number
  modelState: string
  files: Array<{ id: number; path: string; name: string; status: string }>
}

interface MemoryHit {
  documentId: number
  chunkId: number
  path: string
  name: string
  text: string
  location: string
  score: number
}

interface MemoryRead {
  path: string
  name: string
  location: string
  text: string
  verified: boolean
  error?: string
}

type ShellMemoryApi = {
  getDocumentMemoryStatus(): Promise<MemoryStatus>
  excludeDocumentMemory(path: string): Promise<MemoryStatus>
  clearDocumentMemory(): Promise<MemoryStatus>
}

type EditorMemoryApi = {
  documentMemorySearch(
    query: string,
    limit?: number,
  ): Promise<{
    hits: MemoryHit[]
    pending: number
    errors: number
    modelState: string
  }>
  documentMemoryRead(chunkId: number): Promise<MemoryRead>
  documentMemoryOpen(documentId: number): Promise<{ ok: boolean; error?: string }>
}

type WindowWithMemoryApis = Window & {
  aiOffice?: ShellMemoryApi
  desktop?: EditorMemoryApi
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (char) => {
    const entities: Record<string, string> = {
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;',
      '"': '&quot;',
      "'": '&apos;',
    }
    return entities[char]!
  })
}

function tableRow(cells: string[]): string {
  return `<w:tr>${cells
    .map(
      (cell) =>
        `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>${escapeXml(cell)}</w:t></w:r></w:p></w:tc>`,
    )
    .join('')}</w:tr>`
}

async function rosterDocx(phone: string): Promise<Buffer> {
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
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Annual household budget</w:t></w:r></w:p><w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>${tableRow(['Class', 'Class 2/1'])}${tableRow(['Roster code', 'Moonstone'])}${tableRow(['Guardian', 'Linh Tran'])}${tableRow(['Phone', phone])}</w:tbl><w:sectPr/></w:body></w:document>`,
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function homeStatus(page: Page): Promise<MemoryStatus> {
  return page.evaluate(async () => {
    const api = (window as WindowWithMemoryApis).aiOffice
    if (!api) throw new Error('Home document-memory API is unavailable')
    return api.getDocumentMemoryStatus()
  })
}

async function search(editor: Page, query: string) {
  return editor.evaluate(async (q) => {
    const api = (window as WindowWithMemoryApis).desktop
    if (!api) throw new Error('Editor document-memory API is unavailable')
    return api.documentMemorySearch(q, 8)
  }, query)
}

test.describe('opened document memory', () => {
  test('searches actual DOCX table content, verifies changed sources, and honors exclusion and clear', async () => {
    test.setTimeout(180_000)
    const scratch = await mkdtemp(join(tmpdir(), 'genoffice-e2e-document-memory-'))
    const sourcePath = resolve(join(scratch, 'annual-household-budget.docx'))
    await writeFile(sourcePath, await rosterDocx(OLD_PHONE))

    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'document-memory-opened-doc',
      openFile: sourcePath,
    })
    try {
      const shell = await waitForPageWithUrl(launched.app, 'shell/out')
      const editor = await waitForPageWithUrl(launched.app, '://docs/')
      await editor.waitForFunction(
        () => Boolean((window as WindowWithMemoryApis).desktop),
        undefined,
        { timeout: 30_000 },
      )

      // Explicitly opened documents are enrolled through the app's normal open path.
      await expect
        .poll(
          async () => {
            const status = await homeStatus(shell)
            return status.files.find((file) => file.path === sourcePath)?.status
          },
          { timeout: 60_000 },
        )
        .toMatch(/^(ready|text-only)$/)

      const initial = await search(editor, 'Moonstone class 2/1 guardian')
      const hit = initial.hits.find((entry) => entry.path === sourcePath)
      expect(hit, JSON.stringify(initial)).toBeDefined()
      expect(hit!.name).toBe('annual-household-budget.docx')
      expect(hit!.text).toContain('Moonstone')
      expect(initial.modelState).toMatch(/^(not-loaded|downloading|ready|error)$/)

      const read = await editor.evaluate(async (chunkId) => {
        const api = (window as WindowWithMemoryApis).desktop!
        return api.documentMemoryRead(chunkId)
      }, hit!.chunkId)
      expect(read.verified).toBe(true)
      expect(read.path).toBe(sourcePath)
      expect(read.location).toBeTruthy()
      expect(read.text).toContain(OLD_PHONE)

      // Opening a remembered result uses the shell's standard file-open router.
      const opened = await editor.evaluate(async (documentId) => {
        return (window as WindowWithMemoryApis).desktop!.documentMemoryOpen(documentId)
      }, hit!.documentId)
      expect(opened.ok).toBe(true)

      // Replacing the source on disk invalidates the old chunk before any stale answer can escape.
      await writeFile(sourcePath, await rosterDocx(NEW_PHONE))
      const staleRead = await editor.evaluate(async (chunkId) => {
        return (window as WindowWithMemoryApis).desktop!.documentMemoryRead(chunkId)
      }, hit!.chunkId)
      expect(staleRead.verified).toBe(false)
      expect(staleRead.text).not.toContain(OLD_PHONE)

      // Reopen the same path through the app so the current document is re-enrolled and reindexed.
      await editor.evaluate(async (documentId) => {
        return (window as WindowWithMemoryApis).desktop!.documentMemoryOpen(documentId)
      }, hit!.documentId)
      await expect
        .poll(
          async () => {
            const result = await search(editor, 'Moonstone class 2/1 guardian')
            return result.hits.find((entry) => entry.path === sourcePath)?.text ?? ''
          },
          { timeout: 60_000 },
        )
        .toContain(NEW_PHONE)
      const updated = await search(editor, 'Moonstone class 2/1 guardian')
      expect(JSON.stringify(updated.hits)).not.toContain(OLD_PHONE)

      await shell.evaluate(async (path) => {
        return (window as WindowWithMemoryApis).aiOffice!.excludeDocumentMemory(path)
      }, sourcePath)
      const excluded = await homeStatus(shell)
      expect(excluded.files.some((file) => file.path === sourcePath)).toBe(false)
      const afterExclude = await search(editor, 'Moonstone class 2/1 guardian')
      expect(afterExclude.hits.some((entry) => entry.path === sourcePath)).toBe(false)

      await shell.evaluate(async () => {
        return (window as WindowWithMemoryApis).aiOffice!.clearDocumentMemory()
      })
      const cleared = await homeStatus(shell)
      expect(cleared.documents).toBe(0)
      expect(cleared.chunks).toBe(0)
      expect((await search(editor, 'Moonstone class 2/1 guardian')).hits).toHaveLength(0)
    } finally {
      await closeAndSaveVideo(launched, 'document-memory-opened-doc')
      await rm(scratch, { recursive: true, force: true })
    }
  })
})
