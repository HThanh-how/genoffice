import { describe, expect, it } from 'vitest'
import { folderOf } from '../src/renderer/src/fork/IndexFiles'

describe('folderOf', () => {
  it('gives the folder of a Windows or POSIX path', () => {
    expect(folderOf('G:\\Mr Quốc\\Ba\\Ra viện BV Chợ Rẫy.pdf')).toBe('G:\\Mr Quốc\\Ba')
    expect(folderOf('/Users/a/Docs/x.pdf')).toBe('/Users/a/Docs')
  })
})
