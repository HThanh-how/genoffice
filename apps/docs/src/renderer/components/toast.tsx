/** Transient feedback for user-triggered actions, including shell notices. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { setToastEmitter, showInfoToast, type ToastData } from './toast-bus'

export function ToastHost() {
  const [toast, setToast] = useState<ToastData | null>(null)
  const [visible, setVisible] = useState(false)
  const hideTimer = useRef<number | undefined>(undefined)
  const clearTimer = useRef<number | undefined>(undefined)
  const raf = useRef(0)

  const dismiss = useCallback(() => {
    window.cancelAnimationFrame(raf.current)
    window.clearTimeout(hideTimer.current)
    window.clearTimeout(clearTimer.current)
    setVisible(false)
    clearTimer.current = window.setTimeout(() => setToast(null), 200)
  }, [])

  useEffect(() => {
    setToastEmitter((next) => {
      window.clearTimeout(hideTimer.current)
      window.clearTimeout(clearTimer.current)
      window.cancelAnimationFrame(raf.current)
      setToast(next)
      setVisible(false)
      raf.current = window.requestAnimationFrame(() => {
        raf.current = window.requestAnimationFrame(() => setVisible(true))
      })
      const shownMs = next.duration ?? (next.kind === 'error' ? 4000 : 2000)
      hideTimer.current = window.setTimeout(dismiss, shownMs)
    })
    const removeInfoToast = window.desktop.onInfoToast(showInfoToast)
    return () => {
      removeInfoToast()
      setToastEmitter(null)
      window.clearTimeout(hideTimer.current)
      window.clearTimeout(clearTimer.current)
      window.cancelAnimationFrame(raf.current)
    }
  }, [dismiss])

  if (!toast) return null
  const pause = () => window.clearTimeout(hideTimer.current)
  const resume = () => {
    hideTimer.current = window.setTimeout(
      dismiss,
      toast.duration ?? (toast.kind === 'error' ? 4000 : 2000),
    )
  }
  return (
    <div
      className={`app-toast ${toast.kind}${visible ? ' show' : ''}`}
      role="status"
      aria-live="polite"
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocus={pause}
      onBlur={resume}
    >
      <svg
        className="app-toast-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {toast.kind === 'success' ? (
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="m8.2 12.3 2.6 2.6 5-5" />
          </>
        ) : toast.kind === 'info' ? (
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v5" />
            <path d="M12 7.5v.1" />
          </>
        ) : (
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.5v5.3" />
            <path d="M12 16.4v.1" />
          </>
        )}
      </svg>
      <span>{toast.text}</span>
      {toast.kind === 'info' && (
        <button
          className="app-toast-dismiss"
          type="button"
          aria-label={
            document.documentElement.lang.startsWith('vi')
              ? 'Đóng thông báo'
              : 'Dismiss notification'
          }
          onClick={dismiss}
        >
          ×
        </button>
      )}
    </div>
  )
}
