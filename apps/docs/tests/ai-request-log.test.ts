import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiRequestLog, messageStats, SILENT_STEP_MS } from '../src/main/ai-request-log'

type Line = { level: string; ev: string; data: any }
const make = () => {
  const lines: Line[] = []
  const sink = {
    info: (_c: string, ev: string, data?: unknown) => void lines.push({ level: 'info', ev, data }),
    warn: (_c: string, ev: string, data?: unknown) => void lines.push({ level: 'warn', ev, data }),
    error: (_c: string, ev: string, data?: unknown) =>
      void lines.push({ level: 'error', ev, data }),
  }
  return { lines, sink }
}
const start = (sink: ReturnType<typeof make>['sink'], messages: unknown = [{ text: 'hello' }]) =>
  new AiRequestLog(
    { reqId: 'r1', provider: 'agy', model: 'm', messages, tools: [{}, {}], maxTokens: 100 },
    { sink },
  )
const silent = (lines: Line[]) => lines.filter((l) => l.ev === 'request.silent')

describe('AiRequestLog', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reports the start with counts only, never the text', () => {
    const { lines, sink } = make()
    start(sink, [{ text: 'secret prompt' }, { role: 'x' }, null, 7]).dispose()
    expect(lines[0]).toMatchObject({
      ev: 'request.start',
      data: { reqId: 'r1', messages: 4, chars: 13, tools: 2 },
    })
    expect(JSON.stringify(lines)).not.toContain('secret')
  })

  it('does not throw when the renderer sent messages that are not an array of objects', () => {
    const { lines, sink } = make()
    for (const bad of [undefined, null, 'x', 5, { length: 3 }, [undefined], [null, 1, 'a']]) {
      expect(() => start(sink, bad).dispose()).not.toThrow()
    }
    expect(messageStats(undefined)).toEqual({ messages: 0, chars: 0 })
    expect(messageStats([undefined, 'a'])).toEqual({ messages: 2, chars: 0 })
    expect(lines.filter((l) => l.ev === 'request.start')).toHaveLength(7)
  })

  it('keeps going when the sink throws', () => {
    const sink = {
      info: () => {
        throw new Error('broken')
      },
      warn: () => {
        throw new Error('broken')
      },
      error: () => {
        throw new Error('broken')
      },
    }
    const log = start(sink)
    expect(() => {
      log.text()
      vi.advanceTimersByTime(SILENT_STEP_MS * 3)
      log.end('stop')
      log.failed(new Error('x'))
      log.aborted()
      log.dispose()
    }).not.toThrow()
  })

  it('says "alive but quiet" at 30, 60 and 120 s, at info level, while a heartbeat arrives every 5 s (the one-shot CLI)', () => {
    const { lines, sink } = make()
    const log = start(sink)
    for (let s = 5; s <= 140; s += 5) {
      vi.advanceTimersByTime(5_000)
      log.wire() // the heartbeat
    }
    expect(silent(lines)).toHaveLength(0) // not a warning: bytes are arriving
    const quiet = lines.filter((l) => l.ev === 'request.quiet')
    expect(quiet.map((l) => l.level)).toEqual(['info', 'info', 'info'])
    expect(quiet.map((l) => Math.round(l.data.silentContentMs / 30_000))).toEqual([1, 2, 4])
    expect(quiet[2]!.data.silentWireMs).toBeLessThanOrEqual(5_000)
    expect(quiet[0]!.data).toMatchObject({ stage: 'before-first-text', provider: 'agy' })
    log.dispose()
  })

  it('warns at 30, 60, 90 and 120 s when nothing at all arrives, not even a heartbeat', () => {
    const { lines, sink } = make()
    const log = start(sink)
    vi.advanceTimersByTime(140_000)
    const reports = silent(lines)
    expect(reports.map((l) => l.level)).toEqual(['warn', 'warn', 'warn', 'warn'])
    expect(reports.map((l) => Math.floor(l.data.silentContentMs / 30_000))).toEqual([1, 2, 3, 4])
    expect(reports[3]!.data.silentWireMs).toBeGreaterThanOrEqual(120_000)
    expect(lines.filter((l) => l.ev === 'request.quiet')).toHaveLength(0)
    log.dispose()
  })

  it('goes from quiet to silent when the heartbeat stops', () => {
    const { lines, sink } = make()
    const log = start(sink)
    for (let s = 5; s <= 60; s += 5) {
      vi.advanceTimersByTime(5_000)
      log.wire()
    }
    vi.advanceTimersByTime(90_000) // then nothing
    expect(lines.filter((l) => l.ev === 'request.quiet').length).toBeGreaterThanOrEqual(1)
    expect(silent(lines).length).toBeGreaterThanOrEqual(1)
    log.dispose()
  })

  it('is quiet while content keeps arriving, and starts counting again after it', () => {
    const { lines, sink } = make()
    const log = start(sink)
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(10_000)
      log.text()
    }
    expect(silent(lines)).toHaveLength(0)
    vi.advanceTimersByTime(60_000)
    expect(silent(lines).length).toBeGreaterThanOrEqual(1)
    expect(silent(lines)[0]!.data.stage).toBe('streaming')
    const before = silent(lines).length
    log.toolCall() // content again: the count starts over
    vi.advanceTimersByTime(20_000)
    expect(silent(lines)).toHaveLength(before)
    log.dispose()
  })

  it('writes the first text once, the end with its counts, and stops the timer', () => {
    const { lines, sink } = make()
    const log = start(sink)
    vi.advanceTimersByTime(1_500)
    log.text()
    log.text()
    log.toolCall()
    log.end('end_turn')
    log.dispose()
    expect(lines.filter((l) => l.ev === 'request.first-text')).toHaveLength(1)
    expect(lines.find((l) => l.ev === 'request.first-text')!.data.ms).toBe(1500)
    expect(lines.find((l) => l.ev === 'request.end')!.data).toMatchObject({
      deltas: 2,
      toolCalls: 1,
      stopReason: 'end_turn',
      firstTextMs: 1500,
    })
    const count = lines.length
    vi.advanceTimersByTime(600_000)
    expect(lines).toHaveLength(count) // disposed: no more silence lines
    expect(vi.getTimerCount()).toBe(0)
  })

  it('records a failure with the error object for the logger to redact', () => {
    const { lines, sink } = make()
    const log = start(sink)
    const err = new Error('nope')
    log.failed(err)
    log.dispose()
    expect(lines.find((l) => l.ev === 'request.failed')!.data.err).toBe(err)
  })
})
