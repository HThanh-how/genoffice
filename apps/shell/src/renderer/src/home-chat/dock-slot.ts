import { useEffect, useLayoutEffect, useState } from 'react'

/**
 * The element with this id that is in the document right now. `current` is kept only while it is
 * still attached; a node that was removed (the view re-mounted its slot) is never returned.
 */
export function pickSlot(
  doc: Pick<Document, 'getElementById'>,
  id: string,
  current: HTMLElement | null,
): HTMLElement | null {
  if (current && current.isConnected && current.id === id) return current
  return doc.getElementById(id)
}

/**
 * Follows a mount point owned by another component. It is re-checked after every commit and
 * whenever the DOM changes, so a portal never keeps pointing at a node that has been replaced.
 */
export function useSlot(id: string, enabled = true): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const next = enabled ? pickSlot(document, id, slot) : null
    if (next !== slot) setSlot(next)
  })

  useEffect(() => {
    if (!enabled || typeof MutationObserver === 'undefined') return
    let frame = 0
    const sync = () => {
      frame = 0
      setSlot((previous) => {
        const next = pickSlot(document, id, previous)
        return next === previous ? previous : next
      })
    }
    const observer = new MutationObserver(() => {
      if (!frame) frame = window.requestAnimationFrame(sync)
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [enabled, id])

  return slot
}
