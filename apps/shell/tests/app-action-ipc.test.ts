import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { registerAppActionIpc } from '../src/main/app-action-ipc'
import type { TabManager } from '../src/main/tab-manager'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  events: new Map<string, (...args: any[]) => any>(),
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: any[]) => any) => ipc.handlers.set(channel, fn),
    on: (channel: string, fn: (...args: any[]) => any) => ipc.events.set(channel, fn),
  },
}))
function contents(id: number) {
  return Object.assign(new EventEmitter(), { id, isDestroyed: vi.fn(() => false), send: vi.fn() })
}
const print = { kind: 'app_action', id: 'print', args: {}, teach: false }
beforeEach(() => {
  vi.useFakeTimers()
  ipc.handlers.clear()
  ipc.events.clear()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})
function setup() {
  const home = contents(1)
  const docs = contents(2)
  const tabs = [
    { id: 'home', kind: 'home', active: false },
    { id: 'doc', kind: 'docs', active: true, filePath: 'current.docx' },
  ]
  const manager = {
    list: () => tabs,
    describeWebContents: (id: number) => (id === 2 ? { kind: 'docs' } : null),
    webContentsForTab: (id: string) => (id === 'doc' ? docs : undefined),
    openHomeTab: vi.fn(),
  }
  const validate = registerAppActionIpc({
    home: () => home as unknown as WebContents,
    tabs: () => manager as unknown as TabManager,
  })
  ipc.events.get('app-action:register')!({ sender: home }, [
    'open-index-screen',
    'open-settings',
    'new-chat',
    'get_setting',
    'set_setting',
  ])
  ipc.events.get('app-action:register')!({ sender: docs }, ['print', 'export-pdf'])
  return { home, docs, manager, tabs, validate }
}
it('routes the captured Docs action over menu:command and awaits that renderer', async () => {
  const { home, docs } = setup()
  const id = ipc.handlers.get('app-action:prepare')!({ sender: home }, print)
  const promise = ipc.handlers.get('app-action:execute')!({ sender: home }, id)
  expect(docs.send).toHaveBeenCalledWith('menu:command', 'print', undefined, {
    requestId: id,
    input: print,
  })
  ipc.events.get('app-action:ack')!({ sender: home }, id, { status: 'completed' })
  ipc.events.get('app-action:ack')!({ sender: docs }, id, { status: 'handoff' })
  expect(await promise).toEqual({ status: 'handoff' })
})
it('switching tabs during approval invalidates the ticket and notifies its requester', () => {
  const { home, docs, tabs, validate } = setup()
  const id = ipc.handlers.get('app-action:prepare')!({ sender: home }, print)
  tabs[1]!.active = false
  tabs[0]!.active = true
  validate()
  expect(() => ipc.handlers.get('app-action:execute')!({ sender: home }, id)).toThrow()
  expect(docs.send).not.toHaveBeenCalledWith(
    'menu:command',
    expect.anything(),
    expect.anything(),
    expect.anything(),
  )
  expect(home.send).toHaveBeenCalledWith('app-action:cancelled', id)
})
it('renderer navigation releases an in-flight request and ignores a late ack', async () => {
  const { home, docs } = setup()
  const id = ipc.handlers.get('app-action:prepare')!({ sender: home }, print)
  const promise = ipc.handlers.get('app-action:execute')!({ sender: home }, id)
  docs.emit('did-start-navigation', {}, 'new-url', false, true)
  expect(await promise).toEqual({ status: 'cancelled' })
  ipc.events.get('app-action:ack')!({ sender: docs }, id, { status: 'completed' })
  expect(vi.getTimerCount()).toBe(0)
})
it('rejects unknown renderers, model-supplied selectors and registration of another renderer’s commands', () => {
  const { home, docs } = setup()
  expect(() => ipc.handlers.get('app-action:prepare')!({ sender: contents(99) }, print)).toThrow(
    'Unauthorized',
  )
  expect(() =>
    ipc.handlers.get('app-action:prepare')!(
      { sender: home },
      { ...print, args: { selector: 'body' } },
    ),
  ).toThrow()
  ipc.events.get('app-action:register')!({ sender: docs }, ['open-settings'])
  // An invalid replacement must not steal Home's registry.
  const id = ipc.handlers.get('app-action:prepare')!(
    { sender: docs },
    { kind: 'app_action', id: 'open-settings', args: {}, teach: false },
  )
  const promise = ipc.handlers.get('app-action:execute')!({ sender: docs }, id)
  expect(home.send).toHaveBeenCalledWith(
    'app-action:run',
    expect.objectContaining({ requestId: id }),
  )
  ipc.events.get('app-action:cancel')!({ sender: docs }, id)
  return expect(promise).resolves.toEqual({ status: 'cancelled' })
})
it('a setting read stays in the current screen and returns only scalar output', async () => {
  const { docs, home, manager } = setup()
  const id = ipc.handlers.get('app-action:prepare')!(
    { sender: docs },
    { kind: 'get_setting', key: 'theme' },
  )
  const promise = ipc.handlers.get('app-action:execute')!({ sender: docs }, id)
  expect(manager.openHomeTab).not.toHaveBeenCalled()
  ipc.events.get('app-action:ack')!({ sender: home }, id, {
    status: 'completed',
    value: 'dark',
    providers: { key: 'secret' },
  })
  expect(await promise).toEqual({ status: 'completed', value: 'dark' })
})
