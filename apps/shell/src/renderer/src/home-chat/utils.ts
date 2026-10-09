import type { AgentMessage } from '@genoffice/agent-core'
import type { HomeChatMessage, HomeChatSessionSummary } from '../../../shared/fork/home-chat-types'
import { plainAnswer } from './file-refs'

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
    // `[[file:3]]` ids only mean something inside the answer they were written for
    const text = (
      message.role === 'assistant' ? plainAnswer(message.text, message.sources ?? []) : message.text
    ).trim()
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

const EXT =
  'docx?|xlsx?|xlsm|csv|tsv|pptx?|pdf|md|markdown|txt|rtf|odt|ods|odp|html?|json|xml|png|jpe?g|gif|webp'

/** Wrappers a model puts around a file name; the name inside may hold spaces, `&`, commas, parentheses. */
const WRAPPED: RegExp[] = [
  new RegExp(String.raw`\x60([^\x60\n]{1,200}?\.(?:${EXT}))\x60`, 'giu'),
  new RegExp(String.raw`\*{1,3}([^*\n]{1,200}?\.(?:${EXT}))\*{1,3}`, 'giu'),
  new RegExp(String.raw`["“”]([^"“”\n]{1,200}?\.(?:${EXT}))["“”]`, 'giu'),
  new RegExp(String.raw`['‘’]([^'‘’\n]{1,200}?\.(?:${EXT}))['‘’]`, 'giu'),
  new RegExp(String.raw`«([^»\n]{1,200}?\.(?:${EXT}))»`, 'giu'),
]
/** An extension that ends a word: `report.pdf`, not `report.pdfx` or `1.5`. */
const EXT_ANCHOR = new RegExp(String.raw`\.(?:${EXT})(?![\p{L}\p{N}])`, 'giu')
/** Text that always separates two names in a list; a spaced dash or comma may belong to a name. */
const HARD_BREAK = /\s[—–]\s|:\s|;\s|\s&\s|\s(?:và|and|hoặc|or|và cả|cùng với)\s|\t|\|/giu

const normName = (name: string) => name.normalize('NFC').replace(/\s+/g, ' ').trim()

const stripLead = (raw: string) =>
  raw.replace(/^[\s\-*•#>_"'`“‘«([]+/u, '').replace(/^\d+[.)]\s+/u, '')

/** Where an unquoted name starts, scanning back from its extension. */
function unquotedStart(text: string, end: number): number {
  let depth = 0
  let start = end
  for (let i = end - 1; i >= 0; i--) {
    const ch = text[i]!
    if (ch === '\n' || ch === '/' || ch === '\\') break
    if (ch === ')' || ch === ']') depth++
    else if (ch === '(' || ch === '[') {
      if (depth === 0) break
      depth--
    }
    if (depth === 0) {
      HARD_BREAK.lastIndex = 0
      const window = text.slice(i, Math.min(end, i + 8))
      const hard = HARD_BREAK.exec(window)
      if (hard?.index === 0) return Math.max(start, i + hard[0].length)
    }
    start = i
  }
  return start
}

/**
 * File names an answer mentions, in the order they appear, once each (case-insensitively), at most
 * `max`. Quoted names (`name`, **name**, "name") are read whole whatever they contain; an unquoted
 * name is read back from its extension to the nearest separator (a list number, " — ", " & ",
 * a colon), so `A.docx & B (1).docx` is two names. The result is a list of leads to look up,
 * never a list of paths.
 */
export function fileNamesIn(text: string, max = 8): string[] {
  const found: Array<{ at: number; name: string }> = []
  const covered: Array<[number, number]> = []
  for (const pattern of WRAPPED) {
    for (const match of text.matchAll(pattern)) {
      const at = match.index ?? 0
      const end = at + match[0].length
      if (covered.some(([s, e]) => at < e && end > s)) continue
      covered.push([at, end])
      found.push({ at, name: normName(match[1]!) })
    }
  }
  for (const match of text.matchAll(EXT_ANCHOR)) {
    const end = (match.index ?? 0) + match[0].length
    if (covered.some(([s, e]) => end > s && end <= e)) continue
    const start = unquotedStart(text, end - match[0].length)
    const raw = text.slice(start, end)
    // strip list numbering, bullets and wrapper debris left in front
    const name = normName(stripLead(stripLead(raw)))
    if (!name || name.length > 200 || /^\.[A-Za-z]+$/.test(name)) continue
    covered.push([start, end])
    found.push({ at: start, name })
  }
  found.sort((a, b) => a.at - b.at)
  const seen = new Set<string>()
  const out: string[] = []
  for (const { name } of found) {
    const key = name.toLocaleLowerCase()
    if (!name || seen.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length >= max) break
  }
  return out
}

/**
 * Other readings of an unquoted name, longest first, for when the whole thing is not a file:
 * "Tôi mở Báo cáo Q3.docx" -> "Báo cáo Q3.docx" -> "Q3.docx". Quoted names have one reading.
 */
export function fileNameVariants(name: string, max = 4): string[] {
  const words = normName(name).split(' ')
  const out: string[] = [words.join(' ')]
  const looksLikeName = (word: string) =>
    /[_\d-]|\p{Lu}/u.test(word) || /\.[A-Za-z0-9]+$/.test(word)
  for (let i = 1; i < words.length && out.length < max; i++) {
    if (looksLikeName(words[i]!)) out.push(words.slice(i).join(' '))
  }
  return [...new Set(out)]
}
