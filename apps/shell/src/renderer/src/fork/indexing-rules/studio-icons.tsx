/* Lucide-style inline icons: one 24px grid, one stroke width, currentColor.
 * No emoji glyphs anywhere in the studio chrome. */
import type { ReactNode } from 'react'

interface IconProps {
  className?: string
}

function Icon({ className = 'ixr-icon', children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export function IconPlus(p: IconProps = {}) {
  return (
    <Icon className={p.className}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  )
}

export function IconSearch(p: IconProps = {}) {
  return (
    <Icon className={p.className}>
      <circle cx="11" cy="11" r="7" />
      <path d="m16 16 5 5" />
    </Icon>
  )
}

export function IconFilter(p: IconProps = {}) {
  return (
    <Icon className={p.className}>
      <path d="M22 3H2l8 9.46V19l4-2.54L22 3z" />
    </Icon>
  )
}

export function IconPencil(p: IconProps = {}) {
  return (
    <Icon className={p.className}>
      <path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </Icon>
  )
}

export function IconTrash(p: IconProps = {}) {
  return (
    <Icon className={p.className}>
      <path d="M3 6h18M8 6v13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V6M10 10v6M14 10v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </Icon>
  )
}

export function IconSave(p: IconProps = {}) {
  return (
    <Icon className={p.className}>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M17 21v-8H7v8M7 17l5-5" />
    </Icon>
  )
}

export function IconRefresh(p: IconProps = {}) {
  return (
    <Icon className={p.className}>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M3 8h4v4M21 16h-4v-4" />
    </Icon>
  )
}

export function IconFile(p: IconProps = {}) {
  return (
    <Icon className={p.className}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" />
      <path d="M14 2v6h6" />
    </Icon>
  )
}

export function IconCheck(p: IconProps = {}) {
  return (
    <Icon className={p.className}>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
  )
}

export function IconX(p: IconProps = {}) {
  return (
    <Icon className={p.className}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Icon>
  )
}

export function IconAlert(p: IconProps = {}) {
  return (
    <Icon className={p.className}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.66a2 2 0 0 0 1.71-3L10.29 3.86z" />
      <path d="M12 9v4M12 17h.01" />
    </Icon>
  )
}

export function IconChevronDown(p: IconProps = {}) {
  return (
    <Icon className={p.className}>
      <path d="M6 9l6 6 6-6" />
    </Icon>
  )
}

export function IconChevronUp(p: IconProps = {}) {
  return (
    <Icon className={p.className}>
      <path d="M6 15l6-6 6 6" />
    </Icon>
  )
}

export function IconShield(p: IconProps = {}) {
  return (
    <Icon className={p.className}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </Icon>
  )
}

export function IconLayers(p: IconProps = {}) {
  return (
    <Icon className={p.className}>
      <path d="M12 2 2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5M2 12l10 5 10-5" />
    </Icon>
  )
}

export function IconFolder(p: IconProps = {}) {
  return (
    <Icon className={p.className}>
      <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z" />
    </Icon>
  )
}

export function IconBook(p: IconProps = {}) {
  return (
    <Icon className={p.className}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </Icon>
  )
}
