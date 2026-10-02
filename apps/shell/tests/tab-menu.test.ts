import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import type { TabSummary } from '../src/shared/tabs-api'
import {
  tabMenuTemplate,
  tabMenuWords,
  type TabMenuActions,
  type TabMenuInput,
} from '../src/main/fork/tab-menu'

const tab = (id: string, extra: Partial<TabSummary> = {}): TabSummary => ({
  id,
  kind: 'docs',
  title: id,
  closable: true,
  active: false,
  ...extra,
})
const home = tab('home', { kind: 'home', closable: false })

function actions(): TabMenuActions {
  return {
    openInNewWindow: vi.fn(),
    splitBeside: vi.fn(),
    rename: vi.fn(),
    duplicate: vi.fn(),
    copyText: vi.fn(),
    reveal: vi.fn(),
    openDefault: vi.fn(),
    move: vi.fn(),
    closeTabs: vi.fn(),
    reopenClosed: vi.fn(),
  }
}

function menu(
  current: TabSummary,
  tabs: TabSummary[],
  extra: Partial<TabMenuInput> = {},
): { items: Map<string, MenuItemConstructorOptions>; actions: TabMenuActions } {
  const given = actions()
  const template = tabMenuTemplate({
    tab: current,
    tabs,
    canDetach: true,
    fileExists: true,
    canReopen: true,
    words: tabMenuWords('en'),
    labels: { openInNewWindow: 'Open in New Window', close: 'Close' },
    actions: given,
    ...extra,
  })
  const items = new Map<string, MenuItemConstructorOptions>()
  for (const item of template) if (item.label) items.set(item.label, item)
  return { items, actions: given }
}
const click = (item: MenuItemConstructorOptions | undefined): void =>
  (item!.click as unknown as () => void)()
const enabled = (item: MenuItemConstructorOptions | undefined): boolean => item!.enabled !== false

describe('the tab context menu', () => {
  const a = tab('a', { filePath: 'D:\\docs\\Hợp đồng.docx' })
  const b = tab('b')
  const c = tab('c', { filePath: 'D:\\docs\\bảng.xlsx' })
  const all = [home, a, b, c]

  it('offers file actions for a saved document and runs them on its path', () => {
    const { items, actions: given } = menu(a, all)
    for (const label of [
      'Rename',
      'Duplicate (copy the saved file)',
      'Copy path',
      'Copy file name',
      'Show in folder',
      'Open with the default app',
    ])
      expect(enabled(items.get(label)), label).toBe(true)

    click(items.get('Copy path'))
    click(items.get('Copy file name'))
    click(items.get('Duplicate (copy the saved file)'))
    click(items.get('Rename'))
    expect(given.copyText).toHaveBeenNthCalledWith(1, 'D:\\docs\\Hợp đồng.docx')
    expect(given.copyText).toHaveBeenNthCalledWith(2, 'Hợp đồng.docx')
    expect(given.duplicate).toHaveBeenCalledWith('D:\\docs\\Hợp đồng.docx')
    expect(given.rename).toHaveBeenCalledWith('a')
  })

  it('switches off what needs a file for an untitled document, or one gone from the disk', () => {
    const untitled = menu(b, all).items
    for (const label of [
      'Rename',
      'Duplicate (copy the saved file)',
      'Copy path',
      'Copy file name',
    ])
      expect(enabled(untitled.get(label)), label).toBe(false)

    const gone = menu(a, all, { fileExists: false }).items
    expect(enabled(gone.get('Copy path'))).toBe(true)
    for (const label of [
      'Duplicate (copy the saved file)',
      'Show in folder',
      'Open with the default app',
    ])
      expect(enabled(gone.get(label)), label).toBe(false)
  })

  it('closes the other tabs, the tabs to the right, or all of them, never Home', () => {
    const { items, actions: given } = menu(a, all)
    click(items.get('Close'))
    click(items.get('Close other tabs'))
    click(items.get('Close tabs to the right'))
    click(items.get('Close all tabs'))
    expect(given.closeTabs).toHaveBeenNthCalledWith(1, ['a'])
    expect(given.closeTabs).toHaveBeenNthCalledWith(2, ['b', 'c'])
    expect(given.closeTabs).toHaveBeenNthCalledWith(3, ['b', 'c'])
    expect(given.closeTabs).toHaveBeenNthCalledWith(4, ['a', 'b', 'c'])
  })

  it('leaves out tabs that cannot be closed and switches off what has nothing to do', () => {
    const pinned = tab('pinned', { closable: false })
    const last = menu(c, [home, pinned, c]).items
    expect(enabled(last.get('Close tabs to the right'))).toBe(false)
    expect(enabled(last.get('Move right'))).toBe(false)
    expect(enabled(last.get('Move left'))).toBe(true)

    const only = menu(a, [home, a]).items
    expect(enabled(only.get('Close other tabs'))).toBe(false)
    expect(enabled(only.get('Close all tabs'))).toBe(true)
    expect(enabled(only.get('Move left'))).toBe(false)

    // the tab strip keeps Home first: the first document tab cannot move into its place
    expect(enabled(menu(a, all).items.get('Move left'))).toBe(false)
  })

  it('moves a tab one place and splits it into a window of its own', () => {
    const { items, actions: given } = menu(b, all)
    click(items.get('Move left'))
    click(items.get('Move right'))
    click(items.get('Split side by side'))
    click(items.get('Open in New Window'))
    expect(given.move).toHaveBeenNthCalledWith(1, 'b', 1)
    expect(given.move).toHaveBeenNthCalledWith(2, 'b', 3)
    expect(given.splitBeside).toHaveBeenCalledWith('b')
    expect(given.openInNewWindow).toHaveBeenCalledWith('b')

    const stuck = menu(b, all, { canDetach: false }).items
    expect(enabled(stuck.get('Split side by side'))).toBe(false)
    expect(enabled(stuck.get('Open in New Window'))).toBe(false)
  })

  it('reopens a closed tab only when there is one', () => {
    expect(enabled(menu(a, all, { canReopen: false }).items.get('Reopen closed tab'))).toBe(false)
    const { items, actions: given } = menu(a, all)
    click(items.get('Reopen closed tab'))
    expect(given.reopenClosed).toHaveBeenCalled()
  })

  it('speaks Vietnamese when asked to, and English otherwise', () => {
    expect(tabMenuWords('vi').closeOthers).toBe('Đóng các thẻ khác')
    expect(tabMenuWords('fr').closeOthers).toBe('Close other tabs')
  })
})
