/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { DocumentIndexIndicator, type DocumentIndexProgress } from '../src/index-progress'

it('polls from queued to paused to ready and replaces animation with a success dot', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  const root = createRoot(host)
  let progress: DocumentIndexProgress = {
    state: 'queued',
    percent: null,
    completedChunks: 0,
    totalChunks: 0,
  }
  const api = { getDocumentIndexProgress: vi.fn(async () => progress) }
  try {
    await act(async () =>
      root.render(createElement(DocumentIndexIndicator, { path: '/sample.docx', api })),
    )
    expect(host.querySelector('.is-indeterminate')).not.toBeNull()
    progress = { ...progress, state: 'paused' }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(host.querySelector('.is-indeterminate')).toBeNull()
    expect(host.querySelector('.is-paused')).not.toBeNull()
    progress = { state: 'ready', percent: 100, completedChunks: 5, totalChunks: 5 }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(host.querySelector('.is-indeterminate')).toBeNull()
    expect(host.querySelector('.index-progress-ring-dot')).not.toBeNull()
    expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('100')
  } finally {
    act(() => root.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})
