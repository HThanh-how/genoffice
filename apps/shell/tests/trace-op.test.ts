import { describe, expect, it, vi } from 'vitest'
import { installIpcTracing, operationsSince, traceOp } from '../src/main/trace-op'
import { startLoopWatchdog } from '../src/main/fork/loop-watchdog'

describe('operation attribution', () => {
  it('retains a completed blocking child and its IPC parent until the delayed watchdog tick', () => {
    vi.useFakeTimers()
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const lines: string[] = []
    const stop = startLoopWatchdog({ write: (line) => lines.push(line), profile: false })
    traceOp(
      'kb:search',
      () =>
        traceOp(
          'file-index.snippets',
          () => {
            now += 850
          },
          { queryLength: 4, resultCount: 50 },
        ),
      { kind: 'ipc' },
    )
    vi.advanceTimersByTime(50)
    const ops = JSON.parse(lines[0]!).operations
    expect(ops.map((op) => op.label)).toContain('file-index.snippets')
    expect(ops.map((op) => op.label)).toContain('kb:search')
    expect(JSON.stringify(ops)).not.toContain('queryText')
    stop()
    clock.mockRestore()
    vi.useRealTimers()
  })

  it('keeps concurrent async chains separate and cleans up on rejection', async () => {
    const start = performance.now()
    let release!: () => void
    const pending = traceOp(
      'request-a',
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    await traceOp('request-b', async () => {
      expect(
        operationsSince(start)
          .filter((op) => op.active)
          .map((op) => op.label),
      ).toEqual(expect.arrayContaining(['request-a', 'request-b']))
      await expect(
        traceOp('throws', async () => {
          throw new Error('test')
        }),
      ).rejects.toThrow('test')
    })
    release()
    await pending
    expect(operationsSince(start).filter((op) => op.active)).toEqual([])
  })

  it('preserves generic dispatch return values and errors without inspecting arguments', () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipc = { handle: vi.fn((channel, handler) => handlers.set(channel, handler)) }
    installIpcTracing(ipc)
    ipc.handle('test:channel', () => 42)
    expect(handlers.get('test:channel')!()).toBe(42)
    ipc.handle('test:error', () => {
      throw new Error('original')
    })
    expect(() => handlers.get('test:error')!()).toThrow('original')
  })
})
