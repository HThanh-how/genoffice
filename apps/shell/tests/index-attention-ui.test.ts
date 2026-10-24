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
          if (key === 'getIndexBrowserPage') {
            const reason = (args[0] as { reasons: string[] }).reasons[0]
            return Promise.resolve({
              total: 12,
              sizeBytes: 1200,
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

  it('opens the shared selectable file browser with filters and detail disclosure', async () => {
    const calls = await render()
    act(() => container.querySelector<HTMLButtonElement>('.ix-issue-main')!.click())
    await flush()
    expect(calls.some(([name]) => name === 'getIndexBrowserPage')).toBe(true)
    const rows = container.querySelectorAll('.ix-browser-row')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]!.querySelector('input[type="checkbox"]')).not.toBeNull()
    expect(rows[0]!.querySelector('button[aria-expanded="false"]')).not.toBeNull()
    expect(container.querySelector('.ixp')).toBeNull()
    expect(container.textContent).toMatch(/Expand all/)
    expect(container.textContent).toMatch(/Select shown files/)
    expect(container.querySelector('input[type="search"]')).not.toBeNull()
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
