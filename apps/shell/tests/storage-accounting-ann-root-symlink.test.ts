import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectStorageAccounting } from '../src/main/document-memory/runtime/storage-accounting'

describe('storage accounting: ANN metadata root boundary', () => {
  let scratch: string

  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'genoffice-acct-root-')))
  })

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  it('does not flag a managed root that is itself reached through a symlink', () => {
    const realRoot = join(scratch, 'real')
    mkdirSync(realRoot)
    writeFileSync(join(realRoot, 'ann-s.usearch'), Buffer.alloc(128))
    const linkedRoot = join(scratch, 'linked')
    symlinkSync(realRoot, linkedRoot)

    const report = collectStorageAccounting({
      dbPath: join(linkedRoot, 'index.sqlite'),
      annIndexesMeta: [{ space_id: 's', file_path: 'ann-s.usearch' }],
    })

    expect(report.measurementErrors.filter((e) => e.code === 'EESCAPE')).toEqual([])
    expect(report.annSizeBytes).toBe(128)
    expect(report.isDegraded).toBe(false)
  })

  it('still flags an ANN file symlinked to a target outside the managed root', () => {
    const root = join(scratch, 'root')
    const outside = join(scratch, 'outside')
    mkdirSync(root)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.usearch'), Buffer.alloc(64))
    symlinkSync(join(outside, 'secret.usearch'), join(root, 'ann-s.usearch'))

    const report = collectStorageAccounting({
      dbPath: join(root, 'index.sqlite'),
      annIndexesMeta: [{ space_id: 's', file_path: 'ann-s.usearch' }],
    })

    expect(report.measurementErrors.some((e) => e.code === 'EESCAPE')).toBe(true)
    expect(report.isDegraded).toBe(true)
  })
})
