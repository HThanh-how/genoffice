import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { OpeningMaterialConfig } from '../../../../shared/opening-card-types'
import type { OpeningApp } from '../../../../shared/opening-scenes-meta'
import { buildMaterialCss, sampleFileName } from '../../../../shared/opening-card-css'
import { APP_INFO } from './app-info'

/** Logical size of the stage; everything inside is laid out at this size and scaled to fit. */
export const SURFACE_W = 640
export const SURFACE_H = 360

/** The UI theme the studio is showing right now (the app's own switch first, then the system). */
export function resolveUiTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'dark'
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr === 'light' || attr === 'dark') return attr
  return typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark'
}

export function useUiTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(resolveUiTheme)
  useEffect(() => {
    const update = () => setTheme(resolveUiTheme())
    const observer =
      typeof MutationObserver === 'function' ? new MutationObserver(update) : undefined
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    const media = window.matchMedia?.('(prefers-color-scheme: light)')
    media?.addEventListener?.('change', update)
    return () => {
      observer?.disconnect()
      media?.removeEventListener?.('change', update)
    }
  }, [])
  return theme
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  )
}

interface CardSurfaceProps {
  material: OpeningMaterialConfig
  app: OpeningApp
  lang: string
  /** Opening title, e.g. "Opening document…" */
  title: string
  /** Set for decorative uses (gallery tiles): hides the stage from assistive tech */
  decorative?: boolean
  /** Let a breathing card animate (off for gallery tiles) */
  animate?: boolean
  /** Enlarge around the center so the card, not the editor outline, fills a small tile (1 = whole stage) */
  zoom?: number
}

/**
 * The one renderer for a material card: the same CSS the real opening window builds, drawn over the same
 * kind of backdrop (the grey outline of the editor that is opening), scaled to the box it is put in.
 * The preview and every gallery thumbnail use it, so a thumbnail is the preview in small.
 */
export function CardSurface({
  material,
  app,
  lang,
  title,
  decorative,
  animate,
  zoom = 1,
}: CardSurfaceProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [scale, setScale] = useState(1)
  const uiTheme = useUiTheme()

  useLayoutEffect(() => {
    const el = hostRef.current
    if (!el) return
    const fit = () => {
      const w = el.getBoundingClientRect().width
      if (w > 0) setScale(w / SURFACE_W)
    }
    fit()
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const info = APP_INFO[app]
  const css = useMemo(
    () => buildMaterialCss(material, { appColor: info.color, systemTheme: uiTheme }),
    [material, info.color, uiTheme],
  )
  const breathing = Boolean(animate && css.animation && !prefersReducedMotion())
  const fileName = sampleFileName(app, lang)

  return (
    <div
      ref={hostRef}
      className={`ocs-surface is-${uiTheme}`}
      {...(decorative ? { 'aria-hidden': true } : {})}
    >
      <div
        className="ocs-surface-stage"
        style={{
          width: SURFACE_W,
          height: SURFACE_H,
          transform: `translate(${(-(zoom - 1) * SURFACE_W * scale) / 2}px, ${(-(zoom - 1) * SURFACE_H * scale) / 2}px) scale(${scale * zoom})`,
        }}
      >
        {/* the outline of the editor that is opening, so glass has something to blur */}
        <div className="ocs-sk" aria-hidden="true">
          <div className="ocs-sk-tabs">
            <i style={{ width: 44 }} />
            <i style={{ width: 56 }} />
            <i style={{ width: 70 }} />
            <i style={{ width: 52 }} />
          </div>
          <div className="ocs-sk-ribbon">
            <i style={{ width: 40, height: 34 }} />
            <i style={{ width: 40, height: 34 }} />
            <i className="is-accent" style={{ width: 84, height: 34, background: info.color }} />
            <i style={{ width: 120, height: 14 }} />
            <i style={{ width: 90, height: 14 }} />
          </div>
          <div className="ocs-sk-page">
            <i className="is-accent" style={{ width: '46%', height: 16, background: info.color }} />
            <i style={{ width: '92%' }} />
            <i style={{ width: '86%' }} />
            <i style={{ width: '94%' }} />
            <i className="is-block" />
            <i style={{ width: '70%' }} />
            <i style={{ width: '90%' }} />
            <i style={{ width: '58%' }} />
          </div>
        </div>

        {breathing && <style>{css.keyframesCss}</style>}
        <div
          className="ocs-surface-card"
          style={{
            background: css.background,
            backdropFilter: css.backdropFilter,
            WebkitBackdropFilter: css.backdropFilter,
            border: css.border,
            borderRadius: css.borderRadius,
            boxShadow: css.boxShadow,
            color: css.color,
            animation: breathing ? css.animation : undefined,
          }}
        >
          <span className="ocs-surface-badge" style={{ backgroundColor: info.color }}>
            {info.letter}
          </span>
          <div className="ocs-surface-text">
            <span className="ocs-surface-title">{title}</span>
            <span className="ocs-surface-file">{fileName}</span>
          </div>
          <span className="ocs-surface-bar">
            <i style={{ backgroundColor: info.color }} />
          </span>
        </div>
      </div>
    </div>
  )
}
