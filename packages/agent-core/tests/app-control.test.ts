import { describe, expect, it, vi } from 'vitest'
import {
  AppActionRegistry,
  createAppControlSkill,
  needsAppApproval,
  parseAppControl,
  type AppActionBridge,
} from '../src/app-control'
import { createAppActionPreload } from '../src/app-action-preload'

describe('app control allowlist', () => {
  it.each(['credentials', 'apiKey', 'cliPath', '__proto__', 'providers', 'saveDir'])(
    'rejects %s for reads and writes',
    (key) => {
      expect(() => parseAppControl('get_setting', { key })).toThrow()
      expect(() => parseAppControl('set_setting', { key, value: 'secret' })).toThrow()
    },
  )
  it.each([
    ['app_action', { id: 'eval', args: {} }],
    ['app_action', { id: 'print', args: { selector: 'body' } }],
    ['app_action', { id: 'open-settings', args: { pane: 'credentials' } }],
    ['app_action', { id: 'new-chat', teach: 'yes' }],
    ['set_setting', { key: 'theme', value: 'purple' }],
    ['set_setting', { key: 'language', value: 'invalid' }],
    ['get_setting', { key: 'theme', path: 'elsewhere' }],
  ])('rejects malformed %s', (kind, input) =>
    expect(() => parseAppControl(kind as string, input)).toThrow(),
  )
  it('requires approval for print, export and every settings write', () => {
    for (const id of ['print', 'export-pdf'])
      expect(needsAppApproval(parseAppControl('app_action', { id }))).toBe(true)
    for (const key of ['language', 'theme', 'default-model'])
      expect(
        needsAppApproval(
          parseAppControl('set_setting', {
            key,
            value: key === 'language' ? 'vi' : key === 'theme' ? 'dark' : 'configured-model',
          }),
        ),
      ).toBe(true)
    expect(needsAppApproval(parseAppControl('app_action', { id: 'open-index-screen' }))).toBe(false)
  })
  it('rejects duplicate registration and unknown command IDs', () => {
    const registry = new AppActionRegistry()
    const command = {
      id: 'print',
      label: 'print',
      risk: 'confirm' as const,
      teach: false,
      steps: [],
      run: vi.fn(),
    }
    registry.register(command)
    expect(() => registry.register(command)).toThrow('Duplicate')
    expect(() => registry.get('unknown')).toThrow('Unregistered')
    expect(registry.ids()).toEqual(['print'])
  })
})

function setup(approved = true) {
  const bridge: AppActionBridge = {
    prepare: vi.fn(async () => 'ticket'),
    execute: vi.fn(async () => ({ status: 'handoff' as const })),
    cancel: vi.fn(),
    onRequest: vi.fn(),
    onCancel: vi.fn(() => vi.fn()),
  }
  const confirm = vi.fn(async () => approved)
  return { bridge, confirm, skill: createAppControlSkill({ bridge, confirm }) }
}
describe('approval and target capture', () => {
  const print = { id: 'call', name: 'app_action', input: { id: 'print' } }
  it('captures before approval, executes only after it and preserves handoff', async () => {
    const { skill, confirm, bridge } = setup()
    const result = await skill.executeTool(print)
    expect(vi.mocked(bridge.prepare).mock.invocationCallOrder[0]).toBeLessThan(
      confirm.mock.invocationCallOrder[0]!,
    )
    expect(confirm.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(bridge.execute).mock.invocationCallOrder[0]!,
    )
    expect(result.output).toBe('{"status":"handoff"}')
  })
  it('denial releases the ticket without executing', async () => {
    const { skill, bridge } = setup(false)
    expect((await skill.executeTool(print)).output).toContain('cancelled')
    expect(bridge.execute).not.toHaveBeenCalled()
    expect(bridge.cancel).toHaveBeenCalledWith('ticket')
  })
  it('invalid inputs never prepare a ticket or display an approval', async () => {
    const { skill, bridge, confirm } = setup()
    expect((await skill.executeTool({ ...print, input: { id: 'eval' } })).isError).toBe(true)
    expect(bridge.prepare).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })
  it('a renderer invalidation aborts its pending approval', async () => {
    const { bridge } = setup()
    let invalidate: (id: string) => void = () => {}
    bridge.onCancel = vi.fn((handler) => {
      invalidate = handler
      return vi.fn()
    })
    const confirm = vi.fn(
      (_input, signal?: AbortSignal) =>
        new Promise<boolean>((resolve) =>
          signal?.addEventListener('abort', () => resolve(false), { once: true }),
        ),
    )
    const skill = createAppControlSkill({ bridge, confirm })
    const result = skill.executeTool(print)
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled())
    invalidate('ticket')
    expect((await result).output).toContain('cancelled')
    expect(bridge.execute).not.toHaveBeenCalled()
  })
  it('a stop arriving during prepare cannot execute', async () => {
    const { skill, bridge } = setup()
    const controller = new AbortController()
    bridge.prepare = vi.fn(async () => {
      controller.abort()
      return 'ticket'
    })
    expect((await skill.executeTool(print, controller.signal)).output).toContain('cancelled')
    expect(bridge.execute).not.toHaveBeenCalled()
  })
})

it('Docs preload awaits completion on menu:command and ignores ordinary menu events', async () => {
  const listeners = new Map<string, (...args: any[]) => unknown>()
  const port = {
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn((channel, listener) => listeners.set(channel, listener)),
    removeListener: vi.fn(),
  }
  const bridge = createAppActionPreload(port, true)
  let finish!: (result: { status: 'completed' }) => void
  const handler = vi.fn(
    () =>
      new Promise<{ status: 'completed' }>((resolve) => {
        finish = resolve
      }),
  )
  const remove = bridge.onRequest(['export-pdf'], handler)
  await listeners.get('menu:command')!({}, 'print')
  expect(handler).not.toHaveBeenCalled()
  const work = listeners.get('menu:command')!({}, 'export-pdf', undefined, {
    requestId: 'r',
    input: parseAppControl('app_action', { id: 'export-pdf' }),
  })
  expect(port.send).not.toHaveBeenCalledWith('app-action:ack', expect.anything(), expect.anything())
  finish({ status: 'completed' })
  await work
  expect(port.send).toHaveBeenCalledWith('app-action:ack', 'r', { status: 'completed' })
  remove()
  expect(port.removeListener).toHaveBeenCalled()
})
