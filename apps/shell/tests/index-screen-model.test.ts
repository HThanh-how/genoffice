import { describe, expect, it } from 'vitest'
import type { IndexedFolder } from '../src/shared/fork/document-index-api'
import {
  deriveHeadline,
  filterFolderRows,
  folderName,
  foldText,
  shortPath,
  toFolderRows,
  windowRange,
  type HeadlineInput,
} from '../src/renderer/src/fork/index-screen-model'
import { withoutModel } from '../src/renderer/src/fork/index-issue-groups'

function folder(root: string, patch: Partial<IndexedFolder> = {}): IndexedFolder {
  return {
    root,
    state: 'complete',
    priority: false,
    unavailable: false,
    totalFiles: 10,
    readyFiles: 10,
    pendingFiles: 0,
    errorFiles: 0,
    history: [],
    ...patch,
  }
}

const idle: HeadlineInput = {
  status: { kind: 'ready', percent: 100, waiting: 0, ready: 40, eta: null },
  scanning: false,
  modelState: 'ready',
  pending: 0,
  hasFolders: true,
  searchable: 40,
  total: 40,
}

describe('deriveHeadline', () => {
  it('says ready when nothing is running', () => {
    expect(deriveHeadline(idle).kind).toBe('ready')
  })

  it('shows the empty first-run state only when no folder and no file exist', () => {
    expect(deriveHeadline({ ...idle, hasFolders: false, searchable: 0, total: null }).kind).toBe(
      'empty',
    )
    expect(deriveHeadline({ ...idle, hasFolders: false }).kind).toBe('ready')
  })

  it('keeps a pause on top of everything else and carries its reason', () => {
    const head = deriveHeadline({
      ...idle,
      status: { kind: 'paused', why: 'battery', percent: 50, waiting: 9, ready: 40, eta: null },
      scanning: true,
      modelState: 'error',
    })
    expect(head.kind).toBe('paused')
    expect(head.why).toBe('battery')
  })

  it('reports a failing model before progress, and a download with its own percent', () => {
    const working = { kind: 'working', percent: 20, waiting: 5, ready: 40, eta: null } as const
    expect(deriveHeadline({ ...idle, status: working, modelState: 'error' }).kind).toBe(
      'modelError',
    )
    const download = deriveHeadline({
      ...idle,
      status: working,
      modelState: 'downloading',
      modelProgress: 0.374,
      pending: 5,
    })
    expect(download.kind).toBe('downloading')
    expect(download.percent).toBe(37)
  })

  it('prefers scanning over working, with no fill ratio to draw', () => {
    const head = deriveHeadline({
      ...idle,
      status: { kind: 'working', percent: 30, waiting: 5, ready: 40, eta: null },
      scanning: true,
    })
    expect(head.kind).toBe('scanning')
    expect(head.percent).toBeNull()
  })

  it('keeps the time left from the status when it is working', () => {
    const eta = { unit: 'minutes', value: 12 } as const
    const head = deriveHeadline({
      ...idle,
      status: { kind: 'working', percent: 30, waiting: 5, ready: 40, eta },
    })
    expect(head.eta).toEqual(eta)
  })
})

