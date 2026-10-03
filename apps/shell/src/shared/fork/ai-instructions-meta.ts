/** Languages the AI can be told to answer in. "auto" adds no instruction (each app's own rule applies). */
export const REPLY_LANGUAGES = [
  { code: 'vi', label: 'Tiếng Việt', english: 'Vietnamese' },
  { code: 'en', label: 'English', english: 'English' },
  { code: 'zh', label: '简体中文', english: 'Simplified Chinese' },
  { code: 'zh-TW', label: '繁體中文', english: 'Traditional Chinese' },
  { code: 'ja', label: '日本語', english: 'Japanese' },
  { code: 'ko', label: '한국어', english: 'Korean' },
  { code: 'fr', label: 'Français', english: 'French' },
  { code: 'de', label: 'Deutsch', english: 'German' },
  { code: 'es', label: 'Español', english: 'Spanish' },
  { code: 'pt', label: 'Português', english: 'Portuguese' },
  { code: 'ru', label: 'Русский', english: 'Russian' },
  { code: 'th', label: 'ไทย', english: 'Thai' },
  { code: 'id', label: 'Bahasa Indonesia', english: 'Indonesian' },
] as const

export type ReplyLanguage = (typeof REPLY_LANGUAGES)[number]['code'] | 'auto'
export const DEFAULT_REPLY_LANGUAGE: ReplyLanguage = 'vi'
/** longest instructions text that is sent (more would eat the context of every message) */
export const MAX_INSTRUCTIONS_CHARS = 8000

export interface AiInstructionsState {
  language: ReplyLanguage
  text: string
  /** the file the text lives in, for "open in my editor" */
  path: string
}

export function normalizeReplyLanguage(value: unknown): ReplyLanguage {
  return value === 'auto' || REPLY_LANGUAGES.some((l) => l.code === value)
    ? (value as ReplyLanguage)
    : DEFAULT_REPLY_LANGUAGE
}

export const AI_INSTRUCTIONS_CHANNELS = {
  get: 'ai-instructions:get',
  setLanguage: 'ai-instructions:set-language',
  setText: 'ai-instructions:set-text',
  openFile: 'ai-instructions:open-file',
} as const

/** Renderer-facing methods, merged into HomeApi through ForkHomeApi. */
export interface AiInstructionsApi {
  getAiInstructions(): Promise<AiInstructionsState>
  setAiReplyLanguage(language: ReplyLanguage): Promise<AiInstructionsState>
  setAiInstructionsText(text: string): Promise<AiInstructionsState>
  /** open the instructions file in the person's own editor */
  openAiInstructionsFile(): Promise<void>
}
