import { Markdown } from '@genoffice/ui'
import { memo, useEffect, useRef, useState } from 'react'
import type { HomeChatSource } from '../../../shared/fork/home-chat-types'

export type ChatItem = {
  id: number
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
  /** transient line shown beside the typing dots until the first token (e.g. "Starting Antigravity…") */
  status?: string
  error?: string
  sources?: HomeChatSource[]
}

export type ChatLabels = {
  loading: string
  retry: string
  sources: string
  openSource: (name: string) => string
  sourceMissing: string
  sourceStale: string
  sourceMissingHint: string
  sourceStaleHint: string
  copy: string
  copied: string
}

type Props = {
  item: ChatItem
  /** true only for the last assistant answer once nothing is streaming */
  canRetry: boolean
  /** memoized per language by the parent so memo() equality holds across renders */
  labels: ChatLabels
  onOpenSource: (source: HomeChatSource) => void
  onRetry: () => void
}

/**
 * Re-renders only when its own item (id/text/streaming/error/sources) or the
 * retry flag changes. Handlers are stable refs from the parent, so a streamed
 * token re-renders exactly one ChatMessage and re-parses exactly one Markdown
 * string instead of the whole transcript.
 */
export const ChatMessage = memo(function ChatMessage({
  item,
  canRetry,
  labels,
  onOpenSource,
  onRetry,
}: Props) {
  if (item.role === 'user') {
    return (
      <article className="hc-msg user">
        <p>{item.text}</p>
      </article>
    )
  }
  const showTyping = item.streaming && !item.text
  return (
    <article className="hc-msg assistant" aria-busy={item.streaming ? true : undefined}>
      {showTyping ? (
        <span className="hc-typing" role="status" aria-label={labels.loading}>
          <i />
          <i />
          <i />
          {item.status && <span className="hc-status">{item.status}</span>}
        </span>
      ) : (
        item.text && (
          <div className="hc-answer">
            <Markdown text={item.text} />
          </div>
        )
      )}
      {item.error && (
        <div className="hc-error" role="alert">
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="10" cy="10" r="7.25" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M10 6v4.5m0 3h.01"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
          <span>{item.error}</span>
          {canRetry && (
            <button type="button" className="hc-error-retry" onClick={onRetry}>
              {labels.retry}
            </button>
          )}
        </div>
      )}
      {item.sources && item.sources.length > 0 && (
        <div className="hc-sources" role="group" aria-label={labels.sources}>
          {item.sources.map((source) => (
            <SourceChip
              key={source.documentId}
              source={source}
              labels={labels}
              onOpen={onOpenSource}
            />
          ))}
        </div>
      )}
      {!item.streaming && item.text && <CopyButton text={item.text} labels={labels} />}
    </article>
  )
})

function SourceChip({
  source,
  labels,
  onOpen,
}: {
  source: HomeChatSource
  labels: ChatLabels
  onOpen: (source: HomeChatSource) => void
}) {
  const state = source.missing ? 'missing' : source.stale ? 'stale' : ''
  const hint = source.missing
    ? labels.sourceMissingHint
    : source.stale
      ? labels.sourceStaleHint
      : ''
  return (
    <button
      type="button"
      className={`hc-source${state ? ` ${state}` : ''}`}
      disabled={source.missing}
      onClick={() => onOpen(source)}
      aria-label={labels.openSource(source.name)}
      title={[source.name, source.location, hint].filter(Boolean).join(' · ')}
    >
      <span className="hc-source-name">{source.name}</span>
      {state && (
        <span className="hc-source-flag">
          {state === 'missing' ? labels.sourceMissing : labels.sourceStale}
        </span>
      )}
    </button>
  )
}

function CopyButton({ text, labels }: { text: string; labels: ChatLabels }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1600)
  }
  return (
    <div className="hc-msg-actions">
      <button type="button" className="hc-text-button" onClick={() => void copy()}>
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
          {copied ? (
            <path
              d="m4.5 10.5 3.5 3.5 7.5-8"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : (
            <>
              <rect
                x="7"
                y="7"
                width="9"
                height="9.5"
                rx="2"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path
                d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </>
          )}
        </svg>
        <span aria-live="polite">{copied ? labels.copied : labels.copy}</span>
      </button>
    </div>
  )
}
