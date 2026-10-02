import { writeFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {}, dialog: {}, ipcMain: {}, nativeTheme: {} }))
import { messageBoxHtml } from '../src/message-box'

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
