import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isIgnoredFileName } from '../src/main/document-memory/folder-scan'
import { DocumentMemoryStore } from '../src/main/document-memory/store'

let dir: string
let store: DocumentMemoryStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-purge-'))
  store = new DocumentMemoryStore(join(dir, 'm.db'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('purgeDiscoveredByName', () => {
  it('removes scan-discovered lock and temp files but keeps real and user-opened ones', () => {
    store.enrollDiscovered(join(dir, '~$ áp dụng ISO thí nghiệm.doc'), 1, 162)
    store.enrollDiscovered(join(dir, 'download.crdownload'), 1, 10)
    store.enrollDiscovered(join(dir, 'report.docx'), 1, 5000)
    store.remember(join(dir, '~$opened-on-purpose.doc'))

    expect(store.purgeDiscoveredByName(isIgnoredFileName)).toBe(2)

    const names = store.listPaths().map((path) => basename(path))
    expect(names.sort()).toEqual(['report.docx', '~$opened-on-purpose.doc'])
  })

  it('does nothing when no ignored rows exist', () => {
    store.enrollDiscovered(join(dir, 'a.docx'), 1, 1)
    expect(store.purgeDiscoveredByName(isIgnoredFileName)).toBe(0)
    expect(store.listPaths()).toHaveLength(1)
  })
})
