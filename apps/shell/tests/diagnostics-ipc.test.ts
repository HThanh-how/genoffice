import { describe, expect, it } from 'vitest'
import { defaultWaitsForUser, installIpcLogging } from '../src/main/diagnostics/ipc-logging'

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

  it('logs a call that never answers once, while it is still running, and its total when it ends', async () => {
    const ipc = fakeIpc()
    const { entries, sink } = sinkOf()
    let t = 0
    let sweep: (() => void) | undefined
    installIpcLogging(ipc, () => sink, {
      pendingMs: 10_000,
      now: () => t,
      setInterval: ((fn: () => void) => ((sweep = fn), 1)) as any,
      clearInterval: (() => undefined) as any,
    })
    let finish: () => void = () => undefined
    ipc.handle('ai:chat', () => new Promise<void>((resolve) => (finish = resolve)))
    const call = ipc.handlers.get('ai:chat')!({}, 'secret prompt')
    t = 5_000
    sweep!()
    expect(entries).toHaveLength(0)
    t = 12_000
    sweep!()
    sweep!() // reported once only
    expect(entries.map((e) => [e.ev, e.data])).toEqual([
      ['handler.pending', { channel: 'ai:chat', ageMs: 12_000 }],
    ])
    t = 70_000
    finish()
    await call
    await Promise.resolve()
    expect(entries.map((e) => e.ev)).toEqual(['handler.pending', 'handler.slow'])
    expect(entries[1]!.data).toEqual({ channel: 'ai:chat', ms: 70_000 })
    expect(JSON.stringify(entries)).not.toContain('secret')
  })

  it('stops the sweeper when nothing is in flight', async () => {
    const ipc = fakeIpc()
    const { sink } = sinkOf()
    let started = 0
    let cleared = 0
    installIpcLogging(ipc, () => sink, {
      setInterval: (() => ++started) as any,
      clearInterval: (() => void cleared++) as any,
    })
    ipc.handle('a', async () => 1)
    await ipc.handlers.get('a')!({})
    await Promise.resolve()
    expect([started, cleared]).toEqual([1, 1])
  })

  it('does not report calls that wait for a person as slow or pending', async () => {
    const ipc = fakeIpc()
    const { entries, sink } = sinkOf()
    let t = 0
    installIpcLogging(ipc, () => sink, { now: () => t, setInterval: (() => 1) as any })
    ipc.handle('home:browse', async () => {
      t += 60_000
    })
    ipc.handle('home:scan-document-folder', async () => {
      t += 60_000
    })
    await ipc.handlers.get('home:browse')!({})
    await ipc.handlers.get('home:scan-document-folder')!({})
    await Promise.resolve()
    expect(entries).toEqual([])
  })

  it('knows the dialogs of this app by name, and does not mistake prompts for them', () => {
    for (const channel of [
      'home:folder-root-add',
      'integrations:save-skill-zip',
      'home:import-opening-html',
    ])
      expect(defaultWaitsForUser(channel)).toBe(true)
    for (const channel of [
      'home:get-legacy-import-prompt',
      'home:set-legacy-import-prompt',
      'ai:chat',
    ])
      expect(defaultWaitsForUser(channel)).toBe(false)
  })

  it('still reports the failure of a call that waits for a person', async () => {
    const ipc = fakeIpc()
    const { entries, sink } = sinkOf()
    installIpcLogging(ipc, () => sink)
    ipc.handle('home:browse', async () => {
      throw new Error('no dialog')
    })
    await expect(ipc.handlers.get('home:browse')!({})).rejects.toThrow('no dialog')
    await Promise.resolve()
    expect(entries.map((e) => e.ev)).toEqual(['handler.failed'])
  })
})
