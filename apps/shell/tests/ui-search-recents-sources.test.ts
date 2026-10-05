// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SearchResults } from '../src/renderer/src/fork/SearchResults'
import { RecentFiles } from '../src/renderer/src/fork/RecentFiles'
import { IndexedFolders } from '../src/renderer/src/fork/IndexedFolders'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { HomeApi } from '../src/shared/home-api'

describe('UI Audit Fixes: SearchResults, RecentFiles & IndexedFolders', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    vi.useRealTimers()
  })

  describe('SearchResults', () => {
    it('FIX UI-1: does not trigger search open when focus is outside search scope', async () => {
      const openPathMock = vi.fn().mockResolvedValue(true)
      const searchFilesMock = vi.fn().mockResolvedValue({
        hits: [
          {
            path: 'D:/docs/report.docx',
            name: 'report.docx',
            mtimeMs: Date.now(),
            sizeBytes: 1024,
            needles: ['report'],
          },
        ],
        index: { pending: 0, scanning: false },
      })

      const api = {
        openPath: openPathMock,
        searchFiles: searchFilesMock,
      } as unknown as HomeApi

      const onOpened = vi.fn()

      // Create an outside button (like Pause/Scan button)
      const outsideButton = document.createElement('button')
      outsideButton.textContent = 'Pause'
      document.body.appendChild(outsideButton)

      await act(async () => {
        root.render(
          createElement(LocaleProvider, {
            initial: 'vi',
            children: createElement(SearchResults, {
              api,
              query: 'report',
              onOpened,
            }),
          }),
        )
      })

      // Fast-forward debounce
      await act(async () => {
        vi.advanceTimersByTime(150)
      })

      // Focus on outside button
      outsideButton.focus()
      expect(document.activeElement).toBe(outsideButton)

      // Press Enter while focused on outside button
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      expect(openPathMock).not.toHaveBeenCalled()
      expect(onOpened).not.toHaveBeenCalled()

      // Now create and focus a mock search input
      const searchInput = document.createElement('input')
      searchInput.className = 'idx-search-hero-input'
      document.body.appendChild(searchInput)
      searchInput.focus()
      expect(document.activeElement).toBe(searchInput)

      // Press Enter while in search input
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      expect(openPathMock).toHaveBeenCalledWith('D:/docs/report.docx')

      outsideButton.remove()
      searchInput.remove()
    })

    it('FIX UI-2: displays openError banner and does not close dashboard on open failure', async () => {
      const openPathMock = vi.fn().mockRejectedValue(new Error('Drive disconnected'))
      const searchFilesMock = vi.fn().mockResolvedValue({
        hits: [
          {
            path: 'E:/missing.docx',
            name: 'missing.docx',
            mtimeMs: Date.now(),
            sizeBytes: 1024,
            needles: ['missing'],
          },
        ],
        index: { pending: 0, scanning: false },
      })

      const api = {
        openPath: openPathMock,
        searchFiles: searchFilesMock,
      } as unknown as HomeApi

      const onOpened = vi.fn()

      await act(async () => {
        root.render(
          createElement(LocaleProvider, {
            initial: 'vi',
            children: createElement(SearchResults, {
              api,
              query: 'missing',
              onOpened,
            }),
          }),
        )
      })

      await act(async () => {
        vi.advanceTimersByTime(150)
      })

      // Click on the hit item
      const item = container.querySelector('.idx-search-hit-item') as HTMLElement
      expect(item).not.toBeNull()

      await act(async () => {
        item.click()
      })

      expect(openPathMock).toHaveBeenCalledWith('E:/missing.docx')
      expect(onOpened).not.toHaveBeenCalled()

      // Banner must be visible
      const errorBanner = container.querySelector('.idx-search-open-error')
      expect(errorBanner).not.toBeNull()
      expect(errorBanner?.textContent).toContain('Không thể mở tệp')
    })

    it('FIX UI-3: auto-refreshes search results every 2000ms while indexing is pending', async () => {
      let callCount = 0
      const searchFilesMock = vi.fn().mockImplementation(async () => {
        callCount++
        return {
          hits: [
            {
              path: `D:/doc_${callCount}.docx`,
              name: `doc_${callCount}.docx`,
              mtimeMs: Date.now(),
              sizeBytes: 1024,
              needles: ['doc'],
            },
          ],
          index: { pending: 5 - callCount, scanning: true },
        }
      })

      const api = {
        openPath: vi.fn(),
        searchFiles: searchFilesMock,
      } as unknown as HomeApi

      await act(async () => {
        root.render(
          createElement(LocaleProvider, {
            initial: 'en',
            children: createElement(SearchResults, {
              api,
              query: 'doc',
            }),
          }),
        )
      })

      // Initial debounce
      await act(async () => {
        vi.advanceTimersByTime(150)
      })
      expect(searchFilesMock).toHaveBeenCalledTimes(1)

      // Advance 2000ms
      await act(async () => {
        vi.advanceTimersByTime(2000)
      })
      expect(searchFilesMock).toHaveBeenCalledTimes(2)

      // Advance another 2000ms
      await act(async () => {
        vi.advanceTimersByTime(2000)
      })
      expect(searchFilesMock).toHaveBeenCalledTimes(3)
    })
  })

  describe('RecentFiles', () => {
    it('shows open error banner if opening a recent file fails', async () => {
      const openPathMock = vi.fn().mockRejectedValue(new Error('File removed'))
      const recentsMock = vi.fn().mockResolvedValue({
        entries: [
          {
            path: 'D:/recent.docx',
            name: 'recent.docx',
            ext: 'docx',
            mtimeMs: Date.now(),
            sizeBytes: 2048,
            starred: false,
          },
        ],
      })

      const api = {
        openPath: openPathMock,
        recents: recentsMock,
      } as unknown as HomeApi

      const onOpened = vi.fn()

      await act(async () => {
        root.render(
          createElement(LocaleProvider, {
            initial: 'vi',
            children: createElement(RecentFiles, {
              api,
              onOpened,
            }),
          }),
        )
      })

      const item = container.querySelector('.idx-recent-item') as HTMLElement
      expect(item).not.toBeNull()

      await act(async () => {
        item.click()
      })

      expect(openPathMock).toHaveBeenCalledWith('D:/recent.docx')
      expect(onOpened).not.toHaveBeenCalled()

      const errorBanner = container.querySelector('.idx-recent-open-error')
      expect(errorBanner).not.toBeNull()
      expect(errorBanner?.textContent).toContain('Không thể mở tệp')
    })
  })

  describe('IndexedFolders', () => {
    it('renders common locations (Documents, Downloads, Desktop) and handles toggle', async () => {
      const getKnownSearchSourcesMock = vi.fn().mockResolvedValue([
        { id: 'documents', enabled: true },
        { id: 'downloads', enabled: true },
        { id: 'desktop', enabled: false },
      ])
      const setKnownSearchSourceMock = vi.fn().mockResolvedValue(true)
      const listIndexedFoldersMock = vi.fn().mockResolvedValue([])

      const api = {
        getKnownSearchSources: getKnownSearchSourcesMock,
        setKnownSearchSource: setKnownSearchSourceMock,
        listIndexedFolders: listIndexedFoldersMock,
      } as unknown as HomeApi

      await act(async () => {
        root.render(
          createElement(LocaleProvider, {
            initial: 'vi',
            children: createElement(IndexedFolders, {
              api,
            }),
          }),
        )
      })

      const commonSection = container.querySelector('.idx-common-sources-section')
      expect(commonSection).not.toBeNull()

      const items = container.querySelectorAll('.idx-common-source-card')
      expect(items.length).toBe(3)

      expect(container.textContent).toContain('Tài liệu (Documents)')
      expect(container.textContent).toContain('Tải về (Downloads)')
      expect(container.textContent).toContain('Tự động theo dõi tệp tải về mới')
      expect(container.textContent).toContain('Màn hình chính (Desktop)')

      // Toggle Desktop source
      const desktopCard = items[2]
      const checkbox = desktopCard.querySelector('input[type="checkbox"]') as HTMLInputElement
      expect(checkbox).not.toBeNull()

      await act(async () => {
        checkbox.click()
      })

      expect(setKnownSearchSourceMock).toHaveBeenCalledWith('desktop', true)
    })
  })
})
