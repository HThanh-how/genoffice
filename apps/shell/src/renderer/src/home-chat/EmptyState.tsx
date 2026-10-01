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
      <h3>{title}</h3>
      <p>{body}</p>
      <ul className="hc-suggestions">
        {suggestions.map((prompt) => (
          <li key={prompt}>
            <button type="button" disabled={disabled} onClick={() => onPick(prompt)}>
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
