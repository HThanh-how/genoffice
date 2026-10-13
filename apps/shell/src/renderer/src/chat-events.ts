/**
 * Window event that asks the Home assistant to open, start (or reuse an empty)
 * chat and place text in the composer. Dispatch with
 * `new CustomEvent<ChatPrefillDetail>(CHAT_PREFILL_EVENT, { detail })`.
 */
export const CHAT_PREFILL_EVENT = 'genoffice:chat-prefill'

export type ChatLaunchIntent = 'new' | 'resume' | 'open-existing'

export type ChatPrefillDetail = {
  text: string
  send?: boolean
  /**
   * Explicit launch intent:
   * - 'new': Start a fresh empty conversation.
   * - 'resume': Reopen or keep the active conversation.
   * - 'open-existing': Open a specific saved session by sessionId.
   */
  intent?: ChatLaunchIntent
  sessionId?: string
  /** @deprecated use intent: 'resume' instead */
  continue?: boolean
}

export function requestChatPrefill(detail: ChatPrefillDetail): void {
  window.dispatchEvent(new CustomEvent<ChatPrefillDetail>(CHAT_PREFILL_EVENT, { detail }))
}

/**
 * Window event the Home assistant dispatches whenever its panel opens or closes,
 * so overlays that sit beneath it (the clipboard chip) can step aside.
 */
export const CHAT_PANEL_EVENT = 'genoffice:chat-panel'

export type ChatPanelDetail = { open: boolean }

export function announceChatPanel(open: boolean): void {
  window.dispatchEvent(new CustomEvent<ChatPanelDetail>(CHAT_PANEL_EVENT, { detail: { open } }))
}
