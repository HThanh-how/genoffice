import React, { useLayoutEffect, useRef, useState } from 'react'
import { OPENING_APPS } from '../../../../shared/opening-scenes-meta'
import { AllAppsMark, AppMark, appName } from './AppMarks'
import type { ApplyScope } from './studio-logic'

const SCOPES: readonly ApplyScope[] = ['all', ...OPENING_APPS]

interface TargetSwitchProps {
  value: ApplyScope
  onChange: (next: ApplyScope) => void
  isVi: boolean
}

/**
 * Where "Use this card" applies: every app, or one. A row of app icons in one control; the
 * highlight glides from one icon to the next (a plain jump when the person asks for reduced
 * motion, which the stylesheet decides). Arrow keys move the choice, like any radio group.
 */
export function TargetSwitch({ value, onChange, isVi }: TargetSwitchProps): React.JSX.Element {
  const rowRef = useRef<HTMLDivElement | null>(null)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null)
  const [ready, setReady] = useState(false)

  useLayoutEffect(() => {
    const measure = () => {
      const el = buttons.current[SCOPES.indexOf(value)]
      if (el) setPill({ left: el.offsetLeft, width: el.offsetWidth })
    }
    measure()
    // the first placement must not glide in from nowhere
    const frame = requestAnimationFrame(() => setReady(true))
    if (typeof ResizeObserver !== 'function' || !rowRef.current)
      return () => cancelAnimationFrame(frame)
    const observer = new ResizeObserver(measure)
    observer.observe(rowRef.current)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [value])

  const label = (scope: ApplyScope) =>
    scope === 'all' ? (isVi ? 'Mọi ứng dụng' : 'All apps') : appName(scope, isVi)

  const onKeyDown = (event: React.KeyboardEvent) => {
    const at = SCOPES.indexOf(value)
    let next = -1
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (at + 1) % SCOPES.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = (at - 1 + SCOPES.length) % SCOPES.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = SCOPES.length - 1
    if (next < 0) return
    event.preventDefault()
    onChange(SCOPES[next]!)
    buttons.current[next]?.focus()
  }

  return (
    <div
      ref={rowRef}
      className="ocs-seg"
      role="radiogroup"
      aria-label={isVi ? 'Áp dụng cho' : 'Apply to'}
      onKeyDown={onKeyDown}
    >
      {pill && (
        <span
          className={`ocs-seg-pill${ready ? ' is-ready' : ''}`}
          aria-hidden="true"
          style={{ width: pill.width, transform: `translateX(${pill.left}px)` }}
        />
      )}
      {SCOPES.map((scope, index) => {
        const checked = scope === value
        return (
          <button
            key={scope}
            ref={(el) => {
              buttons.current[index] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={label(scope)}
            data-tip={label(scope)}
            tabIndex={checked ? 0 : -1}
            className={`ocs-seg-btn${checked ? ' is-on' : ''}`}
            onClick={() => onChange(scope)}
          >
            {scope === 'all' ? <AllAppsMark size={22} /> : <AppMark app={scope} size={22} />}
          </button>
        )
      })}
    </div>
  )
}
