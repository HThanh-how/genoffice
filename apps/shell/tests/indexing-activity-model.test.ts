import { describe, expect, it, vi } from 'vitest'
import type { HomeIndexingActivity } from '../src/shared/home-api'
import {
  EtaTracker,
  activityEqual,
  createAdaptivePoller,
  deriveIndexView,
  pollDelay,
  shouldAutoExpand,
} from '../src/renderer/src/indexing-activity-model'
import { createActivityCache } from '../src/main/indexing-activity-cache'

function activity(over: {
  running?: boolean
  state?: 'running' | 'complete' | 'stopped'
  enabled?: boolean
  modelState?: string
  lastError?: string
  pending?: number
  total?: number
  errors?: number
  empty?: number
  percent?: number | null
}): HomeIndexingActivity {
  const total = over.total ?? 100
  const pending = over.pending ?? 0
  return {
    folder: {
      running: over.running ?? false,
      state: over.state ?? 'complete',
      root: 'C:\\docs',
      startedAt: 1,
      discovered: total,
      enrolled: total,
      skipped: 0,
      errors: 0,
    },
    memory: {
      enabled: over.enabled ?? true,
      modelState: over.modelState ?? 'ready',
      pending,
      errors: over.errors ?? 0,
      ...(over.lastError ? { lastError: over.lastError } : {}),
    },
    folderProgress: {
      totalFiles: total,
      readyFiles: total - pending,
      pendingFiles: pending,
      errorFiles: over.errors ?? 0,
      emptyFiles: over.empty ?? 0,
      completedChunks: 0,
      totalChunks: 0,
      percent: over.percent === undefined ? 50 : over.percent,
    },
  }
}

describe('deriveIndexView', () => {
  it('returns null without a folder', () => {
    expect(deriveIndexView(null)).toBeNull()
  })
  it('keeps a model failure separate from file problems', () => {
    const view = deriveIndexView(
      activity({ modelState: 'error', pending: 50, errors: 3, lastError: 'fetch failed' }),
    )!
    expect(view.kind).toBe('model-error')
    expect(view.modelError).toBe('fetch failed')
    expect(view.fileErrors).toBe(3)
    expect(view.percent).toBeNull()
  })
  it('model error with nothing waiting is just done', () => {
    expect(deriveIndexView(activity({ modelState: 'error', pending: 0 }))!.kind).toBe('done')
  })
  it('reports scanning, indexing with a real percent, paused, stopped and done', () => {
    expect(deriveIndexView(activity({ running: true, state: 'running', pending: 10 }))!.kind).toBe(
      'scanning',
    )
    const indexing = deriveIndexView(activity({ pending: 40, percent: 37 }))!
    expect(indexing).toMatchObject({ kind: 'indexing', percent: 37, finished: 60, total: 100 })
    expect(deriveIndexView(activity({ enabled: false, pending: 40 }))!.kind).toBe('paused')
    expect(deriveIndexView(activity({ state: 'stopped' }))!.kind).toBe('stopped')
    expect(deriveIndexView(activity({}))).toMatchObject({ kind: 'done', percent: 100 })
  })
})

describe('shouldAutoExpand', () => {
  const active = deriveIndexView(activity({ pending: 5 }))
  const done = deriveIndexView(activity({}))
  const failed = deriveIndexView(
    activity({ modelState: 'error', pending: 50, errors: 3, lastError: 'fetch failed' }),
  )
  it('stays closed for ordinary indexing, finished scans and repeats; opens for a model failure', () => {
    expect(shouldAutoExpand('', 'r:1', active)).toBe(false)
    expect(shouldAutoExpand('r:1', 'r:2', active)).toBe(false)
    expect(shouldAutoExpand('', 'r:1', done)).toBe(false)
    expect(failed?.kind).toBe('model-error')
    expect(shouldAutoExpand('', 'r:1', failed)).toBe(true)
    expect(shouldAutoExpand('r:1', 'r:1', failed)).toBe(false)
  })
})

