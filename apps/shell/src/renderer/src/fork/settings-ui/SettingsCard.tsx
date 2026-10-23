import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import './settings-card.css'

/** Shared chrome for Settings and the index workspace.
 * Card: title + optional subtitle, icon (line-icon id or custom node), action,
 * fold (native, initially collapsed details), className and children.
 * Row: label + optional description/control, or children for custom field layouts;
 * ordinary div props (id, aria-*, etc.) pass through unchanged.
 */
const ICONS = {
  appearance: 'M12 3a9 9 0 1 0 9 9h-9zM12 3v9h9',
  ai: 'M4 4h16v13H9l-5 4zM8 9h8m-8 4h5',
  files: 'M3 6h7l2 3h9v11H3z',
  privacy: 'M12 3 4 6v6c0 4 8 9 8 9s8-5 8-9V6zM9 12l2 2 4-4',
  legacy: 'M7 3h7l4 4v14H7zM14 3v5h4M10 13h5m-5 4h5',
  opening: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z',
  integrations: 'M8 3v5m8-5v5M5 8h14v3a7 7 0 0 1-14 0zM12 18v4',
  skills: 'M5 3h9l5 5v13H5zM14 3v6h5M8 13h8m-8 4h6',
  search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14M15 15l6 6',
  media: 'M3 4h18v16H3zM3 16l5-5 5 5 3-3 5 5M16 8h.01',
} as const

export function SettingsIcon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d={ICONS[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function SettingsCardHeader({
  title,
  subtitle,
  icon = 'ai',
  action,
}: {
  title: string
  subtitle?: string
  icon?: keyof typeof ICONS | ReactNode
  action?: ReactNode
}) {
  return (
    <>
      <span className="set-group-icon" aria-hidden="true">
        {typeof icon === 'string' && icon in ICONS ? (
          <SettingsIcon name={icon as keyof typeof ICONS} />
        ) : (
          icon
        )}
      </span>
      <span className="set-group-text">
        <span>{title}</span>
        {subtitle && <span className="set-group-hint">{subtitle}</span>}
      </span>
      {action && <span className="settings-card-action">{action}</span>}
    </>
  )
}

export function SettingsCard({
  title,
  subtitle,
  icon,
  action,
  fold,
  className = '',
  children,
}: ComponentPropsWithoutRef<typeof SettingsCardHeader> & {
  fold?: boolean
  className?: string
  children: ReactNode
}) {
  const heading = (
    <SettingsCardHeader title={title} subtitle={subtitle} icon={icon} action={action} />
  )
  const body = <div className="set-group-body">{children}</div>
  return fold ? (
    <details className={`set-group settings-card set-group-fold ${className}`}>
      <summary className="set-group-title">{heading}</summary>
      {body}
    </details>
  ) : (
    <section className={`set-group settings-card ${className}`} aria-label={title}>
      <h4 className="set-group-title">{heading}</h4>
      {body}
    </section>
  )
}

export function SettingsRow({
  label,
  description,
  control,
  children,
  className = '',
  ...props
}: Omit<ComponentPropsWithoutRef<'div'>, 'title'> & {
  label?: ReactNode
  description?: ReactNode
  control?: ReactNode
}) {
  return (
    <div className={`set-field settings-row ${className}`} {...props}>
      {label ? (
        <div className="set-field-text">
          <div className="set-field-stack">
            <div className="set-field-label">{label}</div>
            {description && <div className="set-field-desc">{description}</div>}
          </div>
        </div>
      ) : null}
      {control}
      {children}
    </div>
  )
}
