// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FileRow,
  useFileActions,
  type FileActions,
  type FileItem,
  type Live,
} from '../src/renderer/src/fork/IndexFiles'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { HomeApi } from '../src/shared/home-api'

let container: HTMLDivElement
let root: Root
const item: FileItem = {
  id: 1,
  path: 'C:/files/letter.docx',
  name: 'letter.docx',
  reason: 'waiting',
}

function Harness({
  api,
  file = item,
  live,
  ocrQueued = false,
  ocrStage,
  ocrProgress,
  afterChange = async () => {},
}: {
  api: HomeApi
  file?: FileItem
  live?: Live
  ocrQueued?: boolean
  ocrStage?: 'recognizing'
  ocrProgress?: { done: number; total: number }
  afterChange?: () => Promise<void>
}) {
  const actions: FileActions = useFileActions(
    api,
    (reason) => reason,
    () => {},
    afterChange,
  )
  return createElement(
    'ul',
    null,
    createElement(FileRow, { item: file, actions, api, live, ocrQueued, ocrStage, ocrProgress }),
  )
}

const api = (extra: Partial<HomeApi> = {}) =>
  ({
    getIndexFileDetail: vi.fn(async () => null),
    documentMemoryOpen: vi.fn(async () => ({ ok: true })),
    revealDocumentIndexFile: vi.fn(async () => {}),
    ...extra,
  }) as unknown as HomeApi

async function render(props: Parameters<typeof Harness>[0]) {
  await act(async () =>
    root.render(
      createElement(LocaleProvider, { initial: 'en', children: createElement(Harness, props) }),
    ),
  )
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Index file interaction feedback', () => {
  it('acknowledges a click immediately and then shows queued instead of claiming completion', async () => {
    let acknowledge!: (value: { queued: number; skipped: number }) => void
    const enqueue = vi.fn(
      () =>
        new Promise<{ queued: number; skipped: number }>((resolve) => {
          acknowledge = resolve
        }),
    )
    await render({
      api: api({ enqueueDocumentIndex: enqueue }),
      afterChange: () => new Promise<void>(() => {}),
    })
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Read this one first"]',
    )!
    await act(async () => button.click())
    expect(container.textContent).toContain('Sending request')
    expect(button.disabled).toBe(true)
    expect(enqueue).toHaveBeenCalledExactlyOnceWith([1])
    await act(async () => acknowledge({ queued: 1, skipped: 0 }))
    expect(button.disabled).toBe(false)
    expect(container.textContent).toContain('Queued for priority reading')
    expect(container.textContent).not.toContain('It can be searched now')
  })

  it('shows actual page progress for local PDF reading and OCR', async () => {
    await render({
      api: api(),
      file: { ...item, path: 'scan.pdf' },
      live: { kind: 'reading', since: Date.now(), pages: { done: 3, total: 12 } },
    })
    expect(container.querySelector('.ixp-progress')?.getAttribute('aria-valuenow')).toBe('3')
    expect(container.querySelector('.ixp-progress')?.getAttribute('aria-valuemax')).toBe('12')
    await render({
      api: api(),
      file: { ...item, path: 'scan.pdf', reason: 'no-text' },
      ocrStage: 'recognizing',
      ocrProgress: { done: 5, total: 12 },
    })
    expect(container.textContent).toContain('Antigravity is reading')
    expect(container.querySelector('.ixp-progress')?.getAttribute('aria-valuenow')).toBe('5')
  })

  it('only offers OCR stop for an OCR queue, not unsupported defer or duplicate OCR', async () => {
    await render({
      api: api(),
      file: { ...item, path: 'scan.pdf', reason: 'no-text' },
      ocrQueued: true,
    })
    await act(async () =>
      container
        .querySelector('.ixp-row')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 })),
    )
    const menu = document.querySelector('[role="menu"]')!
    expect(menu.textContent).toContain('Stop reading')
    expect(menu.textContent).not.toContain('Read later')
    expect(menu.textContent).not.toContain('Read with Antigravity now')
    expect(container.textContent).toContain('OCR queued')
  })

  it('does not offer retry during active local reading', async () => {
    await render({ api: api(), live: { kind: 'reading', since: Date.now() } })
    await act(async () =>
      container
        .querySelector('.ixp-row')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })),
    )
    const menu = document.querySelector('[role="menu"]')!
    expect(menu.textContent).toContain('Stop reading')
    expect(menu.textContent).toContain('Read later')
    expect(menu.textContent).not.toContain('Read this one first')
  })
  it('shows an embedding backlog as waiting, without an animation claiming active work', async () => {
    await render({ api: api(), live: { kind: 'embedding', done: 4, total: 20, active: false } })
    expect(container.textContent).toContain('Waiting for search vectors')
    expect(container.querySelector('.is-processing')).toBeNull()
    expect(container.querySelector('.ixp-progress')?.getAttribute('aria-label')).toBe('4/20 blocks')
    expect(container.querySelector('button[aria-label="Read this one first"]')).not.toBeNull()
  })
  it('refreshes open file progress without closing and reopening its details', async () => {
    vi.useFakeTimers()
    const detail = {
      id: 1,
      path: item.path,
      name: item.name,
      status: 'ready',
      exists: true,
      updatedAt: 1,
      truncated: false,
      chunkTotal: 10,
      chunkDone: 2,
    }
    const read = vi.fn(async () => detail)
    await render({ api: api({ getIndexFileDetail: read }) })
    await act(async () => container.querySelector<HTMLButtonElement>('.ixp-main')!.click())
    expect(container.querySelector('.ixp-progress')?.getAttribute('aria-valuenow')).toBe('2')
    read.mockResolvedValue({ ...detail, chunkDone: 6 })
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(container.querySelector('.ixp-progress')?.getAttribute('aria-valuenow')).toBe('6')
    expect(container.querySelector('.ixp-main')?.getAttribute('aria-expanded')).toBe('true')
  })
})
