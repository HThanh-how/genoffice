import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { diagHook, newReqId, observeChild, setDiagSink, type DiagSink } from '../src/diag-hook'

function sink(): {
  entries: Array<{ level: string; cat: string; ev: string; data: any }>
  sink: DiagSink
} {
  const entries: Array<{ level: string; cat: string; ev: string; data: any }> = []
  const mk = (level: string) => (cat: string, ev: string, data?: unknown) =>
    void entries.push({ level, cat, ev, data })
  return { entries, sink: { info: mk('info'), warn: mk('warn'), error: mk('error') } }
}

class FakeChild extends EventEmitter {
  pid: number | undefined
  constructor(pid?: number) {
    super()
    this.pid = pid
  }
}

afterEach(() => setDiagSink(undefined))

describe('the diagnostic hook', () => {
  it('does nothing without a sink, and never throws', () => {
    expect(() => diagHook.info('ai', 'x', { a: 1 })).not.toThrow()
    expect(() => observeChild(new FakeChild(1) as any, 'proc')).not.toThrow()
  })

  it('passes events to the sink once there is one', () => {
    const { entries, sink: s } = sink()
    setDiagSink(s)
    diagHook.warn('ai', 'slow', { ms: 5 })
    expect(entries).toEqual([{ level: 'warn', cat: 'ai', ev: 'slow', data: { ms: 5 } }])
  })

  it('a sink that throws does not break the caller', () => {
    setDiagSink({
      info: () => {
        throw new Error('broken sink')
      },
      warn: () => undefined,
      error: () => undefined,
    })
    expect(() => diagHook.info('a', 'b')).not.toThrow()
  })

  it('makes short ids that differ', () => {
    const a = newReqId()
    expect(a).toMatch(/^[0-9a-f]{12}$/)
    expect(newReqId()).not.toBe(a)
  })
})

describe('observeChild', () => {
  it('writes the start (with the pid) and a clean exit', () => {
    const { entries, sink: s } = sink()
    setDiagSink(s)
    const child = new FakeChild(4242)
    observeChild(child as any, 'agy-run', 'req1')
    child.emit('exit', 0, null)
    expect(entries.map((e) => [e.level, e.ev])).toEqual([
      ['info', 'spawn'],
      ['info', 'exit'],
    ])
    expect(entries[0]!.data).toMatchObject({ label: 'agy-run', reqId: 'req1', pid: 4242 })
    expect(entries[1]!.data).toMatchObject({
      label: 'agy-run',
      reqId: 'req1',
      code: 0,
      signal: null,
    })
    expect(typeof entries[1]!.data.ms).toBe('number')
  })

  it('waits for the spawn event when the pid is not there yet', () => {
    const { entries, sink: s } = sink()
    setDiagSink(s)
    const child = new FakeChild()
    observeChild(child as any, 'index-worker')
    expect(entries).toEqual([])
    child.pid = 77
    child.emit('spawn')
    expect(entries[0]!.data).toMatchObject({ label: 'index-worker', pid: 77 })
  })

  it('a failing exit code is a warning, a signal is information', () => {
    const { entries, sink: s } = sink()
    setDiagSink(s)
    const failed = new FakeChild(1)
    observeChild(failed as any, 'a')
    failed.emit('exit', 3, null)
    const killed = new FakeChild(2)
    observeChild(killed as any, 'b')
    killed.emit('exit', null, 'SIGTERM')
    const exits = entries.filter((e) => e.ev === 'exit')
    expect(exits.map((e) => e.level)).toEqual(['warn', 'info'])
    expect(exits[1]!.data.signal).toBe('SIGTERM')
  })

  it('a process that could not be started is an error with its cause', () => {
    const { entries, sink: s } = sink()
    setDiagSink(s)
    const child = new FakeChild()
    observeChild(child as any, 'codex-app-server')
    const failure = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    child.emit('error', failure)
    const error = entries.find((e) => e.level === 'error')!
    expect(error.ev).toBe('error')
    expect(error.data.err).toBe(failure)
  })

  it('does not put the command line in the log: only the label', () => {
    const { entries, sink: s } = sink()
    setDiagSink(s)
    const child = new FakeChild(5)
    observeChild(child as any, 'agy-run')
    child.emit('exit', 0, null)
    expect(JSON.stringify(entries)).not.toMatch(/--|\\\\|\/Users|\.exe/)
  })
})

describe('observeChild with a real child process', () => {
  it('writes the spawn and the exit by label, and never the command line it was started with', async () => {
    const { spawn } = await import('node:child_process')
    const { observeChild, setDiagSink } = await import('../src/diag-hook')
    const lines: Array<{ level: string; ev: string; data: any }> = []
    setDiagSink({
      info: (_c, ev, data) => void lines.push({ level: 'info', ev, data }),
      warn: (_c, ev, data) => void lines.push({ level: 'warn', ev, data }),
      error: (_c, ev, data) => void lines.push({ level: 'error', ev, data }),
    })
    try {
      const secret = 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE'
      const child = spawn(process.execPath, ['-e', 'process.exit(3)', '--', '--token', secret], {
        stdio: 'ignore',
      })
      observeChild(child, 'test-child', 'req9')
      await new Promise<void>((resolve) => child.on('exit', () => resolve()))
      await new Promise((r) => setTimeout(r, 20))
      expect(lines.map((l) => l.ev)).toEqual(['spawn', 'exit'])
      expect(lines[1]).toMatchObject({
        level: 'warn',
        data: { label: 'test-child', reqId: 'req9', code: 3 },
      })
      const all = JSON.stringify(lines)
      expect(all).not.toContain(secret)
      expect(all).not.toContain('--token')
      expect(all).not.toContain(process.execPath)
    } finally {
      setDiagSink(undefined)
    }
  })
})

describe('newReqId', () => {
  it('is short, plain hex and different every time', async () => {
    const { newReqId } = await import('../src/diag-hook')
    const ids = new Set(Array.from({ length: 2000 }, () => newReqId()))
    expect(ids.size).toBe(2000)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{12}$/)
  })
})
