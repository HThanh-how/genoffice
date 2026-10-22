import { useEffect } from 'react'

/** Search lives in the Home box: Ctrl+F leaves the index screen and focuses it there. */
export function useLeaveForSearch(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      if (e.key !== 'f' && e.key !== 'F' && e.code !== 'KeyF') return
      e.preventDefault()
      onClose()
      requestAnimationFrame(() => {
        const input = document.querySelector<HTMLInputElement>('.ask-dock .ask-form input')
        input?.focus()
        input?.select()
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
}
