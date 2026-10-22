import { createHash } from 'node:crypto'
import type { AgentMessage } from '@genoffice/agent-core'

/** Opt in until stream-json resume has also been verified against a real CLI. */
export function agyResumeEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.GENOFFICE_AGY_RESUME === '1'
}

export function agyConversationError(error: unknown): boolean {
  return (
    error instanceof Error && error.name !== 'AbortError' && /conversation/i.test(error.message)
  )
}

export function agyHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Hash all input, including tool IDs/error flags; normalize only absent empty arrays. */
export function agyMessageHash(message: AgentMessage): string {
  if (message.role === 'assistant') {
    return agyHash({
      role: message.role,
      text: message.text,
      toolCalls: message.toolCalls ?? [],
      reasoning: message.reasoning,
    })
  }
  if (message.role === 'user') {
    return agyHash({ role: message.role, text: message.text, images: message.images ?? [] })
  }
  return agyHash(message)
}

/** A completed assistant reply is part of the prefix, never sent a second time. */
export function agyAppendOnly(
  messages: readonly AgentMessage[],
  hashes: readonly string[],
): boolean {
  return (
    messages.length > hashes.length &&
    hashes.every((hash, i) => agyMessageHash(messages[i]!) === hash) &&
    messages.slice(hashes.length).every((message) => message.role !== 'assistant') &&
    !messages.some((message) => message.role === 'user' && message.images?.length)
  )
}

export interface AgyConversation {
  id: string
  signature: string
  hashes: string[]
}

export interface AgyConversationTurn {
  previous?: AgyConversation | undefined
  signature?: string | undefined
  conversationId?: string | undefined
}

/** Memory only, bounded, and isolated by transport deps (also keeps mocked runners separate). */
class ConversationStore {
  private readonly sessions = new Map<string, AgyConversation>()
  private readonly locks = new Map<string, Promise<void>>()

  async turn(
    key: string,
    run: (previous: AgyConversation | undefined) => Promise<AgyConversation | undefined>,
  ): Promise<void> {
    const previousLock = this.locks.get(key)
    let release!: () => void
    const lock = new Promise<void>((resolve) => {
      release = resolve
    })
    this.locks.set(key, lock)
    await previousLock
    try {
      const previous = this.sessions.get(key)
      // Any failure or retry leaves no possibly mutated conversation to resume.
      this.sessions.delete(key)
      const next = await run(previous)
      if (next) {
        this.sessions.set(key, next)
        if (this.sessions.size > 128) this.sessions.delete(this.sessions.keys().next().value!)
      }
    } finally {
      release()
      if (this.locks.get(key) === lock) this.locks.delete(key)
    }
  }
}

const stores = new WeakMap<object, ConversationStore>()
export function agyConversationStore(owner: object): ConversationStore {
  let store = stores.get(owner)
  if (!store) {
    store = new ConversationStore()
    stores.set(owner, store)
  }
  return store
}
