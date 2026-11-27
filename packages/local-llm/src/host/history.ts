import type { ChatHistoryItem } from 'node-llama-cpp'
import type { LocalMessage } from '../protocol'

/** The chat history node-llama-cpp evaluates: tool calls carry their results inline. */
export function buildHistory(system: string, messages: LocalMessage[]): ChatHistoryItem[] {
  const history: ChatHistoryItem[] = [{ type: 'system', text: system }]
  const results = new Map(
    messages.flatMap((message) =>
      message.role === 'tool' ? message.results.map((r) => [r.id, r] as const) : [],
    ),
  )
  for (const message of messages) {
    if (message.role === 'user') history.push({ type: 'user', text: message.text })
    if (message.role === 'assistant') {
      history.push({
        type: 'model',
        response: [
          ...(message.reasoning
            ? [
                {
                  type: 'segment' as const,
                  segmentType: 'thought' as const,
                  text: message.reasoning,
                  ended: true,
                },
              ]
            : []),
          ...(message.text ? [message.text] : []),
          ...(message.toolCalls ?? []).map((call) => ({
            type: 'functionCall' as const,
            name: call.name,
            params: call.input,
            result: results.get(call.id)?.output ?? 'Tool result unavailable',
          })),
        ],
      })
    }
  }
  history.push({ type: 'model', response: [] })
  return history
}
