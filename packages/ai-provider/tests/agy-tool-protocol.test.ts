import { describe, expect, it, vi } from 'vitest'
import type { AgentMessage, AgentToolCall } from '@genoffice/agent-core'
import { buildAgyPrompt, streamAgy } from '../src/agy-cli'
import {
  AGY_SCHEMA_TURN_NOTE,
  agyToolTurnSchema,
  renderAgyStructuredTurn,
  resolveAgyToolProtocol,
} from '../src/agy-structured-turn'
import { CLI, FakeChild, runDeps } from './helpers/agy-fake'

const tools = [
  {
    name: 'replace_text',
    description: 'Replace text in the open document',
    inputSchema: { type: 'object', properties: { find: { type: 'string' } } },
  },
  {
    name: 'read_document',
    description: 'Read the open document',
    inputSchema: { type: 'object', properties: {} },
  },
]

/** a string that is hostile to hand-written JSON: quotes, backslashes, newlines, diacritics */
const HARD =
  'Điều 1. "Bên A" lưu tại C:\\Hồ sơ\\hợp đồng.docx\n\nBiểu thức \\d{4}-\\d{3}, ký tự "\\n".'

const result = (fields: Record<string, unknown>) =>
  JSON.stringify({ event: 'result', result: { status: 'SUCCESS', ...fields } })

interface TurnOptions {
  /** one entry per agy process the turn is expected to start */
  replies: string[]
  /** answer of `agy --help` for `--json-schema` */
  jsonSchema?: boolean
  env?: Record<string, string>
  tools?: typeof tools
  messages?: AgentMessage[]
}

async function runTurn(options: TurnOptions) {
  const children = options.replies.map(() => new FakeChild())
  const queue = [...children]
  /** the prompt of each agy process, decoded from its stream-json stdin line */
  const stdins: string[] = []
  const argLists: string[][] = []
  const schemas: unknown[] = []
  const calls: AgentToolCall[] = []
  const deltas: string[] = []
  const diagnostics: Array<Record<string, unknown>> = []
  const stops: string[] = []
  let spawnCount = 0
  const { deps } = runDeps(children[0] ?? new FakeChild(), {
    capabilities: async () => ({ effort: false, jsonSchema: options.jsonSchema ?? true }),
    env: options.env ?? {},
    writeFile: async (path, bytes) => {
      if (path.endsWith('agy-response-schema.json')) {
        schemas.push(JSON.parse(new TextDecoder().decode(bytes)))
      }
    },
    spawn: (_command, args) => {
      argLists.push(args)
      const child = queue.shift() ?? new FakeChild()
      const reply = options.replies[spawnCount++]
      setTimeout(() => {
        stdins.push(
          (
            JSON.parse(child.stdinText.trim() || '{"message":{}}') as {
              message: { content?: string }
            }
          ).message.content ?? '',
        )
        if (reply !== undefined) child.emitLines([reply])
        child.exit(0)
      }, 5)
      return child.asChild()
    },
  })
  const pending = streamAgy(
    { apiKey: '', cliPath: CLI, model: 'm' },
    '',
    options.messages ?? [{ role: 'user', text: 'edit the document' }],
    options.tools ?? tools,
    1000,
    {
      signal: new AbortController().signal,
      onDelta: (text) => deltas.push(text),
      onToolCall: (call) => calls.push(call),
      onStopReason: (reason) => stops.push(reason),
      onDiagnostic: (record) => diagnostics.push(record),
    },
    deps,
  )
  pending.catch(() => undefined)
  return {
    pending,
    calls,
    deltas,
    diagnostics,
    stops,
    stdins,
    argLists,
    schemas,
    spawnCount: () => spawnCount,
    usesSchemaFlag: (index: number) => argLists[index]?.includes('--json-schema') === true,
  }
}

const structuredReply = (text: string, toolCalls: unknown[]) =>
  result({
    response: 'prose\n{"text":"x"}',
    structured_output: { text, tool_calls: toolCalls },
  })

