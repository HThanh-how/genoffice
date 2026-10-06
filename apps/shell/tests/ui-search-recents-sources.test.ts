// @vitest-environment jsdom
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SearchResults } from '../src/renderer/src/fork/SearchResults'
import { RecentFiles } from '../src/renderer/src/fork/RecentFiles'
import { IndexedFolders } from '../src/renderer/src/fork/IndexedFolders'
import { LocaleProvider } from '../src/renderer/src/locale'
import type { HomeApi } from '../src/shared/home-api'
import type { KnownSearchSourceEntry } from '../src/shared/fork/document-index-api'

describe('UI Audit Fixes: SearchResults, RecentFiles & IndexedFolders (Section 26 - Subagent C)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
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
    vi.restoreAllMocks()
  })

  describe('SearchResults - Keyboard Events & Navigation (Mission C4 & C5)', () => {
    it('C-01: focus nút Pause ngoài -> Enter -> openPath được gọi 0 lần', async () => {
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

      // Tạo nút Pause ngoài danh sách kết quả (giống nút Pause ở header IndexDashboard)
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

      // Fast-forward debounce 150ms
      await act(async () => {
        vi.advanceTimersByTime(150)
      })

      // Focus vào nút Pause ngoài
      outsideButton.focus()
      expect(document.activeElement).toBe(outsideButton)

      // Nhấn Enter khi đang focus nút ngoài
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      expect(openPathMock).toHaveBeenCalledTimes(0)
      expect(onOpened).not.toHaveBeenCalled()

      outsideButton.remove()
    })

    it('C-02: focus search input -> Enter -> openPath được gọi đúng 1 lần', async () => {
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

      const searchInput = document.createElement('input')
      searchInput.className = 'idx-search-hero-input'
      document.body.appendChild(searchInput)

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

      await act(async () => {
        vi.advanceTimersByTime(150)
      })

      // Focus vào ô tìm kiếm
      searchInput.focus()
      expect(document.activeElement).toBe(searchInput)

      // Nhấn Enter
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })

      expect(openPathMock).toHaveBeenCalledTimes(1)
      expect(openPathMock).toHaveBeenCalledWith('D:/docs/report.docx')
      expect(onOpened).toHaveBeenCalledTimes(1)

      searchInput.remove()
    })

    it('C-03: focus dòng kết quả -> Enter -> openPath đúng 1 lần (ngăn chặn duplicate bubbling)', async () => {
      const openPathMock = vi.fn().mockResolvedValue(true)
      const searchFilesMock = vi.fn().mockResolvedValue({
        hits: [
          {
            path: 'D:/docs/summary.docx',
            name: 'summary.docx',
            mtimeMs: Date.now(),
            sizeBytes: 2048,
            needles: ['summary'],
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
              query: 'summary',
              onOpened,
            }),
          }),
        )
      })

      await act(async () => {
        vi.advanceTimersByTime(150)
      })

      const item = container.querySelector('.idx-search-hit-item') as HTMLElement
      expect(item).not.toBeNull()
      item.focus()

      // Bấm Enter trên chính item
      await act(async () => {
        item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })

      // openPath CHỈ được gọi ĐÚNG 1 LẦN, không bị nhân đôi do nổi bọt lên window listener
      expect(openPathMock).toHaveBeenCalledTimes(1)
      expect(openPathMock).toHaveBeenCalledWith('D:/docs/summary.docx')
      expect(onOpened).toHaveBeenCalledTimes(1)
    })

    it('C-04: focus dòng kết quả -> Space -> openPath đúng 1 lần', async () => {
      const openPathMock = vi.fn().mockResolvedValue(true)
      const searchFilesMock = vi.fn().mockResolvedValue({
        hits: [
          {
            path: 'D:/docs/notes.docx',
            name: 'notes.docx',
            mtimeMs: Date.now(),
            sizeBytes: 512,
            needles: ['notes'],
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
              query: 'notes',
              onOpened,
            }),
          }),
        )
      })

      await act(async () => {
        vi.advanceTimersByTime(150)
      })

      const item = container.querySelector('.idx-search-hit-item') as HTMLElement
      expect(item).not.toBeNull()
      item.focus()

      // Bấm Space trên item
      await act(async () => {
        item.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
      })

      expect(openPathMock).toHaveBeenCalledTimes(1)
      expect(openPathMock).toHaveBeenCalledWith('D:/docs/notes.docx')
      expect(onOpened).toHaveBeenCalledTimes(1)
    })

    it('C-05: focus nút dismiss error -> Enter -> openPath 0 lần, banner biến mất', async () => {
      const openPathMock = vi.fn().mockRejectedValue(new Error('File locked'))
      const searchFilesMock = vi.fn().mockResolvedValue({
        hits: [
          {
            path: 'D:/locked.docx',
            name: 'locked.docx',
            mtimeMs: Date.now(),
            sizeBytes: 1024,
            needles: ['locked'],
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
              query: 'locked',
              onOpened,
            }),
          }),
        )
      })

      await act(async () => {
        vi.advanceTimersByTime(150)
      })

      const item = container.querySelector('.idx-search-hit-item') as HTMLElement
      // Click để kích hoạt lỗi
      await act(async () => {
        item.click()
      })

      expect(openPathMock).toHaveBeenCalledTimes(1)

      // Banner lỗi đã xuất hiện
      const errorBanner = container.querySelector('.idx-search-open-error')
      expect(errorBanner).not.toBeNull()

      const dismissBtn = container.querySelector('.idx-error-dismiss-btn') as HTMLButtonElement
      expect(dismissBtn).not.toBeNull()
      dismissBtn.focus()

      // Nhấn Enter khi đang focus nút dismiss
      await act(async () => {
        dismissBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })

      // openPath KHÔNG được gọi thêm lần nào nữa!
      expect(openPathMock).toHaveBeenCalledTimes(1)
      // Banner phải biến mất
      expect(container.querySelector('.idx-search-open-error')).toBeNull()
    })

    it('C-06: openPath lỗi -> hiển thị openError, dashboard vẫn mở (onOpened không được gọi)', async () => {
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

      const item = container.querySelector('.idx-search-hit-item') as HTMLElement
      await act(async () => {
        item.click()
      })

      expect(openPathMock).toHaveBeenCalledWith('E:/missing.docx')
      // onOpened TUYỆT ĐỐI không được gọi khi openPath thất bại
      expect(onOpened).not.toHaveBeenCalled()

      // Banner lỗi hiển thị rõ ràng
      const errorBanner = container.querySelector('.idx-search-open-error')
      expect(errorBanner).not.toBeNull()
      expect(errorBanner?.textContent).toContain('Không thể mở tệp')
    })

    it('C-07: openPath thành công -> onOpened được gọi sau khi openPath hoàn tất', async () => {
      const openPathMock = vi.fn().mockResolvedValue(true)
      const searchFilesMock = vi.fn().mockResolvedValue({
        hits: [
          {
            path: 'D:/success.docx',
            name: 'success.docx',
            mtimeMs: Date.now(),
            sizeBytes: 1024,
            needles: ['success'],
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
              query: 'success',
              onOpened,
            }),
          }),
        )
      })

      await act(async () => {
        vi.advanceTimersByTime(150)
      })

      const item = container.querySelector('.idx-search-hit-item') as HTMLElement
      await act(async () => {
        item.click()
      })

      expect(openPathMock).toHaveBeenCalledWith('D:/success.docx')
      expect(onOpened).toHaveBeenCalledTimes(1)
    })
  })

  describe('SearchResults - Serialized Auto-Refresh & Stale Query Guard (Mission C6 & C7)', () => {
    it('C-08: auto refresh chỉ có tối đa 1 request in-flight tại một thời điểm', async () => {
      let activeRequests = 0
      let maxConcurrentRequests = 0
      let callCount = 0

      const deferredResolvers: Array<() => void> = []

      const searchFilesMock = vi.fn().mockImplementation(() => {
        callCount++
        activeRequests++
        if (activeRequests > maxConcurrentRequests) {
          maxConcurrentRequests = activeRequests
        }

        return new Promise((resolve) => {
          deferredResolvers.push(() => {
            activeRequests--
            resolve({
              hits: [
                {
                  path: `D:/doc_${callCount}.docx`,
                  name: `doc_${callCount}.docx`,
                  mtimeMs: Date.now(),
                  sizeBytes: 1024,
                  needles: ['doc'],
                },
              ],
              index: { pending: 3, scanning: true },
            })
          })
        })
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

      // 1. Initial debounce 100ms
      await act(async () => {
        vi.advanceTimersByTime(150)
      })
      expect(searchFilesMock).toHaveBeenCalledTimes(1)
      expect(activeRequests).toBe(1)

      // Resolve initial request
      await act(async () => {
        const resolveFn = deferredResolvers.shift()
        resolveFn?.()
      })
      expect(activeRequests).toBe(0)

      // 2. Chained timeout: sau 2000ms, request thứ 2 bắt đầu
      await act(async () => {
        vi.advanceTimersByTime(2000)
      })
      expect(searchFilesMock).toHaveBeenCalledTimes(2)
      expect(activeRequests).toBe(1)

      // Trong lúc request 2 ĐANG IN-FLIGHT, dù thời gian trôi qua 3000ms nữa,
      // KHÔNG BAO GIỜ được gửi request thứ 3!
      await act(async () => {
        vi.advanceTimersByTime(3000)
      })
      expect(searchFilesMock).toHaveBeenCalledTimes(2)
      expect(activeRequests).toBe(1)

      // Bây giờ mới giải quyết (resolve) request 2
      await act(async () => {
        const resolveFn = deferredResolvers.shift()
        resolveFn?.()
      })
      expect(activeRequests).toBe(0)

      // Sau khi request 2 đã xong và trôi qua 2000ms tiếp theo -> request 3 mới được phép gửi
      await act(async () => {
        vi.advanceTimersByTime(2000)
      })
      expect(searchFilesMock).toHaveBeenCalledTimes(3)
      expect(activeRequests).toBe(1)

      // Dọn dẹp request 3
      await act(async () => {
        const resolveFn = deferredResolvers.shift()
        resolveFn?.()
      })

      // Khẳng định: số request đồng thời lớn nhất không bao giờ vượt quá 1
      expect(maxConcurrentRequests).toBe(1)
    })

    it('C-09: response cũ phản hồi trễ không ghi đè query mới (Stale Query Guard)', async () => {
      let resolveQuery1: ((value: unknown) => void) | null = null

      const searchFilesMock = vi.fn().mockImplementation(({ q }: { q: string }) => {
        if (q === 'first') {
          return new Promise((resolve) => {
            resolveQuery1 = resolve
          })
        }
        return Promise.resolve({
          hits: [
            {
              path: 'D:/second.docx',
              name: 'second.docx',
              mtimeMs: Date.now(),
              sizeBytes: 1024,
              needles: ['second'],
            },
          ],
          index: { pending: 0, scanning: false },
        })
      })

      const api = {
        openPath: vi.fn(),
        searchFiles: searchFilesMock,
      } as unknown as HomeApi

      // 1. Render với query = 'first'
      await act(async () => {
        root.render(
          createElement(LocaleProvider, {
            initial: 'en',
            children: createElement(SearchResults, {
              api,
              query: 'first',
            }),
          }),
        )
      })

      await act(async () => {
        vi.advanceTimersByTime(150)
      })
      expect(searchFilesMock).toHaveBeenCalledWith(expect.objectContaining({ q: 'first' }))

      // 2. User gõ query mới = 'second' trước khi query 'first' hoàn tất
      await act(async () => {
        root.render(
          createElement(LocaleProvider, {
            initial: 'en',
            children: createElement(SearchResults, {
              api,
              query: 'second',
            }),
          }),
        )
      })

      await act(async () => {
        vi.advanceTimersByTime(150)
      })
      expect(searchFilesMock).toHaveBeenCalledWith(expect.objectContaining({ q: 'second' }))

      // Kiểm tra UI đã hiển thị second.docx
      expect(container.textContent).toContain('second.docx')

      // 3. Bây giờ query cũ 'first' mới phản hồi trễ về
      await act(async () => {
        resolveQuery1?.({
          hits: [
            {
              path: 'D:/stale_first.docx',
              name: 'stale_first.docx',
              mtimeMs: Date.now(),
              sizeBytes: 1024,
              needles: ['first'],
            },
          ],
          index: { pending: 0, scanning: false },
        })
      })

      // Stale Guard: Response cũ bị hủy bỏ hoàn toàn, KHÔNG ghi đè kết quả của 'second'
      expect(container.textContent).toContain('second.docx')
      expect(container.textContent).not.toContain('stale_first.docx')
    })
  })

  describe('RecentFiles - Safe Open and Error Dismiss', () => {
    it('shows open error banner and dismisses safely on recent file failure', async () => {
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

      // Dismiss button keyboard handling
      const dismissBtn = container.querySelector('.idx-error-dismiss-btn') as HTMLButtonElement
      expect(dismissBtn).not.toBeNull()
      dismissBtn.focus()

      await act(async () => {
        dismissBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })

      expect(container.querySelector('.idx-recent-open-error')).toBeNull()
    })
  })

  describe('IndexedFolders - Single Source-of-Truth & UI Hardening (Missions C1, C2, C3)', () => {
    it('C-10: toggle thất bại -> rollback và refetch canonical state', async () => {
      const canonicalSources: KnownSearchSourceEntry[] = [
        { id: 'documents', path: 'C:/Users/Admin/Documents', enabled: true, status: 'watching' },
        { id: 'downloads', path: 'C:/Users/Admin/Downloads', enabled: true, status: 'watching' },
        { id: 'desktop', path: 'C:/Users/Admin/Desktop', enabled: false, status: 'disabled' },
      ]

      const getKnownSearchSourcesMock = vi.fn().mockResolvedValue(canonicalSources)
      const setKnownSearchSourceMock = vi.fn().mockRejectedValue(new Error('Permission denied on disk'))
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

      expect(getKnownSearchSourcesMock).toHaveBeenCalledTimes(1)

      const cards = container.querySelectorAll('.idx-common-source-card')
      expect(cards.length).toBe(3)

      const desktopCard = cards[2]
      const checkbox = desktopCard.querySelector('input[type="checkbox"]') as HTMLInputElement
      expect(checkbox.checked).toBe(false)

      // Cố gắng bật Desktop nhưng API bị lỗi
      await act(async () => {
        checkbox.click()
      })

      expect(setKnownSearchSourceMock).toHaveBeenCalledWith('desktop', true)

      // Rollback: checkbox phải quay về false
      expect(checkbox.checked).toBe(false)

      // Thông báo lỗi inline phải được hiển thị
      const errorMsg = desktopCard.querySelector('.idx-common-source-error')
      expect(errorMsg).not.toBeNull()
      expect(errorMsg?.textContent).toContain('Permission denied on disk')

      // Phải gọi lại getKnownSearchSources để đồng bộ canonical state
      expect(getKnownSearchSourcesMock).toHaveBeenCalledTimes(2)
    })

    it('C-11: actual path được render trên giao diện card', async () => {
      const canonicalSources: KnownSearchSourceEntry[] = [
        { id: 'documents', path: 'C:/Users/Admin/Documents', enabled: true, status: 'watching' },
        { id: 'downloads', path: 'C:/Users/Admin/Downloads', enabled: true, status: 'watching' },
        { id: 'desktop', path: 'C:/Users/Admin/Desktop', enabled: false, status: 'disabled' },
      ]

      const api = {
        getKnownSearchSources: vi.fn().mockResolvedValue(canonicalSources),
        listIndexedFolders: vi.fn().mockResolvedValue([]),
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

      // Kiểm tra đường dẫn thực tế được render
      const pathSpans = container.querySelectorAll('.idx-common-source-path')
      expect(pathSpans.length).toBe(3)
      expect(pathSpans[0].textContent).toBe('C:/Users/Admin/Documents')
      expect(pathSpans[1].textContent).toBe('C:/Users/Admin/Downloads')
      expect(pathSpans[2].textContent).toBe('C:/Users/Admin/Desktop')
    })

    it('C-12: status unavailable được render trực quan', async () => {
      const canonicalSources: KnownSearchSourceEntry[] = [
        { id: 'documents', path: 'C:/Users/Admin/Documents', enabled: true, status: 'watching' },
        { id: 'downloads', path: 'E:/External/Downloads', enabled: true, status: 'unavailable' },
        { id: 'desktop', path: 'C:/Users/Admin/Desktop', enabled: false, status: 'disabled' },
      ]

      const api = {
        getKnownSearchSources: vi.fn().mockResolvedValue(canonicalSources),
        listIndexedFolders: vi.fn().mockResolvedValue([]),
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

      const cards = container.querySelectorAll('.idx-common-source-card')
      const downloadsCard = cards[1]
      expect(downloadsCard.classList.contains('is-unavailable')).toBe(true)

      const statusChip = downloadsCard.querySelector('.idx-common-source-chip')
      expect(statusChip?.textContent).toBe('Không khả dụng')
      expect(statusChip?.classList.contains('status-unavailable')).toBe(true)
    })

    it('C-13: toggle switch bị disable khi request đang pending', async () => {
      let resolveToggle: ((value: unknown) => void) | null = null

      const setKnownSearchSourceMock = vi.fn().mockImplementation(() => {
        return new Promise((resolve) => {
          resolveToggle = resolve
        })
      })

      const canonicalSources: KnownSearchSourceEntry[] = [
        { id: 'documents', path: 'C:/Users/Admin/Documents', enabled: true, status: 'watching' },
        { id: 'downloads', path: 'C:/Users/Admin/Downloads', enabled: true, status: 'watching' },
        { id: 'desktop', path: 'C:/Users/Admin/Desktop', enabled: false, status: 'disabled' },
      ]

      const api = {
        getKnownSearchSources: vi.fn().mockResolvedValue(canonicalSources),
        setKnownSearchSource: setKnownSearchSourceMock,
        listIndexedFolders: vi.fn().mockResolvedValue([]),
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

      const cards = container.querySelectorAll('.idx-common-source-card')
      const desktopCard = cards[2]
      const checkbox = desktopCard.querySelector('input[type="checkbox"]') as HTMLInputElement
      expect(checkbox.disabled).toBe(false)

      // Click toggle
      await act(async () => {
        checkbox.click()
      })

      // Trong lúc request đang pending: switch bị disable
      expect(checkbox.disabled).toBe(true)

      // Resolve toggle thành công
      await act(async () => {
        resolveToggle?.({
          id: 'desktop',
          path: 'C:/Users/Admin/Desktop',
          enabled: true,
          status: 'watching',
        })
      })

      // Sau khi hoàn tất: switch được mở lại
      expect(checkbox.disabled).toBe(false)
      expect(checkbox.checked).toBe(true)
    })
  })

  describe('P1 Audit Fixes: UI State Consistency (Subagent IT 3)', () => {
    it('UI-01: Known source chuyển từ scanning sang watching tự động cập nhật UI sau 5s refresh mà không cần remount', async () => {
      let pollCount = 0
      const getKnownSearchSourcesMock = vi.fn().mockImplementation(async () => {
        pollCount++
        if (pollCount === 1) {
          return [
            { id: 'downloads', path: 'C:/Users/Admin/Downloads', enabled: true, status: 'scanning' },
          ]
        }
        return [
          { id: 'downloads', path: 'C:/Users/Admin/Downloads', enabled: true, status: 'watching' },
        ]
      })

      const api = {
        getKnownSearchSources: getKnownSearchSourcesMock,
        listIndexedFolders: vi.fn().mockResolvedValue([]),
      } as unknown as HomeApi

      await act(async () => {
        root.render(
          createElement(LocaleProvider, {
            initial: 'vi',
            children: createElement(IndexedFolders, { api }),
          }),
        )
      })

      // Check initial state: chip displays Scanning
      const cards = container.querySelectorAll('.idx-common-source-card')
      const downloadsCard = cards[1]
      const chip = downloadsCard?.querySelector('.idx-common-source-chip')
      expect(chip?.getAttribute('data-status')).toBe('scanning')
      expect(chip?.textContent).toBe('Đang quét')
      expect(getKnownSearchSourcesMock).toHaveBeenCalledTimes(1)

      // Fast forward 5s interval
      await act(async () => {
        vi.advanceTimersByTime(5000)
      })

      // Verify that UI updated to watching without remount
      expect(getKnownSearchSourcesMock).toHaveBeenCalledTimes(2)
      expect(chip?.getAttribute('data-status')).toBe('watching')
      expect(chip?.textContent).toBe('Đang theo dõi')
    })

    it('UI-02: Thư mục chỉ có owner known-* không xuất hiện trong danh sách Custom Folders', async () => {
      const canonicalSources: KnownSearchSourceEntry[] = [
        { id: 'documents', path: 'C:/Users/Admin/Documents', enabled: false, status: 'disabled' },
        { id: 'downloads', path: 'C:/Users/Admin/Downloads', enabled: true, status: 'watching' },
        { id: 'desktop', path: 'C:/Users/Admin/Desktop', enabled: false, status: 'disabled' },
      ]

      const listIndexedFoldersMock = vi.fn().mockResolvedValue([
        {
          root: 'C:/Users/Admin/Downloads',
          owners: ['known:downloads'],
          state: 'complete',
          priority: false,
          unavailable: false,
          totalFiles: 42,
          readyFiles: 42,
          pendingFiles: 0,
          errorFiles: 0,
          history: [],
        },
      ])

      const api = {
        getKnownSearchSources: vi.fn().mockResolvedValue(canonicalSources),
        listIndexedFolders: listIndexedFoldersMock,
      } as unknown as HomeApi

      await act(async () => {
        root.render(
          createElement(LocaleProvider, {
            initial: 'vi',
            children: createElement(IndexedFolders, { api }),
          }),
        )
      })

      // Check Known Sources section has downloads card
      const cards = container.querySelectorAll('.idx-common-source-card')
      const downloadsCard = cards[1]
      expect(downloadsCard).not.toBeNull()
      expect(downloadsCard?.textContent).toContain('Tải về (Downloads)')

      // Check Custom Folders section does NOT list the downloads folder
      const customFolderCards = container.querySelectorAll('.set-folder')
      expect(customFolderCards.length).toBe(0)

      // Empty message should be displayed
      expect(container.textContent).toContain('Chưa quét thư mục nào')
    })

    it('UI-03: Thư mục có cả manual và known-* xuất hiện ở cả 2 khu vực', async () => {
      const canonicalSources: KnownSearchSourceEntry[] = [
        { id: 'documents', path: 'C:/Users/Admin/Documents', enabled: false, status: 'disabled' },
        { id: 'downloads', path: 'C:/Users/Admin/Downloads', enabled: true, status: 'watching' },
        { id: 'desktop', path: 'C:/Users/Admin/Desktop', enabled: false, status: 'disabled' },
      ]

      const listIndexedFoldersMock = vi.fn().mockResolvedValue([
        {
          root: 'C:/Users/Admin/Downloads',
          owners: ['manual', 'known:downloads'],
          state: 'complete',
          priority: false,
          unavailable: false,
          totalFiles: 42,
          readyFiles: 42,
          pendingFiles: 0,
          errorFiles: 0,
          history: [],
        },
      ])

      const api = {
        getKnownSearchSources: vi.fn().mockResolvedValue(canonicalSources),
        listIndexedFolders: listIndexedFoldersMock,
      } as unknown as HomeApi

      await act(async () => {
        root.render(
          createElement(LocaleProvider, {
            initial: 'vi',
            children: createElement(IndexedFolders, { api }),
          }),
        )
      })

      // Check Known Sources section has downloads card
      const cards = container.querySelectorAll('.idx-common-source-card')
      const downloadsCard = cards[1]
      expect(downloadsCard).not.toBeNull()
      expect(downloadsCard?.textContent).toContain('Tải về (Downloads)')

      // Check Custom Folders section ALSO lists the downloads folder because it has manual registration
      const customFolderCards = container.querySelectorAll('.set-folder')
      expect(customFolderCards.length).toBe(1)
      expect(customFolderCards[0].textContent).toContain('Downloads')
    })

    it('UI-04: Đổi query từ A sang B, request ban đầu của B bị hoãn > 2s -> không có request auto-refresh B nào chạy đè đồng thời', async () => {
      const calls: Array<{ q: string; time: number }> = []
      let resolveInitialB: ((value: unknown) => void) | null = null

      const searchFilesMock = vi.fn().mockImplementation(({ q }: { q: string }) => {
        calls.push({ q, time: Date.now() })
        if (q === 'queryA') {
          return Promise.resolve({
            hits: [
              {
                path: 'D:/docA.docx',
                name: 'docA.docx',
                mtimeMs: Date.now(),
                sizeBytes: 1024,
                needles: ['queryA'],
              },
            ],
            index: { pending: 2, scanning: true },
          })
        }
        if (q === 'queryB') {
          return new Promise((resolve) => {
            resolveInitialB = resolve
          })
        }
        return Promise.resolve({ hits: [], index: { pending: 0, scanning: false } })
      })

      const api = {
        openPath: vi.fn(),
        searchFiles: searchFilesMock,
      } as unknown as HomeApi

      // 1. Initial render with queryA
      await act(async () => {
        root.render(
          createElement(LocaleProvider, {
            initial: 'en',
            children: createElement(SearchResults, { api, query: 'queryA' }),
          }),
        )
      })

      // Fast forward debounce 150ms
      await act(async () => {
        vi.advanceTimersByTime(150)
      })

      expect(searchFilesMock).toHaveBeenCalledWith(expect.objectContaining({ q: 'queryA' }))
      expect(container.textContent).toContain('docA.docx')

      // 2. Change query to queryB
      await act(async () => {
        root.render(
          createElement(LocaleProvider, {
            initial: 'en',
            children: createElement(SearchResults, { api, query: 'queryB' }),
          }),
        )
      })

      // Immediately upon query change: searchPage should be cleared
      expect(container.textContent).not.toContain('docA.docx')

      // Fast forward debounce 150ms for queryB -> initial request for queryB is triggered
      await act(async () => {
        vi.advanceTimersByTime(150)
      })

      expect(searchFilesMock).toHaveBeenCalledWith(expect.objectContaining({ q: 'queryB' }))
      const callsForBBeforeDelay = calls.filter((c) => c.q === 'queryB')
      expect(callsForBBeforeDelay.length).toBe(1)

      // 3. Request for queryB is delayed for > 2 seconds (advance 2500ms while unresolved)
      await act(async () => {
        vi.advanceTimersByTime(2500)
      })

      // Assert coordinator prevented any overlapping auto-refresh for queryB
      const callsForBDuringDelay = calls.filter((c) => c.q === 'queryB')
      expect(callsForBDuringDelay.length).toBe(1)

      // 4. Now resolve the initial request for queryB
      await act(async () => {
        resolveInitialB?.({
          hits: [
            {
              path: 'D:/docB.docx',
              name: 'docB.docx',
              mtimeMs: Date.now(),
              sizeBytes: 2048,
              needles: ['queryB'],
            },
          ],
          index: { pending: 1, scanning: true },
        })
      })

      expect(container.textContent).toContain('docB.docx')

      // 5. After initial request finished, auto-refresh is scheduled and triggers after 2000ms
      await act(async () => {
        vi.advanceTimersByTime(2000)
      })

      const callsForBAfterRefresh = calls.filter((c) => c.q === 'queryB')
      expect(callsForBAfterRefresh.length).toBe(2)
    })

    it('UI-05: Periodic fetch bắt đầu chậm, user thực hiện toggle source và toggle hoàn tất thành công. Khi periodic fetch cũ phản hồi muộn, UI giữ nguyên trạng thái mới vừa toggle, không bị giật về trạng thái cũ', async () => {
      let callCount = 0
      let resolveSlowPeriodic: ((value: unknown) => void) | null = null

      const initialSources: KnownSearchSourceEntry[] = [
        { id: 'documents', path: 'C:/Users/Admin/Documents', enabled: true, status: 'watching' },
        { id: 'downloads', path: 'C:/Users/Admin/Downloads', enabled: true, status: 'watching' },
        { id: 'desktop', path: 'C:/Users/Admin/Desktop', enabled: false, status: 'disabled' },
      ]

      const getKnownSearchSourcesMock = vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          // Lần fetch ban đầu khi mount
          return Promise.resolve(initialSources)
        }
        // Lần fetch định kỳ tiếp theo: giả lập phản hồi chậm / bị trễ
        return new Promise((resolve) => {
          resolveSlowPeriodic = resolve
        })
      })

      const setKnownSearchSourceMock = vi.fn().mockResolvedValue({
        id: 'desktop',
        path: 'C:/Users/Admin/Desktop',
        enabled: true,
        status: 'watching',
      })

      const api = {
        getKnownSearchSources: getKnownSearchSourcesMock,
        setKnownSearchSource: setKnownSearchSourceMock,
        listIndexedFolders: vi.fn().mockResolvedValue([]),
      } as unknown as HomeApi

      // 1. Render IndexedFolders ban đầu
      await act(async () => {
        root.render(
          createElement(LocaleProvider, {
            initial: 'vi',
            children: createElement(IndexedFolders, { api }),
          }),
        )
      })

      const cards = container.querySelectorAll('.idx-common-source-card')
      const desktopCard = cards[2]
      const checkbox = desktopCard.querySelector('input[type="checkbox"]') as HTMLInputElement
      const chip = desktopCard.querySelector('.idx-common-source-chip')

      expect(checkbox.checked).toBe(false)
      expect(chip?.getAttribute('data-status')).toBe('disabled')
      expect(getKnownSearchSourcesMock).toHaveBeenCalledTimes(1)

      // 2. Kích hoạt periodic refresh sau 5s -> getKnownSearchSources lần 2 được gọi nhưng chưa resolve
      await act(async () => {
        vi.advanceTimersByTime(5000)
      })

      expect(getKnownSearchSourcesMock).toHaveBeenCalledTimes(2)
      expect(resolveSlowPeriodic).not.toBeNull()

      // 3. Trong lúc periodic fetch đang pending, user thao tác click toggle bật desktop
      await act(async () => {
        checkbox.click()
      })

      expect(setKnownSearchSourceMock).toHaveBeenCalledWith('desktop', true)
      // Toggle hoàn tất thành công: checkbox bật, chip chuyển sang watching
      expect(checkbox.checked).toBe(true)
      expect(chip?.getAttribute('data-status')).toBe('watching')

      // 4. Lúc này periodic fetch cũ (được gửi trước khi toggle) mới phản hồi muộn mang dữ liệu cũ (desktop = disabled)
      await act(async () => {
        resolveSlowPeriodic?.(initialSources)
      })

      // 5. Khẳng định: UI giữ nguyên trạng thái mới vừa toggle (enabled/watching), KHÔNG bị giật về trạng thái cũ
      expect(checkbox.checked).toBe(true)
      expect(chip?.getAttribute('data-status')).toBe('watching')
      expect(chip?.textContent).toBe('Đang theo dõi')
    })

    it('UI-06: Per-source Rollback - khi toggle một source bị lỗi thì chỉ rollback duy nhất source đó, giữ nguyên trạng thái của các source khác', async () => {
      let rejectDesktopToggle: ((err: Error) => void) | null = null

      const currentSources: KnownSearchSourceEntry[] = [
        { id: 'documents', path: 'C:/Users/Admin/Documents', enabled: false, status: 'disabled' },
        { id: 'downloads', path: 'C:/Users/Admin/Downloads', enabled: false, status: 'disabled' },
        { id: 'desktop', path: 'C:/Users/Admin/Desktop', enabled: false, status: 'disabled' },
      ]

      const getKnownSearchSourcesMock = vi.fn().mockImplementation(async () => {
        return currentSources.map((s) => ({ ...s }))
      })

      const setKnownSearchSourceMock = vi.fn().mockImplementation((id: string) => {
        if (id === 'desktop') {
          return new Promise((_, reject) => {
            rejectDesktopToggle = reject
          })
        }
        return Promise.resolve({ id, path: '', enabled: true, status: 'watching' })
      })

      const api = {
        getKnownSearchSources: getKnownSearchSourcesMock,
        setKnownSearchSource: setKnownSearchSourceMock,
        listIndexedFolders: vi.fn().mockResolvedValue([]),
      } as unknown as HomeApi

      await act(async () => {
        root.render(
          createElement(LocaleProvider, {
            initial: 'vi',
            children: createElement(IndexedFolders, { api }),
          }),
        )
      })

      const cards = container.querySelectorAll('.idx-common-source-card')
      const downloadsCard = cards[1]
      const desktopCard = cards[2]

      const downloadsCheckbox = downloadsCard.querySelector('input[type="checkbox"]') as HTMLInputElement
      const desktopCheckbox = desktopCard.querySelector('input[type="checkbox"]') as HTMLInputElement

      expect(downloadsCheckbox.checked).toBe(false)
      expect(desktopCheckbox.checked).toBe(false)

      // 1. User click toggle desktop -> request pending (in-flight)
      await act(async () => {
        desktopCheckbox.click()
      })

      expect(setKnownSearchSourceMock).toHaveBeenCalledWith('desktop', true)
      expect(desktopCheckbox.checked).toBe(true) // Optimistic update

      // 2. Trong lúc desktop đang pending, hệ thống cập nhật downloads thành enabled: true (ví dụ qua background sync)
      currentSources[1] = {
        id: 'downloads',
        path: 'C:/Users/Admin/Downloads',
        enabled: true,
        status: 'watching',
      }

      await act(async () => {
        vi.advanceTimersByTime(5000) // Kích hoạt periodic fetchKnown
      })

      // Downloads trên UI đã cập nhật thành true
      expect(downloadsCheckbox.checked).toBe(true)

      // 3. Bây giờ request desktop bị lỗi và reject
      await act(async () => {
        rejectDesktopToggle?.(new Error('Desktop access denied'))
      })

      // 4. Per-source Rollback: Chỉ có desktop bị rollback về false và hiển thị lỗi
      expect(desktopCheckbox.checked).toBe(false)
      const errorMsg = desktopCard.querySelector('.idx-common-source-error')
      expect(errorMsg?.textContent).toContain('Desktop access denied')

      // 5. Downloads PHẢI GIỮ NGUYÊN trạng thái checked = true, không bị rollback nhầm theo snapshot cũ của desktop
      expect(downloadsCheckbox.checked).toBe(true)
    })
  })

  describe('P2 Audit Fixes: Rapid Double-Click & Failure Cleanup (Subagent IT 4)', () => {
    it('P2-01: Rapid double-click trên toggle switch chỉ gửi đúng 1 API request duy nhất', async () => {
      let resolveToggle: ((value: unknown) => void) | null = null
      const setKnownSearchSourceMock = vi.fn().mockImplementation(() => {
        return new Promise((resolve) => {
          resolveToggle = resolve
        })
      })

      const canonicalSources: KnownSearchSourceEntry[] = [
        { id: 'documents', path: 'C:/Users/Admin/Documents', enabled: false, status: 'disabled' },
        { id: 'downloads', path: 'C:/Users/Admin/Downloads', enabled: false, status: 'disabled' },
        { id: 'desktop', path: 'C:/Users/Admin/Desktop', enabled: false, status: 'disabled' },
      ]

      const api = {
        getKnownSearchSources: vi.fn().mockResolvedValue(canonicalSources),
        setKnownSearchSource: setKnownSearchSourceMock,
        listIndexedFolders: vi.fn().mockResolvedValue([]),
      } as unknown as HomeApi

      await act(async () => {
        root.render(
          createElement(LocaleProvider, {
            initial: 'vi',
            children: createElement(IndexedFolders, { api }),
          }),
        )
      })

      const cards = container.querySelectorAll('.idx-common-source-card')
      const desktopCard = cards[2]
      const checkbox = desktopCard.querySelector('input[type="checkbox"]') as HTMLInputElement
      expect(checkbox.checked).toBe(false)

      // Thực hiện rapid double-click liên tiếp trước khi request đầu tiên kịp hoàn tất
      await act(async () => {
        checkbox.click()
        checkbox.click()
      })

      // Đảm bảo chỉ gửi duy nhất 1 API request
      expect(setKnownSearchSourceMock).toHaveBeenCalledTimes(1)
      expect(setKnownSearchSourceMock).toHaveBeenCalledWith('desktop', true)

      // Hoàn tất toggle request
      await act(async () => {
        resolveToggle?.({
          id: 'desktop',
          path: 'C:/Users/Admin/Desktop',
          enabled: true,
          status: 'watching',
        })
      })

      expect(checkbox.checked).toBe(true)
    })

    it('P2-02: Toggle lỗi -> fetchKnown được gọi sau khi hoàn tất dọn dẹp busySources, canonical state mới không bị filter bỏ qua', async () => {
      let fetchCount = 0

      const initialSources: KnownSearchSourceEntry[] = [
        { id: 'documents', path: 'C:/Users/Admin/Documents', enabled: false, status: 'disabled' },
        { id: 'downloads', path: 'C:/Users/Admin/Downloads', enabled: false, status: 'disabled' },
        { id: 'desktop', path: 'C:/Users/Admin/Desktop', enabled: false, status: 'disabled' },
      ]

      const recoveredSources: KnownSearchSourceEntry[] = [
        { id: 'documents', path: 'C:/Users/Admin/Documents', enabled: false, status: 'disabled' },
        { id: 'downloads', path: 'C:/Users/Admin/Downloads', enabled: false, status: 'disabled' },
        { id: 'desktop', path: 'C:/Users/Admin/Desktop_Canonical_Recovered', enabled: false, status: 'disabled' },
      ]

      const getKnownSearchSourcesMock = vi.fn().mockImplementation(async () => {
        fetchCount++
        if (fetchCount === 1) {
          return initialSources
        }
        return recoveredSources
      })

      const setKnownSearchSourceMock = vi.fn().mockRejectedValue(new Error('Permission denied on disk'))

      const api = {
        getKnownSearchSources: getKnownSearchSourcesMock,
        setKnownSearchSource: setKnownSearchSourceMock,
        listIndexedFolders: vi.fn().mockResolvedValue([]),
      } as unknown as HomeApi

      await act(async () => {
        root.render(
          createElement(LocaleProvider, {
            initial: 'vi',
            children: createElement(IndexedFolders, { api }),
          }),
        )
      })

      const cards = container.querySelectorAll('.idx-common-source-card')
      const desktopCard = cards[2]
      const checkbox = desktopCard.querySelector('input[type="checkbox"]') as HTMLInputElement
      const pathSpan = desktopCard.querySelector('.idx-common-source-path')

      expect(checkbox.checked).toBe(false)
      expect(pathSpan?.textContent).toBe('C:/Users/Admin/Desktop')
      expect(getKnownSearchSourcesMock).toHaveBeenCalledTimes(1)

      // Cố gắng bật Desktop nhưng API bị lỗi
      await act(async () => {
        checkbox.click()
      })

      expect(setKnownSearchSourceMock).toHaveBeenCalledWith('desktop', true)

      // Rollback: checkbox phải quay về false
      expect(checkbox.checked).toBe(false)

      // Thông báo lỗi inline phải được hiển thị
      const errorMsg = desktopCard.querySelector('.idx-common-source-error')
      expect(errorMsg?.textContent).toContain('Permission denied on disk')

      // getKnownSearchSources được gọi lần 2 sau khi dọn dẹp busySources
      expect(getKnownSearchSourcesMock).toHaveBeenCalledTimes(2)

      // Kiểm tra: Dữ liệu canonical mới từ backend ('C:/Users/Admin/Desktop_Canonical_Recovered')
      // ĐÃ được cập nhật lên UI vì busySourcesRef.current['desktop'] = false đã chạy trước fetchKnown(),
      // không bị filter isBusy bỏ qua như phiên bản cũ!
      expect(pathSpan?.textContent).toBe('C:/Users/Admin/Desktop_Canonical_Recovered')

      // Switch không còn bị disabled
      expect(checkbox.disabled).toBe(false)
    })
  })
})
