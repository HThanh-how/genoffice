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
export const IconOpen = () => (
  <Svg>
    <path d="M9 3h4v4M13 3 7.5 8.5M12 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.5" />
  </Svg>
)
export const IconRetry = () => (
  <Svg>
    <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" />
  </Svg>
)
export const IconPulse = () => (
  <Svg>
    <path d="M2 8.5h2.6l1.9-4.5 3 8 1.9-3.5H14" />
  </Svg>
)
export const IconClock = () => (
  <Svg>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3.2l2 1.3" />
  </Svg>
)
export const IconSliders = () => (
  <Svg>
    <path d="M3 5h5.5M11.5 5H13M3 11h1.5M7.5 11H13" />
    <circle cx="10" cy="5" r="1.5" />
    <circle cx="6" cy="11" r="1.5" />
  </Svg>
)
export const IconFile = () => (
  <Svg>
    <path d="M4 2.5h5l3 3v8H4z" />
    <path d="M9 2.5v3h3" />
  </Svg>
)
