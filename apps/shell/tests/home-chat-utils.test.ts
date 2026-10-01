import { describe, expect, it, vi } from 'vitest'
import type { HomeChatSessionSummary } from '../src/shared/fork/home-chat-types'
import {
  WINDOW_PAGE,
  createFrameBatcher,
  groupKeyFor,
  groupSessions,
  isNearBottom,
  relativeTime,
  toSeedMessages,
  windowMessages,
} from '../src/renderer/src/home-chat/utils'

const NOW = new Date(2026, 5, 15, 14, 30).getTime() // Mon 15 Jun 2026, 14:30 local
const at = (daysAgo: number, hour = 9) => {
  const d = new Date(NOW)
  d.setDate(d.getDate() - daysAgo)
  d.setHours(hour, 0, 0, 0)
  return d.getTime()
}
const summary = (id: string, updatedAt: number, title = id): HomeChatSessionSummary => ({
  id,
  title,
  createdAt: updatedAt,
  updatedAt,
  messageCount: 2,
})

describe('history grouping', () => {
  it('buckets by calendar day', () => {
    expect(groupKeyFor(at(0, 0), NOW)).toBe('today')
    expect(groupKeyFor(at(1, 23), NOW)).toBe('yesterday')
    expect(groupKeyFor(at(2), NOW)).toBe('week')
    expect(groupKeyFor(at(7), NOW)).toBe('week')
    expect(groupKeyFor(at(8), NOW)).toBe('older')
  })

  it('orders newest first, omits empty groups and filters by title', () => {
    const sessions = [
      summary('old', at(30), 'Archive scan'),
      summary('b', at(0, 8), 'Budget 2026'),
      summary('a', at(0, 13), 'Budget draft'),
      summary('y', at(1), 'Contract'),
    ]
    const groups = groupSessions(sessions, NOW)
    expect(groups.map((g) => g.key)).toEqual(['today', 'yesterday', 'older'])
    expect(groups[0]!.items.map((s) => s.id)).toEqual(['a', 'b'])
    const filtered = groupSessions(sessions, NOW, '  BUDGET ')
    expect(filtered).toHaveLength(1)
    expect(filtered[0]!.items).toHaveLength(2)
    expect(groupSessions(sessions, NOW, 'zzz')).toEqual([])
  })
})

describe('relativeTime', () => {
  it('formats recent and older stamps in the given locale', () => {
    expect(relativeTime(NOW - 5_000, NOW, 'en-US')).toBe('now')
    expect(relativeTime(NOW - 5 * 60_000, NOW, 'en-US')).toMatch(/5 min/)
    expect(relativeTime(NOW - 3 * 3_600_000, NOW, 'en-US')).toMatch(/3 hr/)
    expect(relativeTime(at(1, 9), NOW, 'en-US')).toBe('yesterday')
    expect(relativeTime(at(90), NOW, 'en-US')).toMatch(/\w/)
  })
})

describe('scroll and windowing helpers', () => {
  it('detects when the viewport is following the bottom', () => {
    expect(isNearBottom({ scrollTop: 900, scrollHeight: 1500, clientHeight: 600 })).toBe(true)
    expect(isNearBottom({ scrollTop: 400, scrollHeight: 1500, clientHeight: 600 })).toBe(false)
  })

  it('renders only the newest window and reports hidden count', () => {
    const items = Array.from({ length: 130 }, (_, i) => i)
    const first = windowMessages(items, WINDOW_PAGE)
    expect(first.shown).toHaveLength(WINDOW_PAGE)
    expect(first.shown.at(-1)).toBe(129)
    expect(first.hidden).toBe(90)
    const more = windowMessages(items, WINDOW_PAGE * 4)
    expect(more.hidden).toBe(0)
    expect(windowMessages([1, 2], 40)).toEqual({ shown: [1, 2], hidden: 0 })
  })
})

describe('createFrameBatcher', () => {
  const manualScheduler = () => {
    const queue: Array<() => void> = []
    const schedule = vi.fn((run: () => void) => {
      queue.push(run)
      return () => {
        const at = queue.indexOf(run)
        if (at >= 0) queue.splice(at, 1)
      }
    })
    return { schedule, frame: () => queue.splice(0).forEach((run) => run()), queue }
  }

  it('turns a burst of tokens into one update per frame with the latest value', () => {
    const sched = manualScheduler()
    const apply = vi.fn()
    const batcher = createFrameBatcher<string>(apply, sched.schedule)
    for (let i = 1; i <= 200; i += 1) batcher.push('x'.repeat(i))
    expect(apply).not.toHaveBeenCalled()
    expect(sched.schedule).toHaveBeenCalledTimes(1)
    sched.frame()
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith('x'.repeat(200))
    batcher.push('next')
    sched.frame()
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('flush applies immediately and cancel drops pending text', () => {
    const sched = manualScheduler()
    const apply = vi.fn()
    const batcher = createFrameBatcher<string>(apply, sched.schedule)
    batcher.push('a')
    batcher.flush()
    expect(apply).toHaveBeenCalledWith('a')
    expect(sched.queue).toHaveLength(0)
    batcher.push('b')
    batcher.cancel()
    sched.frame()
    expect(apply).toHaveBeenCalledTimes(1)
  })
})

describe('toSeedMessages', () => {
  it('keeps plain user/assistant text turns only', () => {
    expect(
      toSeedMessages([
        { role: 'user', text: 'hi' },
        {
          role: 'assistant',
          text: 'hello',
          sources: [{ documentId: 1, name: 'a', location: 'b' }],
        },
      ]),
    ).toEqual([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hello' },
    ])
  })

  it('drops failed or empty answers together with their question, and trailing questions', () => {
    expect(
      toSeedMessages([
        { role: 'user', text: 'q1' },
        { role: 'assistant', text: 'a1' },
        { role: 'user', text: 'q2' },
        { role: 'assistant', text: '', error: 'network' },
        { role: 'user', text: 'q3' },
        { role: 'assistant', text: 'partial', error: 'cut' },
        { role: 'user', text: 'q4' },
      ]),
    ).toEqual([
      { role: 'user', text: 'q1' },
      { role: 'assistant', text: 'a1' },
    ])
  })

  it('never lets two user turns sit next to each other', () => {
    const seed = toSeedMessages([
      { role: 'user', text: 'a' },
      { role: 'user', text: 'b' },
      { role: 'assistant', text: 'answer b' },
    ])
    expect(seed).toEqual([
      { role: 'user', text: 'b' },
      { role: 'assistant', text: 'answer b' },
    ])
  })
})
