/**
 * Browser-safe memory of whether the Antigravity CLI is usable (installed and signed in). The
 * settings defaults read it so a fresh install starts on `agy` without any I/O at import time or
 * inside the (synchronous) default builders: the probe in agy-detect.ts fills it in the
 * background and until it has answered the defaults stay what they were before.
 */

let usable: boolean | null = null
let checkedAt = 0
const listeners = new Set<(usable: boolean) => void>()

/** True only after a probe confirmed `agy` is installed and signed in. */
export function agyDefaultsUsable(): boolean {
  return usable === true
}

/** Whether any probe has answered yet. */
export function agyUsabilityKnown(): boolean {
  return usable !== null
}

/** Milliseconds timestamp of the last recorded answer (0 when none). */
export function agyUsabilityCheckedAt(): number {
  return checkedAt
}

/** Record a probe result (or `null` to forget it). Listeners hear about every change of answer. */
export function setAgyUsable(next: boolean | null, now: number = Date.now()): void {
  const before = usable === true
  usable = next
  checkedAt = next === null ? 0 : now
  // listeners care about the defaults, which only change when "usable" itself flips
  if (next !== null && before !== next) for (const listener of [...listeners]) listener(next)
}

/** Subscribe to changes of the answer; returns the unsubscribe function. */
export function onAgyUsableChange(listener: (usable: boolean) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
