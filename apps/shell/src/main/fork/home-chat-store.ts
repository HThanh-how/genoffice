import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HOME_CHAT_LIMITS,
  type HomeChatMessage,
  type HomeChatSession,
  type HomeChatSessionSummary,
  type HomeChatSource,
} from '../../shared/fork/home-chat-types'
import { atomicWriteFile } from '../atomic-write'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const INDEX_FILE = 'index.json'

export const isChatSessionId = (value: unknown): value is string =>
  typeof value === 'string' && UUID_RE.test(value)

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const asTime = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, Date.now() + 60_000)
    : fallback

function cleanSources(value: unknown): HomeChatSource[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: HomeChatSource[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (!isObject(raw)) continue
    const id = raw.documentId
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) continue
    const path = typeof raw.path === 'string' ? raw.path.slice(0, 520) : ''
    if (id === 0 && !path) continue
    const key = id > 0 ? `d${id}` : `p${path}`
    if (seen.has(key)) continue
    seen.add(key)
    const source: HomeChatSource = {
      documentId: id,
      ...(path ? { path } : {}),
      name: typeof raw.name === 'string' ? raw.name.slice(0, 260) : '',
      location: typeof raw.location === 'string' ? raw.location.slice(0, 260) : '',
    }
    if (raw.stale === true) source.stale = true
    if (raw.missing === true) source.missing = true
    if (raw.unverified === true) source.unverified = true
    if (raw.related === true) source.related = true
    if (typeof raw.modifiedAt === 'number' && Number.isFinite(raw.modifiedAt) && raw.modifiedAt > 0)
      source.modifiedAt = raw.modifiedAt
    if (
      typeof raw.ref === 'number' &&
      Number.isSafeInteger(raw.ref) &&
      raw.ref > 0 &&
      raw.ref < 1000
    )
      source.ref = raw.ref
    out.push(source)
    if (out.length >= HOME_CHAT_LIMITS.maxSources) break
  }
  return out.length > 0 ? out : undefined
}

/** Keep only role/text/sources/error; never trust stored or IPC data. */
export function sanitizeChatMessages(value: unknown): HomeChatMessage[] {
  if (!Array.isArray(value)) return []
  const out: HomeChatMessage[] = []
  for (const raw of value) {
    if (!isObject(raw)) continue
    if (raw.role !== 'user' && raw.role !== 'assistant') continue
    if (typeof raw.text !== 'string') continue
    const message: HomeChatMessage = {
      role: raw.role,
      text: raw.text.slice(0, HOME_CHAT_LIMITS.maxTextChars),
    }
    const sources = raw.role === 'assistant' ? cleanSources(raw.sources) : undefined
    if (sources) message.sources = sources
    if (raw.role === 'assistant' && typeof raw.error === 'string' && raw.error)
      message.error = raw.error.slice(0, 600)
    out.push(message)
  }
  return out.length > HOME_CHAT_LIMITS.maxMessages
    ? out.slice(out.length - HOME_CHAT_LIMITS.maxMessages)
    : out
}

/** Title from the first user message: one line, trimmed, ellipsised. */
export function deriveChatTitle(messages: readonly HomeChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user' && m.text.trim())
  const line = (first?.text ?? '').replace(/\s+/g, ' ').trim()
  const max = HOME_CHAT_LIMITS.maxTitleChars
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

export function cleanChatTitle(value: unknown): string {
  if (typeof value !== 'string') return ''
  let line = ''
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    line += code < 0x20 || code === 0x7f ? ' ' : ch
  }
  return line.replace(/\s+/g, ' ').trim().slice(0, HOME_CHAT_LIMITS.maxTitleChars)
}

