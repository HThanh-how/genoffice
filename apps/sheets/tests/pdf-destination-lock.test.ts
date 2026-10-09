import { describe, expect, it } from 'vitest'

import { pdfDestinationKey, tryAcquirePdfDestination } from '../src/main/pdf-destination-lock'

describe('pdf-destination-lock', () => {
  it('PDFLOCK-01: exact same path acquires lease, blocks second acquire, and allows re-acquire after release', () => {
    const testPath = 'D:\\test\\export-01.pdf'
    const lease1 = tryAcquirePdfDestination(testPath)
    expect(lease1).not.toBeNull()
    expect(lease1?.key).toBe(pdfDestinationKey(testPath))

    const lease2 = tryAcquirePdfDestination(testPath)
    expect(lease2).toBeNull()

    lease1?.release()

    const lease3 = tryAcquirePdfDestination(testPath)
    expect(lease3).not.toBeNull()
    lease3?.release()
  })

  it('PDFLOCK-02: windows case and separator aliases produce the same destination key', () => {
    const key1 = pdfDestinationKey('D:\\Reports\\Report.pdf', 'win32', 'D:\\work')
    const key2 = pdfDestinationKey('d:/reports/report.pdf', 'win32', 'D:\\work')
    expect(key1).toBe(key2)
  })

  it('PDFLOCK-03: windows relative path alias resolves to same key as normalized absolute path', () => {
    const cwd = 'D:\\work'
    const directPath = 'D:\\work\\report.pdf'
    const dottedPath = 'D:\\work\\.\\report.pdf'
    const relativePath = 'report.pdf'

    const keyDirect = pdfDestinationKey(directPath, 'win32', cwd)
    const keyDotted = pdfDestinationKey(dottedPath, 'win32', cwd)
    const keyRelative = pdfDestinationKey(relativePath, 'win32', cwd)

    expect(keyDirect).toBe(keyDotted)
    expect(keyDirect).toBe(keyRelative)
  })

  it('PDFLOCK-04: linux case sensitivity preserves distinct keys for different cases', () => {
    const pathA = '/tmp/A.pdf'
    const pathLowerA = '/tmp/a.pdf'

    const keyA = pdfDestinationKey(pathA, 'linux')
    const keyLowerA = pdfDestinationKey(pathLowerA, 'linux')

    expect(keyA).toBe('/tmp/A.pdf')
    expect(keyLowerA).toBe('/tmp/a.pdf')
    expect(keyA).not.toBe(keyLowerA)
  })

  it('PDFLOCK-05: darwin conservative policy folds paths to lowercase for same key', () => {
    const pathA = '/tmp/A.pdf'
    const pathLowerA = '/tmp/a.pdf'

    const keyA = pdfDestinationKey(pathA, 'darwin')
    const keyLowerA = pdfDestinationKey(pathLowerA, 'darwin')

    expect(keyA).toBe('/tmp/a.pdf')
    expect(keyLowerA).toBe('/tmp/a.pdf')
    expect(keyA).toBe(keyLowerA)
  })

  it('PDFLOCK-06: lease release is idempotent and allows re-acquire', () => {
    const testPath = 'D:\\test\\idempotent.pdf'
    const lease = tryAcquirePdfDestination(testPath)
    expect(lease).not.toBeNull()

    expect(() => {
      lease?.release()
      lease?.release()
      lease?.release()
    }).not.toThrow()

    const reacquired = tryAcquirePdfDestination(testPath)
    expect(reacquired).not.toBeNull()
    reacquired?.release()
  })

  it('PDFLOCK-07: different paths can be acquired in parallel without conflict', () => {
    const path1 = 'D:\\test\\parallel-1.pdf'
    const path2 = 'D:\\test\\parallel-2.pdf'

    const lease1 = tryAcquirePdfDestination(path1)
    const lease2 = tryAcquirePdfDestination(path2)

    expect(lease1).not.toBeNull()
    expect(lease2).not.toBeNull()
    expect(lease1?.key).not.toBe(lease2?.key)

    lease1?.release()
    lease2?.release()
  })

  it('throws an error if destination path is empty or whitespace', () => {
    expect(() => pdfDestinationKey('')).toThrow('PDF destination path is empty.')
    expect(() => pdfDestinationKey('   ')).toThrow('PDF destination path is empty.')
  })
})
