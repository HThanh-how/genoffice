import { writeFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({ on: vi.fn(), parent: {} }))
vi.mock('electron', () => ({
  BrowserWindow: class {
    static fromWebContents() {
      return bridge.parent
    }
  },
  dialog: {},
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
  const provider = vi.fn().mockResolvedValue({ response: 0, checkboxChecked: true })
  installThemedDialogs(provider)
  const handler = bridge.on.mock.calls.find(([channel]) => channel === DIALOG_SYNC_CHANNEL)![1]
  const event = { sender: {}, returnValue: undefined as unknown }
  handler(event, 'confirm', 'Keep edits?')
  await vi.waitFor(() => expect(event.returnValue).toBe(true))
  expect(provider).toHaveBeenCalledWith(
    bridge.parent,
    expect.objectContaining({
      message: 'Keep edits?',
      buttons: ['OK', 'Cancel'],
      cancelId: 1,
    }),
  )
  provider.mockRejectedValueOnce(new Error('Window unavailable'))
  event.returnValue = undefined
  handler(event, 'confirm', 'Discard edits?')
  await vi.waitFor(() => expect(event.returnValue).toBe(false))
})
