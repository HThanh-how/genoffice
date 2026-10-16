/**
 * The main process' containment rule for mail-merge output.
 *
 * A renderer may only write inside the directory it picked. These tests exercise
 * the POSIX and Windows path semantics through the platform rule objects — they
 * prove the rule is correct for those path shapes, not that the app was run on
 * those operating systems.
 */
import { describe, expect, it } from 'vitest'
import {
  containedTarget,
  isInsideDirectory,
  posixRules,
  windowsRules,
} from '../src/shared/output-containment'

/** A filesystem where only `present` paths exist and `links` are symlinks. */
const fakeFs = (present: string[], links: Record<string, string> = {}) => ({
  exists: (p: string) => present.includes(p) || p in links,
  realpath: (p: string) => links[p] ?? p,
})

describe('POSIX containment', () => {
  const fs = fakeFs(['/tmp/out', '/tmp/out/Huy.pdf', '/tmp/outside'])
  const check = (path: string) =>
    containedTarget('/tmp/out', path, posixRules, fs.exists, fs.realpath)

  it('allows a file inside the chosen directory', () => {
    expect(check('/tmp/out/Huy.pdf')).toBe('/tmp/out/Huy.pdf')
  })

  it('rejects a traversal written inside the directory', () => {
    expect(check('/tmp/out/../outside.pdf')).toBeNull()
  })

  it('rejects an absolute path outside the directory', () => {
    expect(check('/tmp/outside/Huy.pdf')).toBeNull()
  })

  it('rejects the directory itself', () => {
    expect(check('/tmp/out')).toBeNull()
  })

  it('allows a not-yet-written file in a subdirectory of the grant', () => {
    const nested = fakeFs(['/tmp/out', '/tmp/out/deep'])
    expect(
      containedTarget(
        '/tmp/out',
        '/tmp/out/deep/Huy.pdf',
        posixRules,
        nested.exists,
        nested.realpath,
      ),
    ).toBe('/tmp/out/deep/Huy.pdf')
  })

  it('rejects a symlink that points out of the directory', () => {
    const linked = fakeFs(['/tmp/out', '/tmp/out/link'], { '/tmp/out/link': '/elsewhere' })
    expect(
      containedTarget(
        '/tmp/out',
        '/tmp/out/link/Huy.pdf',
        posixRules,
        linked.exists,
        linked.realpath,
      ),
    ).toBeNull()
  })

  it('rejects a symlinked file that resolves outside the directory', () => {
    const linked = fakeFs(['/tmp/out', '/tmp/out/Huy.pdf'], {
      '/tmp/out/Huy.pdf': '/elsewhere/Huy.pdf',
    })
    expect(
      containedTarget('/tmp/out', '/tmp/out/Huy.pdf', posixRules, linked.exists, linked.realpath),
    ).toBeNull()
  })

  it('keeps a Unicode file name intact', () => {
    const uni = fakeFs(['/tmp/out'])
    const name = 'Nguyễn Văn A.docx'
    expect(
      containedTarget('/tmp/out', `/tmp/out/${name}`, posixRules, uni.exists, uni.realpath),
    ).toBe(`/tmp/out/${name}`)
  })
})

describe('Windows containment', () => {
  const fs = fakeFs(['C:\\Output', 'C:\\Output\\Huy.pdf', 'C:\\Outside'])
  const check = (path: string) =>
    containedTarget('C:\\Output', path, windowsRules, fs.exists, fs.realpath)

  it('allows a file inside the chosen directory', () => {
    expect(check('C:\\Output\\Huy.pdf')).toBe('C:\\Output\\Huy.pdf')
  })

  it('handles mixed separators the same way', () => {
    expect(check('C:/Output/Huy.pdf')).toBe('C:\\Output\\Huy.pdf')
  })

  it('rejects a traversal written inside the directory', () => {
    expect(check('C:\\Output\\..\\outside.pdf')).toBeNull()
  })

  it('rejects an absolute path outside the directory', () => {
    expect(check('C:\\Outside\\Huy.pdf')).toBeNull()
  })

  it('does not treat a sibling with the same prefix as inside', () => {
    // "C:\Output2" starts with "C:\Output" as a string but is a different folder
    expect(isInsideDirectory('C:\\Output', 'C:\\Output2\\Huy.pdf', windowsRules)).toBe(false)
  })
})
