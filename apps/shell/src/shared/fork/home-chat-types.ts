/** Persisted Home assistant conversations (stored under userData/home-chat-sessions). */

/** A cited document. Only display fields are kept; passages are never stored. */
export interface HomeChatSource {
  /** 0 for a file found by name only; then `path` is what opens it */
  documentId: number
  path?: string
  name: string
  location: string
  /** the file changed on disk since it was indexed */
  stale?: boolean
  /** the file no longer exists */
  missing?: boolean
  /** the source file cannot currently be verified */
  unverified?: boolean
  /** only the outline of this document is kept (repeated body compacted); opening it re-reads the full text */
  skeletonIndex?: boolean
}

export interface HomeChatMessage {
  role: 'user' | 'assistant'
  text: string
  sources?: HomeChatSource[]
  error?: string
}

export interface HomeChatSessionSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

export interface HomeChatSession extends Omit<HomeChatSessionSummary, 'messageCount'> {
  messages: HomeChatMessage[]
}

/**
 * Save input. Omit `id` to create a session (the main process generates it).
 * `title`, `createdAt` and `updatedAt` are only honoured when the session is
 * created or re-created (undoing a delete); later saves keep the stored values.
 */
export interface HomeChatSaveInput {
  id?: string
  title?: string
  createdAt?: number
  updatedAt?: number
  messages: HomeChatMessage[]
}

export const HOME_CHAT_CHANNELS = {
  list: 'homeChatHistory:list',
  get: 'homeChatHistory:get',
  save: 'homeChatHistory:save',
  rename: 'homeChatHistory:rename',
  delete: 'homeChatHistory:delete',
  clear: 'homeChatHistory:clear',
} as const

export const HOME_CHAT_LIMITS = {
  maxSessions: 200,
  maxMessages: 400,
  maxTextChars: 60_000,
  maxSources: 12,
  maxTitleChars: 80,
  /** serialized size of one session file */
  maxSessionBytes: 1_000_000,
} as const

/** Renderer-facing API, exposed on window.aiOffice by the preload fork module. */
export interface HomeChatApi {
  homeChatList(): Promise<HomeChatSessionSummary[]>
  homeChatGet(id: string): Promise<HomeChatSession | null>
  homeChatSave(input: HomeChatSaveInput): Promise<HomeChatSessionSummary | null>
  homeChatRename(id: string, title: string): Promise<HomeChatSessionSummary | null>
  homeChatDelete(id: string): Promise<boolean>
  homeChatClear(): Promise<number>
}
