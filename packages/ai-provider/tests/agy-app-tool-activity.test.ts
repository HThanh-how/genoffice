import { describe, expect, it } from 'vitest'
import type { AgentMessage, AgentToolCall } from '@genoffice/agent-core'
import { appToolActivity, streamAgy } from '../src/agy-cli'
import { subscribeAgyActivity, type AgyActivity } from '../src/agy-activity'
import { CLI, FakeChild, runDeps } from './helpers/agy-fake'

const tools = [
  {
    name: 'create_document',
    description: 'Save a new document',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, content: { type: 'string' } },
    },
  },
]

const reply = (text: string, toolCalls: unknown[]) =>
  JSON.stringify({
    event: 'result',
    result: {
      status: 'SUCCESS',
      response: text,
      structured_output: { text, tool_calls: toolCalls },
    },
  })

async function turn(answer: string) {
  const child = new FakeChild()
  const { deps } = runDeps(child, {
    capabilities: async () => ({ effort: false, jsonSchema: true }),
    env: {},
    writeFile: async () => undefined,
    spawn: () => {
      setTimeout(() => {
        child.emitLines([answer])
        child.exit(0)
      }, 5)
      return child.asChild()
    },
  })
  const seen: AgyActivity[] = []
  const off = subscribeAgyActivity((activity) => seen.push(activity))
  const calls: AgentToolCall[] = []
  try {
    await streamAgy(
      { apiKey: '', cliPath: CLI, model: 'm' },
      '',
      [{ role: 'user', text: 'tạo giáo án' }],
      tools,
      1000,
      {
        signal: new AbortController().signal,
        onDelta: () => undefined,
        onToolCall: (call) => calls.push(call),
      },
      deps,
    )
  } finally {
    off()
  }
  return { seen, calls }
}

describe('app tool calls on the activity strip', () => {
  it('a turn that hands a GenOffice tool to the chat ends on that tool step, not "done"', async () => {
    const { seen, calls } = await turn(
      reply('', [
        { name: 'create_document', arguments: { title: 'Giáo án Toán 6', content: '# A' } },
      ]),
    )
    expect(calls.map((c) => c.name)).toEqual(['create_document'])
    const phases = seen.map((a) => a.phase)
    expect(phases[0]).toBe('start')
    expect(phases).not.toContain('done')
    expect(seen.at(-1)).toMatchObject({
      phase: 'tool',
      tool: 'create_document',
      target: 'Giáo án Toán 6',
    })
  })

  it('a plain answer still finishes with "done"', async () => {
    const { seen } = await turn(reply('Xin chào', []))
    expect(seen.at(-1)?.phase).toBe('done')
  })
})

describe('appToolActivity', () => {
  const create = (outline?: string[]): AgentMessage => ({
    role: 'assistant',
    text: '',
    toolCalls: [
      { id: 'c', name: 'create_document', input: { title: 'T', content: '# A', outline } },
    ],
  })
  const appended: AgentMessage = {
    role: 'assistant',
    text: '',
    toolCalls: [
      { id: 'a', name: 'append_to_document', input: { path: '/x/T.docx', content: '## B' } },
    ],
  }
  const next = {
    id: 'n',
    name: 'append_to_document',
    input: { path: '/x/T.docx', content: '## Đánh giá\n\ntext' },
  }

  it('counts the section against the announced outline', () => {
    expect(appToolActivity(next, [create(['A', 'B', 'Đánh giá', 'D']), appended]).target).toBe(
      '3/4 Đánh giá',
    )
    expect(
      appToolActivity({ ...next, input: { ...next.input, heading: 'Củng cố' } }, [
        create(['A', 'B']),
      ]).target,
    ).toBe('2/2 Củng cố')
  })

  it('falls back to the heading alone without an outline, and to names for other tools', () => {
    expect(appToolActivity(next, [create()]).target).toBe('Đánh giá')
    expect(
      appToolActivity(
        { id: 'r', name: 'read_knowledge_file', input: { path: 'C:\\a\\b\\hợp đồng.docx' } },
        [],
      ).target,
    ).toBe('hợp đồng.docx')
    expect(appToolActivity({ id: 's', name: 'search_knowledge_base', input: {} }, [])).toEqual({
      phase: 'tool',
      tool: 'search_knowledge_base',
    })
  })
})
