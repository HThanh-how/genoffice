// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexProblems } from '../src/renderer/src/fork/IndexProblems'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { HomeApi } from '../src/shared/home-api'
import type { IndexIssue } from '../src/main/document-memory/issues'

const files: IndexIssue[] = [
  { id: 1, path: 'D:/shared/scan.pdf', name: 'scan.pdf', reason: 'no-text' },
  { id: 2, path: 'D:/shared/letter.docx', name: 'letter.docx', reason: 'waiting' },
  { id: 3, path: 'Z:/company/report.xlsx', name: 'report.xlsx', reason: 'timeout' },
]
let container: HTMLDivElement
let root: Root
const api = {
  getIndexingNow: async () => ({
    extracting: [],
    embedding: {},
    positions: {},
    pages: {},
    queued: 0,
    paused: false,
  }),
  listIndexedFolders: async () => [
    { root: 'D:/', unavailable: false },
    { root: 'Z:/', unavailable: true },
  ],
  getDocumentIndexIssues: async (_root: string, offset: number, reason?: string) => {
    const matches = files.filter((file) => !reason || file.reason === reason)
    return { total: matches.length, items: matches.slice(offset, offset + 10) }
  },
  getIndexFileDetail: vi.fn(async () => null),
} as unknown as HomeApi

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
async function render(grouping: 'folder' | 'type' | 'none' = 'folder') {
  await act(async () =>
    root.render(
      createElement(LocaleProvider, {
        initial: 'en',
        children: createElement(IndexProblems, {
          api,
          root: '*',
          onChanged: () => {},
          bucket: 'all',
          grouping,
          sort: 'name',
          hideToolbar: true,
          summary: { total: 3, groups: files.map((file) => ({ reason: file.reason, count: 1 })) },
        }),
      }),
    ),
  )
}

describe('Grouped Index list interaction', () => {
  it('supports Shift selection across visible folder groups', async () => {
    await render()
    const rows = [...container.querySelectorAll<HTMLElement>('.ixp-alternate-view .ixp-files > li')]
    await act(async () => rows[0].querySelector<HTMLInputElement>('input')!.click())
    await act(async () =>
      rows[2]
        .querySelector<HTMLButtonElement>('.ixp-main')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })),
    )
    expect(container.querySelectorAll('input:checked')).toHaveLength(3)
  })
  it('merges different issues in the same folder and selects only that folder', async () => {
    await render()
    expect(container.querySelectorAll('.ixp-file-name')).toHaveLength(3)
    const shared = [...container.querySelectorAll<HTMLElement>('.ixp-group')].find((group) =>
      group.textContent?.includes('D:/shared'),
    )!
    expect(shared.querySelectorAll('.ixp-file-name')).toHaveLength(2)
    const choose = [...shared.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Select shown files',
    )!
    await act(async () => choose.click())
    expect(container.querySelectorAll('input:checked')).toHaveLength(2)
    expect(container.querySelector('.is-muted-source input:checked')).toBeNull()
  })
  it('keeps offline rows visible and switches to a flat view without duplicated rows', async () => {
    await render('none')
    expect(container.querySelectorAll('.ixp-alternate-view .ixp-group')).toHaveLength(1)
    expect(container.querySelectorAll('.ixp-file-name')).toHaveLength(3)
    expect(container.querySelector('.is-muted-source')?.textContent).toContain('Source offline')
    expect(container.textContent).toContain('3/3 loaded files')
    await render('type')
    expect(container.querySelectorAll('.ixp-file-name')).toHaveLength(3)
  })
})
