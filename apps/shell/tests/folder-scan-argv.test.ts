import { describe, expect, it } from 'vitest'
import { parseFolderScanArgv, withoutFolderScanArgs } from '../src/main/folder-scan-argv'

describe('selected folder launch arguments', () => {
  it('preserves folder names with spaces and transfers requests through the instance lock', () => {
    const argv = ['GenOffice.exe', '--genoffice-scan-folder', 'C:\\Parent files\\Class 2']
    expect(parseFolderScanArgv(argv, { folderScanPaths: ['C:\\Parent files\\Class 2'] })).toEqual([
      'C:\\Parent files\\Class 2',
    ])
    expect(withoutFolderScanArgs([...argv, 'C:\\report.docx'])).toEqual([
      'GenOffice.exe',
      'C:\\report.docx',
    ])
  })
  it('does not consume an unrelated flag when the folder value is missing', () => {
    const argv = ['app', '--genoffice-scan-folder', '--headless-export', 'report.docx']
    expect(parseFolderScanArgv(argv)).toEqual([])
    expect(withoutFolderScanArgs(argv)).toEqual(['app', '--headless-export', 'report.docx'])
    expect(parseFolderScanArgv([], { folderScanPaths: [null, 7, ''] })).toEqual([])
  })
})
