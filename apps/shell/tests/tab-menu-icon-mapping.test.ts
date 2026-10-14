import { describe, expect, it, vi } from 'vitest'
import type { NativeImage } from 'electron'
import type { TabSummary } from '../src/shared/tabs-api'
import {
  tabMenuTemplate,
  tabMenuWords,
  type TabMenuActions,
  type TabMenuIcon,
} from '../src/main/tab-menu'

const ALL_18_ACTIONS: TabMenuIcon[] = [
  'save',
  'saveAs',
  'print',
  'rename',
  'duplicate',
  'splitBeside',
  'openInNewWindow',
  'copyPath',
  'copyName',
  'reveal',
  'openDefault',
  'moveLeft',
  'moveRight',
  'close',
  'closeOthers',
  'closeRight',
  'closeAll',
  'reopen',
]

function mockNativeImage(id: string): NativeImage {
  return {
    isEmpty: () => false,
    getSize: () => ({ width: 16, height: 16 }),
    toPNG: () => Buffer.from(id),
    __mockId: id,
  } as unknown as NativeImage
}

function dummyActions(): TabMenuActions {
  return {
    save: vi.fn(),
    saveAs: vi.fn(),
    print: vi.fn(),
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

describe('tab menu icon mapping', () => {
  const currentTab: TabSummary = {
    id: 'tab-1',
    kind: 'docs',
    title: 'Document.docx',
    filePath: '/tmp/Document.docx',
    closable: true,
    active: true,
  }
  const otherTab: TabSummary = {
    id: 'tab-2',
    kind: 'docs',
    title: 'Other.docx',
    filePath: '/tmp/Other.docx',
    closable: true,
    active: false,
  }
  const tabs = [currentTab, otherTab]

  it('all 18 action IDs are unique and present in the menu template', () => {
    const raw = tabMenuTemplate({
      tab: currentTab,
      tabs,
      canDetach: true,
      fileExists: true,
      canReopen: true,
      words: tabMenuWords('en'),
      labels: { openInNewWindow: 'Open in New Window', close: 'Close' },
      actions: dummyActions(),
    })

    const actionItems = raw.filter((i) => i.type !== 'separator' && i.id)
    const ids = actionItems.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(18)
    for (const expectedId of ALL_18_ACTIONS) {
      expect(ids).toContain(expectedId)
    }
  })

  it('every action maps to its matching icon from input.icons by stable ID', () => {
    const mockIcons: Partial<Record<TabMenuIcon, NativeImage>> = {}
    for (const actionId of ALL_18_ACTIONS) {
      mockIcons[actionId] = mockNativeImage(`icon-${actionId}`)
    }

    const raw = tabMenuTemplate({
      tab: currentTab,
      tabs,
      canDetach: true,
      fileExists: true,
      canReopen: true,
      words: tabMenuWords('en'),
      labels: { openInNewWindow: 'Open in New Window', close: 'Close' },
      actions: dummyActions(),
      icons: mockIcons,
    })

    for (const item of raw) {
      if (item.type === 'separator' || !item.id) continue
      const expectedMock = mockIcons[item.id as TabMenuIcon]
      expect(item.icon).toBe(expectedMock)
    }
  })

  it('separators and file path header never receive icons', () => {
    const mockIcons: Partial<Record<TabMenuIcon, NativeImage>> = {}
    for (const actionId of ALL_18_ACTIONS) {
      mockIcons[actionId] = mockNativeImage(`icon-${actionId}`)
    }

    const raw = tabMenuTemplate({
      tab: currentTab,
      tabs,
      canDetach: true,
      fileExists: true,
      canReopen: true,
      words: tabMenuWords('en'),
      labels: { openInNewWindow: 'Open in New Window', close: 'Close' },
      actions: dummyActions(),
      icons: mockIcons,
    })

    const separators = raw.filter((i) => i.type === 'separator')
    expect(separators.length).toBeGreaterThan(0)
    for (const sep of separators) {
      expect(sep.icon).toBeUndefined()
    }

    // Path header (first item when file exists)
    const pathHeader = raw[0]
    expect(pathHeader.label).toContain('Document.docx')
    expect(pathHeader.icon).toBeUndefined()
  })

  it('icon mapping is independent of translated presentation text (en, vi, zh, fr, de, ja)', () => {
    const mockIcons: Partial<Record<TabMenuIcon, NativeImage>> = {}
    for (const actionId of ALL_18_ACTIONS) {
      mockIcons[actionId] = mockNativeImage(`icon-${actionId}`)
    }

    const languages = ['en', 'vi', 'zh', 'zh-tw', 'fr', 'de', 'ja', 'ko', 'es', 'ru', 'pt', 'it']
    for (const lang of languages) {
      const raw = tabMenuTemplate({
        tab: currentTab,
        tabs,
        canDetach: true,
        fileExists: true,
        canReopen: true,
        words: tabMenuWords(lang),
        labels: { openInNewWindow: `Window_${lang}`, close: `Close_${lang}` },
        actions: dummyActions(),
        icons: mockIcons,
      })

      for (const item of raw) {
        if (item.type === 'separator' || !item.id) continue
        expect(item.icon, `Action ${item.id} in ${lang}`).toBe(mockIcons[item.id as TabMenuIcon])
      }
    }
  })

  it('two actions with identical translated labels still receive distinct icons by ID', () => {
    const mockIcons: Partial<Record<TabMenuIcon, NativeImage>> = {
      save: mockNativeImage('icon-save'),
      saveAs: mockNativeImage('icon-saveAs'),
    }

    // Custom words where save and saveAs have the exact same label
    const collisionWords = { ...tabMenuWords('en'), save: 'Lưu', saveAs: 'Lưu' }
    const raw = tabMenuTemplate({
      tab: currentTab,
      tabs,
      canDetach: true,
      fileExists: true,
      canReopen: true,
      words: collisionWords,
      labels: { openInNewWindow: 'Open', close: 'Close' },
      actions: dummyActions(),
      icons: mockIcons,
    })

    const saveItem = raw.find((i) => i.id === 'save')
    const saveAsItem = raw.find((i) => i.id === 'saveAs')
    expect(saveItem?.icon).toBe(mockIcons.save)
    expect(saveAsItem?.icon).toBe(mockIcons.saveAs)
    expect(saveItem?.icon).not.toBe(saveAsItem?.icon)
  })

  it('missing optional icons or empty icon map never crashes menu construction', () => {
    expect(() =>
      tabMenuTemplate({
        tab: currentTab,
        tabs,
        canDetach: true,
        fileExists: true,
        canReopen: true,
        words: tabMenuWords('en'),
        labels: { openInNewWindow: 'Open in New Window', close: 'Close' },
        actions: dummyActions(),
        icons: undefined,
      }),
    ).not.toThrow()

    expect(() =>
      tabMenuTemplate({
        tab: currentTab,
        tabs,
        canDetach: true,
        fileExists: true,
        canReopen: true,
        words: tabMenuWords('en'),
        labels: { openInNewWindow: 'Open in New Window', close: 'Close' },
        actions: dummyActions(),
        icons: {},
      }),
    ).not.toThrow()
  })

  it('Save, Save As and Print keep the same callbacks and IDs', () => {
    const acts = dummyActions()
    const raw = tabMenuTemplate({
      tab: currentTab,
      tabs,
      canDetach: true,
      fileExists: true,
      canReopen: true,
      words: tabMenuWords('en'),
      labels: { openInNewWindow: 'Open in New Window', close: 'Close' },
      actions: acts,
    })

    const save = raw.find((i) => i.id === 'save')
    const saveAs = raw.find((i) => i.id === 'saveAs')
    const print = raw.find((i) => i.id === 'print')

    expect(save).toBeDefined()
    expect(saveAs).toBeDefined()
    expect(print).toBeDefined()

    ;(save!.click as () => void)()
    ;(saveAs!.click as () => void)()
    ;(print!.click as () => void)()

    expect(acts.save).toHaveBeenCalledWith('tab-1')
    expect(acts.saveAs).toHaveBeenCalledWith('tab-1')
    expect(acts.print).toHaveBeenCalledWith('tab-1')
  })
})
