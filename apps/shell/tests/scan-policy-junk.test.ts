import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isIndexableFileName, isJunkFileName } from '../src/main/document-memory/scan-policy'
import { isSupportedIndexFile } from '../src/main/file-index/scan'
import { FolderScanManager, isIgnoredFileName, isIndexablePath } from '../src/main/document-memory/folder-scan'

const JUNK = [
  // Word / Excel lock files
  '~$report.docx', '~$Bao cao thang 9.xlsx', '~$slides.pptx',
  // editor temp
  'draft.tmp', '~WRL0001.tmp', 'draft.docx.tmp', '.~lock.report.docx#', 'notes.txt.swp', '.notes.txt.swp', 'a.swo',
  // backups
  'report.docx.bak', 'report.bak', 'report.docx.old', 'report.old', 'notes.txt~', 'budget.csv~',
  // partial downloads
  'big.pdf.crdownload', 'big.pdf.part', 'big.pdf.download', 'x.pdf.partial',
  // OS junk
  'Thumbs.db', 'thumbs.db', 'desktop.ini', 'Desktop.INI', '.DS_Store', '._report.docx', 'ehthumbs.db',
]

const LEGIT = [
  'report.docx', 'Bản sao của hợp đồng.docx', 'Hợp đồng - bản sao.pdf', 'Copy of budget.xlsx', 'report (1).docx',
  'report (2).pdf', 'báo cáo cũ.docx', 'old plan.docx', 'backup plan.docx', 'temp-schedule.xlsx', 'download guide.pdf',
  'notes.txt', 'data.csv', 'IMG_0001.jpg',
]

describe('junk file policy', () => {
  it.each(JUNK)('%s is junk and never indexable', (name) => {
    expect(isJunkFileName(name)).toBe(true)
    expect(isIgnoredFileName(name)).toBe(true)
    expect(isIndexableFileName(name)).toBe(false)
  })

  it.each(LEGIT)('%s stays indexable (duplicates are the redundancy package\'s job)', (name) => {
    expect(isJunkFileName(name)).toBe(false)
    expect(isIgnoredFileName(name)).toBe(false)
    expect(isIndexableFileName(name)).toBe(true)
  })

  it('the name index (file-index) refuses the same junk, given a bare name or a full path', () => {
    for (const name of JUNK) expect(isSupportedIndexFile(join('/', 'data', name))).toBe(false)
    for (const name of LEGIT.filter((n) => !n.endsWith('.jpg'))) expect(isSupportedIndexFile(join('/', 'data', name))).toBe(true)
  })

  it('isIndexablePath applies the same rule below a scanned root', () => {
    const root = join('/', 'data', 'docs')
    expect(isIndexablePath(root, join(root, 'sub', 'report.docx'))).toBe(true)
    expect(isIndexablePath(root, join(root, 'sub', '~$report.docx'))).toBe(false)
    expect(isIndexablePath(root, join(root, 'sub', 'report.docx.bak'))).toBe(false)
    expect(isIndexablePath(root, join(root, 'sub', 'report (1).docx'))).toBe(true)
  })
})

describe('folder scan enrolls no junk', () => {
  let dir: string
  let scanner: FolderScanManager | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'junk-scan-'))
  })
  afterEach(() => {
    scanner?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('walks a folder full of clutter and indexes only the real documents', async () => {
    const root = join(dir, 'docs')
    mkdirSync(root, { recursive: true })
    for (const name of [...JUNK.filter((n) => !n.includes('/')), ...LEGIT.filter((n) => !n.endsWith('.jpg'))]) writeFileSync(join(root, name), 'content that is long enough')
    const indexed: string[] = []
    scanner = new FolderScanManager(join(dir, 'state'), { indexDiscoveredFile: (p) => (indexed.push(p), true) })
    scanner.start(root)
    const started = Date.now()
    while (scanner.status().running) {
      if (Date.now() - started > 5000) throw new Error('scan timed out')
      await new Promise((r) => setTimeout(r, 10))
    }
    const names = indexed.map((p) => p.slice(root.length + 1)).sort()
    expect(names).toEqual(LEGIT.filter((n) => !n.endsWith('.jpg')).sort())
  })
})
