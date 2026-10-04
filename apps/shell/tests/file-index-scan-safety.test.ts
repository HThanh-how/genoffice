import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scanFileSnapshot } from '../src/main/file-index/scan'

const blocked = vi.hoisted(() => ({ directory: '' }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      if (String(args[0]) === blocked.directory)
        throw Object.assign(new Error('network share unavailable'), { code: 'EACCES' })
      return actual.readdirSync(...args)
    },
  }
})
afterEach(() => {
  blocked.directory = ''
})

describe('File scan completeness', () => {
  it('marks an unavailable mount root incomplete instead of a successful empty scan', () => {
    const root = join(tmpdir(), `missing-share-${Date.now()}`)
    expect(scanFileSnapshot(root)).toEqual({ files: [], complete: false })
  })

  it('keeps files from accessible branches but reports the partial walk', () => {
    const root = mkdtempSync(join(tmpdir(), 'file-scan-partial-'))
    try {
      const good = join(root, 'visible.txt')
      writeFileSync(good, 'visible content')
      blocked.directory = join(root, 'company')
      mkdirSync(blocked.directory)
      writeFileSync(join(blocked.directory, 'contract.txt'), 'unavailable branch')
      const snapshot = scanFileSnapshot(root)
      expect(snapshot.complete).toBe(false)
      expect(snapshot.files.map((file) => file.path)).toEqual([good])
      blocked.directory = ''
      expect(scanFileSnapshot(root).complete).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
