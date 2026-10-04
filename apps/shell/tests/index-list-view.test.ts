import { describe, expect, it } from 'vitest'
import {
  groupViewFiles,
  sortViewFiles,
  sourceOffline,
} from '../src/renderer/src/fork/index-list-view'

const files = [
  {
    id: 1,
    path: 'Z:/company/Report 10.pdf',
    name: 'Report 10.pdf',
    reason: 'no-text',
    offline: true,
    progress: { done: 1, total: 2 },
  },
  {
    id: 2,
    path: 'D:/work/Report 2.docx',
    name: 'Report 2.docx',
    reason: 'waiting',
    progress: { done: 3, total: 4 },
  },
  {
    id: 3,
    path: 'D:/work/Report 1.pdf',
    name: 'Report 1.pdf',
    reason: 'no-text',
    progress: { done: 1, total: 4 },
  },
]
describe('Index list view', () => {
  it('sorts naturally and keeps offline files last without mutating the source order', () => {
    expect(sortViewFiles(files, 'name', false, 'vi', null).map((file) => file.id)).toEqual([
      3, 2, 1,
    ])
    expect(sortViewFiles(files, 'name', true, 'vi', null).map((file) => file.id)).toEqual([2, 3, 1])
    expect(files.map((file) => file.id)).toEqual([1, 2, 3])
  })
  it('sorts progress and can explicitly put disconnected sources first', () => {
    expect(sortViewFiles(files, 'progress', true, 'vi', null).map((file) => file.id)).toEqual([
      2, 3, 1,
    ])
    expect(sortViewFiles(files, 'connection', true, 'vi', null)[0].id).toBe(1)
  })
  it('groups one folder across different issues without duplicating rows', () => {
    const groups = groupViewFiles(files, 'folder')
    expect(groups.find((group) => group.key === 'D:/work')?.items.map((file) => file.id)).toEqual([
      2, 3,
    ])
    expect(groups.flatMap((group) => group.items)).toHaveLength(3)
    expect(groupViewFiles(files, 'type').map((group) => [group.key, group.items.length])).toEqual([
      ['PDF', 2],
      ['DOCX', 1],
    ])
    expect(groupViewFiles(files, 'none')).toHaveLength(1)
  })
  it('uses the deepest source and segment boundaries for mapped drives and UNC shares', () => {
    const roots = [
      { root: 'D:/', unavailable: false },
      { root: 'D:/company', unavailable: true },
    ]
    expect(sourceOffline('d:\\Company\\invoice.pdf', roots)).toBe(true)
    expect(sourceOffline('D:/company-old/invoice.pdf', roots)).toBe(false)
    expect(
      sourceOffline('\\\\server\\share\\invoice.pdf', [
        { root: '//SERVER/share', unavailable: true },
      ]),
    ).toBe(true)
    expect(sourceOffline('/mnt/Company/a.pdf', [{ root: '/mnt/company', unavailable: true }])).toBe(
      false,
    )
  })
})
