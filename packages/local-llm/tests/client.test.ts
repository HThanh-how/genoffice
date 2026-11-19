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
