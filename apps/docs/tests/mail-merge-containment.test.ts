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

  it('accepts the same name in a different case', () => {
    // Windows names are matched case-insensitively, so a grant for C:\Output
    // authorises C:\output\Huy.pdf — a case-sensitive comparison would wrongly
    // refuse the file the user actually chose
    const anyCase = fakeFs(['C:\\output', 'C:\\output\\Huy.pdf'])
    expect(
      containedTarget(
        'C:\\Output',
        'C:\\output\\Huy.pdf',
        windowsRules,
        anyCase.exists,
        anyCase.realpath,
      ),
    ).toBe('C:\\output\\Huy.pdf')
    expect(isInsideDirectory('C:\\Output', 'C:\\OUTPUT\\Huy.pdf', windowsRules)).toBe(true)
  })

  it('rejects a path on a different drive even when the folder name matches', () => {
    expect(check('C:\\Output\\..\\..\\D:\\Output\\Huy.pdf')).toBeNull()
    const otherDrive = fakeFs(['C:\\Output', 'D:\\Output', 'D:\\Output\\Huy.pdf'])
    expect(
      containedTarget(
        'C:\\Output',
        'D:\\Output\\Huy.pdf',
        windowsRules,
        otherDrive.exists,
        otherDrive.realpath,
      ),
    ).toBeNull()
  })

  it('rejects a sibling whose only difference is case', () => {
    const sibling = fakeFs(['C:\\Output', 'C:\\Output2\\Huy.pdf'])
    expect(
      containedTarget(
        'C:\\Output',
        'C:\\Output2\\Huy.pdf',
        windowsRules,
        sibling.exists,
        sibling.realpath,
      ),
    ).toBeNull()
  })
})

describe('a chosen directory that is itself a symlink', () => {
  it('follows the grant to the real directory instead of rejecting it', () => {
    // the user picked /home/huy/merge, which is a link to /data/merge. Every
    // file under the real directory is exactly what they authorized
    const fs = fakeFs(['/home/huy/merge', '/data/merge', '/data/merge/Huy.docx'], {
      '/home/huy/merge': '/data/merge',
    })
    expect(
      containedTarget(
        '/home/huy/merge',
        '/home/huy/merge/Huy.docx',
        posixRules,
        fs.exists,
        fs.realpath,
      ),
    ).toBe('/data/merge/Huy.docx')
  })

  it('still rejects a path that escapes the real directory', () => {
    const fs = fakeFs(['/home/huy/merge', '/data/merge', '/data/other'], {
      '/home/huy/merge': '/data/merge',
    })
    expect(
      containedTarget(
        '/home/huy/merge',
        '/home/huy/merge/../other/x.pdf',
        posixRules,
        fs.exists,
        fs.realpath,
      ),
    ).toBeNull()
  })

  it('rejects a symlink inside the grant that points outside it', () => {
    const fs = fakeFs(['/data/merge', '/data/merge/link', '/data/elsewhere'], {
      '/data/merge/link': '/data/elsewhere',
    })
    expect(
      containedTarget(
        '/home/huy/merge',
        '/data/merge/link/Huy.pdf',
        posixRules,
        fs.exists,
        fs.realpath,
      ),
    ).toBeNull()
  })

  it('allows a symlinked subdirectory that stays inside the grant', () => {
    const fs = fakeFs(['/home/huy/merge', '/home/huy/merge/sub', '/data/merge/sub/Huy.pdf'], {
      '/home/huy/merge': '/data/merge',
      '/home/huy/merge/sub': '/data/merge/sub',
    })
    expect(
      containedTarget(
        '/home/huy/merge',
        '/home/huy/merge/sub/Huy.pdf',
        posixRules,
        fs.exists,
        fs.realpath,
      ),
    ).toBe('/data/merge/sub/Huy.pdf')
  })
})
