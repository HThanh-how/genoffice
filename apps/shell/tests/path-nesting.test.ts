import { describe, expect, it } from 'vitest'
import { isInsidePath, outermostPaths } from '../src/shared/path-nesting'

describe('folders inside folders', () => {
  it('knows a folder from the one it lies in, on Windows paths in any case and slash', () => {
    expect(isInsidePath('D:\\', 'D:\\HT')).toBe(true)
    expect(isInsidePath('D:\\Hồ sơ', 'd:/hồ sơ/2026/Ba')).toBe(true)
    expect(isInsidePath('D:\\Hồ sơ\\', 'D:\\Hồ sơ\\2026')).toBe(true)
    expect(isInsidePath('\\\\nas\\share', '\\\\NAS\\share\\Ba')).toBe(true)
  })

  it('does not take a folder for its own parent, a sibling, or a longer name', () => {
    expect(isInsidePath('D:\\HT', 'D:\\HT')).toBe(false)
    expect(isInsidePath('D:\\HT', 'D:\\HT\\')).toBe(false)
    expect(isInsidePath('D:\\HT', 'D:\\HTX')).toBe(false)
    expect(isInsidePath('D:\\HT\\a', 'D:\\HT')).toBe(false)
    expect(isInsidePath('D:\\HT', 'E:\\HT\\a')).toBe(false)
  })

  it('compares other paths exactly', () => {
    expect(isInsidePath('/Users/a', '/Users/a/docs')).toBe(true)
    expect(isInsidePath('/Users/a', '/users/a/docs')).toBe(false)
    expect(isInsidePath('/', '/Users')).toBe(true)
  })

  it('keeps only the outermost of a list', () => {
    expect(
      outermostPaths([
        'D:\\Mr Quốc\\Ba',
        'D:\\Mr Quốc',
        'E:\\Phim',
        'D:\\Mr Quốc\\Ba\\2026',
        'D:\\Khác',
      ]),
    ).toEqual(['D:\\Mr Quốc', 'E:\\Phim', 'D:\\Khác'])
  })
})
