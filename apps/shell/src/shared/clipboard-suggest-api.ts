/**
 * Contract for the opt-in clipboard suggestion chip (main <-> renderer).
 * Pure types and helpers only — no Electron imports — so both sides and the
 * tests can share it.
 */

export type ClipboardKind =
  'url' | 'longText' | 'shortText' | 'question' | 'paths' | 'table' | 'contact' | 'code'

export type ClipboardActionId =
  | 'summarize'
  | 'translate'
  | 'rewrite'
  | 'ask'
  | 'findRelated'
  | 'analyze'
  | 'toSheet'
  | 'explainCode'
  | 'organize'

/** What the renderer gets: a truncated preview, never the full clipboard. */
export interface ClipboardSuggestion {
  /** opaque id; the full text is fetched on demand with it */
  id: string
  kind: ClipboardKind
  /** whitespace-collapsed, at most CLIPBOARD_PREVIEW_MAX characters */
  preview: string
  /** 1-3 suggested actions, best first */
  actions: ClipboardActionId[]
  /** true when the content is over the size cap and only its head is used */
  truncated: boolean
}

export const CLIPBOARD_PREVIEW_MAX = 160
export const CLIPBOARD_MIN_CHARS = 12
export const CLIPBOARD_MAX_CHARS = 20_000
/** how long the renderer shows a chip before hiding it */
export const CLIPBOARD_VISIBLE_MS = 12_000

export const CLIPBOARD_SUGGEST_CHANNELS = {
  getEnabled: 'clipboardSuggest:get-enabled',
  setEnabled: 'clipboardSuggest:set-enabled',
  getCurrent: 'clipboardSuggest:get-current',
  dismiss: 'clipboardSuggest:dismiss',
  getFullText: 'clipboardSuggest:get-full-text',
  /** main -> renderer: a new suggestion, or null when it was cleared */
  changed: 'clipboardSuggest:changed',
} as const

export interface ClipboardSuggestApi {
  /** opt-in; false until the user turns it on in Settings -> General */
  getClipboardSuggestEnabled(): Promise<boolean>
  setClipboardSuggestEnabled(enabled: boolean): Promise<boolean>
  getClipboardSuggestion(): Promise<ClipboardSuggestion | null>
  dismissClipboardSuggestion(id: string): Promise<void>
  /** full clipboard text for a suggestion the user clicked (null if expired) */
  getClipboardSuggestionText(id: string): Promise<string | null>
  onClipboardSuggestion(handler: (suggestion: ClipboardSuggestion | null) => void): () => void
}

/**
 * Compose the chat prefill from the localized action label and the copied
 * text. "ask" sends the text as-is; everything else is "<label>:\n\n<text>".
 */
export function buildClipboardPrefill(
  action: ClipboardActionId,
  label: string,
  text: string,
): string {
  if (action === 'ask') return text
  return `${label}:\n\n${text}`
}
