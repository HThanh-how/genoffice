import { describe, expect, it } from 'vitest'
import {
  AgentLoop,
  type AgentMessage,
  type AgentSkill,
  type AgentStreamCallbacks,
  type AgentTransport,
} from '../src'

/** Records every request's message list so the seeded context can be asserted. */
function recordingTransport(reply: string) {
  const requests: AgentMessage[][] = []
  const transport: AgentTransport = {
    stream(request, cb: AgentStreamCallbacks) {
      requests.push(request.messages.map((m) => ({ ...m })))
      queueMicrotask(() => {
        cb.onDelta(reply)
        cb.onDone()
      })
      return { cancel: () => {} }
    },
  } as AgentTransport
  return { transport, requests }
}

const skill: AgentSkill = {
  id: 'seed',
  systemPrompt: 'system',
  tools: [],
  buildContext: () => '',
  executeTool: () => ({ output: '', summary: '', mutated: false }),
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('AgentLoop.restore for restored chat history', () => {
  it('continues a restored text conversation with its context and no tool blocks', async () => {
    const { transport, requests } = recordingTransport('follow-up answer')
    const loop = new AgentLoop({ transport, skill })
    loop.restore([
      { role: 'user', text: 'find the budget file' },
      { role: 'assistant', text: 'It is budget-2026.xlsx' },
    ])
    loop.run('open it')
    await flush()
    expect(requests[0]).toEqual([
      { role: 'user', text: 'find the budget file' },
      { role: 'assistant', text: 'It is budget-2026.xlsx' },
      { role: 'user', text: 'open it' },
    ])
    expect(requests[0]!.some((m) => 'toolCalls' in m || m.role === 'tool')).toBe(false)
  })

  it('drops a trailing unanswered question so it does not merge with the next message', async () => {
    const { transport, requests } = recordingTransport('ok')
    const loop = new AgentLoop({ transport, skill })
    loop.restore([
      { role: 'user', text: 'q1' },
      { role: 'assistant', text: 'a1' },
      { role: 'user', text: 'interrupted question' },
    ])
    loop.run('q2')
    await flush()
    expect(requests[0]!.map((m) => (m.role === 'tool' ? '' : m.text))).toEqual(['q1', 'a1', 'q2'])
  })

  it('reset then restore replaces the conversation (switching chats)', async () => {
    const { transport, requests } = recordingTransport('ok')
    const loop = new AgentLoop({ transport, skill })
    loop.restore([
      { role: 'user', text: 'chat A question' },
      { role: 'assistant', text: 'chat A answer' },
    ])
    loop.reset()
    loop.restore([
      { role: 'user', text: 'chat B question' },
      { role: 'assistant', text: 'chat B answer' },
    ])
    loop.run('continue B')
    await flush()
    const texts = requests[0]!.map((m) => (m.role === 'tool' ? '' : m.text))
    expect(texts).toEqual(['chat B question', 'chat B answer', 'continue B'])
  })
})
