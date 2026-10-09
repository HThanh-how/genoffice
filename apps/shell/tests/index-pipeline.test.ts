// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { LocaleProvider } from '../src/renderer/src/locale'
import { IndexPipeline } from '../src/renderer/src/fork/IndexPipeline'
import type { HomeApi, HomeIndexingActivity } from '../src/shared/home-api'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

it('shows actual local work separately from queued vectors and an unavailable OCR connection', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const onTodo = vi.fn()
  try {
    await act(async () => {
      root.render(
        createElement(
          LocaleProvider,
          { initial: 'vi' },
          createElement(IndexPipeline, {
            api: {} as HomeApi,
            activity: { memory: { pending: 2 } } as HomeIndexingActivity,
            now: {
              extracting: [],
              embedding: {
                'running.txt': { done: 8, total: 16 },
                'waiting.txt': { done: 0, total: 100 },
              },
              activeEmbeddingPath: 'running.txt',
              queued: 0,
              positions: {},
              pages: {},
              paused: false,
            },
            paused: false,
            onTodo,
            onSettings: vi.fn(),
          }),
        ),
      )
    })
    expect(host.textContent).toContain('running.txt')
    expect(host.textContent).not.toContain('waiting.txt')
    expect(host.textContent).toContain('Chưa lấy được trạng thái')
    expect(host.textContent).not.toContain('Đang lấy trạng thái…')
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.idx-lane > button')!.click()
    })
    expect(onTodo).toHaveBeenCalledOnce()
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

it('says why files are waiting when nothing is being read and the queue is not paused', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const render = async (blocked: 'storage-checking' | undefined) => {
    await act(async () => {
      root.render(
        createElement(
          LocaleProvider,
          { initial: 'en' },
          createElement(IndexPipeline, {
            api: {} as HomeApi,
            activity: { memory: { pending: 12 } } as HomeIndexingActivity,
            now: {
              extracting: [],
              embedding: {},
              queued: 12,
              positions: {},
              pages: {},
              paused: false,
              ...(blocked ? { blocked } : {}),
            },
            paused: false,
            onTodo: vi.fn(),
            onSettings: vi.fn(),
          }),
        ),
      )
    })
  }
  try {
    await render(undefined)
    expect(host.textContent).not.toContain('Checking storage')
    await render('storage-checking')
    expect(host.textContent).toContain('Checking storage before writing more.')
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