describe('resolveAgyToolProtocol', () => {
  it('uses the schema whenever tools are present and the flag exists', () => {
    expect(resolveAgyToolProtocol({ hasTools: true, schemaSupported: true })).toBe('schema')
  })

  it('stays on text without tools, without the flag, or when GENOFFICE_AGY_TOOL_MODE says text', () => {
    expect(resolveAgyToolProtocol({ hasTools: false, schemaSupported: true })).toBe('text')
    expect(resolveAgyToolProtocol({ hasTools: true, schemaSupported: false })).toBe('text')
    expect(
      resolveAgyToolProtocol({ hasTools: true, schemaSupported: true, override: ' Text ' }),
    ).toBe('text')
  })

  it('cannot force the schema onto an agy that lacks the flag, and ignores unknown values', () => {
    expect(
      resolveAgyToolProtocol({ hasTools: true, schemaSupported: false, override: 'schema' }),
    ).toBe('text')
    expect(
      resolveAgyToolProtocol({ hasTools: true, schemaSupported: true, override: 'banana' }),
    ).toBe('schema')
  })
})

describe('buildAgyPrompt: schema protocol', () => {
  it('asks for the object, lists the tools and drops the <tool_call> instructions', () => {
    const { prompt } = buildAgyPrompt('', [{ role: 'user', text: 'hi' }], tools, 'schema')
    expect(prompt).toContain(AGY_SCHEMA_TURN_NOTE)
    expect(prompt).toContain('- replace_text: Replace text in the open document')
    expect(prompt).not.toContain('<tool_call>')
    expect(prompt).toContain('response schema')
  })

  it('replays earlier tool calls as the same object the model has to produce, results unchanged', () => {
    const history: AgentMessage[] = [
      { role: 'user', text: 'đổi a' },
      {
        role: 'assistant',
        text: 'Đang sửa.',
        toolCalls: [{ id: '1', name: 'replace_text', input: { find: HARD } }],
      },
      {
        role: 'tool',
        results: [{ callId: '1', name: 'replace_text', output: 'replaced 2', isError: false }],
      } as unknown as AgentMessage,
    ]
    const { prompt } = buildAgyPrompt('', history, tools, 'schema')
    const line = prompt.split('\n\n').find((part) => part.startsWith('Assistant: '))!
    expect(JSON.parse(line.slice('Assistant: '.length))).toEqual({
      text: 'Đang sửa.',
      tool_calls: [{ name: 'replace_text', arguments: { find: HARD } }],
    })
    expect(prompt).toContain('Tool result (replace_text): replaced 2')
    expect(prompt).not.toContain('<tool_call>')
  })

  it('keeps the text protocol byte for byte when asked for it, and for turns without tools', () => {
    const history: AgentMessage[] = [{ role: 'user', text: 'hi' }]
    expect(buildAgyPrompt('s', history, tools, 'text')).toEqual(buildAgyPrompt('s', history, tools))
    expect(buildAgyPrompt('s', history, [], 'schema')).toEqual(buildAgyPrompt('s', history))
    expect(buildAgyPrompt('s', history, tools).prompt).toContain('<tool_call>')
  })

  it('renders a turn without tool calls as an object with an empty tool_calls list', () => {
    expect(JSON.parse(renderAgyStructuredTurn('  hello ', []))).toEqual({
      text: 'hello',
      tool_calls: [],
    })
  })
})

