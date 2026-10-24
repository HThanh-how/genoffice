import type { ReactNode } from 'react'

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
        <span className="set-group-hint">{hint}</span>
      </span>
      {children && <span className="ix-card-heading-actions">{children}</span>}
    </div>
  )
}
