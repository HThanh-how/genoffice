import { useCallback, useState, type ReactNode } from 'react'
import { IconMore } from './index-icons'
import { IndexMenu } from './IndexMenu'

/** Uses the same generic header classes as Settings → Appearance. */
export function IndexCardHeading({
  title,
  hint,
  icon,
  children,
}: {
  title: string
  hint: string
  icon: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="set-group-title ix-card-heading">
      <span className="set-group-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="set-group-text">
        <strong role="heading" aria-level={2}>
          {title}
        </strong>
        {hint && <span className="set-group-hint">{hint}</span>}
      </span>
      {children && <span className="ix-card-heading-actions">{children}</span>}
    </div>
  )
}

/**
 * The quiet "…" button with a menu behind it. `children` is a function so each item can close the
 * menu before it acts.
 */
export function IndexOverflow({
  label,
  children,
  width,
}: {
  label: string
  children: (close: () => void) => ReactNode
  width?: number
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  return (
    <>
      <button
        type="button"
        ref={setAnchor}
        className="ix-icon-btn ix-overflow-trigger"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <IconMore />
      </button>
      {open && (
        <IndexMenu anchor={anchor} onClose={close} label={label} {...(width ? { width } : {})}>
          {children(close)}
        </IndexMenu>
      )}
    </>
  )
}
