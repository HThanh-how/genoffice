import { OPEN_FLIGHT_MS } from '../../shared/open-flight'

/**
 * Opening a file from Home: the file's icon lifts off its row, arcs up to the new tab in the strip
 * and lands in it while the tab grows out of the icon (the Dock-like "it went there" feel). Home
 * remembers where the icon was when the file is opened; the tab strip plays the flight once the new
 * tab shows up. The main process keeps Home in front for the same length of time.
 */

interface Origin {
  rect: DOMRect
  node: Node
  at: number
}

const ROW = '.recent-item, .search-row, [role="button"]'
const ICON = '.recent-icon img, .recent-icon svg, img[aria-hidden="true"], svg[aria-hidden="true"]'

let lastTarget: { el: Element; at: number } | null = null
let pending: Origin | null = null
let installed = false

const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Remember what the person last pressed, so the icon of that row is where the flight starts. */
export function installOpenFlight(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  const note = (event: Event): void => {
    if (event.target instanceof Element) lastTarget = { el: event.target, at: performance.now() }
  }
  document.addEventListener('pointerdown', note, true)
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Enter') note(event)
    },
    true,
  )
}

/** Open a file from Home; when its row is in view, its icon flies to the tab it opens. */
export function openFromHome(path: string): Promise<boolean> {
  const fresh = lastTarget && performance.now() - lastTarget.at < 1500 ? lastTarget.el : null
  const icon = fresh?.closest(ROW)?.querySelector(ICON) ?? null
  const rect = icon?.getBoundingClientRect()
  const flight = !!icon && !!rect && rect.width >= 8 && !reducedMotion()
  const mine: Origin | null =
    flight && icon && rect ? { rect, node: icon.cloneNode(true), at: performance.now() } : null
  pending = mine
  return window.aiOffice.openPath(path, flight).then((opened) => {
    // nothing new opened (an existing tab was shown, or it failed): no flight for a later tab
    setTimeout(() => {
      if (pending === mine) pending = null
    }, 400)
    return opened
  })
}

/** The flight to play for a tab that has just appeared, if a file was just opened from Home. */
export function takeOpenFlight(): Origin | null {
  const origin = pending
  pending = null
  return origin && performance.now() - origin.at < 3000 ? origin : null
}

/** Fly the icon from its row to the icon slot of `tabEl`; `done` runs when it lands. */
export function playOpenFlight(origin: Origin, tabEl: HTMLElement, done: () => void): void {
  const slot = tabEl.querySelector('.tab-icon')?.getBoundingClientRect()
  if (!slot || slot.width === 0) {
    done()
    return
  }
  const { rect } = origin
  const dx = slot.left + slot.width / 2 - (rect.left + rect.width / 2)
  const dy = slot.top + slot.height / 2 - (rect.top + rect.height / 2)
  const scale = slot.width / rect.width
  const fly = (opacity: number, delay: number, blur: number, onLand?: () => void): void => {
    const el = document.createElement('div')
    el.className = 'open-flight'
    el.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;${blur ? `filter:blur(${blur}px);` : ''}`
    el.appendChild(origin.node.cloneNode(true))
    document.body.appendChild(el)
    const anim = el.animate(
      [
        { transform: 'translate(0,0) scale(1)', opacity: 0, offset: 0 },
        { transform: 'translate(0,0) scale(1.12)', opacity, offset: 0.08 },
        {
          transform: `translate(${dx * 0.3}px,${dy * 0.3 - 22}px) scale(1.22)`,
          opacity,
          offset: 0.4,
        },
        { transform: `translate(${dx}px,${dy}px) scale(${scale})`, opacity, offset: 1 },
      ],
      {
        duration: OPEN_FLIGHT_MS,
        delay,
        easing: 'cubic-bezier(.45,.05,.2,1)',
        fill: 'both',
      },
    )
    anim.onfinish = () => {
      el.remove()
      onLand?.()
    }
    anim.oncancel = () => el.remove()
  }
  fly(0.35, 35, 2)
  fly(1, 0, 0, done)
}
