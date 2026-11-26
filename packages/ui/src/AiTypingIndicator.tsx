import React, { useEffect, useState } from 'react'
import { useStreamStatus } from './use-stream-status'

/** Some locales already end the label with an ellipsis — normalize to exactly one. */
function withEllipsis(label: string): string {
  return `${label.replace(/(?:…|\.{3})+$/u, '')}…`
}

/** Pre-stream thinking indicator , two mutually exclusive phases:
 *  grow/shrink blue dots first, then after ~1.2s only the shimmer label with a " · Ns" elapsed hint after 3s.
 *  While the model service reports what it is doing, that replaces the label at once.
 *  The .ai-typing-* style classes are provided by each app's styles.css. */
export function AiTypingIndicator(props: { readonly label: string }): React.JSX.Element {
  const status = useStreamStatus()
  const label = status ?? props.label
  const [elapsed, setElapsed] = useState(0)
  const [showLabel, setShowLabel] = useState(false)

  useEffect(() => {
    const phase = setTimeout(() => setShowLabel(true), 1200)
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => {
      clearTimeout(phase)
      clearInterval(timer)
    }
  }, [])

  return (
    <span className="ai-typing" role="status" aria-label={label}>
      {showLabel || status ? (
        <span className="ai-typing-label">
          {withEllipsis(label)}
          {elapsed >= 3 && (
            <span className="ai-typing-elapsed" aria-hidden>{` · ${elapsed}s`}</span>
          )}
        </span>
      ) : (
        <span className="ai-typing-dots" aria-hidden>
          <span className="ai-typing-dot-slot">
            <span className="ai-typing-dot-grow" />
          </span>
          <span className="ai-typing-dot-slot">
            <span className="ai-typing-dot-shrink" />
          </span>
        </span>
      )}
    </span>
  )
}
