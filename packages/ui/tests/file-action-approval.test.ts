/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LANGS } from '@genoffice/i18n'
import type { PendingFileAction } from '@genoffice/agent-core'
import { FileActionApproval, useFileActionApproval } from '../src/FileActionApproval'
import { FILE_ACTION_LABELS } from '../src/strings-file-action'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot> | null
let approval: ReturnType<typeof useFileActionApproval>
const proposal = (): PendingFileAction => ({
  id: 'permission-token',
  action: { tool: 'move_file', source: '/allowed/old.md', destination: '/allowed/new.md' },
  expiresAt: Date.now() + 60_000,
})

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  function Probe() {
    approval = useFileActionApproval()
    return createElement(FileActionApproval, {
      pending: approval.pending,
      lang: 'en',
      onDecide: approval.decide,
    })
  }
  act(() => root!.render(createElement(Probe)))
})

afterEach(() => {
  act(() => root?.unmount())
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('waits for a click, displays both paths, and consumes approval once', async () => {
  let result!: Promise<boolean>
  act(() => {
    result = approval.confirm(proposal())
  })
  const settled = vi.fn()
  void result.then(settled)
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  expect(host.textContent).toContain('/allowed/old.md')
  expect(host.textContent).toContain('/allowed/new.md')
  const buttons = host.querySelectorAll('button')
  expect(buttons[0]!.textContent).toBe('Deny')
  expect(buttons[1]!.textContent).toBe('Approve')
  act(() => buttons[1]!.click())
  expect(await result).toBe(true)
  expect(host.querySelector('section')).toBeNull()
  act(() => approval.decide(false))
  expect(settled).toHaveBeenCalledExactlyOnceWith(true)
})

it('denies on Escape, cancellation, expiry and unmount', async () => {
  let result!: Promise<boolean>
  act(() => {
    result = approval.confirm(proposal())
  })
  act(() =>
    host
      .querySelector('button')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  )
  expect(await result).toBe(false)

  const controller = new AbortController()
  act(() => {
    result = approval.confirm(proposal(), controller.signal)
  })
  act(() => controller.abort())
  expect(await result).toBe(false)

  vi.useFakeTimers()
  act(() => {
    result = approval.confirm(proposal())
  })
  act(() => vi.advanceTimersByTime(60_000))
  expect(await result).toBe(false)
  vi.useRealTimers()

  act(() => {
    result = approval.confirm(proposal())
  })
  act(() => root!.unmount())
  root = null
  expect(await result).toBe(false)
})

it('includes every permission label in every supported locale', () => {
  const keys = Object.keys(FILE_ACTION_LABELS.zh)
  for (const lang of LANGS) {
    expect(Object.keys(FILE_ACTION_LABELS[lang])).toEqual(keys)
    expect(Object.values(FILE_ACTION_LABELS[lang]).every((value) => value.trim().length > 0)).toBe(
      true,
    )
  }
})

it('shows every ordered merge source and its destination before approval', async () => {
  const p = proposal()
  p.action = {
    tool: 'merge_documents',
    sources: ['/allowed/B.docx', '/allowed/A.md'],
    destination: '/allowed/Combined.docx',
    format: 'docx',
    separator: 'heading',
  }
  let result!: Promise<boolean>
  act(() => {
    result = approval.confirm(p)
  })
  const text = host.querySelector('pre')!.textContent!
  expect(text).toBe('/allowed/B.docx\n/allowed/A.md\n→ /allowed/Combined.docx')
  act(() => host.querySelector('button')!.click())
  expect(await result).toBe(false)
})
