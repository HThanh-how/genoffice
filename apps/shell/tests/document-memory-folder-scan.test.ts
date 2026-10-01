import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FolderScanManager } from '../src/main/document-memory/folder-scan'

let dir: string
let scanners: FolderScanManager[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-folder-scan-'))
  scanners = []
})
afterEach(() => {
  for (const scanner of scanners) scanner.close()
  rmSync(dir, { recursive: true, force: true })
})

async function until(check: () => boolean, timeout = 3000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting for folder scan')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function scanner(userData: string, indexer: (path: string) => boolean) {
  const instance = new FolderScanManager(userData, { indexDiscoveredFile: indexer })
  scanners.push(instance)
  return instance
}

describe('FolderScanManager', () => {
  it('recursively enrolls supported files and skips generated folders and symlinks', async () => {
    const root = join(dir, 'chosen')
    mkdirSync(join(root, 'nested'), { recursive: true })
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    mkdirSync(join(root, '.private'), { recursive: true })
    writeFileSync(join(root, 'notes.md'), 'notes')
    writeFileSync(join(root, 'nested', 'report.xlsx'), 'sheet')
    writeFileSync(join(root, 'archive.zip'), 'not supported')
    writeFileSync(join(root, 'node_modules', 'ignored.pdf'), 'generated')
    writeFileSync(join(root, '.private', 'hidden.pdf'), 'hidden')
    const outside = join(dir, 'outside.pdf')
    writeFileSync(outside, 'outside selected folder')
    let hasSymlink = false
    try {
      symlinkSync(outside, join(root, 'linked.pdf'))
      hasSymlink = true
    } catch {
      // Windows may require developer mode or elevated privileges for symlinks.
    }

    const enrolled: string[] = []
    const instance = scanner(join(dir, 'state'), (path) => {
      enrolled.push(path)
      return true
    })
    instance.start(root)
    await until(() => !instance.status().running)

    expect(enrolled.sort()).toEqual(
      [join(root, 'nested', 'report.xlsx'), join(root, 'notes.md')].sort(),
    )
    expect(instance.status()).toMatchObject({ discovered: 2, enrolled: 2, errors: 0 })
    expect(instance.status().skipped).toBeGreaterThanOrEqual(hasSymlink ? 4 : 3)
  })

  it('resumes a persisted selected root after restart and enrollment remains idempotent', async () => {
    const root = join(dir, 'chosen')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'one.txt'), 'one')
    writeFileSync(join(root, 'two.pdf'), 'two')
    const userData = join(dir, 'state')
    const indexed = new Set<string>()
    const indexer = (path: string) => {
      const isNew = !indexed.has(path)
      indexed.add(path)
      return isNew
    }

    const first = scanner(userData, indexer)
    first.start(root)
    first.close()

    const resumed = scanner(userData, indexer)
    await until(() => !resumed.status().running && resumed.status().discovered === 2)

    expect(indexed.size).toBe(2)
    expect(resumed.status()).toMatchObject({ root, discovered: 2, enrolled: 2, errors: 0 })
  })

  it('persists an explicit stop so the selected folder is not rescanned after restart', async () => {
    const root = join(dir, 'chosen')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'one.txt'), 'one')
    let enrollments = 0
    const userData = join(dir, 'state')
    const first = scanner(userData, () => {
      enrollments++
      return true
    })

    first.start(root)
    first.stop()
    first.close()
    const resumed = scanner(userData, () => {
      enrollments++
      return true
    })
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(enrollments).toBe(0)
    expect(resumed.status()).toMatchObject({ running: false, root, discovered: 0 })
  })

  it('rejects drive roots so a scan is always scoped to a selected folder', () => {
    const instance = scanner(join(dir, 'state'), () => true)
    expect(() => instance.start('/')).toThrow(/below the drive root/)
  })

  it('continues after a file enrollment error and reports it', async () => {
    const root = join(dir, 'chosen')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'bad.txt'), 'bad')
    writeFileSync(join(root, 'good.txt'), 'good')
    const instance = scanner(join(dir, 'state'), (path) => {
      if (path.endsWith('bad.txt')) throw new Error('test enrollment failure')
      return true
    })

    instance.start(root)
    await until(() => !instance.status().running)

    expect(instance.status()).toMatchObject({ discovered: 2, enrolled: 1, errors: 1 })
    expect(instance.status().lastError).toBe('test enrollment failure')
  })
})
