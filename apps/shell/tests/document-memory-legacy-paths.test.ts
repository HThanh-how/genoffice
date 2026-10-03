import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryStore } from '../src/main/document-memory/store'

let dir: string
let store: DocumentMemoryStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-legacy-'))
  store = new DocumentMemoryStore(join(dir, 'm.db'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('legacyPaths', () => {
  it('lists only the old formats asked for, whatever the letter case', () => {
    for (const name of ['a.xls', 'B.XLS', 'c.doc', 'd.ppt', 'e.xlsx', 'f.docx', 'g.xlsm'])
      store.enrollDiscovered(join(dir, name), 1, 10)
    const names = (exts: string[]) =>
      store
        .legacyPaths(exts, 50)
        .map((p) => basename(p))
        .sort()
    expect(names(['.xls'])).toEqual(['B.XLS', 'a.xls'])
    expect(names(['.xls', '.doc', '.ppt'])).toEqual(['B.XLS', 'a.xls', 'c.doc', 'd.ppt'])
    expect(names([])).toEqual([])
  })

  it('skips files the person excluded and honours the limit', () => {
    for (const name of ['1.xls', '2.xls', '3.xls']) store.enrollDiscovered(join(dir, name), 1, 10)
    store.exclude(join(dir, '2.xls'))
    expect(store.legacyPaths(['.xls'], 50).map((p) => basename(p))).not.toContain('2.xls')
    expect(store.legacyPaths(['.xls'], 1)).toHaveLength(1)
  })
})
