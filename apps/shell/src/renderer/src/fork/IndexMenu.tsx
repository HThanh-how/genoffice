import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { placeFolderMenu } from '../folder-menu-position'

/**
 * A small popover menu anchored to a button. It is drawn in the document body with fixed
 * coordinates so no scrolling list can clip it, flips above its anchor when there is no room below,
 * and closes on Escape, on a press outside, and when the page scrolls or resizes.
 */
export function IndexMenu({
  anchor,
  onClose,
  children,
  width = 232,
  label,
}: {
  anchor: HTMLElement | null
  onClose: () => void
  children: ReactNode
  width?: number
  label?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    if (!anchor || !ref.current) return
    const rect = anchor.getBoundingClientRect()
    const menu = ref.current.getBoundingClientRect()
    setPos(
      placeFolderMenu(
        { x: rect.right - width, y: rect.bottom + 4, above: rect.top - 4 },
        { width, height: menu.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    )
  }, [anchor, width, children])

  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('button:not(:disabled)')
    first?.focus({ preventScroll: true })
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        anchor?.focus()
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const items = Array.from(
          ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [],
        )
        if (items.length === 0) return
        event.preventDefault()
        const at = items.indexOf(document.activeElement as HTMLElement)
        const next = event.key === 'ArrowDown' ? at + 1 : at - 1
        items[(next + items.length) % items.length]!.focus()
      }
    }
    const onPress = (event: PointerEvent) => {
      const target = event.target as Node
      if (ref.current?.contains(target) || anchor?.contains(target)) return
      onClose()
    }
    const close = () => onClose()
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onPress, true)
    window.addEventListener('resize', close)
    document.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onPress, true)
      window.removeEventListener('resize', close)
      document.removeEventListener('scroll', close, true)
    }
  }, [anchor, onClose])

  return createPortal(
    <div
      ref={ref}
      className="ix-menu"
      role="menu"
      aria-label={label}
      style={{ width, left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
    >
      {children}
    </div>,
    document.body,
  )
}

export function MenuItem({
  children,
  onClick,
  disabled,
  checked,
  danger,
  title,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  checked?: boolean
  danger?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={checked}
      className={`ix-menu-item${danger ? ' is-danger' : ''}`}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export const MenuSeparator = () => <div className="ix-menu-sep" role="separator" />
