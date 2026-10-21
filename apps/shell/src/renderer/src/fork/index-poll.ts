/**
 * Polling cadence for the Index screen and its sidebar entry.
 *
 * Windows reports a window that is merely covered by another app as `document.visibilityState ===
 * 'hidden'` (native occlusion), while it can still be on screen a moment later or captured. The Index
 * loaders used to skip every read while hidden, including the very first one, so a page mounted in
 * that state kept its empty initial state ("0 files", "Loading folder progress…") forever. The rule
 * now: always read; while hidden only slow down.
 */
export const HIDDEN_POLL_MS = 30_000

export function isPageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

/** Delay before the next read: the normal cadence when visible, a slow one while hidden. */
export function nextPollDelay(visibleMs: number): number {
  return isPageHidden() ? Math.max(visibleMs, HIDDEN_POLL_MS) : visibleMs
}
