import { writeFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({
  on: vi.fn(),
  parent: {},
  provider: vi.fn(),
  dialog: {} as Record<string, unknown>,
}))
vi.mock('electron', () => ({
  BrowserWindow: class {
    static fromWebContents() {
      return bridge.parent
    }
  },
  dialog: bridge.dialog,
  ipcMain: { on: bridge.on },
  nativeTheme: {},
}))
import { DIALOG_SYNC_CHANNEL, installThemedDialogs, messageBoxHtml } from '../src/message-box'

it('renders buttons, detail and checkbox, and escapes caller text', () => {
  const html = messageBoxHtml({
    type: 'question',
    message: 'Xóa 3 tệp khỏi chỉ mục?',
    detail: 'Tệp gốc không bị xóa. Bạn có thể lập chỉ mục lại bất cứ lúc nào.',
    buttons: ['Xóa', 'Hủy'],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: 'Không hỏi lại',
  })
  expect(html).toContain('Xóa 3 tệp')
  expect(html).toContain('data-i="1"')
  expect(html).toContain('id="cb"')
  expect(messageBoxHtml({ message: '<b>x</b>' })).not.toContain('<b>x</b>')
  if (process.env.MB_PREVIEW) writeFileSync(process.env.MB_PREVIEW, html)
})

it('uses the injected dialog for editor confirmations and cancels safely when it fails', async () => {
  bridge.provider.mockResolvedValue({ response: 0, checkboxChecked: true })
  installThemedDialogs(bridge.provider)
  const handler = bridge.on.mock.calls.find(([channel]) => channel === DIALOG_SYNC_CHANNEL)![1]
  const event = { sender: {}, returnValue: undefined as unknown }
  handler(event, 'confirm', 'Keep edits?')
  await vi.waitFor(() => expect(event.returnValue).toBe(true))
  expect(bridge.provider).toHaveBeenCalledWith(
    bridge.parent,
    expect.objectContaining({
      message: 'Keep edits?',
      buttons: ['OK', 'Cancel'],
      cancelId: 1,
    }),
  )
  bridge.provider.mockRejectedValueOnce(new Error('Window unavailable'))
  event.returnValue = undefined
  handler(event, 'confirm', 'Discard edits?')
  await vi.waitFor(() => expect(event.returnValue).toBe(false))
})

describe('DIALOG synchronization & failure contracts (Contract Section 6)', () => {
  it('DIALOG-01: User accepts confirmation', async () => {
    bridge.provider.mockResolvedValue({ response: 0, checkboxChecked: false })
    const handler = bridge.on.mock.calls.find(([channel]) => channel === DIALOG_SYNC_CHANNEL)![1]
    const event = { sender: {}, returnValue: undefined as unknown }
    handler(event, 'confirm', 'Delete file?')
    await vi.waitFor(() => expect(event.returnValue).toBe(true))
  })

  it('DIALOG-02: User cancels confirmation', async () => {
    bridge.provider.mockResolvedValue({ response: 1, checkboxChecked: false })
    const handler = bridge.on.mock.calls.find(([channel]) => channel === DIALOG_SYNC_CHANNEL)![1]
    const event = { sender: {}, returnValue: undefined as unknown }
    handler(event, 'confirm', 'Delete file?')
    await vi.waitFor(() => expect(event.returnValue).toBe(false))
  })

  it('DIALOG-03: Dialog provider throws and safely cancels', async () => {
    bridge.provider.mockRejectedValue(new Error('Dialog process crashed'))
    const handler = bridge.on.mock.calls.find(([channel]) => channel === DIALOG_SYNC_CHANNEL)![1]
    const event = { sender: {}, returnValue: undefined as unknown }
    handler(event, 'confirm', 'Delete file?')
    await vi.waitFor(() => expect(event.returnValue).toBe(false))
  })

  it('DIALOG-04: Dialog host window is destroyed or unavailable', async () => {
    bridge.provider.mockResolvedValue({ response: 1, checkboxChecked: false })
    const handler = bridge.on.mock.calls.find(([channel]) => channel === DIALOG_SYNC_CHANNEL)![1]
    const event = { sender: null, returnValue: undefined as unknown }
    handler(event, 'confirm', 'Delete file?')
    await vi.waitFor(() => expect(event.returnValue).toBe(false))
  })

  it('DIALOG-05: Two confirmations requested sequentially execute cleanly', async () => {
    bridge.provider
      .mockResolvedValueOnce({ response: 0, checkboxChecked: false })
      .mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const handler = bridge.on.mock.calls.find(([channel]) => channel === DIALOG_SYNC_CHANNEL)![1]
    const event1 = { sender: {}, returnValue: undefined as unknown }
    handler(event1, 'confirm', 'Action 1')
    await vi.waitFor(() => expect(event1.returnValue).toBe(true))

    const event2 = { sender: {}, returnValue: undefined as unknown }
    handler(event2, 'confirm', 'Action 2')
    await vi.waitFor(() => expect(event2.returnValue).toBe(false))
  })

  it('DIALOG-06 & 07: Synchronous showMessageBoxSync path sets returnValue immediately when available', () => {
    const handler = bridge.on.mock.calls.find(([channel]) => channel === DIALOG_SYNC_CHANNEL)![1]
    const mockSync = vi.fn().mockReturnValue(0)
    bridge.dialog.showMessageBoxSync = mockSync
    try {
      const event = { sender: {}, returnValue: undefined as unknown }
      handler(event, 'confirm', 'Sync action')
      expect(event.returnValue).toBe(true)
      expect(mockSync).toHaveBeenCalled()
    } finally {
      delete bridge.dialog.showMessageBoxSync
    }
  })
})