describe('activityEqual', () => {
  it('ignores identical payloads so a tick does not re-render', () => {
    expect(activityEqual(activity({ pending: 3 }), activity({ pending: 3 }))).toBe(true)
    expect(activityEqual(activity({ pending: 3 }), activity({ pending: 2 }))).toBe(false)
    expect(activityEqual(null, activity({}))).toBe(false)
  })
})

describe('pollDelay', () => {
  it('is fast only when expanded and visible, slower collapsed, none when hidden', () => {
    expect(pollDelay({ expanded: true, visible: true, active: true })).toBe(1000)
    expect(pollDelay({ expanded: false, visible: true, active: true })).toBe(5000)
    expect(pollDelay({ expanded: false, visible: true, active: false })).toBe(10_000)
    expect(pollDelay({ expanded: true, visible: false, active: true })).toBeNull()
  })
})

describe('createAdaptivePoller', () => {
  it('never overlaps requests and honours a paused (null) delay', async () => {
    vi.useFakeTimers()
    try {
      let delay: number | null = 1000
      let running = 0
      let maxRunning = 0
      let calls = 0
      const poller = createAdaptivePoller({
        fetch: async () => {
          calls++
          running++
          maxRunning = Math.max(maxRunning, running)
          await new Promise((resolve) => setTimeout(resolve, 3000))
          running--
        },
        getDelay: () => delay,
      })
      poller.kick()
      poller.kick() // in flight: ignored
      await vi.advanceTimersByTimeAsync(3000)
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(1000) // next tick starts after the delay
      expect(calls).toBe(2)
      delay = null // window hidden
      await vi.advanceTimersByTimeAsync(3000)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls).toBe(2)
      delay = 5000
      poller.kick() // visible again: fetch immediately
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toBe(3)
      expect(maxRunning).toBe(1)
      poller.stop()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('EtaTracker', () => {
  it('stays silent until the evidence is solid, then reports a steady rate', () => {
    const tracker = new EtaTracker()
    tracker.record(0, 0, 1000)
    tracker.record(5000, 10, 1000)
    expect(tracker.estimate()).toBeNull()
    for (let t = 10_000; t <= 40_000; t += 5000) tracker.record(t, (t / 1000) * 2, 1000)
    // 2 files/s, 920 left -> about 460 s -> about 8 minutes
    expect(tracker.estimate()).toMatchObject({ unit: 'minutes', value: 8 })
  })
  it('refuses to guess when the rate swings wildly', () => {
    const tracker = new EtaTracker()
    const done = [0, 2, 4, 6, 8, 100, 200, 300, 400]
    done.forEach((d, i) => tracker.record(i * 5000, d, 5000))
    expect(tracker.estimate()).toBeNull()
  })
  it('resets when progress goes backwards or the total changes', () => {
    const tracker = new EtaTracker()
    for (let i = 0; i < 8; i++) tracker.record(i * 5000, i * 10, 1000)
    tracker.record(50_000, 5, 1000)
    expect(tracker.estimate()).toBeNull()
  })
})

describe('createActivityCache', () => {
  it('reuses a result within its TTL, recomputes on key change or expiry, and scales TTL with cost', () => {
    let now = 0
    let computes = 0
    let cost = 10
    const cache = createActivityCache<number>({ now: () => now })
    const compute = () => {
      computes++
      now += cost
      return computes
    }
    expect(cache.get('a', compute)).toBe(1)
    now += 500
    expect(cache.get('a', compute)).toBe(1) // within the 1 s minimum TTL
    expect(cache.get('b', compute)).toBe(2) // key changed
    now += 1100
    expect(cache.get('b', compute)).toBe(3) // expired
    cost = 400 // slow database: TTL grows to ~4 s
    now += 1100
    expect(cache.get('b', compute)).toBe(4)
    now += 3000
    expect(cache.get('b', compute)).toBe(4) // still cached after 3 s
    now += 1500
    expect(cache.get('b', compute)).toBe(5)
    cache.invalidate()
    expect(cache.get('b', compute)).toBe(6)
  })
})
