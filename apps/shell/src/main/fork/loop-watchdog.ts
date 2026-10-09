import { Session } from 'node:inspector'
import { cpuUsage, memoryUsage } from 'node:process'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { getSqliteTimingSummary } from '../document-memory/sqlite-timing'
import { rotatingFileWriter } from './renderer-diagnostics'

/**
 * Always-on diagnostic for main-process stalls.
 *
 * Electron routes input, IPC and window management for every window through the main thread, so a stalled event loop
 * makes the whole app stutter while the process looks "busy" from outside. A 50 ms timer measures how late it fires;
 * when the loop was blocked for more than `thresholdMs` one line goes to a local log (rate limited, rotated, never
 * sent anywhere). To say WHAT blocked, the first stall arms a CPU profile (10 ms sampling) of the following window; stalls
 * usually recur, so the next window's profile is summarised into the functions that held the thread, and profiling
 * stays on only while stalls keep happening. Nothing runs or is written while the app is smooth (stopping a profile
 * costs ~100 ms, so a permanently rolling one would itself be a stall every window).
 */
export interface LoopWatchdogOptions {
  write: (line: string) => void
  thresholdMs?: number
  sampleMs?: number
  /** At most one stall line per this many ms; the rest are counted into the next line. */
  minGapMs?: number
  windowMs?: number
  /** Disable the rolling profile (the lag line is still written). */
  profile?: boolean
  now?: () => number
  /** Test seam: a profiler with the same two calls as the inspector session. */
  profiler?: SamplingProfiler | null
}

export interface SamplingProfiler {
  start(): void
  stop(): CpuProfileLike | null
}

export interface CpuProfileLike {
  nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number } }>
  samples?: number[]
  timeDeltas?: number[]
}

export interface ProfileTop {
  fn: string
  at: string
  ms: number
}

/** Self time per function of a CPU profile, idle excluded, largest first. Pure; shared with the tests. */
export function summarizeProfile(
  profile: CpuProfileLike,
  topN = 6,
): { busyMs: number; top: ProfileTop[] } {
  const byId = new Map(profile.nodes.map((n) => [n.id, n.callFrame]))
  const self = new Map<string, ProfileTop>()
  let busyMs = 0
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  for (let i = 0; i < samples.length; i++) {
    const frame = byId.get(samples[i]!)
    if (!frame) continue
    const ms = (deltas[i] ?? 0) / 1000
    if (frame.functionName === '(idle)') continue
    busyMs += ms
    const fn = frame.functionName || '(anonymous)'
    const at = `${frame.url.replace(/^.*[\\/]/, '')}:${frame.lineNumber + 1}`
    const key = `${fn}@${at}`
    const cur = self.get(key)
    if (cur) cur.ms += ms
    else self.set(key, { fn, at, ms })
  }
  const top = [...self.values()]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, topN)
    .map((t) => ({ ...t, ms: Math.round(t.ms) }))
  return { busyMs: Math.round(busyMs), top }
}

function inspectorProfiler(): SamplingProfiler | null {
  try {
    const session = new Session()
    session.connect()
    session.post('Profiler.enable')
    session.post('Profiler.setSamplingInterval', { interval: 10_000 })
    return {
      start: () => session.post('Profiler.start'),
      stop: () => {
        let out: CpuProfileLike | null = null
        session.post('Profiler.stop', (err, result) => {
          if (!err) out = (result as { profile: CpuProfileLike }).profile
        })
        return out
      },
    }
  } catch {
    return null
  }
}

