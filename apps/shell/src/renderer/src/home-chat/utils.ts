import type { AgentMessage } from '@genoffice/agent-core'
import type { HomeChatMessage, HomeChatSessionSummary } from '../../../shared/fork/home-chat-types'

/** Messages rendered initially; "Show earlier" reveals this many more each time. */
export const WINDOW_PAGE = 40
/** Distance from the bottom (px) that still counts as "following the stream". */
export const STICK_THRESHOLD = 96

export type SessionGroupKey = 'today' | 'yesterday' | 'week' | 'older'

export interface SessionGroup {
  key: SessionGroupKey
  items: HomeChatSessionSummary[]
}

const startOfDay = (ms: number): number => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function groupKeyFor(updatedAt: number, now: number): SessionGroupKey {
  const today = startOfDay(now)
  const day = 86_400_000
  // calendar days, not 24h blocks, so a chat from 11pm last night is "Yesterday"
  const dayStart = startOfDay(updatedAt)
  if (dayStart >= today) return 'today'
  const diffDays = Math.round((today - dayStart) / day)
  if (diffDays <= 1) return 'yesterday'
  if (diffDays <= 7) return 'week'
  return 'older'
}

/** Newest first, filtered by title, bucketed Today / Yesterday / Previous 7 days / Older. */
export function groupSessions(
  sessions: readonly HomeChatSessionSummary[],
  now: number,
  query = '',
): SessionGroup[] {
  const needle = query.trim().toLocaleLowerCase()
  const buckets: Record<SessionGroupKey, HomeChatSessionSummary[]> = {
    today: [],
    yesterday: [],
    week: [],
    older: [],
  }
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  for (const session of sorted) {
    if (needle && !session.title.toLocaleLowerCase().includes(needle)) continue
    buckets[groupKeyFor(session.updatedAt, now)].push(session)
  }
  return (['today', 'yesterday', 'week', 'older'] as const)
    .map((key) => ({ key, items: buckets[key] }))
    .filter((group) => group.items.length > 0)
}

/** Short relative stamp ("5 minutes ago", "yesterday") in the UI locale. */
export function relativeTime(timestamp: number, now: number, locale: string): string {
  const seconds = Math.round((timestamp - now) / 1000)
  const abs = Math.abs(seconds)
  let formatter: Intl.RelativeTimeFormat
  try {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' })
  } catch {
    formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' })
  }
  if (abs < 45) return formatter.format(0, 'second')
  if (abs < 3600) return formatter.format(Math.round(seconds / 60), 'minute')
  if (abs < 86_400) return formatter.format(Math.round(seconds / 3600), 'hour')
  if (abs < 86_400 * 30) {
    const days = Math.round((startOfDay(timestamp) - startOfDay(now)) / 86_400_000)
    return formatter.format(days, 'day')
  }
  return new Date(timestamp).toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

export function isNearBottom(
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold = STICK_THRESHOLD,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold
}

/** How many of the newest messages to render, and how many are hidden above. */
export function windowMessages<T>(
  items: readonly T[],
  visible: number,
): { shown: T[]; hidden: number } {
  const count = Math.max(WINDOW_PAGE, visible)
  if (items.length <= count) return { shown: items as T[], hidden: 0 }
  return { shown: items.slice(items.length - count), hidden: items.length - count }
}

/**
 * Coalesces rapid updates (one per streamed token) into at most one callback
 * per scheduled frame, always with the most recent value. With rAF scheduling
 * a 200-token/s stream causes ~60 renders/s at worst instead of 200, and each
 * render only touches the streaming message (see ChatMessage memoization).
 */
export function createFrameBatcher<T>(
  apply: (value: T) => void,
  schedule: (run: () => void) => () => void,
): { push(value: T): void; flush(): void; cancel(): void } {
  let pending: { value: T } | null = null
  let cancelFrame: (() => void) | null = null
  const run = () => {
    cancelFrame = null
    if (!pending) return
    const { value } = pending
    pending = null
    apply(value)
  }
  return {
    push(value) {
      pending = { value }
      if (!cancelFrame) cancelFrame = schedule(run)
    },
    flush() {
      cancelFrame?.()
      cancelFrame = null
      run()
    },
    cancel() {
      cancelFrame?.()
      cancelFrame = null
      pending = null
    },
  }
}

/**
 * Persisted turns -> plain text turns for AgentLoop.restore(). Only role and
 * text are kept (tool calls and results are never persisted), failed or empty
 * assistant turns are dropped, and a user turn left without an answer is
 * dropped so the next message does not merge with it.
 */
export function toSeedMessages(messages: readonly HomeChatMessage[]): AgentMessage[] {
  const seed: AgentMessage[] = []
  for (const message of messages) {
    const text = message.text.trim()
    if (message.role === 'assistant') {
      if (!text || message.error) {
        // an unanswered question must not stay in context
        if (seed.at(-1)?.role === 'user') seed.pop()
        continue
      }
      if (seed.at(-1)?.role !== 'user') continue
      seed.push({ role: 'assistant', text })
    } else if (text) {
      if (seed.at(-1)?.role === 'user') seed.pop()
      seed.push({ role: 'user', text })
    }
  }
  if (seed.at(-1)?.role === 'user') seed.pop()
  return seed
}
