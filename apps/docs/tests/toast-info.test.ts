import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastHost } from '../src/renderer/components/toast'

describe('shell informational toast', () => {
  let root: Root | undefined
  let container: HTMLElement | undefined
  let onToast: ((text: string) => void) | undefined
  const priorDesktop = (window as unknown as { desktop?: unknown }).desktop

  afterEach(() => {
    if (root) act(() => root!.unmount())
    container?.remove()
    root = undefined
    container = undefined
    onToast = undefined
    if (priorDesktop === undefined) delete (window as unknown as { desktop?: unknown }).desktop
    else (window as unknown as { desktop: unknown }).desktop = priorDesktop
  })

  it('makes the shown info toast interactive while leaving hidden toasts inert', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles.css'), 'utf8')
    expect(css).toMatch(/\.app-toast\s*\{[^}]*pointer-events:\s*none/s)
    expect(css).toMatch(/\.app-toast\.info\.show\s*\{[^}]*pointer-events:\s*auto/s)
    expect(css).toContain('outline: 2px solid currentColor')
  })

  it('delivers a shell notice in the live region and dismisses it with the close button', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.useFakeTimers()
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: {
        onInfoToast: (handler: (text: string) => void) => {
          onToast = handler
          return () => {
            onToast = undefined
          }
        },
      },
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root!.render(createElement(ToastHost)))
    act(() => onToast?.('Your converted .docx is open.'))

    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Your converted .docx is open.',
    )
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull()
    act(() => {
      container!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    act(() => vi.advanceTimersByTime(200))
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
})
