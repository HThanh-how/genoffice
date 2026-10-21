// @vitest-environment jsdom
// @ts-expect-error global React act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement } from 'react'
import { LocaleProvider } from '../src/renderer/src/locale'
import { IndexDashboard } from '../src/renderer/src/fork/IndexDashboard'
import type { HomeApi } from '../src/shared/home-api'

/**
 * Regression: the Index screen showed "Ready to search 0 files", "Loading folder progress…" and
 * "0 searchable files" forever while getIndexingActivity() returned real numbers. Windows reports a
 * window covered by another app as visibilityState 'hidden', and every Index loader skipped its read
 * in that state, the first one included. The payload below is a trimmed copy of the real one.
 */

const folderProgress = {
  totalFiles: 42853,
  readyFiles: 8103,
  pendingFiles: 9694,
  waitingFiles: 9694,
  releasedFiles: 25021,
  errorFiles: 35,
  emptyFiles: 1957,
  truncatedFiles: 1615,
  completedChunks: 19840,
  totalChunks: 187389,
  percent: 77,
}
const memory = {
  enabled: true,
  modelState: 'ready',
  documents: 42853,
  chunks: 187389,
  vectors: 19840,
  pending: 9680,
  errors: 35,
  dbPath: 'C:\\db\\document-memory.db',
  files: [],
}
const activity = {
  folder: { state: 'complete', running: false, root: 'D:\\', discovered: 25189, enrolled: 25163, skipped: 260307, errors: 0 },
  progressScope: 'library',
  memory: { enabled: true, cpuMode: 'gentle', modelState: 'ready', pending: 9680, errors: 35 },
  folderProgress,
}
const issues = {
  total: 1995,
  groups: [
    { reason: 'waiting', count: 3 },
    { reason: 'corrupt', count: 2 },
    { reason: 'other', count: 19 },
    { reason: 'password', count: 14 },
    { reason: 'no-text', count: 1467 },
    { reason: 'empty', count: 490 },
  ],
}
const mode = {
  mode: 'fast',
  pauseOnBattery: true,
  effective: { tier: 'battery', paused: false, threads: 1, cpuShare: 0.3, onBattery: true, memoryTier: 'high' },
}
const folders = [
  {
    root: 'D:\\',
    owners: ['manual'],
    state: 'complete',
    priority: false,
    unavailable: false,
    totalFiles: 37901,
    readyFiles: 5733,
    pendingFiles: 8649,
    waitingFiles: 8649,
    releasedFiles: 23487,
    errorFiles: 32,
    emptyFiles: 476,
    history: [],
  },
  {
    root: 'G:\\Mr Quoc',
    owners: ['manual'],
    state: 'complete',
    priority: false,
    unavailable: false,
    totalFiles: 4932,
    readyFiles: 2356,
    pendingFiles: 1040,
    waitingFiles: 1040,
    releasedFiles: 1534,
    errorFiles: 2,
    emptyFiles: 1481,
    history: [],
  },
]

function makeApi() {
  const calls: Record<string, number> = {}
  const known: Record<string, (...args: unknown[]) => unknown> = {
    getDocumentIndexSnapshot: async () => ({ memory, activity, mode, issues, now: { extracting: [] }, timestamp: 1 }),
    getDocumentMemoryStatus: async () => memory,
    getIndexingActivity: async () => activity,
    getIndexingModeState: async () => mode,
    getDocumentIndexIssueSummary: async () => issues,
    getIndexingNow: async () => ({ extracting: [] }),
    listIndexedFolders: async () => folders,
    getKnownSearchSources: async () => [],
    getLegacyConvertState: async () => null,
    recents: async () => ({ entries: [] }),
  }
  const api = new Proxy(
    {},
    {
      get(_t, key: string) {
        if (key === 'then') return undefined
        return (...args: unknown[]) => {
          calls[key] = (calls[key] ?? 0) + 1
          return known[key] ? known[key](...args) : Promise.resolve(null)
        }
      },
    },
  ) as unknown as HomeApi
  return { api, calls }
}

let container: HTMLDivElement
let root: Root

async function flush(times = 6) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

function clickTab(label: string) {
  const tab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((b) =>
    (b.textContent ?? '').trim().startsWith(label),
  )
  if (!tab) throw new Error(`tab ${label} not found`)
  act(() => tab.click())
}

describe('Index screen while Windows reports the window hidden', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    // drop the instance override so the prototype getter is used again
    delete (document as unknown as Record<string, unknown>).visibilityState
    vi.useRealTimers()
  })

  it('reads the real numbers on every tab instead of showing zero or loading forever', async () => {
    const { api, calls } = makeApi()
    act(() => {
      root.render(
        createElement(LocaleProvider, {
          initial: 'en',
          children: createElement(IndexDashboard, { api, onClose: () => undefined }),
        }),
      )
    })
    await flush()

    expect(calls.getDocumentIndexSnapshot ?? 0).toBeGreaterThan(0)
    const status = container.querySelector('.idx-status')?.textContent ?? ''
    expect(status).not.toMatch(/Ready to search 0 files/)
    expect(status).toMatch(/77%/)

    clickTab('Sources')
    await flush()
    expect(container.textContent).not.toMatch(/Loading folder progress/)
    expect(container.textContent).toContain('G:\\Mr Quoc')

    clickTab('Issues')
    await flush()
    const issuesText = container.textContent ?? ''
    expect(issuesText).not.toMatch(/Loading file status/)
    expect(issuesText).not.toMatch(/\b0 searchable files/)
    expect(issuesText).toContain('8,103')
    // corrupt (2) + password (14) fold into one group the person can act on
    expect(issuesText).toMatch(/Damaged or needs a password[^0-9]*16/)
  })

  it('shows a placeholder, not "0 files", before the first answer arrives', async () => {
    const { api } = makeApi()
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const slow = new Proxy(api as object, {
      get(t, key: string) {
        const fn = (t as Record<string, unknown>)[key] as (...a: unknown[]) => Promise<unknown>
        if (key === 'getDocumentIndexSnapshot') return async (...a: unknown[]) => { await gate; return fn(...a) }
        return fn
      },
    }) as unknown as HomeApi
    act(() => {
      root.render(
        createElement(LocaleProvider, {
          initial: 'en',
          children: createElement(IndexDashboard, { api: slow, onClose: () => undefined }),
        }),
      )
    })
    await flush(2)
    const status = container.querySelector('.idx-status')
    expect(status?.getAttribute('aria-busy')).toBe('true')
    expect(status?.textContent ?? '').not.toMatch(/0 files/)
    release()
    await flush()
    expect(container.querySelector('.idx-status')?.textContent ?? '').toMatch(/77%/)
  })
})
