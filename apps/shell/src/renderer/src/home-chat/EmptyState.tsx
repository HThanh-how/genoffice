import { memo } from 'react'

type Props = {
  title: string
  body: string
  suggestions: string[]
  disabled: boolean
  onPick: (prompt: string) => void
}

/** First-run / new-chat surface: one line of context and three prompts worth tapping. */
export const EmptyState = memo(function EmptyState({
  title,
  body,
  suggestions,
  disabled,
  onPick,
}: Props) {
  return (
    <div className="hc-welcome">
      <span className="hc-welcome-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <path
            d="m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3L12 3Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <h3>{title}</h3>
      <p>{body}</p>
      <ul className="hc-suggestions">
        {suggestions.map((prompt, index) => (
          <li key={prompt}>
            <button type="button" disabled={disabled} onClick={() => onPick(prompt)}>
              <span className="hc-suggestion-number" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span>{prompt}</span>
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path
                  d="M5 10h10m0 0-4-4m4 4-4 4"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
})
