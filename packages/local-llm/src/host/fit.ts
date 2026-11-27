import type { LocalMessage } from '../protocol'

export interface FitResult {
  messages: LocalMessage[]
  /** messages dropped from the start of the conversation */
  droppedMessages: number
  /** tool results cut short to fit */
  truncatedResults: number
}

const RESULT_CAPS = [8000, 4000, 2000, 1000, 500, 200]

function capResults(
  messages: LocalMessage[],
  cap: number,
): { messages: LocalMessage[]; cut: number } {
  let cut = 0
  const out = messages.map((message) => {
    if (message.role !== 'tool') return message
    return {
      ...message,
      results: message.results.map((result) => {
        if (result.output.length <= cap) return result
        cut += 1
        return {
          ...result,
          output: `${result.output.slice(0, cap)}\n…[${result.output.length - cap} characters cut to fit the local context]`,
        }
      }),
    }
  })
  return { messages: out, cut }
}

/**
 * Make a conversation fit the context window instead of failing the request: first the oldest
 * turns go (only at a user message, so a tool call is never separated from its result), then the
 * tool results that are still too large are cut short. The newest user message is never dropped.
 * `count` is the prompt size in tokens of a candidate conversation. Returns null when even the
 * newest turn alone does not fit.
 */
export function fitMessages(
  messages: LocalMessage[],
  count: (messages: LocalMessage[]) => number,
  limit: number,
): FitResult | null {
  if (count(messages) <= limit) return { messages, droppedMessages: 0, truncatedResults: 0 }
  const users = messages.flatMap((message, index) => (message.role === 'user' ? [index] : []))
  const starts = users.length ? users : [0]
  for (const start of starts) {
    const tail = messages.slice(start)
    if (start > 0 && count(tail) <= limit)
      return { messages: tail, droppedMessages: start, truncatedResults: 0 }
  }
  const start = starts[starts.length - 1]!
  const tail = messages.slice(start)
  for (const cap of RESULT_CAPS) {
    const { messages: capped, cut } = capResults(tail, cap)
    if (count(capped) <= limit)
      return { messages: capped, droppedMessages: start, truncatedResults: cut }
  }
  return null
}
