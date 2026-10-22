import type { AppActionStep } from '@genoffice/agent-core/app-control'

export interface SpotlightRect {
  x: number
  y: number
  width: number
  height: number
}
/** Viewport CSS pixels only: never mix screen coordinates from different renderers. */
export function spotlightRect(
  rect: SpotlightRect,
  width: number,
  height: number,
  padding = 6,
): SpotlightRect | null {
  if (
    ![rect.x, rect.y, rect.width, rect.height, width, height, padding].every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    width <= 0 ||
    height <= 0 ||
    padding < 0
  )
    return null
  const x = Math.max(0, rect.x - padding)
  const y = Math.max(0, rect.y - padding)
  const right = Math.min(width, rect.x + rect.width + padding)
  const bottom = Math.min(height, rect.y + rect.height + padding)
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
}

/** A guide advances only on the current step's observed event, never on a timer. */
export class AppActionSequence {
  index = 0
  cancelled = false
  constructor(readonly steps: readonly AppActionStep[]) {}
  observe(index: number, event: AppActionStep['event']): boolean {
    if (this.cancelled || index !== this.index || this.steps[index]?.event !== event) return false
    this.index++
    return true
  }
  cancel(): void {
    this.cancelled = true
  }
  get done(): boolean {
    return !this.cancelled && this.index === this.steps.length
  }
}

export function waitForActionStep(step: AppActionStep, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let seen = false
    const finish = (error?: Error) => {
      observer.disconnect()
      document.removeEventListener('click', clicked, true)
      signal.removeEventListener('abort', aborted)
      if (error) reject(error)
      else resolve()
    }
    const aborted = () => finish(new Error('Guide cancelled'))
    const find = () => {
      const element = step.selector ? document.querySelector(step.selector) : null
      if (element && element.getBoundingClientRect().width > 0) {
        seen = true
        if (step.event === 'observe') finish()
      } else if (seen) finish(new Error('Guide target disappeared'))
    }
    const clicked = (event: MouseEvent) => {
      if (
        step.event === 'click' &&
        event.isTrusted &&
        step.selector &&
        event.target instanceof Element &&
        event.target.closest(step.selector)
      )
        finish()
    }
    const observer = new MutationObserver(find)
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true })
    document.addEventListener('click', clicked, true)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    else find()
  })
}
