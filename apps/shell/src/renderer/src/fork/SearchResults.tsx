import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { FileSearchHit, FileSearchPage, HomeApi } from '../../../shared/home-api'
import { markText } from '../../../shared/text-marks'
import { useI18n } from '../locale'
import { iconFor } from '../file-icons'
import { formatBytes } from './index-file-log'

export interface SearchResultsProps {
  api: HomeApi
  query: string
  onOpened?: () => void
}

function highlightText(text: string, needles: readonly string[]): ReactElement[] | string {
  const marks = markText(text, needles)
  if (!marks.some((m) => m.hit)) return text
  return marks.map((m, i) =>
    m.hit ? (
      <mark key={i} className="search-hit">
        {m.text}
      </mark>
    ) : (
      <span key={i}>{m.text}</span>
    ),
  )
}

export function SearchResults({ api, query, onOpened }: SearchResultsProps) {
  const { lang, dateLocale } = useI18n()
  const isVi = lang === 'vi'

  const [searchPage, setSearchPage] = useState<FileSearchPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const searchSeq = useRef(0)
  const inFlightSeqRef = useRef<number | null>(null)
  const searchPageQueryRef = useRef<string | null>(null)
  const selectedItemRef = useRef<HTMLLIElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Reset selectedIndex, openError and searchPage whenever query changes
  useEffect(() => {
    setSelectedIndex(0)
    setOpenError(null)
    setSearchPage(null)
    searchPageQueryRef.current = null
  }, [query])

  // Debounce 100ms (within required 80-120ms range)
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      searchSeq.current++
      inFlightSeqRef.current = null
      searchPageQueryRef.current = null
      setSearchPage(null)
      setLoading(false)
      setError(null)
      return
    }

    const seq = ++searchSeq.current
    inFlightSeqRef.current = null
    searchPageQueryRef.current = null
    setSearchPage(null)
    setLoading(true)
    setError(null)

    const timer = window.setTimeout(async () => {
      // Coordinator check: do not run if a request is already in-flight for this generation
      if (inFlightSeqRef.current === seq) {
        return
      }
      inFlightSeqRef.current = seq

      try {
        const res = await api.searchFiles({ q, limit: 100 })
        if (seq === searchSeq.current) {
          searchPageQueryRef.current = q
          setSearchPage(res)
        }
      } catch (err) {
        if (seq === searchSeq.current) {
          setError(
            isVi
              ? 'Lỗi trong quá trình tìm kiếm tài liệu.'
              : 'Error occurred while searching files.',
          )
        }
      } finally {
        if (inFlightSeqRef.current === seq) {
          inFlightSeqRef.current = null
        }
        if (seq === searchSeq.current) {
          setLoading(false)
        }
      }
    }, 100)

    return () => {
      window.clearTimeout(timer)
      if (inFlightSeqRef.current === seq) {
        inFlightSeqRef.current = null
      }
    }
  }, [api, query, isVi])

  // Auto-refresh search results while indexing is pending or scanning (Serialized Chained setTimeout)
  useEffect(() => {
    const q = query.trim()
    if (!q || !searchPage || searchPageQueryRef.current !== q) return
    const isIndexing = searchPage.index.pending > 0 || searchPage.index.scanning
    if (!isIndexing) return

    let alive = true
    let timerId: number | ReturnType<typeof setTimeout> | null = null

    const scheduleNext = () => {
      if (!alive) return
      timerId = window.setTimeout(() => {
        void poll()
      }, 2000)
    }

    const poll = async () => {
      if (!alive) return
      const currentSeq = searchSeq.current

      // Coordinator: Never allow concurrent in-flight requests for the same generation
      if (inFlightSeqRef.current === currentSeq) {
        if (alive) {
          scheduleNext()
        }
        return
      }

      inFlightSeqRef.current = currentSeq
      try {
        const res = await api.searchFiles({ q, limit: 100 })
        // Stale Query Guard: Drop response if sequence has advanced, component unmounted, or query changed
        if (alive && currentSeq === searchSeq.current && searchPageQueryRef.current === q) {
          setSearchPage(res)
        }
      } catch (err) {
        console.error('Auto-refresh search failed:', err)
      } finally {
        if (inFlightSeqRef.current === currentSeq) {
          inFlightSeqRef.current = null
        }
        if (alive) {
          scheduleNext()
        }
      }
    }

    scheduleNext()

    return () => {
      alive = false
      if (timerId !== null) {
        window.clearTimeout(timerId as unknown as number)
      }
    }
  }, [api, query, searchPage, searchPage?.index.pending, searchPage?.index.scanning])

  const openingRef = useRef(false)

  const handleOpen = async (path: string) => {
    if (openingRef.current) return
    openingRef.current = true
    try {
      setOpenError(null)
      await api.openPath(path)
      onOpened?.()
    } catch (err) {
      console.error('Failed to open path:', err)
      setOpenError(
        isVi
          ? 'Không thể mở tệp. Tệp có thể đã được di chuyển hoặc ổ đĩa đang không khả dụng.'
          : 'Could not open the file. It may have moved or the drive may be unavailable.',
      )
    } finally {
      openingRef.current = false
    }
  }

  const formatModified = (timeMs: number): string => {
    if (!timeMs) return '–'
    return new Date(timeMs).toLocaleDateString(dateLocale, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  const getDirectoryPath = (filePath: string): string => {
    const parts = filePath.split(/[\\/]/)
    if (parts.length <= 1) return ''
    parts.pop()
    return parts.join('/')
  }

  // Partition hits into "Best matches" (file/folder name) and "Matches in contents"
  const qLower = query.toLowerCase().trim()
  const bestMatches: FileSearchHit[] = []
  const contentMatches: FileSearchHit[] = []

  if (searchPage?.hits) {
    for (const hit of searchPage.hits) {
      const nameMarks = markText(hit.name, hit.needles)
      const nameMatched =
        nameMarks.some((m) => m.hit) || hit.name.toLowerCase().includes(qLower)

      if (!hit.snippet || nameMatched) {
        bestMatches.push(hit)
      } else {
        contentMatches.push(hit)
      }
    }
  }

  const visibleHits = [...bestMatches, ...contentMatches]

  // Keyboard navigation (FIX UI-1: Keyboard handler scope)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (visibleHits.length === 0) return

      const active = document.activeElement

      // If focus is on any button (e.g. dismiss error button or outside action button),
      // do not hijack Enter or Space
      if (
        active?.tagName === 'BUTTON' ||
        active?.closest('button') ||
        active?.classList.contains('idx-error-dismiss-btn')
      ) {
        return
      }

      const isInputFocused = active?.classList.contains('idx-search-hero-input')
      const isContainerFocused = containerRef.current?.contains(active)

      if (!isInputFocused && !isContainerFocused) return

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.min(prev + 1, visibleHits.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.max(prev - 1, 0))
      } else if (e.key === 'Enter') {
        // Only trigger from window listener if search input is focused.
        // Hit item (li) has its own onKeyDown handler with e.stopPropagation().
        if (isInputFocused) {
          const target = visibleHits[selectedIndex]
          if (target) {
            e.preventDefault()
            void handleOpen(target.path)
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [visibleHits, selectedIndex, isVi])

  // Scroll selected item into view smoothly
  useEffect(() => {
    if (selectedItemRef.current) {
      selectedItemRef.current.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  const isIndexing = !!searchPage && (searchPage.index.pending > 0 || searchPage.index.scanning)

  const renderHitItem = (hit: FileSearchHit, itemIndex: number) => {
    const isSelected = itemIndex === selectedIndex
    const dir = getDirectoryPath(hit.path)
    return (
      <li
        key={hit.path}
        ref={isSelected ? selectedItemRef : undefined}
        className={`idx-search-hit-item${isSelected ? ' is-selected' : ''}`}
        role="button"
        tabIndex={0}
        aria-selected={isSelected}
        onClick={() => void handleOpen(hit.path)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            void handleOpen(hit.path)
          }
        }}
      >
        <img src={iconFor(hit.name)} alt="" className="idx-search-hit-icon" aria-hidden="true" />
        <div className="idx-search-hit-main">
          <div className="idx-search-hit-head">
            <span className="idx-search-hit-name">{highlightText(hit.name, hit.needles)}</span>
            {dir && (
              <span className="idx-search-hit-dir" title={dir}>
                {highlightText(dir, hit.needles)}
              </span>
            )}
          </div>

          {hit.snippet && (
            <p className="idx-search-hit-snippet">
              {hit.snippet.map((part, i) =>
                part.hit ? (
                  <mark key={i} className="search-hit">
                    {part.text}
                  </mark>
                ) : (
                  <span key={i}>{part.text}</span>
                ),
              )}
            </p>
          )}
        </div>
        <div className="idx-search-hit-meta">
          <span className="idx-search-hit-time">{formatModified(hit.mtimeMs)}</span>
          {hit.sizeBytes > 0 && (
            <span className="idx-search-hit-size">{formatBytes(hit.sizeBytes, dateLocale)}</span>
          )}
        </div>
      </li>
    )
  }

  return (
    <div ref={containerRef} className="idx-search-results-container" aria-live="polite">
      {openError && (
        <div className="idx-search-open-error" role="alert">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span className="idx-search-open-error-msg">{openError}</span>
          <button
            type="button"
            className="idx-error-dismiss-btn"
            aria-label={isVi ? 'Đóng thông báo lỗi' : 'Dismiss error'}
            onClick={(e) => {
              e.stopPropagation()
              setOpenError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                setOpenError(null)
              }
            }}
          >
            ×
          </button>
        </div>
      )}

      {isIndexing && (
        <div className="idx-search-indexing-banner" role="status">
          <span className="idx-spinner" aria-hidden="true" />
          <span>
            {isVi
              ? `Đang tối ưu hóa tìm kiếm (${searchPage?.index.pending} tệp)… Kết quả sẽ tự động mở rộng.`
              : `Optimizing search (${searchPage?.index.pending} pending)… Results will update automatically.`}
          </span>
        </div>
      )}

      {loading && !searchPage && (
        <div className="idx-search-loading" role="status">
          <span className="idx-spinner" aria-hidden="true" />
          <span>{isVi ? 'Đang tìm kiếm…' : 'Searching…'}</span>
        </div>
      )}

      {error && (
        <div className="idx-search-error" role="alert">
          <p>{error}</p>
        </div>
      )}

      {!loading && searchPage && searchPage.hits.length === 0 && (
        <div className="idx-search-empty">
          <svg
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="idx-search-empty-icon"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
            <line x1="8" y1="11" x2="14" y2="11" />
          </svg>
          <h4>{isVi ? 'Không tìm thấy kết quả phù hợp' : 'No matching results found'}</h4>
          <p>
            {isVi
              ? `Không có tệp nào khớp với từ khoá "${query}". Thử từ khoá khác hoặc kiểm tra lại chính tả.`
              : `No files matched "${query}". Try different keywords or check spelling.`}
          </p>
        </div>
      )}

      {searchPage && searchPage.hits.length > 0 && (
        <div className="idx-search-hits-wrapper">
          {/* Best matches (Tên tệp / Thư mục phù hợp nhất) */}
          {bestMatches.length > 0 && (
            <section
              className="idx-search-group"
              aria-label={isVi ? 'Tệp phù hợp nhất' : 'Best matches'}
            >
              <div className="idx-search-group-header">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
                <h4>{isVi ? 'Tệp phù hợp nhất' : 'Best matches'}</h4>
                <span className="idx-search-group-count">
                  {bestMatches.length} {isVi ? 'kết quả' : 'results'}
                </span>
              </div>
              <ul className="idx-search-list">
                {bestMatches.map((h, i) => renderHitItem(h, i))}
              </ul>
            </section>
          )}

          {/* Matches in contents (Khớp trong nội dung) */}
          {contentMatches.length > 0 && (
            <section
              className="idx-search-group"
              aria-label={isVi ? 'Khớp trong nội dung' : 'Matches in contents'}
            >
              <div className="idx-search-group-header">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                  <polyline points="10 9 9 9 8 9" />
                </svg>
                <h4>{isVi ? 'Khớp trong nội dung' : 'Matches in contents'}</h4>
                <span className="idx-search-group-count">
                  {contentMatches.length} {isVi ? 'kết quả' : 'results'}
                </span>
              </div>
              <ul className="idx-search-list">
                {contentMatches.map((h, i) => renderHitItem(h, bestMatches.length + i))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
