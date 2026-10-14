import type { ReactElement } from 'react'
import './update-artwork.css'

export type UpdateArtworkVariant =
  'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error'

export interface UpdateArtworkProps {
  variant?: UpdateArtworkVariant
  className?: string
}

function ArtworkBadgeIcon({ variant }: { variant: UpdateArtworkVariant }): ReactElement {
  switch (variant) {
    case 'up-to-date':
      return (
        <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <circle
            cx="16"
            cy="16"
            r="13"
            stroke="currentColor"
            strokeWidth="2"
            className="update-artwork-circle-path"
          />
          <path
            d="M10 16.5l4 4 8-8"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="update-artwork-check-path"
          />
        </svg>
      )
    case 'checking':
      return (
        <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <circle
            cx="16"
            cy="16"
            r="12"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray="18 10"
            className="update-artwork-circle-path"
          />
          <circle cx="16" cy="16" r="4" fill="currentColor" opacity="0.8" />
        </svg>
      )
    case 'available':
      return (
        <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <circle
            cx="16"
            cy="16"
            r="13"
            stroke="currentColor"
            strokeWidth="2"
            className="update-artwork-circle-path"
          />
          <path
            d="M16 22V10M11 15l5-5 5 5"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'downloading':
      return (
        <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <circle
            cx="16"
            cy="16"
            r="13"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray="24 8"
            className="update-artwork-circle-path"
          />
          <path
            d="M16 10v12M11 17l5 5 5-5"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'downloaded':
      return (
        <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <rect
            x="5"
            y="7"
            width="22"
            height="18"
            rx="4"
            stroke="currentColor"
            strokeWidth="2"
            className="update-artwork-circle-path"
          />
          <path
            d="M11 16l3.5 3.5 6.5-6.5"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'error':
      return (
        <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <circle
            cx="16"
            cy="16"
            r="13"
            stroke="currentColor"
            strokeWidth="2"
            className="update-artwork-circle-path"
          />
          <path
            d="M16 10v8M16 21.5v.5"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
        </svg>
      )
  }
}

/**
 * Presentational, decorative Apple-inspired update artwork component.
 * Purely cosmetic: buttons and updater actions remain application-owned.
 */
export function UpdateArtwork({
  variant = 'up-to-date',
  className = '',
}: UpdateArtworkProps): ReactElement {
  return (
    <div className={`update-artwork ${className}`.trim()} data-variant={variant} aria-hidden="true">
      <div className="update-artwork-stage">
        <div className="update-artwork-atmosphere" />
        <div className="update-artwork-aurora">
          <div className="update-artwork-ribbon update-artwork-ribbon-1" />
          <div className="update-artwork-ribbon-2" />
        </div>
        <div className="update-artwork-glass-disc update-artwork-glass-disc-1" />
        <div className="update-artwork-glass-disc update-artwork-glass-disc-2" />
        <div className="update-artwork-badge">
          <ArtworkBadgeIcon variant={variant} />
        </div>
      </div>
    </div>
  )
}
export default UpdateArtwork
