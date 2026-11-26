/**
 * Live status lines ("Downloading Local AI · 82%") of requests that ended because the model is not
 * there yet. The transport keeps each one up to date; whoever shows it reads it by id, so a change
 * replaces the text in place and never adds a message.
 */
export interface Notice {
  text: string
  /** preparing the model failed; `text` is the error */
  failed: boolean
}
const notices = new Map<string, Notice>()
const listeners = new Set<() => void>()

export function setNotice(id: string, text: string, failed = false): void {
  const shown = notices.get(id)
  if (shown?.text === text && shown.failed === failed) return
  notices.set(id, { text, failed })
  for (const listener of listeners) listener()
}

export function getNotice(id: string): Notice | undefined {
  return notices.get(id)
}

export function subscribeNotices(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A chat shows one status line at a time: a new one takes the place of those before it. */
export function withoutNotices<T extends { role: string; notice?: string | undefined }>(
  entries: readonly T[],
): T[] {
  return entries.filter((entry) => entry.role !== 'assistant' || !entry.notice)
}