export function startLoopWatchdog(options: LoopWatchdogOptions): () => void {
  const threshold = options.thresholdMs ?? 200
  const sampleMs = options.sampleMs ?? 50
  const minGap = options.minGapMs ?? 5_000
  const windowMs = options.windowMs ?? 15_000
  const now = options.now ?? (() => performance.now())
  const profiler =
    options.profiler !== undefined
      ? options.profiler
      : options.profile === false
        ? null
        : inspectorProfiler()

  const bootAt = now()
  let last = now()
  let lastReportAt = Number.NEGATIVE_INFINITY
  let suppressed = 0
  let windowStart = last
  let windowMax = 0
  let windowStalls = 0
  let profiling = false
  let cpuAtLast = cpuUsage()

  const safeWrite = (record: Record<string, unknown>): void => {
    try {
      options.write(JSON.stringify({ at: new Date().toISOString(), ...record }))
    } catch {
      // a diagnostic must never get in the way of the app
    }
  }

  const startWindow = (): void => {
    windowStart = now()
    windowMax = 0
    windowStalls = 0
    if (!profiler || profiling) return
    try {
      profiler.start()
      profiling = true
    } catch {
      profiling = false
    }
  }

  /** Ends the profiled window; keeps profiling only if the window itself saw stalls (the problem is still there). */
  const endWindow = (): void => {
    const hadStalls = windowStalls > 0
    const stalls = windowStalls
    const maxStall = windowMax
    const started = windowStart
    if (profiler && profiling) {
      try {
        const profile = profiler.stop()
        profiling = false
        if (profile && hadStalls) {
          const { busyMs, top } = summarizeProfile(profile)
          safeWrite({
            kind: 'main-thread-profile',
            windowMs: Math.round(now() - started),
            stalls,
            maxStallMs: Math.round(maxStall),
            busyMs,
            top,
          })
        }
      } catch {
        profiling = false
      }
    }
    windowStalls = 0
    windowMax = 0
    windowStart = now()
    if (hadStalls) startWindow()
  }

  const tick = (): void => {
    const t = now()
    const lag = t - last - sampleMs
    last = t
    if (lag >= threshold) {
      if (!profiling)
        startWindow() // the first stall arms the profile for what follows (it is not part of that profile)
      else {
        windowStalls++
        windowMax = Math.max(windowMax, lag)
      }
      if (t - lastReportAt >= minGap) {
        const cpu = cpuUsage()
        const slow = getSqliteTimingSummary()
          .recentSlow.slice(-5)
          .map((r) => ({ op: r.operation, ms: Math.round(r.durationMs) }))
        safeWrite({
          kind: 'main-thread-stall',
          ms: Math.round(lag),
          uptimeS: Math.round((t - bootAt) / 1000),
          suppressed,
          cpuMs: {
            user: Math.round((cpu.user - cpuAtLast.user) / 1000),
            system: Math.round((cpu.system - cpuAtLast.system) / 1000),
          },
          rssMB: Math.round(memoryUsage().rss / (1024 * 1024)),
          recentSlowSqlite: slow,
        })
        suppressed = 0
        lastReportAt = t
      } else suppressed++
    }
    cpuAtLast = cpuUsage()
    if (profiling && t - windowStart >= windowMs) endWindow()
  }

  const timer = setInterval(tick, sampleMs)
  timer.unref()
  return () => {
    clearInterval(timer)
    if (profiler && profiling) {
      try {
        profiler.stop()
      } catch {
        // already stopped
      }
    }
  }
}

/** The production wiring: stalls go to a rotated local file (default 1 MB, one previous generation kept). Off with GENOFFICE_NO_LAG_LOG=1. */
export function startLoopWatchdogToFile(logPath: string): (() => void) | null {
  if (process.env.GENOFFICE_NO_LAG_LOG === '1') return null
  return startLoopWatchdog({
    write: rotatingFileWriter(logPath, {
      append: (path, text) => {
        mkdirSync(dirname(path), { recursive: true })
        appendFileSync(path, text)
      },
      size: (path) => (existsSync(path) ? statSync(path).size : 0),
      rename: (from, to) => renameSync(from, to),
    }),
    profile: process.env.GENOFFICE_NO_LAG_PROFILE !== '1',
  })
}
