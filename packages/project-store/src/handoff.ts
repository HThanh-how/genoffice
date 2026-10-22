/**
 * Context handoff from a Home chat into the chat of a document it created or opened.
 *
 * The handoff is a compact, deterministic digest (no model call): the user's
 * original request, their recent turns (where standing instructions live), and
 * the file concerned. It is stored as the first message of the document's chat
 * (identity: the document's existing path -> chatId mapping), tagged with
 * `handoff`, so the document panel can show it and seed its model context.
 *
 * Pure and dependency-free so both the shell renderer and the document apps can
 * import it (subpath `@genoffice/project-store/handoff`, which avoids pulling
 * the fs-backed store into a renderer bundle).
 */
import type { ChatHandoffMeta, ChatMessage, ProjectApi } from './ipc.js'

export const HANDOFF_MAX_CHARS = 1500
/** Recent user turns considered for standing instructions. */
export const HANDOFF_RECENT_TURNS = 6
const ORIGINAL_MAX_CHARS = 400
const TURN_MAX_CHARS = 220
const TITLE_MAX_CHARS = 60

export interface HandoffTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface HandoffInput {
  /** Home chat title; falls back to the first user message */
  chatTitle?: string
  turns: readonly HandoffTurn[]
  filePath: string
  /** the document was created by the chat turn, or merely opened from it */
  kind: 'created' | 'opened'
}

function squash(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

export function handoffTitle(input: Pick<HandoffInput, 'chatTitle' | 'turns'>): string {
  const explicit = squash(input.chatTitle ?? '', TITLE_MAX_CHARS)
  if (explicit) return explicit
  const first = input.turns.find((t) => t.role === 'user' && t.text.trim())
  return first ? squash(first.text, TITLE_MAX_CHARS) : ''
}

/**
 * Builds the handoff body, or '' when the chat has no user turns to carry
 * (nothing worth seeding). Output is at most HANDOFF_MAX_CHARS.
 */
export function buildChatHandoff(input: HandoffInput): string {
  const users = input.turns.filter((t) => t.role === 'user' && t.text.trim())
  if (users.length === 0) return ''
  const original = squash(users[0]!.text, ORIGINAL_MAX_CHARS)
  const title = handoffTitle(input)
  const recent = users
    .slice(-HANDOFF_RECENT_TURNS)
    .filter((t) => t !== users[0])
    .map((t) => squash(t.text, TURN_MAX_CHARS))
  const fileLine =
    input.kind === 'created'
      ? `Document created in that chat: ${baseName(input.filePath)} (${input.filePath})`
      : `Document opened from that chat: ${baseName(input.filePath)} (${input.filePath})`
  const head = `Context carried over from the Home chat "${title}".`
  const originalLine = `Original request: ${original}`
  const recentHead = 'Later requests and standing instructions from the user (oldest first):'

  const compose = (bullets: string[]): string =>
    [
      head,
      originalLine,
      ...(bullets.length > 0 ? [recentHead, ...bullets.map((b) => `- ${b}`)] : []),
      fileLine,
    ].join('\n')

  // Drop the oldest bullets first: the newest instructions win on conflict.
  let bullets = recent
  let out = compose(bullets)
  while (out.length > HANDOFF_MAX_CHARS && bullets.length > 0) {
    bullets = bullets.slice(1)
    out = compose(bullets)
  }
  if (out.length > HANDOFF_MAX_CHARS) {
    // A pathological path/title: shrink the request, never the file line.
    const overflow = out.length - HANDOFF_MAX_CHARS
    const shrunk = squash(original, Math.max(40, original.length - overflow))
    out = [head, `Original request: ${shrunk}`, fileLine].join('\n')
  }
  return out.length > HANDOFF_MAX_CHARS ? out.slice(0, HANDOFF_MAX_CHARS) : out
}

/** Seeding rule: only a document chat with no messages at all is seeded (so never twice). */
export function shouldSeedHandoff(existing: readonly Pick<ChatMessage, 'seq'>[]): boolean {
  return existing.length === 0
}

/** Only Word documents have a document chat that renders the handoff. */
export function isHandoffTarget(path: string): boolean {
  return /\.(docx|dotx)$/i.test(path)
}

/**
 * Seeds the chat of `input.filePath` from the Home chat. Returns true when a
 * handoff was written. No-ops (false) for non-Word files, chats without user
 * turns, and document chats that already have any message.
 */
export async function seedDocChatHandoff(
  api: Pick<ProjectApi, 'resolveChat' | 'loadChat' | 'appendChat'>,
  input: HandoffInput,
): Promise<boolean> {
  if (!isHandoffTarget(input.filePath)) return false
  const text = buildChatHandoff(input)
  if (!text) return false
  const ids = await api.resolveChat({ filePath: input.filePath })
  const existing = await api.loadChat({ projectId: ids.projectId, chatId: ids.chatId, limit: 1 })
  if (!shouldSeedHandoff(existing)) return false
  const handoff: ChatHandoffMeta = { title: handoffTitle(input) }
  await api.appendChat({
    projectId: ids.projectId,
    chatId: ids.chatId,
    role: 'assistant',
    text,
    handoff,
  })
  return true
}

/** Splits loaded chat history into the carried handoff (first message only) and the real conversation. */
export function splitHandoff<T extends Pick<ChatMessage, 'text' | 'handoff'>>(
  messages: readonly T[],
): { handoff: { title: string; text: string } | null; rest: T[] } {
  const first = messages[0]
  if (first?.handoff) {
    return {
      handoff: { title: first.handoff.title, text: first.text },
      rest: messages.slice(1) as T[],
    }
  }
  return { handoff: null, rest: [...messages] }
}
