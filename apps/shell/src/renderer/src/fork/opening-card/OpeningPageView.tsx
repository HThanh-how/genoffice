import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { OpeningCardDefinition } from '../../../../shared/opening-card-types'
import { sampleFileName } from '../../../../shared/opening-card-css'
import { openingPageParts, openingWords, type SplashTier } from '../../../../shared/opening-page'
import type { OpeningApp } from '../../../../shared/opening-scenes-meta'
import { runGOScene } from '../../../../shared/opening-scenes-runner'

/** The size the opening card is laid out at (a tab, with the card in the middle), scaled to fit the box. */
export const PAGE_W = 640
export const PAGE_H = 360

interface OpeningPageViewProps {
  app: OpeningApp
  lang: string
  tier: SplashTier
  /** the scene to play (a scene card) */
  sceneId?: string
  /** a card that is not a plain scene, e.g. a picture (see `mediaDataUrl`) */
  card?: OpeningCardDefinition
  mediaDataUrl?: string | null
  decorative?: boolean
}

/**
 * The opening card as the opening window shows it, drawn in the studio: the same page (the same
 * markup and stylesheet, from `openingPageParts`) and the same scene code (`runGOScene`, which the
 * window runs too, see `opening-scenes-lib`). The page goes in a shadow root so that its stylesheet
 * cannot touch the studio and the studio's cannot touch it, and in a box of the size of a tab,
 * scaled down to fit.
 */
export function OpeningPageView({
  app,
  lang,
  tier,
  sceneId,
  card,
  mediaDataUrl,
  decorative,
}: OpeningPageViewProps): React.JSX.Element {
  const outerRef = useRef<HTMLDivElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [scale, setScale] = useState(1)

  useLayoutEffect(() => {
    const el = outerRef.current
    if (!el) return
    const fit = () => {
      const w = el.getBoundingClientRect().width
      if (w > 0) setScale(w / PAGE_W)
    }
    fit()
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    const parts = openingPageParts(
      openingWords(lang === 'vi' ? 'vi' : 'en', 'open'),
      sampleFileName(app, lang),
      app,
      tier,
      sceneId,
      'card',
      card,
      mediaDataUrl ?? undefined,
      'shadow',
    )
    root.innerHTML = `<style>${parts.css}</style><div class="pg${parts.bodyClass ? ` ${parts.bodyClass}` : ''}"${parts.bodyAttrs}>${parts.bodyInner}</div>`
    let stop: (() => void) | null = null
    const canvas = root.getElementById('sea') as HTMLCanvasElement | null
    if (canvas && parts.isCanvasScene && tier !== 'minimal') {
      try {
        stop = runGOScene(canvas, parts.sceneId, tier, parts.rgb, parts.lt)
      } catch {
        // a scene that cannot start leaves the still page
      }
    }
    return () => {
      stop?.()
      root.innerHTML = ''
    }
  }, [app, lang, tier, sceneId, card, mediaDataUrl])

  return (
    <div ref={outerRef} className="ocs-pageview" {...(decorative ? { 'aria-hidden': true } : {})}>
      <div
        ref={hostRef}
        className="ocs-pageview-stage"
        style={{ width: PAGE_W, height: PAGE_H, transform: `scale(${scale})` }}
      />
    </div>
  )
}
