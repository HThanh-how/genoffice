import type { MenuItemConstructorOptions } from 'electron'
import type { TabSummary } from '../../shared/tabs-api'

const EN = {
  rename: 'Rename',
  duplicate: 'Duplicate (copy the saved file)',
  splitBeside: 'Split side by side',
  copyPath: 'Copy path',
  copyName: 'Copy file name',
  reveal: 'Show in folder',
  openDefault: 'Open with the default app',
  moveLeft: 'Move left',
  moveRight: 'Move right',
  closeOthers: 'Close other tabs',
  closeRight: 'Close tabs to the right',
  closeAll: 'Close all tabs',
  reopen: 'Reopen closed tab',
}
const VI: typeof EN = {
  rename: 'Đổi tên',
  duplicate: 'Nhân bản (sao chép file đã lưu)',
  splitBeside: 'Chia đôi màn hình',
  copyPath: 'Sao chép đường dẫn',
  copyName: 'Sao chép tên file',
  reveal: 'Mở thư mục chứa file',
  openDefault: 'Mở bằng ứng dụng mặc định',
  moveLeft: 'Dời sang trái',
  moveRight: 'Dời sang phải',
  closeOthers: 'Đóng các thẻ khác',
  closeRight: 'Đóng các thẻ bên phải',
  closeAll: 'Đóng tất cả các thẻ',
  reopen: 'Mở lại thẻ vừa đóng',
}

/** Words for the tab menu: Vietnamese, else English (the shell's other languages keep English). */
export const tabMenuWords = (lang: string): typeof EN => (lang === 'vi' ? VI : EN)

/** What each menu entry does; the shell supplies these, the menu only decides what is offered. */
export interface TabMenuActions {
  openInNewWindow(id: string): void
  splitBeside(id: string): void
  rename(id: string): void
  duplicate(path: string): void
  copyText(text: string): void
  reveal(path: string): void
  openDefault(path: string): void
  move(id: string, toIndex: number): void
  /** close these tabs one after another (a save prompt that is cancelled stops the rest) */
  closeTabs(ids: string[]): void
  reopenClosed(): void
}

export interface TabMenuInput {
  tab: TabSummary
  /** every tab in strip order, Home first */
  tabs: readonly TabSummary[]
  canDetach: boolean
  /** the file behind the tab is still on disk */
  fileExists: boolean
  /** something was closed that can be opened again */
  canReopen: boolean
  words: typeof EN
  /** the shell's existing, fully translated labels */
  labels: { openInNewWindow: string; close: string }
  actions: TabMenuActions
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/**
 * The right-click menu of a document tab: what to do with the tab (move, split, close the others)
 * and with its file (rename, copy, duplicate, reveal). Entries that need a file on disk are shown
 * but off for an untitled document, and "close" ones only count tabs that can be closed.
 */
export function tabMenuTemplate(input: TabMenuInput): MenuItemConstructorOptions[] {
  const { tab, tabs, words, actions } = input
  const index = tabs.findIndex((other) => other.id === tab.id)
  const file = tab.filePath
  const onDisk = !!file && input.fileExists
  const closable = (other: TabSummary): boolean => other.id !== 'home' && other.closable
  const others = tabs.filter((other) => other.id !== tab.id && closable(other))
  const right = tabs.slice(index + 1).filter(closable)
  const everything = tabs.filter(closable)
  return [
    { label: words.rename, enabled: !!file, click: () => actions.rename(tab.id) },
    { label: words.duplicate, enabled: onDisk, click: () => actions.duplicate(file!) },
    { type: 'separator' },
    {
      label: words.splitBeside,
      enabled: input.canDetach,
      click: () => actions.splitBeside(tab.id),
    },
    {
      label: input.labels.openInNewWindow,
      enabled: input.canDetach,
      click: () => actions.openInNewWindow(tab.id),
    },
    { type: 'separator' },
    { label: words.copyPath, enabled: !!file, click: () => actions.copyText(file!) },
    { label: words.copyName, enabled: !!file, click: () => actions.copyText(baseName(file!)) },
    { label: words.reveal, enabled: onDisk, click: () => actions.reveal(file!) },
    { label: words.openDefault, enabled: onDisk, click: () => actions.openDefault(file!) },
    { type: 'separator' },
    {
      label: words.moveLeft,
      enabled: index > 1,
      click: () => actions.move(tab.id, index - 1),
    },
    {
      label: words.moveRight,
      enabled: index >= 1 && index < tabs.length - 1,
      click: () => actions.move(tab.id, index + 1),
    },
    { type: 'separator' },
    { label: input.labels.close, enabled: closable(tab), click: () => actions.closeTabs([tab.id]) },
    {
      label: words.closeOthers,
      enabled: others.length > 0,
      click: () => actions.closeTabs(others.map((other) => other.id)),
    },
    {
      label: words.closeRight,
      enabled: right.length > 0,
      click: () => actions.closeTabs(right.map((other) => other.id)),
    },
    {
      label: words.closeAll,
      enabled: everything.length > 0,
      click: () => actions.closeTabs(everything.map((other) => other.id)),
    },
    { type: 'separator' },
    { label: words.reopen, enabled: input.canReopen, click: () => actions.reopenClosed() },
  ]
}
