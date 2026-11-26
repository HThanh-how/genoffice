import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalChatTransport } from '@genoffice/ai-provider/local'

const hosts = vi.hoisted(() => ({ spawned: [] as unknown[], autoLoad: true, autoChat: true }))
class FakeHost extends EventEmitter {
  messages: { id: string; type: string }[] = []
  postMessage(message: { id: string; type: string }): void {
    this.messages.push(message)
    if (message.type === 'shutdown') return void queueMicrotask(() => this.emit('exit', 0))
    if (message.type === 'load' && !hosts.autoLoad) return
    if (message.type === 'chat' && !hosts.autoChat) return
    queueMicrotask(() => this.emit('message', { id: message.id, type: 'done' }))
  }
  kill(): void {
    this.emit('exit', 1)
  }
}
vi.mock('electron', () => ({
  app: { getPath: () => '/virtual', getLocale: () => 'en', on: () => {} },
  utilityProcess: {
    fork: () => {
      const host = new FakeHost()
      hosts.spawned.push(host)
      return host
    },
  },
}))
let transport: LocalChatTransport
vi.mock('@genoffice/ai-provider/local', () => ({
  setLocalChatTransport: (value: LocalChatTransport) => {
    transport = value
  },
}))

const config = { apiKey: '', model: 'm' }
const request = { system: '', messages: [], tools: [], maxTokens: 1 }
const signal = new AbortController().signal
let local: typeof import('../src/local-chat')

beforeEach(async () => {
  vi.resetModules()
  hosts.spawned.length = 0
  hosts.autoLoad = true
  hosts.autoChat = true
  local = await import('../src/local-chat')
  local.registerLocalChat(async () => '/virtual/model.gguf')
})

describe('preloadLocalChat', () => {
  it('a preload and a chat started together use one host', async () => {
    await Promise.all([
      local.preloadLocalChat(config, signal),
      transport(config, request, () => {}, signal),
    ])
    expect(hosts.spawned).toHaveLength(1)
    await local.shutdownLocalChat()
  })

  it('never blocks a chat: one with other options replaces a preload still in flight', async () => {
    hosts.autoLoad = false
    const loading = local.preloadLocalChat(config, signal)
    const failed = expect(loading).rejects.toThrow()
    await vi.waitFor(() => expect(hosts.spawned).toHaveLength(1))
    hosts.autoLoad = true
    await transport({ ...config, local: { threads: 2 } }, request, () => {}, signal)
    await failed
    expect(hosts.spawned).toHaveLength(2)
    await local.shutdownLocalChat()
  })

  it('a finished preload is recreated when the options change, and only one host stays alive', async () => {
    await local.preloadLocalChat(config, signal)
    await transport({ ...config, local: { threads: 2 } }, request, () => {}, signal)
    expect(hosts.spawned).toHaveLength(2)
    const types = (i: number) => (hosts.spawned[i] as FakeHost).messages.map((m) => m.type)
    expect(types(0)).toEqual(['load', 'shutdown'])
    expect(types(1)).toEqual(['load', 'chat'])
    await local.shutdownLocalChat()
  })

  it('a preload with other options never interrupts a chat in progress', async () => {
    hosts.autoChat = false
    const chatting = transport(config, request, () => {}, signal)
    await vi.waitFor(() =>
      expect((hosts.spawned[0] as FakeHost)?.messages.at(-1)?.type).toBe('chat'),
    )
    const other = { ...config, local: { threads: 2 } }
    await expect(local.preloadLocalChat(other, signal)).rejects.toThrow('busy')
    const host = hosts.spawned[0] as FakeHost
    host.emit('message', { id: host.messages.at(-1)!.id, type: 'done' })
    await chatting
    expect(hosts.spawned).toHaveLength(1)
    await local.shutdownLocalChat()
  })

  it('many preloads and a chat at once still use one host', async () => {
    const preloads = Array.from({ length: 5 }, () => local.preloadLocalChat(config, signal))
    await Promise.all([...preloads, transport(config, request, () => {}, signal)])
    expect(hosts.spawned).toHaveLength(1)
    await local.shutdownLocalChat()
  })

  it('cancelling a chat does not end a preload, and the next chat uses the same host', async () => {
    hosts.autoLoad = false
    const failure = vi.fn(async (_error: unknown) => {})
    local.registerLocalChat(undefined, failure)
    const loading = local.preloadLocalChat(config, signal)
    await vi.waitFor(() => expect(hosts.spawned).toHaveLength(1))
    const host = hosts.spawned[0] as FakeHost
    const abort = new AbortController()
    const working = vi.fn()
    const chatting = transport(config, request, working, abort.signal)
    await vi.waitFor(() => expect(working).toHaveBeenCalled())
    abort.abort()
    await expect(chatting).rejects.toMatchObject({ code: 'ABORTED' })
    host.emit('message', { id: host.messages[0].id, type: 'done' })
    expect(await loading).toBe(true)
    await transport(config, request, () => {}, signal)
    expect(hosts.spawned).toHaveLength(1)
    expect(host.messages.map((m) => m.type)).toEqual(['load', 'chat'])
    expect(failure.mock.calls.map(([e]) => (e as { code: string }).code)).toEqual(['ABORTED'])
    await local.shutdownLocalChat()
  })

  it('a failed preload leaves the next chat working', async () => {
    hosts.autoLoad = false
    const loading = local.preloadLocalChat(config, signal)
    const failed = expect(loading).rejects.toThrow()
    await vi.waitFor(() => expect(hosts.spawned).toHaveLength(1))
    ;(hosts.spawned[0] as FakeHost).emit('exit', 139)
    await failed
    hosts.autoLoad = true
    await expect(transport(config, request, () => {}, signal)).resolves.toBeUndefined()
    await local.shutdownLocalChat()
  })

  it('does nothing once the app is quitting', async () => {
    await expect(local.preloadLocalChat(config, AbortSignal.abort())).rejects.toThrow()
    expect(hosts.spawned).toHaveLength(0)
  })
})

describe('followLocalModel', () => {
  it('reports until the end, then stops listening; nothing to follow without a manager', async () => {
    expect(local.followLocalModel(() => {})).toBeUndefined()
    let tell!: (line: { text: string; end?: 'ready' | 'failed' }) => void
    const off = vi.fn()
    local.registerLocalChat(undefined, undefined, undefined, (listener) => {
      tell = listener
      tell({ text: '80%' })
      return off
    })
    const lines: string[] = []
    local.followLocalModel(({ text }) => lines.push(text))
    tell({ text: '81%' })
    tell({ text: 'Ready', end: 'ready' })
    tell({ text: 'late' })
    expect(lines).toEqual(['80%', '81%', 'Ready'])
    await Promise.resolve()
    expect(off).toHaveBeenCalledOnce()
  })
})
