import React from 'react'
import { OPENING_APPS, type OpeningApp } from '../../../../shared/opening-scenes-meta'
import { APP_INFO } from './app-info'

export const appName = (app: OpeningApp, isVi: boolean): string =>
  isVi ? APP_INFO[app].nameVi : APP_INFO[app].nameEn

/** The badge of one app: its colour and the letter the real opening card shows. */
export function AppMark({ app, size = 18 }: { app: OpeningApp; size?: number }): React.JSX.Element {
  const info = APP_INFO[app]
  const long = info.letter.length > 1
  return (
    <span
      className="ocs-appmark"
      data-app={app}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        backgroundColor: info.color,
        fontSize: Math.round(size * (long ? 0.34 : 0.56)),
        borderRadius: Math.round(size * 0.28),
      }}
    >
      {info.letter}
    </span>
  )
}

/** "Every app": the four first app colours as a small tile. */
export function AllAppsMark({ size = 18 }: { size?: number }): React.JSX.Element {
  return (
    <span
      className="ocs-appmark ocs-appmark-all"
      aria-hidden="true"
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28) }}
    >
      {OPENING_APPS.slice(0, 4).map((app) => (
        <i key={app} style={{ backgroundColor: APP_INFO[app].color }} />
      ))}
    </span>
  )
}

/**
 * The apps a card plays in: all six as the all-apps tile, otherwise up to `max` badges and a
 * "+N" for the rest.
 */
export function AppLogoStack({
  apps,
  isVi,
  size = 18,
  max = 3,
}: {
  apps: readonly OpeningApp[]
  isVi: boolean
  size?: number
  max?: number
}): React.JSX.Element | null {
  if (apps.length === 0) return null
  const all = apps.length === OPENING_APPS.length
  const names = apps.map((app) => appName(app, isVi)).join(', ')
  const label = all
    ? isVi
      ? 'Dùng cho mọi ứng dụng'
      : 'Used by all apps'
    : (isVi ? 'Dùng cho ' : 'Used by ') + names
  const shown = apps.slice(0, max)
  const rest = apps.length - shown.length
  return (
    <span className="ocs-logostack" role="img" aria-label={label} title={label}>
      {all ? (
        <AllAppsMark size={size} />
      ) : (
        <>
          {shown.map((app) => (
            <AppMark key={app} app={app} size={size} />
          ))}
          {rest > 0 && (
            <span className="ocs-logostack-more" style={{ height: size, minWidth: size }}>
              +{rest}
            </span>
          )}
        </>
      )}
    </span>
  )
}
