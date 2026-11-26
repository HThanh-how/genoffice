/**
 * What the model service is doing while it has not answered yet ("Loading the model…"), as reported
 * by 'status' stream chunks. The transport writes it and any waiting indicator reads it, so no chat
 * panel has to carry it. With several requests in flight the newest report wins.
 */
const active = new Map<string, string>()
const listeners = new Set<() => void>()

const notify = (): void => {
  for (const listener of listeners) listener()
}

export function setStreamStatus(requestId: string, text: string): void {
  if (active.get(requestId) === text) return
  active.delete(requestId)
  active.set(requestId, text)
  notify()
}

export function clearStreamStatus(requestId: string): void {
  if (active.delete(requestId)) notify()
}

export function getStreamStatus(): string | null {
  return [...active.values()].at(-1) ?? null
}

export function subscribeStreamStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
