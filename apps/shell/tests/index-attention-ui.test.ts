// @vitest-environment jsdom
// @ts-expect-error global React act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement } from 'react'
import { LocaleProvider } from '../src/renderer/src/locale'
import { IndexAttention } from '../src/renderer/src/fork/IndexAttention'
import type { HomeApi } from '../src/shared/home-api'

const attention = {
  total: 20,
  groups: [
    { reason: 'permission' as const, count: 5 },
    { reason: 'corrupt' as const, count: 4 },
    { reason: 'unavailable' as const, count: 3 },
    { reason: 'other' as const, count: 2 },
    { reason: 'no-text' as const, count: 6 },
  ],
}

function makeApi() {
  const calls: Array<[string, unknown[]]> = []
  const api = new Proxy(
    {},
    {
      get(_t, key: string) {
        if (key === 'then') return undefined
        return (...args: unknown[]) => {
          calls.push([key, args])
          if (key === 'getDocumentIndexIssues') {
            const reason = String(args[2])
            return Promise.resolve({
              total: 12,
              items: Array.from({ length: 10 }, (_, i) => ({
                id: i + 1,
                path: `D:\\Work\\Old\\file-${reason}-${i}.docx`,
                name: `file-${reason}-${i}.docx`,
                reason,
              })),
            })
          }
          return Promise.resolve(null)
        }
      },
    },
  ) as unknown as HomeApi
  return { api, calls }
}

let container: HTMLDivElement
let root: Root
const flush = async () => {
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
}

describe('Index attention list', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const render = async () => {
    const { api, calls } = makeApi()
    act(() => {
      root.render(
        createElement(LocaleProvider, {
          initial: 'en',
          children: createElement(IndexAttention, { api, attention, onChanged: () => undefined }),
        }),
      )
    })
    await flush()
    return calls
  }

  it('lists the top three kinds of trouble and folds the rest behind a toggle', async () => {
    await render()
    expect(container.querySelectorAll('.ix-issues > .ix-issue').length).toBe(3)
    const toggle = container.querySelector<HTMLButtonElement>('.ix-more-groups')
    expect(toggle?.textContent).toBe('Show 1 more')
    act(() => toggle!.click())
    expect(container.querySelectorAll('.ix-issues > .ix-issue').length).toBe(4)
    expect(container.querySelector('.ix-more-groups')?.textContent).toBe('Show fewer')
  })

  it('opens a group as a flat list of files with hover actions and no inner toolbar or cards', async () => {
    const calls = await render()
    act(() => container.querySelector<HTMLButtonElement>('.ix-issue-main')!.click())
    await flush()
    expect(calls.some(([name]) => name === 'getDocumentIndexIssues')).toBe(true)
    const rows = container.querySelectorAll('.ix-file')
    expect(rows.length).toBeGreaterThan(0)
    // each row: open, try again, show in folder
    expect(rows[0]!.querySelectorAll('.ix-file-actions button').length).toBe(3)
    // nothing from the old nested list
    expect(container.querySelector('.ixp')).toBeNull()
    expect(container.textContent).not.toMatch(/Expand all|Collapse all|Select shown files/)
    // the reason text is said once by the group, not per file
    expect(container.querySelectorAll('.ix-file-text span').length).toBe(rows.length)
    // 12 files exist and 10 are shown: one control loads the rest
    expect(container.querySelector('.ix-files-more')?.textContent).toMatch(/Show 2 more files/)
  })

  it('shows an offline root calmly and checks it on request', async () => {
    const { api, calls } = makeApi()
    act(() =>
      root.render(
        createElement(LocaleProvider, {
          initial: 'en',
          children: createElement(IndexAttention, {
            api,
            attention: {
              total: 0,
              groups: [],
              offlineRoots: [{ root: 'G:', since: 1_000, waiting: 1454 }],
            },
            onChanged: () => undefined,
          }),
        }),
      ),
    )
    await flush()
    const note = container.querySelector('[role="status"]')!
    expect(note.textContent).toContain('G: is not connected')
    expect(note.textContent).toContain('1,454 files are waiting')
    expect(note.textContent).toContain('resume automatically')
    expect(container.querySelector('.ix-issue')).toBeNull()
    act(() => note.querySelector<HTMLButtonElement>('button')!.click())
    await flush()
    expect(calls.some(([name]) => name === 'checkDocumentIndexSources')).toBe(true)
  })
})
