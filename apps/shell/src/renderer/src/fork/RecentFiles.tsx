import { useEffect, useState } from 'react'
import type { HomeApi, RecentEntry } from '../../../shared/home-api'
import { useI18n } from '../locale'
import { iconFor } from '../file-icons'
import { formatBytes } from './index-file-log'

export interface RecentFilesProps {
  api: HomeApi
  limit?: number
  onOpened?: () => void
}

export function RecentFiles({ api, limit = 12, onOpened }: RecentFilesProps) {
  const { lang, dateLocale } = useI18n()
  const isVi = lang === 'vi'

  const [recents, setRecents] = useState<RecentEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)

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
          setError(
            isVi
              ? 'Không thể tải danh sách tệp gần đây.'
              : 'Could not load recent files.',
          )
        }
      } finally {
        if (alive) setLoading(false)
      }
    }

    void loadRecents()
    return () => {
      alive = false
    }
  }, [api, limit, isVi])

  const handleOpen = async (path: string) => {
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
    <section className="idx-recent-section" aria-label={isVi ? 'Tệp gần đây' : 'Recent files'}>
      <div className="idx-recent-header">
        <h3 className="idx-recent-title">
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
            <polyline points="12 6 12 12 16 14" />
          </svg>
          {isVi ? 'Tệp mở gần đây' : 'Recent files'}
        </h3>
        {recents.length > 0 && (
          <span className="idx-recent-count">
            {recents.length} {isVi ? 'tệp' : 'files'}
          </span>
        )}
      </div>

      {openError && (
        <div className="idx-recent-open-error" role="alert">
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
          <span className="idx-recent-open-error-msg">{openError}</span>
          <button
            type="button"
            className="idx-error-dismiss-btn"
            aria-label={isVi ? 'Đóng thông báo lỗi' : 'Dismiss error'}
            onClick={() => setOpenError(null)}
          >
            ×
          </button>
        </div>
      )}

      {loading && (
        <div className="idx-recent-loading" role="status">
          <span className="idx-spinner" aria-hidden="true" />
          <span>{isVi ? 'Đang tải tệp gần đây…' : 'Loading recent files…'}</span>
        </div>
      )}

      {error && (
        <div className="idx-recent-error" role="alert">
          <p>{error}</p>
        </div>
      )}

      {!loading && !error && recents.length === 0 && (
        <div className="idx-recent-empty">
          <p>{isVi ? 'Chưa có tệp nào được mở gần đây.' : 'No recently opened files found.'}</p>
        </div>
      )}

      {!loading && !error && recents.length > 0 && (
        <ul className="idx-recent-list">
          {recents.map((file) => {
            const dir = getDirectoryPath(file.path)
            return (
              <li
                key={file.path}
                className="idx-recent-item"
                role="button"
                tabIndex={0}
                onClick={() => void handleOpen(file.path)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    void handleOpen(file.path)
                  }
                }}
              >
                <img
                  src={iconFor(file.name)}
                  alt=""
                  className="idx-recent-icon"
                  aria-hidden="true"
                />
                <div className="idx-recent-info">
                  <span className="idx-recent-name" title={file.name}>
                    {file.name}
                  </span>
                  {dir && (
                    <span className="idx-recent-path" title={dir}>
                      {dir}
                    </span>
                  )}
                </div>
                <div className="idx-recent-meta">
                  <span className="idx-recent-time">{formatModifiedDate(file.mtimeMs)}</span>
                  {file.sizeBytes > 0 && (
                    <span className="idx-recent-size">
                      {formatBytes(file.sizeBytes, dateLocale)}
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
