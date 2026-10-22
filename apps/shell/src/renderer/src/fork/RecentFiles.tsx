import { useEffect, useRef, useState } from 'react'
import type { HomeApi, RecentEntry } from '../../../shared/home-api'
import { useI18n } from '../locale'
import { iconFor } from '../file-icons'

export interface RecentFilesProps {
  api: HomeApi
  limit?: number
  onOpened?: () => void
  /** opens the full Recent list (Home); shown as "View all" in the header */
  onViewAll?: () => void
}

/** A short list: the full Recent list lives on Home, this one only shows the latest few. */
export function RecentFiles({ api, limit = 5, onOpened, onViewAll }: RecentFilesProps) {
  const { lang, dateLocale } = useI18n()
  const isVi = lang === 'vi'

  const [recents, setRecents] = useState<RecentEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let alive = true
    const loadRecents = async () => {
      try {
        setLoading(true)
        setError(null)
        const res = await api.recents({ limit })
        if (alive) {
          setRecents(res?.entries ?? [])
        }
      } catch (err) {
        if (alive) {
          setError(isVi ? 'Không thể tải danh sách tệp gần đây.' : 'Could not load recent files.')
        }
      } finally {
        if (alive) setLoading(false)
      }
    }

    void loadRecents()
    return () => {
      alive = false
    }
  }, [api, limit, isVi, reload])

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

  const formatModifiedDate = (timeMs: number): string => {
    if (!timeMs) return '–'
    const now = Date.now()
    const diffHours = (now - timeMs) / (1000 * 60 * 60)
    if (diffHours < 24 && new Date(now).getDate() === new Date(timeMs).getDate()) {
      return new Date(timeMs).toLocaleTimeString(dateLocale, {
        hour: '2-digit',
        minute: '2-digit',
      })
    }
    return new Date(timeMs).toLocaleDateString(dateLocale, {
      month: 'short',
      day: 'numeric',
      year: diffHours > 24 * 300 ? 'numeric' : undefined,
    })
  }

  const getDirectoryPath = (filePath: string): string => {
    const parts = filePath.split(/[\\/]/)
    if (parts.length <= 1) return ''
    parts.pop() // remove filename
    return parts.join('/')
  }

  return (
    <section className="idx-recent-section" aria-label={isVi ? 'Tệp mở gần đây' : 'Recent files'}>
      <div className="idx-recent-header">
        <h3 className="idx-recent-title">{isVi ? 'Tệp mở gần đây' : 'Recent files'}</h3>
        {onViewAll && (
          <button type="button" className="idx-link" onClick={onViewAll}>
            {isVi ? 'Xem tất cả' : 'View all'}
          </button>
        )}
      </div>

      {openError && (
        <div className="idx-recent-open-error" role="alert">
          <span className="idx-recent-open-error-msg">{openError}</span>
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

      {loading && recents.length === 0 && (
        <ul className="idx-recent-list" aria-busy="true" aria-label={isVi ? 'Đang tải' : 'Loading'}>
          {Array.from({ length: limit }, (_, i) => (
            <li key={i} className="idx-recent-item is-placeholder" aria-hidden="true">
              <span className="idx-skel idx-skel-icon" />
              <span className="idx-recent-info">
                <span className="idx-skel idx-skel-name" />
                <span className="idx-skel idx-skel-path" />
              </span>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <div className="idx-recent-error" role="alert">
          <p>{error}</p>
          <button type="button" className="idx-link" onClick={() => setReload((n) => n + 1)}>
            {isVi ? 'Thử lại' : 'Try again'}
          </button>
        </div>
      )}

      {!loading && !error && recents.length === 0 && (
        <div className="idx-recent-empty">
          <p>{isVi ? 'Chưa có tệp nào được mở gần đây.' : 'No recently opened files yet.'}</p>
        </div>
      )}

      {!error && recents.length > 0 && (
        <ul className="idx-recent-list">
          {recents.slice(0, limit).map((file) => {
            const dir = getDirectoryPath(file.path)
            return (
              <li key={file.path}>
                <button
                  type="button"
                  className="idx-recent-item"
                  onClick={() => void handleOpen(file.path)}
                >
                  <img
                    src={iconFor(file.name)}
                    alt=""
                    className="idx-recent-icon"
                    aria-hidden="true"
                  />
                  <span className="idx-recent-info">
                    <span className="idx-recent-name" title={file.name}>
                      {file.name}
                    </span>
                    {dir && (
                      <span className="idx-recent-path" title={dir}>
                        {dir}
                      </span>
                    )}
                  </span>
                  <span className="idx-recent-time">{formatModifiedDate(file.mtimeMs)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
