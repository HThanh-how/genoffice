import { Component, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { strings } from './strings'
import './boot-error.css'

/**
 * Last-resort screen for a shell window that failed to mount. Without it an exception while the renderer boots
 * (a preload API that is missing, a render that throws) leaves a blank white window with no clue why. The screen
 * shows the message, lets the person copy the full details for a bug report, and reloads the window.
 *
 * It is deliberately self-contained: it reads `strings` directly (no LocaleProvider, no window.aiOffice) so it
 * still works when those are exactly what broke.
 */

type BootStrings = Pick<
  (typeof strings)['en'],
  'bootErrorTitle' | 'bootErrorHint' | 'bootErrorCopy' | 'bootErrorCopied' | 'bootErrorReload'
>

/**
 * UI-language guess that needs no API: the language main.tsx resolved (when it got that far), else the browser's.
 * The document's own `lang` is the static page default until boot succeeds, so it is only the last resort.
 */
export function bootErrorStrings(lang?: string): BootStrings {
  const dict = strings as unknown as Record<string, BootStrings | undefined>
  const candidates = [
    lang,
    typeof navigator !== 'undefined' ? navigator.language : undefined,
    typeof document !== 'undefined' ? document.documentElement.lang : undefined,
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    const exact = dict[candidate]
    if (exact) return exact
    const base = dict[candidate.split('-')[0]!]
    if (base) return base
  }
  return strings.en
}

/** Readable text for any thrown value, including the stack when there is one. */
export function describeBootError(error: unknown): string {
  if (error instanceof Error)
    return error.stack
      ? `${error.name}: ${error.message}\n${error.stack}`
      : `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

function shortMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return describeBootError(error).split('\n')[0] ?? ''
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // fall back to a selection copy (clipboard API needs a focused, secure document)
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch {
      return false
    }
  }
}

export function BootErrorScreen({
  error,
  lang,
  onReload = () => location.reload(),
}: {
  error: unknown
  lang?: string
  onReload?: () => void
}) {
  const words = bootErrorStrings(lang)
  const details = describeBootError(error)
  const [copied, setCopied] = useState(false)
  return (
    <div className="boot-error" role="alert">
      <div className="boot-error-card">
        <h1 className="boot-error-title">{words.bootErrorTitle}</h1>
        <p className="boot-error-hint">{words.bootErrorHint}</p>
        <p className="boot-error-message">{shortMessage(error)}</p>
        <pre className="boot-error-details" tabIndex={0}>
          {details}
        </pre>
        <div className="boot-error-actions">
          <button
            type="button"
            className="boot-error-btn"
            onClick={() => {
              void copyText(details).then((ok) => setCopied(ok))
            }}
          >
            {copied ? words.bootErrorCopied : words.bootErrorCopy}
          </button>
          <button
            type="button"
            className="boot-error-btn boot-error-btn-primary"
            onClick={onReload}
          >
            {words.bootErrorReload}
          </button>
        </div>
      </div>
    </div>
  )
}

interface BoundaryState {
  error: unknown
  failed: boolean
}

/** Catches render-time exceptions anywhere below it and shows the error screen instead of a blank window. */
export class RootErrorBoundary extends Component<
  { children: ReactNode; lang?: string },
  BoundaryState
> {
  state: BoundaryState = { error: null, failed: false }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error, failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[shell] renderer failed to render:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.failed)
      return <BootErrorScreen error={this.state.error} lang={this.props.lang} />
    return this.props.children
  }
}

/**
 * Shows the error screen for a failure that happened outside React (the pre-render preload calls in main.tsx, a
 * rejected promise). Replaces whatever is in #root. If even React cannot mount, the message is written as plain text.
 */
export function renderBootError(error: unknown, lang?: string): void {
  console.error('[shell] renderer failed to start:', error)
  const host = document.getElementById('root') ?? document.body
  try {
    createRoot(host).render(<BootErrorScreen error={error} lang={lang} />)
  } catch {
    host.textContent = describeBootError(error)
  }
}
