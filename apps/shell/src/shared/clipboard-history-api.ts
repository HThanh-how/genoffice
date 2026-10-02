/** Local clipboard history contract. Payloads stay in GenOffice and are never sent to a service. */
export interface ClipboardHistoryEntry {
  id: string
  /** Absent in histories written before images were supported: those are text. */
  kind?: 'text' | 'image'
  /** Text clips only; empty for images. */
  text: string
  copiedAt: number
  /** Looks like a password, key or other secret: shown masked, still pastes. Never written to disk. */
  sensitive?: boolean
  /** Images only: small data-URL thumbnail for the list. */
  preview?: string
  width?: number
  height?: number
}

export const CLIPBOARD_HISTORY_CHANNELS = {
  getEnabled: 'clipboardHistory:get-enabled',
  setEnabled: 'clipboardHistory:set-enabled',
  getEntries: 'clipboardHistory:get-entries',
  clear: 'clipboardHistory:clear',
  /** Puts an image entry back on the system clipboard so the normal paste path can use it. */
  restoreImage: 'clipboardHistory:restore-image',
} as const

export interface ClipboardHistoryApi {
  getClipboardHistoryEnabled(): Promise<boolean>
  setClipboardHistoryEnabled(enabled: boolean): Promise<boolean>
  getClipboardHistory(): Promise<ClipboardHistoryEntry[]>
  clearClipboardHistory(): Promise<boolean>
  restoreClipboardHistoryImage(id: string): Promise<boolean>
}