describe('streamAgy: schema-first tool turns', () => {
  it('asks once through --json-schema and delivers the validated object', async () => {
    const t = await runTurn({
      replies: [
        structuredReply('Đã sửa.', [
          { name: 'replace_text', arguments: { find: HARD } },
          { name: 'read_document', arguments: {} },
        ]),
      ],
    })
    await t.pending
    expect(t.spawnCount()).toBe(1)
    expect(t.usesSchemaFlag(0)).toBe(true)
    expect(t.schemas[0]).toEqual(agyToolTurnSchema(tools))
    expect(t.stdins[0]).toContain(AGY_SCHEMA_TURN_NOTE)
    expect(t.stdins[0]).not.toContain('<tool_call>')
    expect(t.deltas).toEqual(['Đã sửa.'])
    expect(t.calls.map((c) => [c.name, c.input])).toEqual([
      ['replace_text', { find: HARD }],
      ['read_document', {}],
    ])
    expect(new Set(t.calls.map((c) => c.id)).size).toBe(2)
    expect(t.stops).toEqual(['tool_use'])
    expect(t.diagnostics).toEqual([
      { provider: 'agy', status: 'success', reason: 'cli_result', attempts: 1, toolCallCount: 2 },
    ])
  })

  it('ends the turn with the text alone when the object asks for no tool', async () => {
    const t = await runTurn({ replies: [structuredReply('Chỉ là câu trả lời.', [])] })
    await t.pending
    expect(t.deltas).toEqual(['Chỉ là câu trả lời.'])
    expect(t.calls).toEqual([])
    expect(t.stops).toEqual(['end_turn'])
  })

  it('treats an empty object (no text, no tool) as no content', async () => {
    const t = await runTurn({ replies: [structuredReply('', [])] })
    await expect(t.pending).rejects.toThrow(/returned no content/)
    expect(t.calls).toEqual([])
  })

  it('does not use the schema for a turn without tools', async () => {
    const t = await runTurn({
      replies: [result({ response: 'plain answer' })],
      tools: [] as never,
    })
    await t.pending
    expect(t.usesSchemaFlag(0)).toBe(false)
    expect(t.stdins[0]).not.toContain(AGY_SCHEMA_TURN_NOTE)
    expect(t.deltas.join('')).toBe('plain answer')
  })

  it('uses the text protocol when the installed agy has no --json-schema', async () => {
    const t = await runTurn({
      jsonSchema: false,
      replies: [
        result({ response: '<tool_call>{"name":"read_document","arguments":{}}</tool_call>' }),
      ],
    })
    await t.pending
    expect(t.usesSchemaFlag(0)).toBe(false)
    expect(t.stdins[0]).toContain('<tool_call>')
    expect(t.calls.map((c) => c.name)).toEqual(['read_document'])
  })

  it('uses the text protocol when GENOFFICE_AGY_TOOL_MODE=text, even with --json-schema available', async () => {
    const t = await runTurn({
      env: { GENOFFICE_AGY_TOOL_MODE: 'text' },
      replies: [
        result({ response: '<tool_call>{"name":"read_document","arguments":{}}</tool_call>' }),
      ],
    })
    await t.pending
    expect(t.usesSchemaFlag(0)).toBe(false)
    expect(t.calls.map((c) => c.name)).toEqual(['read_document'])
  })

  it('accepts a reply without an object when it is plain prose', async () => {
    const t = await runTurn({ replies: [result({ response: 'Just words.' })] })
    await t.pending
    expect(t.spawnCount()).toBe(1)
    expect(t.deltas).toEqual(['Just words.'])
    expect(t.stops).toEqual(['end_turn'])
  })

  it('accepts a reply without an object when it carries readable <tool_call> blocks', async () => {
    const t = await runTurn({
      replies: [
        result({
          response: 'Sure.\n<tool_call>{"name":"read_document","arguments":{}}</tool_call>',
        }),
      ],
    })
    await t.pending
    expect(t.spawnCount()).toBe(1)
    expect(t.deltas).toEqual(['Sure.'])
    expect(t.calls.map((c) => c.name)).toEqual(['read_document'])
  })

  it('asks once more as <tool_call> text when the object names an unknown tool', async () => {
    const t = await runTurn({
      replies: [
        structuredReply('x', [{ name: 'run_command', arguments: {} }]),
        result({
          response:
            'Retrying.\n<tool_call>{"name":"replace_text","arguments":{"find":"a"}}</tool_call>',
        }),
      ],
    })
    await t.pending
    expect(t.spawnCount()).toBe(2)
    expect(t.usesSchemaFlag(1)).toBe(false)
    expect(t.stdins[1]).toContain('<tool_call>')
    expect(t.stdins[1]).toContain('could not be read as a tool request')
    expect(t.deltas).toEqual(['Retrying.'])
    expect(t.calls.map((c) => [c.name, c.input])).toEqual([['replace_text', { find: 'a' }]])
    expect(t.diagnostics.map((d) => [d.status, d.reason])).toEqual([
      ['retry', 'malformed_host_tool_call'],
      ['success', 'malformed_host_tool_call'],
    ])
  })

  it('fails without running anything when both protocols give nothing readable', async () => {
    const t = await runTurn({
      replies: [
        structuredReply('x', [{ name: 'run_command', arguments: {} }]),
        result({ response: '<tool_call>not json</tool_call>' }),
      ],
    })
    await expect(t.pending).rejects.toThrow(/tool request that could not be read/)
    expect(t.spawnCount()).toBe(2)
    expect(t.calls).toEqual([])
    expect(t.deltas).toEqual([])
    expect(t.diagnostics.at(-1)).toMatchObject({
      status: 'failure',
      reason: 'malformed_host_tool_call',
    })
  })

  it('keeps the schema on the retry after agy reports a malformed native function call', async () => {
    const t = await runTurn({
      replies: [
        result({
          response: 'Your previous response contained an improperly formatted function call',
        }),
        structuredReply('Done', [{ name: 'read_document', arguments: {} }]),
      ],
    })
    await t.pending
    expect(t.spawnCount()).toBe(2)
    expect(t.usesSchemaFlag(0)).toBe(true)
    expect(t.usesSchemaFlag(1)).toBe(true)
    expect(t.stdins[1]).toContain('Reply only through the response schema')
    expect(t.calls.map((c) => c.name)).toEqual(['read_document'])
    expect(t.diagnostics.map((d) => [d.status, d.reason])).toEqual([
      ['retry', 'malformed_native_call'],
      ['success', 'cli_result'],
    ])
  })

  it('does not start the other-protocol retry once the turn is aborted', async () => {
    const controller = new AbortController()
    const child = new FakeChild()
    const { deps, spawned } = runDeps(child, {
      capabilities: async () => ({ effort: false, jsonSchema: true }),
    })
    const pending = streamAgy(
      { apiKey: '', cliPath: CLI, model: 'm' },
      '',
      [{ role: 'user', text: 'edit' }],
      tools,
      1000,
      { signal: controller.signal, onDelta: vi.fn(), onToolCall: vi.fn() },
      deps,
    )
    pending.catch(() => undefined)
    await new Promise((r) => setTimeout(r, 5))
    child.emitLines([structuredReply('x', [{ name: 'run_command', arguments: {} }])])
    controller.abort()
    child.exit(0)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawned).toHaveLength(1)
  })
})

