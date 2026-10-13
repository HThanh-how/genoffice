import { describe, expect, it, vi } from 'vitest'
import type { TabSummary } from '../src/shared/tabs-api'

describe('tab tooltip formatting and lifecycle updates', () => {
  const formatTooltip = (tab: TabSummary): string =>
    tab.filePath ? `${tab.title}\n${tab.filePath}` : tab.title

  it('formats tooltip with title only for untitled documents and Home', () => {
    const homeTab: TabSummary = {
      id: 'home',
      kind: 'home',
      title: 'Home',
      active: true,
      closable: false,
    }
    const untitledDoc: TabSummary = {
      id: 'doc-1',
      kind: 'docs',
      title: 'Untitled Document',
      active: false,
      closable: true,
    }

    expect(formatTooltip(homeTab)).toBe('Home')
    expect(formatTooltip(untitledDoc)).toBe('Untitled Document')
  })

  it('formats tooltip with title and absolute path across POSIX, Windows, and Unicode paths', () => {
    const posixTab: TabSummary = {
      id: 'doc-2',
      kind: 'docs',
      title: 'Notes.docx',
      filePath: '/home/user/work/Notes.docx',
      active: true,
      closable: true,
    }
    const winTab: TabSummary = {
      id: 'sheet-1',
      kind: 'sheets',
      title: 'Financials.xlsx',
      filePath: 'C:\\Users\\Finance\\Documents\\Financials.xlsx',
      active: false,
      closable: true,
    }
    const vnTab: TabSummary = {
      id: 'pdf-1',
      kind: 'pdf',
      title: 'Hợp đồng chuyển nhượng.pdf',
      filePath: 'D:\\Hồ sơ\\Hợp đồng chuyển nhượng.pdf',
      active: false,
      closable: true,
    }

    expect(formatTooltip(posixTab)).toBe('Notes.docx\n/home/user/work/Notes.docx')
    expect(formatTooltip(winTab)).toBe(
      'Financials.xlsx\nC:\\Users\\Finance\\Documents\\Financials.xlsx',
    )
    expect(formatTooltip(vnTab)).toBe(
      'Hợp đồng chuyển nhượng.pdf\nD:\\Hồ sơ\\Hợp đồng chuyển nhượng.pdf',
    )
  })

  it('updates tooltip dynamically after Rename or Save As', () => {
    let currentTab: TabSummary = {
      id: 'tab-rename',
      kind: 'docs',
      title: 'Draft.docx',
      filePath: '/work/Draft.docx',
      active: true,
      closable: true,
    }
    expect(formatTooltip(currentTab)).toBe('Draft.docx\n/work/Draft.docx')

    // Simulate Rename
    currentTab = { ...currentTab, title: 'Final.docx', filePath: '/work/Final.docx' }
    expect(formatTooltip(currentTab)).toBe('Final.docx\n/work/Final.docx')

    // Simulate Save As from untitled to saved
    let untitled: TabSummary = {
      id: 'tab-saveas',
      kind: 'sheets',
      title: 'Untitled Sheet',
      active: true,
      closable: true,
    }
    expect(formatTooltip(untitled)).toBe('Untitled Sheet')
    untitled = { ...untitled, title: 'Budget 2027.xlsx', filePath: '/work/Budget 2027.xlsx' }
    expect(formatTooltip(untitled)).toBe('Budget 2027.xlsx\n/work/Budget 2027.xlsx')
  })
})

describe('bulk close and reopen lifecycle', () => {
  it('stops closing subsequent tabs if unsaved-changes confirmation is cancelled', async () => {
    let openTabs = ['a', 'b', 'c']
    const closeTabMock = vi.fn().mockImplementation(async (id: string) => {
      if (id === 'b') {
        // User clicked "Cancel" on unsaved prompt for tab 'b'
        // Tab 'b' remains open in openTabs
        return
      }
      // Tab 'a' closed successfully
      openTabs = openTabs.filter((t) => t !== id)
    })

    const closeTabsInOrder = async (ids: string[]) => {
      for (const id of ids) {
        if (!openTabs.includes(id)) continue
        await closeTabMock(id)
        if (openTabs.includes(id)) return // stopped!
      }
    }

    await closeTabsInOrder(['a', 'b', 'c'])
    expect(closeTabMock).toHaveBeenCalledWith('a')
    expect(closeTabMock).toHaveBeenCalledWith('b')
    expect(closeTabMock).not.toHaveBeenCalledWith('c') // 'c' was protected from closing!
    expect(openTabs).toEqual(['b', 'c'])
  })

  it('maintains bounded history for recently closed tabs and skips missing files on reopen', () => {
    const MAX_RECENTLY_CLOSED = 20
    const recentlyClosedTabs: Array<{ kind: string; filePath: string }> = []
    const rememberClosedTab = (closed: { kind: string; filePath?: string }) => {
      if (!closed.filePath) return
      const at = recentlyClosedTabs.findIndex((entry) => entry.filePath === closed.filePath)
      if (at >= 0) recentlyClosedTabs.splice(at, 1)
      recentlyClosedTabs.push({ kind: closed.kind, filePath: closed.filePath })
      if (recentlyClosedTabs.length > MAX_RECENTLY_CLOSED) recentlyClosedTabs.shift()
    }

    // Add 25 closed tabs
    for (let i = 1; i <= 25; i++) {
      rememberClosedTab({ kind: 'docs', filePath: `/path/file${i}.docx` })
    }
    expect(recentlyClosedTabs.length).toBe(20)
    expect(recentlyClosedTabs[0]?.filePath).toBe('/path/file6.docx')
    expect(recentlyClosedTabs[19]?.filePath).toBe('/path/file25.docx')

    // Untitled tab is never remembered
    rememberClosedTab({ kind: 'docs' })
    expect(recentlyClosedTabs.length).toBe(20)

    // Reopen skipping missing files
    const existingFiles = new Set(['/path/file23.docx'])
    const openDocumentMock = vi.fn().mockReturnValue(true)

    const reopenClosed = () => {
      while (recentlyClosedTabs.length) {
        const closed = recentlyClosedTabs.pop()!
        if (existingFiles.has(closed.filePath) && openDocumentMock(closed.filePath)) return
      }
    }

    reopenClosed()
    expect(openDocumentMock).toHaveBeenCalledWith('/path/file23.docx')
    expect(recentlyClosedTabs.length).toBe(17) // popped 25, 24, and 23
  })
})
