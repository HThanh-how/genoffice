import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { installLifecycleLogging } from '../src/main/diagnostics/lifecycle'

function setup(extra: Partial<Parameters<typeof installLifecycleLogging>[0]> = {}) {
  const app = Object.assign(new EventEmitter(), { getVersion: () => '1.0.0' })
  const proc = new EventEmitter()
  const entries: Array<{ level: string; cat: string; ev: string; data?: any }> = []
  const mk = (level: string) => (cat: string, ev: string, data?: unknown) =>
    void entries.push({ level, cat, ev, data })
  const sink = { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') }
  const dispose = installLifecycleLogging({
    app,
    proc,
    sink,
    setInterval: (() => 0) as any,
    clearInterval: (() => undefined) as any,
    ...extra,
  })
  return { app, proc, entries, dispose }
}

describe('lifecycle logging', () => {
  it('records renderer and child process crashes', () => {
    const { app, entries } = setup()
    app.emit('render-process-gone', {}, { id: 7 }, { reason: 'crashed', exitCode: 139 })
    app.emit('child-process-gone', {}, { type: 'GPU', reason: 'launch-failed', exitCode: 1 })
    expect(entries).toEqual([
      {
        level: 'error',
        cat: 'app',
        ev: 'render-process-gone',
        data: { wc: 7, reason: 'crashed', exitCode: 139 },
      },
      {
        level: 'error',
        cat: 'app',
        ev: 'child-process-gone',
        data: expect.objectContaining({ type: 'GPU', reason: 'launch-failed' }),
      },
    ])
  })

  it('records unresponsive and responsive of every web contents, with the hang time', () => {
    const { app, entries } = setup()
    const wc = Object.assign(new EventEmitter(), { id: 3 })
    app.emit('web-contents-created', {}, wc)
    wc.emit('unresponsive')
    wc.emit('responsive')
    expect(entries.map((e) => e.ev)).toEqual(['unresponsive', 'responsive'])
    expect(entries[1]!.data.wc).toBe(3)
    expect(typeof entries[1]!.data.hungMs).toBe('number')
    wc.emit('destroyed')
    expect(wc.listenerCount('unresponsive')).toBe(0)
  })

  it('also watches web contents that existed before the hooks were installed', () => {
    const early = Object.assign(new EventEmitter(), { id: 1 })
    const { entries } = setup({ existingWebContents: () => [early] })
    early.emit('unresponsive')
    expect(entries.map((e) => e.ev)).toEqual(['unresponsive'])
  })

  it('writes the queue to disk at once on a crash and when quitting', () => {
    let flushes = 0
    const { app, proc } = setup({ flushSync: () => void flushes++ })
    proc.emit('uncaughtExceptionMonitor', new Error('x'), 'uncaughtException')
    app.emit('before-quit')
    app.emit('will-quit')
    expect(flushes).toBe(3)
  })

  it('records uncaught exceptions and unhandled rejections without leaking secrets', () => {
    const { proc, entries } = setup()
    const original = console.error
    console.error = () => undefined
    try {
      proc.emit(
        'uncaughtExceptionMonitor',
        new Error('bad Bearer abcdefghijklmnop1234'),
        'uncaughtException',
      )
      proc.emit('unhandledRejection', new Error('rejected'))
    } finally {
      console.error = original
    }
    expect(entries.map((e) => [e.level, e.ev])).toEqual([
      ['error', 'uncaughtException'],
      ['error', 'unhandledRejection'],
    ])
    expect(JSON.stringify(entries)).not.toContain('abcdefghijklmnop1234')
  })

  it('records the quit sequence', () => {
    const { app, entries } = setup()
    app.emit('before-quit')
    app.emit('will-quit')
    app.emit('quit', {}, 0)
    expect(entries.map((e) => e.ev)).toEqual(['before-quit', 'will-quit', 'quit'])
  })

  it('samples memory: debug when steady, info on a step, warn above the limit', () => {
    let tick: (() => void) | undefined
    let rss = 100 * 1024 * 1024
    const { entries } = setup({
      setInterval: ((fn: () => void) => ((tick = fn), 1)) as any,
      memoryWarnBytes: 1000 * 1024 * 1024,
      memoryStepBytes: 200 * 1024 * 1024,
      sample: () => ({ rss, heapUsed: 1, external: 1 }),
    })
    tick!() // 100 MB vs the 0 baseline: the first line is an info
    tick!() // steady
    rss = 400 * 1024 * 1024
    tick!() // +300 MB: a step
    rss = 1200 * 1024 * 1024
    tick!() // over the limit
    expect(entries.map((e) => [e.level, e.ev])).toEqual([
      ['info', 'memory'],
      ['debug', 'memory'],
      ['info', 'memory'],
      ['warn', 'memory.high'],
    ])
  })

  it('removes every listener on dispose', () => {
    const { app, proc, dispose } = setup()
    dispose()
    expect(app.eventNames()).toEqual([])
    expect(proc.eventNames()).toEqual([])
  })
})