describe('streamAgy: text-first tool turns (GENOFFICE_AGY_TOOL_MODE=text)', () => {
  const env = { GENOFFICE_AGY_TOOL_MODE: 'text' }

  it('falls back to a schema retry when the blocks cannot be read, then delivers the object', async () => {
    const t = await runTurn({
      env,
      replies: [
        result({ response: '<tool_call>{"name": broken</tool_call>' }),
        structuredReply('Fixed.', [{ name: 'replace_text', arguments: { find: HARD } }]),
      ],
    })
    await t.pending
    expect(t.spawnCount()).toBe(2)
    expect(t.usesSchemaFlag(0)).toBe(false)
    expect(t.usesSchemaFlag(1)).toBe(true)
    expect(t.stdins[1]).toContain(AGY_SCHEMA_TURN_NOTE)
    expect(t.calls.map((c) => [c.name, c.input])).toEqual([['replace_text', { find: HARD }]])
    expect(t.deltas).toEqual(['Fixed.'])
  })

  it('does not spend a second model call on a schema retry the installed agy cannot honour', async () => {
    const t = await runTurn({
      env,
      jsonSchema: false,
      replies: [result({ response: '<tool_call>{"name": broken</tool_call>' })],
    })
    await expect(t.pending).rejects.toThrow(/malformed GenOffice <tool_call>/)
    expect(t.spawnCount()).toBe(1)
  })
})
