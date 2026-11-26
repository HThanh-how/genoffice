import React, { useCallback, useSyncExternalStore } from 'react'
import { getNotice, subscribeNotices } from '@genoffice/agent-core'

/** One status line that changes in place; `text` is what it said when the message was sent. */
export function LiveNotice({
  id,
  text,
}: {
  readonly id: string
  readonly text: string
}): React.JSX.Element {
  const read = useCallback(() => getNotice(id), [id])
  const notice = useSyncExternalStore(subscribeNotices, read, read)
  return (
    <div
      dir="auto"
      // announced when it appears or fails, not at every percent
      role={notice?.failed ? 'alert' : undefined}
      style={{ whiteSpace: 'pre-line', ...(notice?.failed ? { color: 'var(--danger)' } : {}) }}
    >
      {notice?.text ?? text}
    </div>
  )
}
