import { AGY_CHAT_DEFAULT_MODEL, firstRunChatModel, type ChatCatalog } from './agy-chat'

/**
 * Browser-safe memory of whether the Antigravity CLI is usable (installed and signed in). The
 * settings defaults read it so a fresh install starts on `agy` without any I/O at import time or
 * inside the (synchronous) default builders: the probe in agy-detect.ts fills it in the
 * background and until it has answered the defaults stay what they were before.
 */

let usable: boolean | null = null
let checkedAt = 0
/**
 * The chat model each configured Antigravity executable was last seen to offer, keyed by the CLI
 * path the person configured ('' = auto-detect). Keying by path keeps a model discovered from one
 * executable from being used as the first-run default of another, and records whether the answer
 * came from a catalog that actually answered.
 */
interface ChatDefaultRecord {
  /** the model to seed a first run with, or null when the CLI has no eligible one */
  model: string | null
  /** a successful `agy models` read confirmed it (false after a confirmed failure) */
  verified: boolean
  /** epoch ms of the last read that touched this record */
  at: number
}
const chatDefaults = new Map<string, ChatDefaultRecord>()
/** Whether each CLI path the app has probed answered, keyed the same way as the chat defaults. */
const cliUsable = new Map<string, boolean>()
/**
 * The CLI the app is configured to use right now. Only this path's answer is the effective
 * usability the defaults follow, so a slow probe for a path that was replaced can never make the
 * current CLI look broken.
 */
let activeCliKey: string | null = null
const listeners = new Set<(usable: boolean) => void>()

/** The key a CLI path resolves to; the unconfigured (auto-detect) path is the empty string. */
export function agyChatDefaultKey(cliPath?: string): string {
  return typeof cliPath === 'string' ? cliPath.trim() : ''
}

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

/** Say which CLI path is the configured one now; later probes for other paths cannot set it. */
export function setAgyActiveCli(cliPath?: string): string {
  activeCliKey = agyChatDefaultKey(cliPath)
  return activeCliKey
}

/** The CLI path whose answer the defaults currently follow (null before the first probe). */
export function agyActiveCliKey(): string | null {
  return activeCliKey
}

/** What is known about one CLI path's usability: true, false, or nothing yet. */
export function agyCliUsable(cliPath?: string): boolean | null {
  return cliUsable.has(agyChatDefaultKey(cliPath))
    ? cliUsable.get(agyChatDefaultKey(cliPath))!
    : null
}

/**
 * Record one probe answer. The answer of the active CLI becomes the effective usability; an answer
 * for a path that is no longer configured is kept for that path only and never overwrites it.
 * Returns whether the effective answer changed.
 */
export function recordAgyCliUsable(
  cliPath: string | undefined,
  ok: boolean,
  now: number = Date.now(),
): boolean {
  const key = agyChatDefaultKey(cliPath)
  cliUsable.set(key, ok)
  if (activeCliKey !== null && key !== activeCliKey) return false
  setAgyUsable(ok, now)
  return true
}

/** Forget every per-path usability answer (used by tests). */
export function clearAgyCliUsability(): void {
  cliUsable.clear()
  activeCliKey = null
}

/** Subscribe to changes of the answer; returns the unsubscribe function. */
export function onAgyUsableChange(listener: (usable: boolean) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Record which chat model the CLI at `cliPath` really offers. A catalog that answered sets the
 * answer, including "this CLI has no eligible chat model". A catalog that failed keeps the last
 * answer but marks it unverified: a temporary CLI problem never erases what was learned, and never
 * gets presented as confirmed.
 */
export function recordAgyChatDefault(
  cliPath: string | undefined,
  catalog: ChatCatalog,
  now: number = Date.now(),
): void {
  const key = agyChatDefaultKey(cliPath)
  const failed = typeof catalog.error === 'string' && catalog.error.trim() !== ''
  if (failed) {
    const previous = chatDefaults.get(key)
    chatDefaults.set(key, { model: previous?.model ?? null, verified: false, at: now })
    return
  }
  chatDefaults.set(key, { model: firstRunChatModel(catalog) ?? null, verified: true, at: now })
}

/** What is known about the chat model for one CLI path: nothing, or a model plus its verification. */
export function agyChatDefaultRecord(
  cliPath?: string,
): { model: string | null; verified: boolean } | undefined {
  const record = chatDefaults.get(agyChatDefaultKey(cliPath))
  return record ? { model: record.model, verified: record.verified } : undefined
}

/**
 * The chat model to seed for a first run on this CLI path, or undefined when nothing usable is
 * known. The High default until a probe for this path says otherwise.
 */
export function agyChatDefaultModel(cliPath?: string): string | undefined {
  const record = agyChatDefaultRecord(cliPath)
  if (record === undefined) return AGY_CHAT_DEFAULT_MODEL
  return record.model ?? undefined
}

/** Forget every recorded chat default (used by tests and when the CLI configuration is reset). */
export function clearAgyChatDefaults(): void {
  chatDefaults.clear()
}
