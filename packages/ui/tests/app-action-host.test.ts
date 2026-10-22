/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LANGS } from '@genoffice/i18n'
import {
  AppActionRegistry,
  type AppActionBridge,
  type AppActionRequest,
  type AppActionResult,
} from '@genoffice/agent-core/app-control'
import { AppActionHost, reportAppAction } from '../src/AppActionHost'
import { waitForActionStep } from '../src/app-action-steps'
import { useAppControl } from '../src/use-app-control'
import { clarifyText } from '../src/strings-clarify'

let root: ReturnType<typeof createRoot>
let host: HTMLDivElement
let receive: (request: AppActionRequest) => Promise<AppActionResult>
let cancel: (id: string) => void
let bridge: AppActionBridge
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  bridge = {
    prepare: vi.fn(async () => 'ticket'),
    execute: vi.fn(async () => ({ status: 'completed' as const })),
    cancel: vi.fn(),
    onRequest: vi.fn((_ids, handler) => {
      receive = handler
      return vi.fn()
    }),
    onCancel: vi.fn((handler) => {
      cancel = handler
      return vi.fn()
    }),
  }
  Object.assign(window, { appActions: bridge })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (window as unknown as { appActions?: AppActionBridge }).appActions
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const print: AppActionRequest = {
  requestId: 'r',
  input: { kind: 'app_action', id: 'print', args: {}, teach: true },
}
function mountGuide() {
  const registry = new AppActionRegistry()
  const run = vi.fn(async () => ({ status: 'completed' as const }))
  registry.register({
    id: 'print',
    label: 'aiActionPrint',
    risk: 'confirm',
    teach: true,
    steps: [{ label: 'aiActionPrint', event: 'handoff' }],
    run,
  })
  act(() => root.render(createElement(AppActionHost, { registry, lang: 'en' })))
  return run
}
it('teach mode narrates a native handoff without inventing a rectangle or executing', async () => {
  const run = mountGuide()
  let pending!: Promise<AppActionResult>
  act(() => {
    pending = receive(print)
  })
  expect(host.textContent).toContain('Step 1/1: Open File')
  expect(host.querySelector('svg')).toBeNull()
  expect(run).not.toHaveBeenCalled()
  await act(async () => reportAppAction('print', { status: 'handoff' }))
  expect(await pending).toEqual({ status: 'handoff' })
  expect(host.textContent).toBe('')
})
it('renderer cancellation removes narration and cannot claim completion', async () => {
  const run = mountGuide()
  let pending!: Promise<AppActionResult>
  act(() => {
    pending = receive(print)
  })
  await act(async () => cancel('r'))
  expect(await pending).toEqual({ status: 'cancelled' })
  expect(run).not.toHaveBeenCalled()
  expect(host.textContent).toBe('')
})
it('cancelling before narration paints does not execute an automatic command', async () => {
  const run = mountGuide()
  let pending!: Promise<AppActionResult>
  act(() => {
    pending = receive({
      ...print,
      input: { ...print.input, kind: 'app_action', id: 'print', args: {}, teach: false },
    })
  })
  await act(async () => cancel('r'))
  expect(await pending).toEqual({ status: 'cancelled' })
  expect(run).not.toHaveBeenCalled()
  expect(host.textContent).toBe('')
})
it('Esc cancels a guide and unmount unregisters its renderer', async () => {
  mountGuide()
  let pending!: Promise<AppActionResult>
  act(() => {
    pending = receive(print)
  })
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  expect(await pending).toEqual({ status: 'cancelled' })
  const unregister = vi.mocked(bridge.onRequest).mock.results[0]?.value
  act(() => root.unmount())
  expect(unregister).toHaveBeenCalledOnce()
  root = createRoot(host)
})
it('waits for an observed DOM target and ignores synthetic clicks', async () => {
  const target = document.createElement('button')
  target.id = 'target'
  target.getBoundingClientRect = () => ({
    x: 1,
    y: 1,
    width: 10,
    height: 10,
    top: 1,
    left: 1,
    bottom: 11,
    right: 11,
    toJSON() {},
  })
  host.append(target)
  const controller = new AbortController()
  const settled = vi.fn()
  const promise = waitForActionStep(
    { label: 'button', event: 'click', selector: '#target' },
    controller.signal,
  ).catch(settled)
  target.click()
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  controller.abort()
  await promise
  expect(settled).toHaveBeenCalledWith(expect.any(Error))
})

function mountApproval() {
  let skill: ReturnType<typeof useAppControl>['skill']
  function Harness() {
    const control = useAppControl('en')
    skill = control.skill
    return control.approval
  }
  act(() => root.render(createElement(Harness)))
  return skill!
}
it('settings approval has no preselected answer; denial never executes', async () => {
  const skill = mountApproval()
  let pending!: ReturnType<typeof skill.executeTool>
  await act(async () => {
    pending = skill.executeTool({
      id: 'tool',
      name: 'set_setting',
      input: { key: 'theme', value: 'dark' },
    })
  })
  expect(host.textContent).toContain('theme: dark')
  expect(host.textContent).not.toContain('Decide for me')
  expect(bridge.execute).not.toHaveBeenCalled()
  const deny = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Deny'))
  expect(deny).toBeTruthy()
  await act(async () => {
    deny!.click()
    await vi.advanceTimersByTimeAsync(250)
  })
  expect((await pending).output).toContain('cancelled')
  expect(bridge.execute).not.toHaveBeenCalled()
  expect(bridge.cancel).toHaveBeenCalledWith('ticket')
})
it('explicit approval executes exactly once and closes its card', async () => {
  const skill = mountApproval()
  let pending!: ReturnType<typeof skill.executeTool>
  await act(async () => {
    pending = skill.executeTool({
      id: 'tool',
      name: 'set_setting',
      input: { key: 'theme', value: 'dark' },
    })
  })
  const approve = [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Approve'),
  )
  expect(approve).toBeTruthy()
  await act(async () => {
    approve!.click()
    await vi.advanceTimersByTimeAsync(250)
  })
  expect((await pending).output).toContain('completed')
  expect(bridge.execute).toHaveBeenCalledExactlyOnceWith('ticket')
  expect(host.textContent).toBe('')
})
it('every supported locale has localized step and approval text', () => {
  for (const lang of LANGS) {
    const label = clarifyText(lang, 'aiActionStep', { step: 2, total: 3, text: 'test' })
    expect(label).toContain('2/3')
    expect(label).not.toContain('{step}')
    expect(clarifyText(lang, 'aiActionApprove')).not.toBe('aiActionApprove')
  }
})
