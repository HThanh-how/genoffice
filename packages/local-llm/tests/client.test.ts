import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalLlmClient, type HostProcess } from '../src/client'
import { type HostRequest, type HostEvent } from '../src/protocol'

class FakeHost extends EventEmitter implements HostProcess {
  messages: HostRequest[] = []
  autoLoad = true
  autoChat = true
  autoExit = true
  autoAbort = true
  kills = 0
  postMessage(message: HostRequest): void {
    this.messages.push(message)
    if (message.type === 'load' && !this.autoLoad) return
    if (message.type === 'chat' && !this.autoChat) return
    if (message.type === 'shutdown') {
      if (this.autoExit) queueMicrotask(() => this.emit('exit', 0))
      return
    }
    if (message.type === 'abort') {
      if (!this.autoAbort) return
      this.emit('message', {
        id: message.requestId,
        type: 'error',
        code: 'ABORTED',
        message: 'cancelled',
      } satisfies HostEvent)
      return
    }
    queueMicrotask(() => this.emit('message', { id: message.id, type: 'done' } satisfies HostEvent))
  }
  kill(): void {
    this.kills++
    this.emit('exit', 1)
  }
}
const request = {
  system: 'system',
  messages: [{ role: 'user' as const, text: 'xin chào' }],
  tools: [],
  maxTokens: 10,
}
afterEach(() => vi.useRealTimers())
describe('LocalLlmClient', () => {
  it('terminates a stalled native decode after abort grace and shutdown timeout', async () => {
    vi.useFakeTimers()
    const host = new FakeHost()
    host.autoChat = false
    host.autoAbort = false
    host.autoExit = false
    const client = new LocalLlmClient(() => host, 'model', {}, 50)
    const abort = new AbortController()
    const running = client.chat(request, () => {}, abort.signal)
    const rejected = expect(running).rejects.toMatchObject({ code: 'ABORTED' })
    await vi.advanceTimersByTimeAsync(0)
    abort.abort()
    await vi.advanceTimersByTimeAsync(2050)
    await rejected
    expect(host.kills).toBe(1)
    expect(client.state).toBe('STOPPED')
  })
  it('loads lazily, stays hot, unloads only when idle, and starts after awaited shutdown', async () => {
    vi.useFakeTimers()
    const hosts: FakeHost[] = []
    const client = new LocalLlmClient(
      () => {
        const host = new FakeHost()
        hosts.push(host)
        return host
      },
      'model',
      { keepHotMinutes: 1 },
    )
    expect(hosts).toHaveLength(0)
    await client.chat(request, () => {})
    expect(client.state).toBe('IDLE')
    hosts[0].autoChat = false
    const running = client.chat(request, () => {})
    await vi.advanceTimersByTimeAsync(61_000)
    expect(client.state).toBe('BUSY')
    expect(hosts[0].messages.some((m) => m.type === 'unload')).toBe(false)
    const chat = hosts[0].messages.filter((m) => m.type === 'chat').at(-1)!
    hosts[0].emit('message', { id: chat.id, type: 'done' })
    await running
    await vi.advanceTimersByTimeAsync(60_000)
    expect(hosts[0].messages.some((m) => m.type === 'unload')).toBe(true)
    await client.shutdown()
    await client.chat(request, () => {})
    expect(hosts).toHaveLength(2)
    await client.shutdown()
  })
  it('preloads once, shares the load with a chat that arrives meanwhile, and does not count as busy', async () => {
    const host = new FakeHost()
    const spawn = vi.fn(() => host)
    const client = new LocalLlmClient(spawn, 'model')
    const loading = client.preload()
    expect(client.state).toBe('STARTING')
    expect(client.busy).toBe(false)
    const chatting = client.chat(request, () => {})
    expect(client.busy).toBe(true)
    await Promise.all([loading, chatting])
    await client.preload()
    expect(spawn).toHaveBeenCalledOnce()
    expect(host.messages.filter((m) => m.type === 'load')).toHaveLength(1)
    await client.shutdown()
  })
  it('unloads a preloaded model nobody talks to, and skips preloading without a warm time', async () => {
    vi.useFakeTimers()
    const host = new FakeHost()
    const client = new LocalLlmClient(() => host, 'model', { keepHotMinutes: 1 })
    await client.preload()
    expect(client.state).toBe('READY')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.messages.some((m) => m.type === 'unload')).toBe(true)
    await client.shutdown()
    const spawn = vi.fn(() => new FakeHost())
    await new LocalLlmClient(spawn, 'model', { keepHotMinutes: 0 }).preload()
    expect(spawn).not.toHaveBeenCalled()
  })
  it('chats normally after a preload that crashed', async () => {
    const hosts: FakeHost[] = []
    const client = new LocalLlmClient(() => {
      const host = new FakeHost()
      host.autoLoad = hosts.length > 0
      hosts.push(host)
      return host
    }, 'model')
    const loading = client.preload()
    hosts[0].emit('exit', 139)
    await expect(loading).rejects.toMatchObject({ code: 'NATIVE_CRASH' })
    expect(client.state).toBe('STOPPED')
    await client.chat(request, () => {})
    expect(hosts).toHaveLength(2)
    await client.shutdown()
  })
  it('reports the real load steps, also to a chat that joins late', async () => {
    const host = new FakeHost()
    host.autoLoad = false
    const client = new LocalLlmClient(() => host, 'model')
    const preloadSteps: unknown[] = []
    const loading = client.preload((p) => preloadSteps.push(p))
    const load = host.messages.find((m) => m.type === 'load')!
    const say = (event: object) => host.emit('message', { id: load.id, ...event })
    say({ type: 'phase', phase: 'loading', percent: 40 })
    const chatSteps: unknown[] = []
    const chatting = client.chat(request, (e) => {
      if (e.type === 'phase') chatSteps.push([e.phase, e.percent])
    })
    say({ type: 'phase', phase: 'preparing' })
    say({ type: 'done' })
    expect(await loading).toBe(true)
    await chatting
    expect(preloadSteps).toEqual([
      { phase: 'starting' },
      { phase: 'loading', percent: 40 },
      { phase: 'preparing' },
    ])
    expect(chatSteps).toEqual([
      ['loading', 40],
      ['preparing', undefined],
    ])
    await client.shutdown()
  })
  it('aborts native generation and rejects parallel callers', async () => {
    const host = new FakeHost()
    host.autoChat = false
    const client = new LocalLlmClient(() => host, 'model')
    const abort = new AbortController()
    const running = client.chat(request, () => {}, abort.signal)
    await vi.waitFor(() => expect(client.state).toBe('BUSY'))
    await expect(client.chat(request, () => {})).rejects.toMatchObject({ code: 'BUSY' })
    abort.abort()
    await expect(running).rejects.toMatchObject({ code: 'ABORTED' })
    expect(host.messages.some((m) => m.type === 'abort')).toBe(true)
    await client.shutdown()
  })
  it('waits for exit, force kills after timeout, and shares concurrent shutdowns', async () => {
    vi.useFakeTimers()
    const host = new FakeHost()
    host.autoExit = false
    const client = new LocalLlmClient(() => host, 'model', {}, 50)
    await client.chat(request, () => {})
    let exited = false
    const stopping = client.shutdown().then(() => {
      exited = true
    })
    expect(client.state).toBe('STOPPING')
    await vi.advanceTimersByTimeAsync(49)
    expect(exited).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await stopping
    expect(host.kills).toBe(1)
    expect(client.state).toBe('STOPPED')
  })
  it('cancels during STARTING and does not spawn a late host', async () => {
    const host = new FakeHost()
    host.autoLoad = false
    const client = new LocalLlmClient(() => host, 'model')
    const abort = new AbortController()
    const running = client.chat(request, () => {}, abort.signal)
    expect(client.state).toBe('STARTING')
    abort.abort()
    await expect(running).rejects.toMatchObject({ code: 'ABORTED' })
    expect(client.state).toBe('STOPPED')
    host.autoLoad = true
    await client.chat(request, () => {})
    await client.shutdown()
  })
  it.each(['preload', 'chat'])(
    'cancelling a chat leaves a preload running that shares its load (%s came first)',
    async (first) => {
      const host = new FakeHost()
      host.autoLoad = false
      const spawn = vi.fn(() => host)
      const client = new LocalLlmClient(spawn, 'model')
      const abort = new AbortController()
      const preloadSteps: string[] = []
      const chatSteps: string[] = []
      const preload = () => client.preload((p) => preloadSteps.push(p.phase))
      const chat = () =>
        client.chat(
          request,
          (e) => {
            if (e.type === 'phase') chatSteps.push(e.phase)
          },
          abort.signal,
        )
      const early = first === 'preload' ? preload() : undefined
      const chatting = chat()
      const loading = early ?? preload()
      abort.abort()
      // at once, not when the load is over: the user may send again
      await expect(chatting).rejects.toMatchObject({ code: 'ABORTED' })
      expect(client.busy).toBe(false)
      expect(client.state).toBe('STARTING')
      const load = host.messages.find((m) => m.type === 'load')!
      host.emit('message', { id: load.id, type: 'phase', phase: 'preparing' })
      expect(preloadSteps).toEqual(['starting', 'preparing'])
      expect(chatSteps).toEqual(['starting'])
      host.emit('message', { id: load.id, type: 'done' })
      expect(await loading).toBe(true)
      expect(client.state).toBe('READY')
      expect(host.messages.map((m) => m.type)).toEqual(['load'])
      await client.chat(request, () => {})
      expect(host.messages.map((m) => m.type)).toEqual(['load', 'chat'])
      expect(spawn).toHaveBeenCalledOnce()
      await client.shutdown()
    },
  )
  it('a chat sent after the cancelled one joins the same load, and can be cancelled too', async () => {
    const host = new FakeHost()
    host.autoLoad = false
    const spawn = vi.fn(() => host)
    const client = new LocalLlmClient(spawn, 'model')
    const loading = client.preload()
    for (let i = 0; i < 2; i++) {
      const abort = new AbortController()
      const cancelled = client.chat(request, () => {}, abort.signal)
      abort.abort()
      await expect(cancelled).rejects.toMatchObject({ code: 'ABORTED' })
    }
    const chatting = client.chat(request, () => {})
    host.emit('message', { id: host.messages[0].id, type: 'done' })
    expect(await loading).toBe(true)
    await chatting
    expect(host.messages.map((m) => m.type)).toEqual(['load', 'chat'])
    expect(spawn).toHaveBeenCalledOnce()
    await client.shutdown()
  })
  it('a cancelled chat neither unloads the model early nor keeps it from being unloaded', async () => {
    vi.useFakeTimers()
    const host = new FakeHost()
    host.autoLoad = false
    const client = new LocalLlmClient(() => host, 'model', { keepHotMinutes: 1 })
    const abort = new AbortController()
    const loading = client.preload()
    const chatting = client.chat(request, () => {}, abort.signal)
    abort.abort()
    await expect(chatting).rejects.toMatchObject({ code: 'ABORTED' })
    await vi.advanceTimersByTimeAsync(50_000)
    host.emit('message', { id: host.messages[0].id, type: 'done' })
    await loading
    await vi.advanceTimersByTimeAsync(59_000)
    expect(host.messages.map((m) => m.type)).toEqual(['load'])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.messages.map((m) => m.type)).toEqual(['load', 'unload'])
    // with the preload over, a chat cancelled during its own load ends that load again
    const own = new AbortController()
    const alone = client.chat(request, () => {}, own.signal)
    expect(client.state).toBe('STARTING')
    own.abort()
    await expect(alone).rejects.toMatchObject({ code: 'ABORTED' })
    expect(client.state).toBe('STOPPED')
  })
  it('a load that really fails after the chat was cancelled still says why', async () => {
    const host = new FakeHost()
    host.autoLoad = false
    const client = new LocalLlmClient(() => host, 'model')
    const abort = new AbortController()
    const loading = client.preload()
    const chatting = client.chat(request, () => {}, abort.signal)
    abort.abort()
    await expect(chatting).rejects.toMatchObject({ code: 'ABORTED' })
    const failed = expect(loading).rejects.toMatchObject({
      code: 'INSUFFICIENT_RAM',
      message: 'At least 2.5 GiB',
    })
    host.emit('message', {
      id: host.messages[0].id,
      type: 'error',
      code: 'INSUFFICIENT_RAM',
      message: 'At least 2.5 GiB',
    })
    await failed
    expect(client.state).toBe('STOPPED')
  })
  it('reports native crash and restarts on the next turn', async () => {
    const hosts: FakeHost[] = []
    const client = new LocalLlmClient(() => {
      const h = new FakeHost()
      hosts.push(h)
      return h
    }, 'model')
    await client.chat(request, () => {})
    hosts[0].autoChat = false
    const running = client.chat(request, () => {})
    await vi.waitFor(() => expect(client.state).toBe('BUSY'))
    hosts[0].emit('exit', 139)
    await expect(running).rejects.toMatchObject({ code: 'NATIVE_CRASH' })
    await client.chat(request, () => {})
    expect(hosts).toHaveLength(2)
    await client.shutdown()
  })
})
