/** Local clipboard history contract. Payloads stay in GenOffice and are never sent to a service. */
export interface ClipboardHistoryEntry {
  id: string
  text: string
  copiedAt: number
}

export const CLIPBOARD_HISTORY_CHANNELS = {
  getEnabled: 'clipboardHistory:get-enabled',
  setEnabled: 'clipboardHistory:set-enabled',
  getEntries: 'clipboardHistory:get-entries',
  clear: 'clipboardHistory:clear',
} as const

export interface ClipboardHistoryApi {
  getClipboardHistoryEnabled(): Promise<boolean>
  setClipboardHistoryEnabled(enabled: boolean): Promise<boolean>
  getClipboardHistory(): Promise<ClipboardHistoryEntry[]>
  clearClipboardHistory(): Promise<boolean>
}