describe('folder rows', () => {
  it('derives one state per folder, offline first', () => {
    const rows = toFolderRows([
      folder('D:\\a', { unavailable: true }),
      folder('D:\\b', { state: 'running' }),
      folder('D:\\c', { state: 'stopped' }),
      folder('D:\\d', { pendingFiles: 3, readyFiles: 7 }),
      folder('D:\\e'),
    ])
    expect(Object.fromEntries(rows.map((r) => [r.name, r.state]))).toEqual({
      a: 'offline',
      b: 'scanning',
      c: 'stopped',
      d: 'indexing',
      e: 'ready',
    })
  })

  it('puts the priority folder first and sorts the rest by name with numbers in order', () => {
    const rows = toFolderRows([
      folder('D:\\Du an 10'),
      folder('D:\\Du an 2'),
      folder('D:\\Zeta', { priority: true }),
      folder('D:\\Alpha'),
    ])
    expect(rows.map((r) => r.name)).toEqual(['Zeta', 'Alpha', 'Du an 2', 'Du an 10'])
  })

  it('treats a folder with no owner list or a manual owner as added by the person', () => {
    const rows = toFolderRows([
      folder('D:\\a'),
      folder('D:\\b', { owners: ['manual'] }),
      folder('D:\\c', { owners: ['documents'] as never }),
    ])
    expect(rows.map((r) => r.manual)).toEqual([true, true, false])
  })

  it('counts empty, failed and released files as handled', () => {
    const [row] = toFolderRows([
      folder('D:\\a', { totalFiles: 10, readyFiles: 6, errorFiles: 2, releasedFiles: 1 }),
    ])
    expect(row).toMatchObject({ done: 9, total: 10, errors: 2 })
  })

  it('filters by name or path without caring for case or accents', () => {
    const rows = toFolderRows([folder('D:\\Tài liệu\\Hợp đồng'), folder('D:\\Photos')])
    expect(filterFolderRows(rows, 'hop dong').map((r) => r.name)).toEqual(['Hợp đồng'])
    expect(filterFolderRows(rows, 'TAI LIEU').map((r) => r.name)).toEqual(['Hợp đồng'])
    expect(filterFolderRows(rows, '  ').length).toBe(2)
    expect(filterFolderRows(rows, 'zzz')).toEqual([])
  })

  it('names a folder by its last segment, and a drive by itself', () => {
    expect(folderName('C:\\Users\\Linh\\Work\\')).toBe('Work')
    expect(folderName('/home/linh/docs')).toBe('docs')
    expect(folderName('D:\\')).toBe('D:')
  })

  it('folds Vietnamese text', () => {
    expect(foldText('Đường  Hợp Đồng')).toBe('duong hop dong')
  })
})

describe('shortPath', () => {
  it('leaves short paths alone', () => {
    expect(shortPath('D:\\Work\\Docs')).toBe('D:\\Work\\Docs')
  })
  it('keeps the start and the last two folders of a long Windows path', () => {
    const path = 'C:\\Users\\Admin\\AppData\\Local\\Temp\\claude\\project\\Contracts\\2024'
    expect(shortPath(path)).toBe('C:\\…\\Contracts\\2024')
  })
  it('does the same for a posix path', () => {
    const path = '/home/linh/work/clients/acme/contracts/archive/2024/signed'
    expect(shortPath(path)).toBe('/…/2024/signed')
  })
})

describe('windowRange', () => {
  const base = { rowHeight: 56, viewport: 560, count: 300, overscan: 2 }
  it('starts at the top of the list', () => {
    expect(windowRange({ ...base, scrolledPast: 0 })).toEqual({ start: 0, end: 13 })
    // a list that starts lower on the page has fewer rows on screen
    expect(windowRange({ ...base, scrolledPast: -200 })).toEqual({ start: 0, end: 9 })
  })
  it('follows the scroll position', () => {
    expect(windowRange({ ...base, scrolledPast: 5600 })).toEqual({ start: 98, end: 113 })
  })
  it('stays inside the list at the end', () => {
    const range = windowRange({ ...base, scrolledPast: 999999 })
    expect(range.end).toBe(300)
    expect(range.start).toBeLessThan(300)
    expect(range.start).toBeGreaterThanOrEqual(0)
  })
  it('handles an empty list', () => {
    expect(windowRange({ ...base, count: 0, scrolledPast: 0 })).toEqual({ start: 0, end: 0 })
  })
  it('never draws more than a screenful plus the margins', () => {
    const range = windowRange({ ...base, scrolledPast: 12345 })
    expect(range.end - range.start).toBeLessThanOrEqual(Math.ceil(560 / 56) + 1 + 4)
  })
})

describe('withoutModel', () => {
  it('drops only the search-model group and recounts', () => {
    const summary = {
      total: 7,
      groups: [
        { reason: 'model' as const, count: 4 },
        { reason: 'corrupt' as const, count: 3 },
      ],
    }
    expect(withoutModel(summary)).toEqual({
      total: 3,
      groups: [{ reason: 'corrupt', count: 3 }],
    })
    expect(withoutModel(null)).toBeNull()
  })
})
