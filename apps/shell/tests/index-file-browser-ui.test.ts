// @vitest-environment jsdom
// @ts-expect-error React act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexFileBrowser } from '../src/renderer/src/fork/IndexFileBrowser'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { HomeApi } from '../src/shared/home-api'
import type { IndexBrowserQuery } from '../src/shared/fork/index-browser'
import type { FileItem } from '../src/renderer/src/fork/IndexFiles'
import type { IndexFileDetail } from '../src/shared/fork/document-index-api'

vi.mock('../src/renderer/src/ui-feedback', () => ({ appConfirm: vi.fn(async () => true) }))
let container: HTMLDivElement
let root: Root
const flush = async () => {
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
}
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
function render() {
  const retried = new Set<number>()
  const rows = Array.from({ length: 350 }, (_, index) => ({
    id: index + 1,
    name: `Seed ${index + 1}.pdf`,
    path: `D:\\Seed\\Seed ${index + 1}.pdf`,
    status: 'error',
    reason: 'permission' as const,
  }))
  const getIndexBrowserPage = vi.fn(async (q: IndexBrowserQuery) => {
    const matching = rows.filter(
      (row) =>
        !retried.has(row.id) && row.id > (q.afterId ?? 0) && row.id <= (q.throughId ?? Infinity),
    )
    return {
      total: matching.length,
      sizeBytes: matching.length * 100,
      maxId: Math.max(0, ...matching.map((row) => row.id)),
      items: matching.slice(q.offset ?? 0, (q.offset ?? 0) + 100),
    }
  })
  const getIndexFileDetail = vi.fn(async (id: number): Promise<IndexFileDetail> => ({
    ...rows[id - 1],
    exists: true,
    updatedAt: 1000,
    truncated: false,
    chunkDone: 0,
    chunkTotal: 0,
  }))
  const enqueueDocumentIndex = vi.fn(async (ids: number[]) => {
    for (const id of ids) retried.add(id)
    return { queued: ids.length, skipped: 0 }
  })
  const api = {
    getIndexBrowserPage,
    getIndexFileDetail,
    enqueueDocumentIndex,
  } as unknown as HomeApi
  act(() =>
    root.render(
      createElement(LocaleProvider, {
        initial: 'en',
        children: createElement(IndexFileBrowser, {
          api,
          scope: { reasons: ['permission'] },
          onChanged: () => {},
        }),
      }),
    ),
  )
  return { rows, retried, getIndexBrowserPage, getIndexFileDetail, enqueueDocumentIndex }
}
describe('shared Index file interactions', () => {
  it('uses freshly loaded detail metadata when a file changes after the list was read', async () => {
    const api = render()
    await flush()
    api.getIndexFileDetail.mockImplementationOnce(async () => ({
      id: 1,
      name: 'Renamed.pdf',
      path: 'D:\\Seed\\Renamed.pdf',
      status: 'ready',
      indexStatus: 'ready',
      exists: true,
      updatedAt: 2000,
      truncated: false,
      chunkDone: 1,
      chunkTotal: 1,
    }))
    act(() => container.querySelector<HTMLButtonElement>('[data-file-id="1"]')!.click())
    await flush()
    const detail = container.querySelector('.ix-detail')!
    expect(detail.querySelector('h3')?.textContent).toBe('Renamed.pdf')
    expect(detail.querySelector('.ix-detail-path')?.textContent).toBe('D:\\Seed\\Renamed.pdf')
    expect(detail.querySelector('.ix-detail-reason')).toBeNull()
    expect(detail.querySelector('.ix-detail-facts')?.textContent).toContain('Searchable')
  })
  it('opens the same detail actions with the keyboard context-menu shortcut', async () => {
    render()
    await flush()
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-file-id="1"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })),
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(container.querySelector<HTMLDetailsElement>('.ix-detail-more')?.open).toBe(true)
    expect(container.querySelector('.ix-detail')?.textContent).toContain('Copy file name')
  })
  it('stops eligible local work and queued OCR in a mixed selection without failing on ready files', async () => {
    const stopIndexFile = vi.fn(async () => ({ ok: true }))
    const cancelScannedPdfsWithAgy = vi.fn(async () => 1)
    const api = { stopIndexFile, cancelScannedPdfsWithAgy } as unknown as HomeApi
    const fixedItems: FileItem[] = [
      { id: 1, path: 'D:/seed/ready.md', name: 'ready.md', status: 'ready' },
      {
        id: 2,
        path: 'D:/seed/waiting.md',
        name: 'waiting.md',
        status: 'pending',
        reason: 'waiting',
      },
      { id: 3, path: 'D:/seed/scan.pdf', name: 'scan.pdf', status: 'empty', reason: 'no-text' },
    ]
    act(() =>
      root.render(
        createElement(LocaleProvider, {
          initial: 'en',
          children: createElement(IndexFileBrowser, { api, fixedItems, onChanged: () => {} }),
        }),
      ),
    )
    await flush()
    act(() =>
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Select shown files')!
        .click(),
    )
    act(() => container.querySelector<HTMLElement>('.ix-bulk summary')!.click())
    act(() =>
      [...container.querySelectorAll<HTMLButtonElement>('.ix-bulk button')]
        .find((button) => button.textContent === 'Stop processing')!
        .click(),
    )
    await flush()
    expect(stopIndexFile).toHaveBeenCalledExactlyOnceWith(2)
    expect(cancelScannedPdfsWithAgy).toHaveBeenCalledExactlyOnceWith([3])
    expect(container.textContent).toContain('Action completed.')
  })
  it('loads details only after selection and exposes every action', async () => {
    const api = render()
    await flush()
    expect(api.getIndexFileDetail).not.toHaveBeenCalled()
    act(() => container.querySelector<HTMLButtonElement>('[data-file-id="1"]')!.click())
    await flush()
    expect(api.getIndexFileDetail).toHaveBeenCalledTimes(1)
    const panel = container.querySelector('.ix-detail')!
    for (const label of [
      'Open in its app',
      'Show in folder',
      'Read again',
      'Cloud OCR now',
      'Copy path',
      'Copy file name',
      'Copy diagnostic log',
      'Exclude this file',
      'Exclude this folder',
      'Remove from index',
      'Read later',
      'Stop processing',
    ])
      expect(panel.textContent).toContain(label)
    act(() => panel.querySelector<HTMLButtonElement>('[aria-label="Close details"]')!.click())
    expect(container.querySelector('.ix-detail')).toBeNull()
  })
  it('supports checkboxes, Shift ranges, Space and Escape', async () => {
    render()
    await flush()
    const boxes = container.querySelectorAll<HTMLInputElement>('.ix-browser-row input')
    act(() => boxes[0]!.click())
    act(() => boxes[4]!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })))
    expect(container.querySelectorAll('.ix-browser-row input:checked')).toHaveLength(5)
    expect(container.querySelector('.ix-bulk')?.textContent).toContain('5 files selected')
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-file-id="6"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })),
    )
    expect(container.querySelectorAll('.ix-browser-row input:checked')).toHaveLength(6)
    act(() =>
      container
        .querySelector('.ix-browser-scroll')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    )
    expect(container.querySelector('.ix-bulk')).toBeNull()
  })
  it('selects the whole filtered group and processes bounded keyset pages without skipping changed rows', async () => {
    const api = render()
    await flush()
    const all = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Select all 350 matching files',
    )!
    act(() => all.click())
    expect(container.querySelector('.ix-bulk')?.textContent).toContain('350 files selected')
    act(() => container.querySelector<HTMLButtonElement>('.ix-bulk button')!.click())
    await flush()
    expect(api.retried.size).toBe(350)
    expect(api.enqueueDocumentIndex.mock.calls.every(([ids]) => ids.length <= 100)).toBe(true)
    expect(
      api.getIndexBrowserPage.mock.calls
        .filter(([q]) => q.afterId !== undefined)
        .map(([q]) => q.afterId),
    ).toEqual([0, 100, 200, 300, 350])
    expect(api.getIndexFileDetail).not.toHaveBeenCalled()
    expect(container.querySelector('.ix-bulk')).toBeNull()
  })
})
