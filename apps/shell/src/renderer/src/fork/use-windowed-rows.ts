import { useEffect, useRef, useState, type RefObject } from 'react'
import { WINDOW_FROM, windowRange } from './index-screen-model'

/**
 * Which rows of a long list to draw. The list is measured against the scroller it sits in (the page
 * itself, or a pane), so a list of 300 folders draws about twenty rows and scrolling stays cheap.
 * Short lists are drawn whole.
 */
export function useWindowedRows(
  listRef: RefObject<HTMLElement | null>,
  count: number,
  rowHeight: number,
  scrollerSelector: string,
) {
  const windowed = count > WINDOW_FROM
  const [range, setRange] = useState({ start: 0, end: 20 })
  const frame = useRef(0)
  useEffect(() => {
    const list = listRef.current
    if (!windowed || !list) return
    const scroller = list.closest<HTMLElement>(scrollerSelector)
    if (!scroller) return
    const measure = () => {
      frame.current = 0
      const scrolledPast = scroller.getBoundingClientRect().top - list.getBoundingClientRect().top
      const next = windowRange({
        scrolledPast,
        viewport: scroller.clientHeight,
        rowHeight,
        count,
      })
      setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
    }
    const schedule = () => {
      if (!frame.current) frame.current = requestAnimationFrame(measure)
    }
    measure()
    scroller.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(frame.current)
      frame.current = 0
      scroller.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [windowed, count, rowHeight, scrollerSelector, listRef])
  return {
    windowed,
    range,
    padTop: windowed ? range.start * rowHeight : 0,
    padBottom: windowed ? Math.max(0, (count - range.end) * rowHeight) : 0,
  }
}
