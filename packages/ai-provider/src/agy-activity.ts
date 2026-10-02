/**
 * Live progress of an Antigravity chat turn (what the "thinking" strip under the chat box shows).
 *
 * `agy` does not stream the model's reasoning text, only step events: a response step finishing
 * reports how many thinking tokens it spent, tool steps name what the agent is doing, and
 * `text_delta` marks the answer being written. This module is the pub/sub between the CLI wrapper
 * (which publishes) and the app (which forwards the events to the windows). Browser-safe types,
 * no Node imports.
 */

export type AgyActivityPhase = 'start' | 'thinking' | 'tool' | 'writing' | 'done' | 'error'

export interface AgyActivity {
  /** one per chat turn */
  runId: string
  phase: AgyActivityPhase
  /** epoch ms */
  at: number
  model?: string
  /** `tool`: the tool the agent is running, e.g. view_file */
  tool?: string
  /** `tool`: what it works on (a file name, a command, a query), shortened */
  target?: string
  /** `thinking`: tokens the model spent thinking in this step */
  thinkingTokens?: number
  /** seconds the finished step took, when agy reports it */
  stepSeconds?: number
  /** `error`: short message */
  message?: string
}

type Listener = (activity: AgyActivity) => void
const listeners = new Set<Listener>()

export function subscribeAgyActivity(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function publishAgyActivity(activity: AgyActivity): void {
  for (const listener of [...listeners]) {
    try {
      listener(activity)
    } catch {
      // a faulty listener must never disturb the chat turn
    }
  }
}
