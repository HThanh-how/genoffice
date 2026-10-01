import { memo, useEffect, useRef } from 'react'

export type ComposerLabels = {
  input: string
  placeholder: string
  send: string
  stop: string
  hint: string
}

type Props = {
  value: string
  busy: boolean
  disabled: boolean
  labels: ComposerLabels
  /** focus handle: the parent calls inputRef.current?.focus() */
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  onChange: (value: string) => void
  onSend: (value: string) => void
  onStop: () => void
}

/** Auto-growing message box with send / stop. Memoized so streamed tokens never touch it. */
export const Composer = memo(function Composer({
  value,
  busy,
  disabled,
  labels,
  inputRef,
  onChange,
  onSend,
  onStop,
}: Props) {
  const localRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = localRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`
  }, [value])
  return (
    <form
      className="hc-composer"
      onSubmit={(event) => {
        event.preventDefault()
        onSend(value)
      }}
    >
      <div className="hc-field">
        <label className="home-chat-sr-only" htmlFor="home-chat-input">
          {labels.input}
        </label>
        <textarea
          id="home-chat-input"
          ref={(el) => {
            localRef.current = el
            ;(inputRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el
          }}
          rows={1}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              onSend(value)
            }
          }}
          placeholder={labels.placeholder}
          disabled={disabled}
        />
        {busy ? (
          <button
            type="button"
            className="hc-send stop"
            onClick={onStop}
            aria-label={labels.stop}
            title={labels.stop}
          >
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <rect x="5.5" y="5.5" width="9" height="9" rx="2" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button
            type="submit"
            className="hc-send"
            disabled={!value.trim() || disabled}
            aria-label={labels.send}
            title={labels.send}
          >
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                d="M10 15.75V4.5m0 0L5.5 9m4.5-4.5L14.5 9"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>
      <span className="hc-hint">{labels.hint}</span>
    </form>
  )
})
