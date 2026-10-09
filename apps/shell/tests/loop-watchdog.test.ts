import { describe, expect, it, vi } from 'vitest'
import {
  startLoopWatchdog,
  summarizeProfile,
  type CpuProfileLike,
  type SamplingProfiler,
} from '../src/main/fork/loop-watchdog'

function profile(): CpuProfileLike {
  return {
    nodes: [
      { id: 1, callFrame: { functionName: '(idle)', url: '', lineNumber: 0 } },
      {
        id: 2,
        callFrame: {
          functionName: 'purgeDiscoveredByName',
          url: 'file:///app/out/main/index.js',
          lineNumber: 7655,
        },
      },
      {
        id: 3,
        callFrame: {
          functionName: 'enrollNew',
          url: 'C:\\app\\out\\main\\index.js',
          lineNumber: 20381,
        },
      },
    ],
    samples: [1, 2, 2, 3, 1, 2],
    timeDeltas: [1000, 5000, 5000, 2000, 9000, 3000],
  }
}

describe('summarizeProfile', () => {
  it('ranks functions by self time, leaves idle out and names file:line', () => {
    const { busyMs, top } = summarizeProfile(profile(), 2)
    expect(busyMs).toBe(15)
    expect(top).toEqual([
      { fn: 'purgeDiscoveredByName', at: 'index.js:7656', ms: 13 },
      { fn: 'enrollNew', at: 'index.js:20382', ms: 2 },
    ])
  })
})

describe('startLoopWatchdog', () => {
  function harness(options: { profiler?: SamplingProfiler | null } = {}) {
    vi.useFakeTimers()
    let clock = 0
    const lines: Array<Record<string, unknown>> = []
    const profiler: SamplingProfiler = options.profiler ?? {
      start: vi.fn(),
      stop: vi.fn(() => profile()),
    }
    const stop = startLoopWatchdog({
      write: (line) => lines.push(JSON.parse(line)),
      now: () => clock,
      thresholdMs: 200,
      sampleMs: 50,
      minGapMs: 5_000,
      windowMs: 1_000,
      profiler,
    })
    /** advance the clock by `ms` of wall time in which the loop was free except for `blockMs` consumed up front */
    const run = (ms: number, blockMs = 0): void => {
      clock += blockMs
      clock += ms
      vi.advanceTimersByTime(ms)
    }
    return { lines, run, stop, profiler, tickTo: (t: number) => (clock = t) }
  }

  it('writes nothing while the loop is smooth', () => {
    const { lines, stop, tickTo } = harness()
    for (let t = 50; t <= 5_000; t += 50) {
      tickTo(t)
      vi.advanceTimersByTime(50)
    }
    stop()
    vi.useRealTimers()
    expect(lines).toEqual([])
  })

  it('logs a stall once, rate limited, and profiles the window after the first stall', () => {
    const { lines, stop, tickTo, profiler } = harness()
    let t = 0
    const step = (ms: number): void => {
      t += ms
      tickTo(t)
      vi.advanceTimersByTime(50)
    }
    step(50)
    step(800) // first stall: 750 ms late -> logged, profile armed
    expect(lines.filter((l) => l.kind === 'main-thread-stall')).toHaveLength(1)
    expect(profiler.start).toHaveBeenCalledTimes(1)
    step(50)
    step(600) // second stall inside the rate-limit gap: counted, not logged
    expect(lines.filter((l) => l.kind === 'main-thread-stall')).toHaveLength(1)
    // the window ends (>= 1 s after arming) with stalls inside it: the profile is summarised and profiling continues
    step(1200)
    const profiles = lines.filter((l) => l.kind === 'main-thread-profile')
    expect(profiles).toHaveLength(1)
    expect((profiles[0]!.top as Array<{ fn: string }>)[0]!.fn).toBe('purgeDiscoveredByName')
    expect(profiler.start).toHaveBeenCalledTimes(2) // armed by the first stall, re-armed because the window itself saw a stall
    // later stall after the gap is logged with the number suppressed in between
    t += 6_000
    step(900)
    const stalls = lines.filter((l) => l.kind === 'main-thread-stall')
    expect(stalls.length).toBeGreaterThanOrEqual(2)
    expect(stalls.at(-1)!.suppressed).toBeGreaterThanOrEqual(1)
    stop()
    vi.useRealTimers()
  })

  it('a failing profiler never breaks the watchdog', () => {
    const profiler: SamplingProfiler = {
      start: () => {
        throw new Error('no inspector')
      },
      stop: () => null,
    }
    const { lines, tickTo, stop } = harness({ profiler })
    tickTo(900)
    vi.advanceTimersByTime(50)
    expect(lines.some((l) => l.kind === 'main-thread-stall')).toBe(true)
    stop()
    vi.useRealTimers()
  })
})
