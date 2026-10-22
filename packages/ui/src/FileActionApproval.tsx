import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Lang } from '@genoffice/i18n'
import type { PendingFileAction } from '@genoffice/agent-core'
import { FILE_ACTION_LABELS } from './strings-file-action'

const buttonStyle: CSSProperties = {
  background: 'var(--surface)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '6px 12px',
  font: 'inherit',
  cursor: 'pointer',
}

/** Like the Docs partial-content card: suspend the tool until an explicit decision. */
export function useFileActionApproval() {
  const [pending, setPending] = useState<PendingFileAction | null>(null)
  const finishRef = useRef<((approved: boolean) => void) | null>(null)
  const decide = useCallback((approved: boolean) => finishRef.current?.(approved), [])
  const confirm = useCallback((proposal: PendingFileAction, signal?: AbortSignal) => {
    finishRef.current?.(false)
    if (signal?.aborted || proposal.expiresAt <= Date.now()) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let done = false
      const abort = () => finish(false)
      const timer = setTimeout(abort, Math.max(0, proposal.expiresAt - Date.now()))
      const finish = (approved: boolean) => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        finishRef.current = null
        setPending(null)
        resolve(approved)
      }
      finishRef.current = finish
      signal?.addEventListener('abort', abort, { once: true })
      setPending(proposal)
    })
  }, [])
  useEffect(() => () => finishRef.current?.(false), [])
  return { pending, confirm, decide }
}

export function FileActionApproval({
  pending,
  lang,
  onDecide,
}: {
  pending: PendingFileAction | null
  lang: Lang
  onDecide: (approved: boolean) => void
}) {
  if (!pending) return null
  const labels = FILE_ACTION_LABELS[lang]
  const a = pending.action
  return (
    <section
      role="group"
      aria-label={labels.title}
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 12,
        margin: 8,
        maxHeight: '40vh',
        overflowY: 'auto',
        flexShrink: 0,
        background: 'var(--surface)',
        color: 'var(--text)',
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onDecide(false)
        }
      }}
    >
      <strong>{labels.title}</strong>
      <p>{labels[a.tool]}</p>
      <pre dir="auto" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {a.source ?? a.path}
        {a.destination ? `\n→ ${a.destination}` : ''}
      </pre>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" style={buttonStyle} onClick={() => onDecide(false)}>
          {labels.deny}
        </button>
        <button
          type="button"
          style={{ ...buttonStyle, background: 'var(--accent-soft)' }}
          onClick={() => onDecide(true)}
        >
          {labels.approve}
        </button>
      </div>
    </section>
  )
}