/** Keep the newest messages that fit the per-session byte budget. */
export function fitSessionBytes(messages: HomeChatMessage[], maxBytes: number): HomeChatMessage[] {
  let start = 0
  let total = Buffer.byteLength(JSON.stringify(messages))
  while (total > maxBytes && start < messages.length - 1) {
    total -= Buffer.byteLength(JSON.stringify(messages[start])) + 1
    start += 1
  }
  // never start on an assistant reply: it would be orphaned from its question
  while (start < messages.length - 1 && messages[start]!.role === 'assistant') start += 1
  return start === 0 ? messages : messages.slice(start)
}

function summarize(session: HomeChatSession): HomeChatSessionSummary {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
  }
}

function parseSession(raw: unknown, expectedId: string): HomeChatSession | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || raw.id.toLowerCase() !== expectedId)
    return null
  const messages = sanitizeChatMessages(raw.messages)
  const createdAt = asTime(raw.createdAt, Date.now())
  return {
    id: expectedId,
    title: cleanChatTitle(raw.title) || deriveChatTitle(messages),
    createdAt,
    updatedAt: asTime(raw.updatedAt, createdAt),
    messages,
  }
}

/**
 * One JSON file per conversation plus a small index cache. The index is
 * rebuilt from the session files whenever it is missing or unreadable, and a
 * corrupt session file is skipped (and quarantined) instead of failing the list.
 * All operations run through one queue so save/delete never interleave.
 */
export class HomeChatStore {
  private queue: Promise<unknown> = Promise.resolve()
  private index: HomeChatSessionSummary[] | null = null

