import type { ReactNode } from 'react'

/** The few outline glyphs the Index screen uses: one set, 16px, 1.5px stroke, colour from the text. */
function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export const IconBack = () => (
  <Svg>
    <path d="M10 3 5 8l5 5" />
  </Svg>
)
export const IconFolder = () => (
  <Svg>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.6h5A1.5 1.5 0 0 1 14 6.1v5.4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
  </Svg>
)
export const IconMore = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <circle cx="3.5" cy="8" r="1.2" />
    <circle cx="8" cy="8" r="1.2" />
    <circle cx="12.5" cy="8" r="1.2" />
  </svg>
)
export const IconPlus = () => (
  <Svg>
    <path d="M8 3.5v9M3.5 8h9" />
  </Svg>
)
export const IconChevron = () => (
  <Svg>
    <path d="m6 4 4 4-4 4" />
  </Svg>
)
export const IconCheck = () => (
  <Svg>
    <path d="m3.5 8.5 3 3 6-6.5" />
  </Svg>
)
export const IconSearch = () => (
  <Svg>
    <circle cx="7" cy="7" r="4.2" />
    <path d="m10.2 10.2 3.3 3.3" />
  </Svg>
)
export const IconPause = () => (
  <Svg>
    <path d="M5.5 3.5v9M10.5 3.5v9" />
  </Svg>
)
export const IconAlert = () => (
  <Svg>
    <path d="M8 2.5 14 13H2z" />
    <path d="M8 6.5v3M8 11.4v.1" />
  </Svg>
)
export const IconOffline = () => (
  <Svg>
    <path
      d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.6h5A1.5 1.5 0 0 1 14 6.1v5.4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"
      strokeDasharray="2 2"
    />
  </Svg>
)
