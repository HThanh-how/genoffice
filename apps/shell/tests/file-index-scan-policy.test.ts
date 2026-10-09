import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { isIndexablePath } from '../src/main/document-memory/folder-scan'
import { scanFiles } from '../src/main/file-index/scan'

it('indexes plain-text names and skips generated folders consistently with content indexing', () => {
  const root = mkdtempSync(join(tmpdir(), 'index-policy-'))
  try {
    const files = [
      'notes.txt',
      'letters/report.docx',
      'dist/generated.pdf',
      'build/generated.xlsx',
      'coverage/generated.docx',
      'venv/generated.pdf',
      '.genoffice/original.doc',
    ]
    for (const file of files) {
      const parts = file.split('/')
      mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true })
      writeFileSync(join(root, ...parts), 'test')
    }
    const found = scanFiles(root)
      .files.map((file) => file.path)
      .sort()
    expect(found).toEqual(
      files
        .map((file) => join(root, ...file.split('/')))
        .filter((path) => isIndexablePath(root, path))
        .sort(),
    )
    expect(found).toContain(join(root, 'notes.txt'))
    expect(found).toHaveLength(2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