  constructor(private readonly dir: string) {}

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => {})
    return next
  }

  private file(id: string): string {
    if (!isChatSessionId(id)) throw new Error('Invalid chat id')
    return join(this.dir, `${id.toLowerCase()}.json`)
  }

  private async write(path: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await atomicWriteFile(path, Buffer.from(JSON.stringify(value)))
    // owner-only; best effort (a no-op on Windows)
    await chmod(path, 0o600).catch(() => {})
  }

  private async load(): Promise<HomeChatSessionSummary[]> {
    if (this.index) return this.index
    let loaded: HomeChatSessionSummary[] | null = null
    try {
      const raw = JSON.parse(await readFile(join(this.dir, INDEX_FILE), 'utf8')) as unknown
      if (isObject(raw) && Array.isArray(raw.sessions)) {
        loaded = []
        for (const entry of raw.sessions) {
          if (!isObject(entry) || !isChatSessionId(entry.id)) continue
          loaded.push({
            id: entry.id.toLowerCase(),
            title: cleanChatTitle(entry.title),
            createdAt: asTime(entry.createdAt, 0),
            updatedAt: asTime(entry.updatedAt, 0),
            messageCount:
              typeof entry.messageCount === 'number' && entry.messageCount >= 0
                ? Math.floor(entry.messageCount)
                : 0,
          })
        }
      }
    } catch {
      loaded = null
    }
    this.index = loaded ?? (await this.rebuild())
    return this.index
  }

  private async rebuild(): Promise<HomeChatSessionSummary[]> {
    const found: HomeChatSessionSummary[] = []
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return found
    }
    for (const name of names) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : ''
      if (!isChatSessionId(id)) continue
      const session = await this.readSession(id)
      if (session) found.push(summarize(session))
    }
    found.sort((a, b) => b.updatedAt - a.updatedAt)
    this.index = found
    await this.persistIndex().catch(() => {})
    return found
  }

  private async persistIndex(): Promise<void> {
    await this.write(join(this.dir, INDEX_FILE), { version: 1, sessions: this.index ?? [] })
  }

  private async readSession(id: string): Promise<HomeChatSession | null> {
    try {
      const raw = JSON.parse(await readFile(this.file(id), 'utf8')) as unknown
      const session = parseSession(raw, id.toLowerCase())
      if (session) return session
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    }
    // unreadable or malformed: quarantine it so it cannot break the list again while preserving data
    const corruptPath = `${this.file(id)}.corrupt-${Date.now()}`
    await rename(this.file(id), corruptPath).catch(() => {})
    return null
  }

  list(): Promise<HomeChatSessionSummary[]> {
    return this.run(async () => [...(await this.load())].sort((a, b) => b.updatedAt - a.updatedAt))
  }

  get(id: unknown): Promise<HomeChatSession | null> {
    if (!isChatSessionId(id)) return Promise.resolve(null)
    return this.run(async () => {
      const session = await this.readSession(id)
      if (!session) {
        const index = await this.load()
        const at = index.findIndex((entry) => entry.id === id.toLowerCase())
        if (at >= 0) {
          index.splice(at, 1)
          await this.persistIndex().catch(() => {})
        }
      }
      return session
    })
  }

  save(input: unknown): Promise<HomeChatSessionSummary | null> {
    if (!isObject(input)) return Promise.resolve(null)
    const requested = input.id
    if (requested !== undefined && !isChatSessionId(requested)) return Promise.resolve(null)
    const messages = sanitizeChatMessages(input.messages)
    if (messages.length === 0) return Promise.resolve(null)
    return this.run(async () => {
      const index = await this.load()
      const id = (requested ?? randomUUID()).toLowerCase()
      const previous = index.find((entry) => entry.id === id)
      const now = Date.now()
      const fitted = fitSessionBytes(messages, HOME_CHAT_LIMITS.maxSessionBytes)
      const session: HomeChatSession = {
        id,
        title:
          previous?.title || cleanChatTitle(input.title) || deriveChatTitle(fitted) || 'New chat',
        createdAt: previous?.createdAt || asTime(input.createdAt, now),
        updatedAt: previous ? now : asTime(input.updatedAt, now),
        messages: fitted,
      }
      await this.write(this.file(id), session)
      const summary = summarize(session)
      const at = index.findIndex((entry) => entry.id === id)
      if (at >= 0) index[at] = summary
      else index.push(summary)
      await this.evict(index, id)
      await this.persistIndex()
      return summary
    })
  }

  private async evict(index: HomeChatSessionSummary[], keepId: string): Promise<void> {
    if (index.length <= HOME_CHAT_LIMITS.maxSessions) return
    index.sort((a, b) => b.updatedAt - a.updatedAt)
    while (index.length > HOME_CHAT_LIMITS.maxSessions) {
      const victim = index[index.length - 1]!
      if (victim.id === keepId) break
      index.pop()
      await unlink(this.file(victim.id)).catch(() => {})
    }
  }

  rename(id: unknown, title: unknown): Promise<HomeChatSessionSummary | null> {
    const clean = cleanChatTitle(title)
    if (!isChatSessionId(id) || !clean) return Promise.resolve(null)
    return this.run(async () => {
      const session = await this.readSession(id)
      if (!session) return null
      session.title = clean
      await this.write(this.file(id), session)
      const index = await this.load()
      const summary = summarize(session)
      const at = index.findIndex((entry) => entry.id === session.id)
      if (at >= 0) index[at] = summary
      else index.push(summary)
      await this.persistIndex()
      return summary
    })
  }

  delete(id: unknown): Promise<boolean> {
    if (!isChatSessionId(id)) return Promise.resolve(false)
    return this.run(async () => {
      await unlink(this.file(id)).catch(() => {})
      const index = await this.load()
      const at = index.findIndex((entry) => entry.id === id.toLowerCase())
      if (at >= 0) index.splice(at, 1)
      await this.persistIndex()
      return at >= 0
    })
  }

  clear(): Promise<number> {
    return this.run(async () => {
      const index = await this.load()
      const count = index.length
      let names: string[] = []
      try {
        names = await readdir(this.dir)
      } catch {
        // directory not created yet
      }
      for (const name of names) {
        const id = name.endsWith('.json') ? name.slice(0, -5) : ''
        if (isChatSessionId(id)) await unlink(join(this.dir, name)).catch(() => {})
      }
      this.index = []
      await this.persistIndex().catch(() => {})
      return count
    })
  }
}
