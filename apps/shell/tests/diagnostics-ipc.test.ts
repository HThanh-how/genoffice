import { describe, expect, it } from 'vitest'
import { installIpcLogging } from '../src/main/diagnostics/ipc-logging'

type Handler = (event: unknown, ...args: any[]) => unknown

function fakeIpc() {
  const handlers = new Map<string, Handler>()
  return {
    handlers,
    handle: ((channel: string, listener: Handler) => void handlers.set(channel, listener)) as any,
  }
}

function sinkOf() {
  const entries: Array<{ level: string; ev: string; data: any }> = []
  return {
    entries,
    sink: {
      warn: (_c: string, ev: string, data?: unknown) =>
        void entries.push({ level: 'warn', ev, data }),
      error: (_c: string, ev: string, data?: unknown) =>
        void entries.push({ level: 'error', ev, data }),
    },
  }
}

describe('IPC logging', () => {
  it('keeps return values and logs nothing for a fast call', async () => {
    const ipc = fakeIpc()
    const { entries, sink } = sinkOf()
    installIpcLogging(ipc, () => sink)
    ipc.handle('a', (_e: unknown, x: number) => x + 1)
    ipc.handle('b', async (_e: unknown, x: number) => x * 2)
    expect(ipc.handlers.get('a')!({}, 1)).toBe(2)
    await expect(ipc.handlers.get('b')!({}, 4)).resolves.toBe(8)
    expect(entries).toEqual([])
  })

  it('logs a slow call with channel and duration only', async () => {
    const ipc = fakeIpc()
    const { entries, sink } = sinkOf()
    let t = 0
    installIpcLogging(ipc, () => sink, { slowMs: 500, now: () => t })
    ipc.handle('home:check-for-updates', async () => {
      t += 800
      return 'secret result'
    })
    await ipc.handlers.get('home:check-for-updates')!({}, 'secret argument')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      level: 'warn',
      ev: 'handler.slow',
      data: { channel: 'home:check-for-updates', ms: 800 },
    })
    expect(JSON.stringify(entries)).not.toContain('secret')
  })

  it('logs every failure and rethrows the same error (sync and async)', async () => {
    const ipc = fakeIpc()
    const { entries, sink } = sinkOf()
    installIpcLogging(ipc, () => sink)
    const syncErr = new Error('sync boom')
    const asyncErr = new Error('async boom')
    ipc.handle('s', () => {
      throw syncErr
    })
    ipc.handle('p', async () => {
      throw asyncErr
    })
    expect(() => ipc.handlers.get('s')!({})).toThrow(syncErr)
    await expect(ipc.handlers.get('p')!({})).rejects.toBe(asyncErr)
    await Promise.resolve()
    expect(entries.map((e) => [e.ev, e.data.channel])).toEqual([
      ['handler.failed', 's'],
      ['handler.failed', 'p'],
    ])
    expect(entries[0]!.data.err.message).toBe('sync boom')
  })

  it('works before the logger exists and starts logging once it does', () => {
    const ipc = fakeIpc()
    const { entries, sink } = sinkOf()
    const holder: { current?: typeof sink } = {}
    installIpcLogging(ipc, () => holder.current)
    ipc.handle('x', () => {
      throw new Error('early')
    })
    expect(() => ipc.handlers.get('x')!({})).toThrow('early')
    expect(entries).toHaveLength(0)
    holder.current = sink
    expect(() => ipc.handlers.get('x')!({})).toThrow('early')
    expect(entries).toHaveLength(1)
  })

  it('a throwing logger never changes the handler outcome', async () => {
    const ipc = fakeIpc()
    installIpcLogging(
      ipc,
      () => ({
        warn: () => {
          throw new Error('logger bug')
        },
        error: () => {
          throw new Error('logger bug')
        },
      }),
      { slowMs: 0 },
    )
    ipc.handle('a', () => 5)
    // the sink failure must not leak into the caller
    expect(() => ipc.handlers.get('a')!({})).not.toThrow()
  })
})
