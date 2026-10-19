import { AGY_CHAT_DEFAULT_MODEL } from './agy-chat'

/**
 * Browser-safe memory of whether the Antigravity CLI is usable (installed and signed in). The
 * settings defaults read it so a fresh install starts on `agy` without any I/O at import time or
 * inside the (synchronous) default builders: the probe in agy-detect.ts fills it in the
 * background and until it has answered the defaults stay what they were before.
 */

let usable: boolean | null = null
let checkedAt = 0
/** the chat model the probe found the installed CLI actually offers (null = not known yet) */
let chatDefault: string | null = null
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

/**
 * Record which chat model the installed CLI really offers, so a fresh installation starts on a
 * model that exists rather than on a hardcoded id.
 */
export function setAgyChatDefault(model: string | null): void {
  chatDefault = model
}

/** The chat model to seed for a first run; the High default until a probe says otherwise. */
export function agyChatDefaultModel(): string {
  return chatDefault ?? AGY_CHAT_DEFAULT_MODEL
}
