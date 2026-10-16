import { describe, expect, it, vi } from 'vitest'
import {
  AgentLoop,
  type AgentMessage,
  type AgentSkill,
  type AgentToolCall,
  type AgentTransport,
} from '@genoffice/agent-core'
import { buildAgyPrompt, streamAgy } from '../src/agy-cli'
import {
  AGY_SCHEMA_TURN_NOTE,
  agyToolTurnSchema,
  parseAgyStructuredText,
  readAgyTurnFromText,
  readStructuredToolTurn,
  renderAgyStructuredTurn,
  resolveAgyToolProtocol,
} from '../src/agy-structured-turn'
import { streamForProvider } from '../src/index'
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

describe('Section 7 Regression Matrix: 20 scenarios', () => {
  it('TEST 1: Valid structured_output object', async () => {
    const t = await runTurn({
      replies: [
        structuredReply('Đã định dạng.', [
          { name: 'replace_text', arguments: { find: 'tiêu đề' } },
        ]),
      ],
    })
    await t.pending
    expect(t.deltas).toEqual(['Đã định dạng.'])
    expect(t.calls.map((c) => [c.name, c.input])).toEqual([['replace_text', { find: 'tiêu đề' }]])
    expect(t.stops).toEqual(['tool_use'])
  })

  it('TEST 2: Valid JSON structured turn inside result.response without structured_output', async () => {
    const rawResponse = JSON.stringify({
      text: 'Tôi đã định dạng lại văn bản',
      tool_calls: [
        {
          name: 'replace_text',
          arguments: { find: 'tiêu đề' },
        },
        {
          name: 'read_document',
          arguments: {},
        },
      ],
    })
    const t = await runTurn({
      replies: [
        result({
          response: rawResponse,
          // Notice: NO structured_output property!
        }),
      ],
    })
    await t.pending
    // Raw JSON is never emitted through onDelta
    expect(t.deltas).toEqual(['Tôi đã định dạng lại văn bản'])
    expect(t.calls.map((c) => [c.name, c.input])).toEqual([
      ['replace_text', { find: 'tiêu đề' }],
      ['read_document', {}],
    ])
    expect(t.stops).toEqual(['tool_use'])
    expect(t.diagnostics[0]).toMatchObject({
      status: 'success',
      reason: 'cli_result',
      toolCallCount: 2,
    })
  })

  it('TEST 3: Multiple tool calls in one structured JSON response', async () => {
    const t = await runTurn({
      replies: [
        result({
          response: JSON.stringify({
            text: 'Thực hiện 3 lệnh',
            tool_calls: [
              { name: 'read_document', arguments: {} },
              { name: 'replace_text', arguments: { find: 'chương 1' } },
              { name: 'replace_text', arguments: { find: 'chương 2' } },
            ],
          }),
        }),
      ],
    })
    await t.pending
    expect(t.calls.map((c) => [c.name, c.input])).toEqual([
      ['read_document', {}],
      ['replace_text', { find: 'chương 1' }],
      ['replace_text', { find: 'chương 2' }],
    ])
    expect(t.calls).toHaveLength(3)
  })

  it('TEST 4: Structured JSON with empty tool_calls', async () => {
    const t = await runTurn({
      replies: [
        result({
          response: JSON.stringify({
            text: 'Đây là nội dung tài liệu.',
            tool_calls: [],
          }),
        }),
      ],
    })
    await t.pending
    expect(t.deltas).toEqual(['Đây là nội dung tài liệu.'])
    expect(t.calls).toEqual([])
    expect(t.stops).toEqual(['end_turn'])
  })

  it('TEST 5: Valid <tool_call> text protocol', async () => {
    const t = await runTurn({
      jsonSchema: false,
      replies: [
        result({
          response: 'Đang đọc.\n<tool_call>{"name":"read_document","arguments":{}}</tool_call>',
        }),
      ],
    })
    await t.pending
    expect(t.deltas).toEqual(['Đang đọc.'])
    expect(t.calls.map((c) => c.name)).toEqual(['read_document'])
  })

  it('TEST 6: Ordinary plain-text response', async () => {
    const t = await runTurn({
      replies: [result({ response: 'Tài liệu nói về hợp đồng mua bán.' })],
    })
    await t.pending
    expect(t.deltas).toEqual(['Tài liệu nói về hợp đồng mua bán.'])
    expect(t.calls).toEqual([])
    expect(t.stops).toEqual(['end_turn'])
  })

  it('TEST 7: Plain text explaining JSON syntax', async () => {
    const explanation =
      'Để gọi công cụ, sử dụng định dạng JSON: {"name": "replace_text", "arguments": {"find": "abc"}}. Hãy thử lại.'
    const t = await runTurn({
      replies: [result({ response: explanation })],
    })
    await t.pending
    expect(t.deltas).toEqual([explanation])
    expect(t.calls).toEqual([])
    expect(t.stops).toEqual(['end_turn'])
  })

  it('TEST 8: Unknown tool name', async () => {
    const t = await runTurn({
      replies: [
        result({
          response: JSON.stringify({
            text: 'Thực thi lệnh lạ',
            tool_calls: [{ name: 'delete_entire_hard_drive', arguments: {} }],
          }),
        }),
        result({ response: '<tool_call>invalid_again' }),
      ],
    })
    await expect(t.pending).rejects.toThrow(/could not be read|malformed GenOffice tool request/)
    expect(t.calls).toEqual([])
  })

  it('TEST 9: Malformed arguments', async () => {
    const t = await runTurn({
      replies: [
        result({
          response: JSON.stringify({
            text: 'Sửa lỗi',
            tool_calls: [{ name: 'replace_text', arguments: 'find=string-instead-of-object' }],
          }),
        }),
        result({ response: '<tool_call>invalid_again' }),
      ],
    })
    await expect(t.pending).rejects.toThrow(/could not be read|malformed GenOffice tool request/)
    expect(t.calls).toEqual([])
  })

  it('TEST 10: Malformed JSON recognizable as a structured tool request', async () => {
    const t = await runTurn({
      replies: [
        result({
          response: '{"text": "Đang sửa", "tool_calls": [broken-json',
        }),
        result({ response: '<tool_call>invalid_again' }),
      ],
    })
    await expect(t.pending).rejects.toThrow(/could not be read|malformed GenOffice tool request/)
    expect(t.deltas).toEqual([])
    expect(t.calls).toEqual([])
  })

  it('TEST 11: Truncated structured JSON', async () => {
    const t = await runTurn({
      replies: [
        result({
          response:
            '{"text": "Đang định dạng", "tool_calls": [{"name": "replace_text", "arguments":',
        }),
        result({ response: '<tool_call>invalid_again' }),
      ],
    })
    await expect(t.pending).rejects.toThrow(/could not be read|malformed GenOffice tool request/)
    expect(t.calls).toEqual([])
  })

  it('TEST 12: Repeated tool calls: no accidental duplication from fallback or retry', async () => {
    const t = await runTurn({
      replies: [
        result({
          response: JSON.stringify({
            text: 'Lặp công cụ',
            tool_calls: [
              { name: 'replace_text', arguments: { find: 'a' } },
              { name: 'replace_text', arguments: { find: 'b' } },
            ],
          }),
        }),
      ],
    })
    await t.pending
    expect(t.spawnCount()).toBe(1)
    expect(t.calls).toHaveLength(2)
    expect(t.calls[0].input).toEqual({ find: 'a' })
    expect(t.calls[1].input).toEqual({ find: 'b' })
    expect(t.calls[0].id).not.toBe(t.calls[1].id)
  })

  it('TEST 13: Cancellation before delivery', async () => {
    const controller = new AbortController()
    const child = new FakeChild()
    const { deps } = runDeps(child, {
      capabilities: async () => ({ effort: false, jsonSchema: true }),
    })
    const calls: AgentToolCall[] = []
    const pending = streamAgy(
      { apiKey: '', cliPath: CLI, model: 'm' },
      '',
      [{ role: 'user', text: 'edit' }],
      tools,
      1000,
      {
        signal: controller.signal,
        onDelta: vi.fn(),
        onToolCall: (c) => calls.push(c),
      },
      deps,
    )
    pending.catch(() => undefined)
    await new Promise((r) => setTimeout(r, 5))
    child.emitLines([
      result({
        response: JSON.stringify({
          text: 'Chưa kịp giao',
          tool_calls: [{ name: 'read_document', arguments: {} }],
        }),
      }),
    ])
    controller.abort()
    child.exit(0)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toEqual([])
  })

  it('TEST 14: Structured JSON including Vietnamese Unicode and escaped quotes', async () => {
    const viText =
      'Tôi đã định dạng lại văn bản theo chuẩn thể thức văn bản hành chính Việt Nam (Nghị định 30/2020/NĐ-CP). "Trích yếu": Căn cứ Luật Tổ chức Chính phủ.'
    const viArg = 'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM\nĐộc lập - Tự do - Hạnh phúc'
    const t = await runTurn({
      replies: [
        result({
          response: JSON.stringify({
            text: viText,
            tool_calls: [
              {
                name: 'replace_text',
                arguments: { find: viArg },
              },
            ],
          }),
        }),
      ],
    })
    await t.pending
    expect(t.deltas).toEqual([viText])
    expect(t.calls.map((c) => [c.name, c.input])).toEqual([['replace_text', { find: viArg }]])
  })

  it('TEST 15: Valid native Gemini function-call response', async () => {
    const geminiResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      text: async () => '',
      body: {
        getReader() {
          const encoder = new TextEncoder()
          const chunks = [
            encoder.encode(
              'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"replace_text","args":{"find":"gemini-test"}}}]},"finishReason":"STOP"}]}\n\n',
            ),
          ]
          return {
            async read() {
              const value = chunks.shift()
              return value ? { done: false, value } : { done: true, value: undefined }
            },
            async cancel() {},
            releaseLock() {},
          }
        },
      },
    } as unknown as Response
    const fetchMock = vi.fn().mockResolvedValue(geminiResponse)
    vi.stubGlobal('fetch', fetchMock)
    try {
      const calls: AgentToolCall[] = []
      const deltas: string[] = []
      await streamForProvider(
        'gemini',
        { apiKey: 'k', model: 'gemini-2.5-flash' },
        'system',
        [{ role: 'user', text: 'hi' }],
        tools,
        1000,
        {
          signal: new AbortController().signal,
          onDelta: (d) => deltas.push(d),
          onToolCall: (c) => calls.push(c),
        },
      )
      expect(calls.map((c) => [c.name, c.input])).toEqual([
        ['replace_text', { find: 'gemini-test' }],
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('TEST 16: Valid OpenAI-compatible tool-call response', async () => {
    const openaiResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      text: async () => '',
      body: {
        getReader() {
          const encoder = new TextEncoder()
          const chunks = [
            encoder.encode(
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"replace_text","arguments":"{\\"find\\":\\"openai-test\\"}"}}]}}]}\n\n',
            ),
            encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'),
            encoder.encode('data: [DONE]\n\n'),
          ]
          return {
            async read() {
              const value = chunks.shift()
              return value ? { done: false, value } : { done: true, value: undefined }
            },
            async cancel() {},
            releaseLock() {},
          }
        },
      },
    } as unknown as Response
    const fetchMock = vi.fn().mockResolvedValue(openaiResponse)
    vi.stubGlobal('fetch', fetchMock)
    try {
      const calls: AgentToolCall[] = []
      await streamForProvider(
        'openai',
        { apiKey: 'k', model: 'gpt-4o' },
        'system',
        [{ role: 'user', text: 'hi' }],
        tools,
        1000,
        {
          signal: new AbortController().signal,
          onDelta: vi.fn(),
          onToolCall: (c) => calls.push(c),
        },
      )
      expect(calls.map((c) => [c.name, c.input])).toEqual([
        ['replace_text', { find: 'openai-test' }],
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('TEST 17: Structured tool result followed by unexpected trailing text', async () => {
    const jsonWithTrailing =
      JSON.stringify({
        text: 'Đã xong',
        tool_calls: [{ name: 'read_document', arguments: {} }],
      }) + 'svg'
    const t = await runTurn({
      replies: [
        result({ response: jsonWithTrailing }),
        result({ response: '<tool_call>invalid_again' }),
      ],
    })
    await expect(t.pending).rejects.toThrow(/could not be read|malformed GenOffice tool request/)
    expect(t.deltas).toEqual([])
    expect(t.calls).toEqual([])
  })

  it('TEST 18: Structured JSON wrapped in a complete Markdown code fence', async () => {
    const fenced =
      '```json\n' +
      JSON.stringify({
        text: 'Bọc trong code fence',
        tool_calls: [{ name: 'read_document', arguments: {} }],
      }) +
      '\n```'
    const t = await runTurn({
      replies: [result({ response: fenced })],
    })
    await t.pending
    expect(t.deltas).toEqual(['Bọc trong code fence'])
    expect(t.calls.map((c) => c.name)).toEqual(['read_document'])
  })

  it('TEST 19: A successful tool invocation followed by a normal final answer in AgentLoop', async () => {
    let turnNumber = 0
    const executedToolNames: string[] = []
    const transport: AgentTransport = {
      stream: (_req, cb) => {
        turnNumber++
        if (turnNumber === 1) {
          queueMicrotask(() => {
            cb.onDelta?.('Đang thực hiện thay thế văn bản.')
            cb.onToolCall?.({ id: 'call-1', name: 'replace_text', input: { find: 'cũ' } })
            cb.onStopReason?.('tool_use')
            cb.onDone?.()
          })
        } else {
          queueMicrotask(() => {
            cb.onDelta?.('Tôi đã thay thế văn bản thành công.')
            cb.onStopReason?.('end_turn')
            cb.onDone?.()
          })
        }
        return { cancel: () => {} }
      },
    }
    const skill: AgentSkill = {
      id: 'test_skill',
      systemPrompt: 'test system prompt',
      tools,
      executeTool: async (call) => {
        executedToolNames.push(call.name)
        return { output: 'Đã thay thế 1 lần', summary: 'Đã thay thế 1 lần', isError: false }
      },
    }
    const resultOutcome = await new Promise<{ text: string; cancelled: boolean }>((resolve) => {
      const loop = new AgentLoop({
        transport,
        skill,
        events: {
          onDone: (out) => resolve(out),
        },
      })
      loop.run('Thay thế từ cũ trong tài liệu')
    })
    expect(executedToolNames).toEqual(['replace_text'])
    expect(resultOutcome.text).toBe('Tôi đã thay thế văn bản thành công.')
    expect(resultOutcome.cancelled).toBe(false)
  })

  it('TEST 20: Tool invocation fails: failure is reflected in final outcome without false success', async () => {
    let turnNumber = 0
    const transport: AgentTransport = {
      stream: (req, cb) => {
        turnNumber++
        if (turnNumber === 1) {
          queueMicrotask(() => {
            cb.onDelta?.('Đang kiểm tra tài liệu.')
            cb.onToolCall?.({ id: 'call-1', name: 'read_document', input: {} })
            cb.onStopReason?.('tool_use')
            cb.onDone?.()
          })
        } else {
          const lastMsg = req.messages.at(-1) as {
            role: string
            results?: Array<{ isError?: boolean }>
          }
          const hasError = lastMsg?.results?.some((r) => r.isError)
          queueMicrotask(() => {
            if (hasError) {
              cb.onDelta?.('Không thể đọc tài liệu vì tệp đang bị khóa.')
            } else {
              cb.onDelta?.('Tôi đã đọc tài liệu thành công.')
            }
            cb.onStopReason?.('end_turn')
            cb.onDone?.()
          })
        }
        return { cancel: () => {} }
      },
    }
    const skill: AgentSkill = {
      id: 'test_skill',
      systemPrompt: 'test system prompt',
      tools,
      executeTool: async () => {
        return {
          output: 'Lỗi: Tệp đang bị khóa bởi tiến trình khác.',
          summary: 'Lỗi',
          isError: true,
        }
      },
    }
    const resultOutcome = await new Promise<{ text: string }>((resolve) => {
      const loop = new AgentLoop({
        transport,
        skill,
        events: {
          onDone: (out) => resolve(out),
        },
      })
      loop.run('Đọc tài liệu')
    })
    expect(resultOutcome.text).toBe('Không thể đọc tài liệu vì tệp đang bị khóa.')
    expect(resultOutcome.text).not.toContain('thành công')
  })
})

describe('Issue 1: AGY retry and text-first structured JSON regressions', () => {
  it('Schema mode -> text retry -> structured JSON', async () => {
    const t = await runTurn({
      replies: [
        result({ response: '{"text": "Đang sửa", "tool_calls": [broken-json' }),
        result({
          response: JSON.stringify({
            text: 'Đã phục hồi từ retry',
            tool_calls: [{ name: 'replace_text', arguments: { find: 'cũ', replace: 'mới' } }],
          }),
        }),
      ],
    })
    await t.pending
    expect(t.deltas).toEqual(['Đã phục hồi từ retry'])
    expect(t.calls.map((c) => c.name)).toEqual(['replace_text'])
    expect(t.calls[0]?.input).toEqual({ find: 'cũ', replace: 'mới' })
    expect(t.stops).toEqual(['tool_use'])
  })

  it('Text-first mode -> structured JSON', async () => {
    const t = await runTurn({
      jsonSchema: false,
      replies: [
        result({
          response: JSON.stringify({
            text: 'Đang thực hiện',
            tool_calls: [{ name: 'replace_text', arguments: { find: 'a', replace: 'b' } }],
          }),
        }),
      ],
    })
    await t.pending
    expect(t.deltas).toEqual(['Đang thực hiện'])
    expect(t.calls.map((c) => c.name)).toEqual(['replace_text'])
    expect(t.calls[0]?.input).toEqual({ find: 'a', replace: 'b' })
    expect(t.stops).toEqual(['tool_use'])
  })

  it('Text-first mode -> malformed structured JSON fails closed', async () => {
    const t = await runTurn({
      jsonSchema: false,
      replies: [
        result({
          response:
            '{"text": "Đang sửa", "tool_calls": [{"name": "replace_text", "arguments": "invalid-args"}]}',
        }),
        result({ response: 'still invalid' }),
      ],
    })
    await expect(t.pending).rejects.toThrow(/malformed GenOffice tool request/)
    expect(t.calls).toEqual([])
  })

  it('Text retry -> unknown tool fails closed without leaking raw JSON', async () => {
    const t = await runTurn({
      replies: [
        result({ response: '{"text": "Lỗi", "tool_calls": [broken' }),
        result({
          response: JSON.stringify({
            text: 'Gọi tool lạ',
            tool_calls: [{ name: 'non_existent_tool', arguments: {} }],
          }),
        }),
      ],
    })
    await expect(t.pending).rejects.toThrow(/could not be read|malformed GenOffice tool request/)
    expect(t.calls).toEqual([])
  })

  it('Text retry -> valid normal prose is delivered as end_turn', async () => {
    const t = await runTurn({
      replies: [
        result({ response: '{"text": "Thử lại", "tool_calls": [broken' }),
        result({
          response: 'Tài liệu không có thay đổi nào cần thực hiện.',
        }),
      ],
    })
    await t.pending
    expect(t.deltas).toEqual(['Tài liệu không có thay đổi nào cần thực hiện.'])
    expect(t.calls).toEqual([])
    expect(t.stops).toEqual(['end_turn'])
  })

  it('No duplicate tool execution after retry', async () => {
    const t = await runTurn({
      replies: [
        result({ response: '{"text": "Lần 1", "tool_calls": [broken' }),
        result({
          response: JSON.stringify({
            text: 'Đang chạy',
            tool_calls: [{ name: 'read_document', arguments: {} }],
          }),
        }),
      ],
    })
    await t.pending
    expect(t.spawnCount()).toBe(2)
    expect(t.calls.length).toBe(1)
    expect(t.calls[0]?.name).toBe('read_document')
  })
})

describe('Defect D Regression Matrix: truncated AGY JSON and fail-closed protocol (D01-D20)', () => {
  const knownTools = new Set(['replace_text', 'read_document', 'apply_ops', 'read_blocks'])

  it('D01: valid structured_output object => normal execution', async () => {
    const t = await runTurn({
      replies: [structuredReply('Done', [{ name: 'read_document', arguments: {} }])],
    })
    await t.pending
    expect(t.calls.length).toBe(1)
    expect(t.calls[0]?.name).toBe('read_document')
  })

  it('D02: valid structured JSON in result.response => normal execution', async () => {
    const t = await runTurn({
      replies: [
        result({
          response: JSON.stringify({
            text: 'Processing',
            tool_calls: [{ name: 'replace_text', arguments: { find: 'foo' } }],
          }),
        }),
      ],
    })
    await t.pending
    expect(t.calls.length).toBe(1)
    expect(t.calls[0]?.name).toBe('replace_text')
    expect(t.calls[0]?.input).toEqual({ find: 'foo' })
  })

  it('D03: multiple valid tool calls => all correctly executed', async () => {
    const t = await runTurn({
      replies: [
        result({
          response: JSON.stringify({
            text: 'Batch ops',
            tool_calls: [
              { name: 'read_document', arguments: {} },
              { name: 'replace_text', arguments: { find: 'bar' } },
            ],
          }),
        }),
      ],
    })
    await t.pending
    expect(t.calls.length).toBe(2)
    expect(t.calls[0]?.name).toBe('read_document')
    expect(t.calls[1]?.name).toBe('replace_text')
  })

  it('D04: malformed JSON with complete tool_calls key => FAIL CLOSED', () => {
    const raw = '{"text":"Broken","tool_calls": [broken'
    const res = parseAgyStructuredText(raw, knownTools)
    expect(res.kind).toBe('malformed')
    const turnRes = readAgyTurnFromText(raw, knownTools)
    expect(turnRes.kind).toBe('malformed')
  })

  it('D05: truncated JSON before tool_calls key completes => FAIL CLOSED', () => {
    const raw = '{"text":"Formatting complete","tool_c'
    const res = parseAgyStructuredText(raw, knownTools)
    expect(res.kind).toBe('malformed')
    const turnRes = readAgyTurnFromText(raw, knownTools)
    expect(turnRes.kind).toBe('malformed')
  })

  it('D06: truncated JSON at tool_ca => FAIL CLOSED', () => {
    const raw = '{"text":"Đang xử lý","tool_ca'
    const res = parseAgyStructuredText(raw, knownTools)
    expect(res.kind).toBe('malformed')
    const turnRes = readAgyTurnFromText(raw, knownTools)
    expect(turnRes.kind).toBe('malformed')
  })

  it('D07: truncated JSON immediately after tool_calls => FAIL CLOSED', () => {
    const raw = '{"text":"I updated the document","tool_calls":['
    const res = parseAgyStructuredText(raw, knownTools)
    expect(res.kind).toBe('malformed')
    const turnRes = readAgyTurnFromText(raw, knownTools)
    expect(turnRes.kind).toBe('malformed')
  })

  it('D08: truncated JSON inside tool arguments => FAIL CLOSED', () => {
    const raw =
      '{"text":"I updated the document","tool_calls":[{"name":"replace_text","arguments":{'
    const res = parseAgyStructuredText(raw, knownTools)
    expect(res.kind).toBe('malformed')
    const turnRes = readAgyTurnFromText(raw, knownTools)
    expect(turnRes.kind).toBe('malformed')
  })

  it('D09: unknown tool name => REJECT', () => {
    const raw = JSON.stringify({
      text: 'Testing',
      tool_calls: [{ name: 'unknown_host_tool', arguments: {} }],
    })
    const res = parseAgyStructuredText(raw, knownTools)
    expect(res.kind).toBe('malformed')
  })

  it('D10: malformed argument object => REJECT', () => {
    const raw = JSON.stringify({
      text: 'Testing',
      tool_calls: [{ name: 'replace_text', arguments: 'not-an-object' }],
    })
    const res = parseAgyStructuredText(raw, knownTools)
    expect(res.kind).toBe('malformed')
  })

  it('D11: ordinary prose => PRESERVED', () => {
    const raw = 'Hello, how can I help you today?'
    const turnRes = readAgyTurnFromText(raw, knownTools)
    expect(turnRes.kind).toBe('prose')
    if (turnRes.kind === 'prose') {
      expect(turnRes.text).toBe(raw)
    }
  })

  it('D12: prose explaining JSON => PRESERVED', () => {
    const raw = 'The configuration format is {"text":"hello"}.'
    const turnRes = readAgyTurnFromText(raw, knownTools)
    expect(turnRes.kind).toBe('prose')
    if (turnRes.kind === 'prose') {
      expect(turnRes.text).toBe(raw)
    }
  })

  it('D13: valid non-tool JSON example => PRESERVED', () => {
    const raw = '{"example":"ordinary JSON data"}'
    const res = parseAgyStructuredText(raw, knownTools)
    expect(res.kind).toBe('none')
    const turnRes = readAgyTurnFromText(raw, knownTools)
    expect(turnRes.kind).toBe('prose')
  })

  it('D14: complete fenced structured JSON => correctly parsed', () => {
    const raw = '```json\n{"text":"ok","tool_calls":[{"name":"read_document","arguments":{}}]}\n```'
    const res = parseAgyStructuredText(raw, knownTools)
    expect(res.kind).toBe('valid')
    if (res.kind === 'valid') {
      expect(res.turn.calls[0]?.name).toBe('read_document')
    }
  })

  it('D15: plain text tool-call protocol => correctly parsed', () => {
    const raw = 'Action: <tool_call>{"name":"read_document","arguments":{}}</tool_call>'
    const turnRes = readAgyTurnFromText(raw, knownTools)
    expect(turnRes.kind).toBe('valid')
    if (turnRes.kind === 'valid') {
      expect(turnRes.syntax).toBe('tags')
      expect(turnRes.turn.calls[0]?.name).toBe('read_document')
    }
  })

  it('D16: retry returns valid structured JSON => exactly one execution', async () => {
    const t = await runTurn({
      replies: [
        result({ response: '{"text":"Đang xử lý","tool_ca' }),
        result({
          response: JSON.stringify({
            text: 'Recovered',
            tool_calls: [{ name: 'read_document', arguments: {} }],
          }),
        }),
      ],
    })
    await t.pending
    expect(t.spawnCount()).toBe(2)
    expect(t.calls.length).toBe(1)
    expect(t.calls[0]?.name).toBe('read_document')
  })

  it('D17: retry fails => no host execution, clear error', async () => {
    const t = await runTurn({
      replies: [
        result({ response: '{"text":"Đang xử lý","tool_ca' }),
        result({ response: '{"text":"Vẫn lỗi","tool_ca' }),
      ],
    })
    await expect(t.pending).rejects.toThrow(/could not be read|malformed GenOffice tool request/)
    expect(t.calls).toEqual([])
  })

  it('D18: cancellation before delivery => no tool execution', async () => {
    const child = new FakeChild()
    const { deps } = runDeps(child)
    const controller = new AbortController()
    controller.abort()

    const calls: AgentToolCall[] = []
    const pending = streamAgy(
      { apiKey: '', cliPath: CLI, model: 'm' },
      '',
      [{ role: 'user', text: 'cancel me' }],
      tools,
      1000,
      {
        signal: controller.signal,
        onDelta: () => {},
        onToolCall: (call) => calls.push(call),
      },
      deps,
    )
    await expect(pending).rejects.toThrow(/aborted|cancelled/i)
    expect(calls).toEqual([])
  })

  it('D19: Vietnamese Unicode preserved in structured turn', () => {
    const raw = JSON.stringify({
      text: 'Tiêu đề: Hợp đồng kinh tế và Biên bản nghiệm thu.',
      tool_calls: [{ name: 'replace_text', arguments: { text: HARD } }],
    })
    const res = parseAgyStructuredText(raw, knownTools)
    expect(res.kind).toBe('valid')
    if (res.kind === 'valid') {
      expect(res.turn.text).toBe('Tiêu đề: Hợp đồng kinh tế và Biên bản nghiệm thu.')
      expect(res.turn.calls[0]?.input.text).toBe(HARD)
    }
  })

  it('D20: no raw structured protocol fragment displayed as success in runTurn', async () => {
    const t = await runTurn({
      replies: [result({ response: '{"text":"Đang xử lý","tool_ca' }), result({ response: '' })],
    })
    await expect(t.pending).rejects.toThrow()
    expect(t.deltas).not.toContain('{"text":"Đang xử lý","tool_ca')
  })

  describe('Defect F: Early truncated structured JSON tokens fail closed', () => {
    const truncatedCases = [
      '{"text":"Done","tool_',
      '{"text":"Done","tool',
      '{"text":"Done",',
      '{"text":"Done',
      '{"text":',
      '{"tool',
      '{"tool_',
      '{"tool_c',
      '{"tool_calls',
      '{"text":"Đang xử lý","tool_',
    ]

    for (const [index, raw] of truncatedCases.entries()) {
      it(`F${String(index + 1).padStart(2, '0')}: '${raw}' recognized as malformed`, () => {
        const res = parseAgyStructuredText(raw, knownTools)
        expect(res.kind).toBe('malformed')
        const turn = readAgyTurnFromText(raw, knownTools)
        expect(turn.kind).toBe('malformed')
      })
    }

    it('F11: early truncation does not execute tool or leak as prose in runTurn', async () => {
      const t = await runTurn({
        replies: [result({ response: '{"text":"Đang sửa","tool_' }), result({ response: '' })],
      })
      await expect(t.pending).rejects.toThrow()
      expect(t.calls).toHaveLength(0)
      expect(t.deltas).not.toContain('{"text":"Đang sửa","tool_')
    })
  })

  describe('Defect G: Markdown fence variants for structured turn', () => {
    const validTurn = { text: 'Done', tool_calls: [] }
    const validJson = JSON.stringify(validTurn)

    it('G01: ```json', () => {
      const res = parseAgyStructuredText(`\`\`\`json\n${validJson}\n\`\`\``, knownTools)
      expect(res.kind).toBe('valid')
    })

    it('G02: ```JSON (uppercase)', () => {
      const res = parseAgyStructuredText(`\`\`\`JSON\n${validJson}\n\`\`\``, knownTools)
      expect(res.kind).toBe('valid')
    })

    it('G03: ```Json (mixed case)', () => {
      const res = parseAgyStructuredText(`\`\`\`Json\n${validJson}\n\`\`\``, knownTools)
      expect(res.kind).toBe('valid')
    })

    it('G04: ``` json (space before json)', () => {
      const res = parseAgyStructuredText(`\`\`\` json\n${validJson}\n\`\`\``, knownTools)
      expect(res.kind).toBe('valid')
    })

    it('G05: ``` (unlabeled)', () => {
      const res = parseAgyStructuredText(`\`\`\`\n${validJson}\n\`\`\``, knownTools)
      expect(res.kind).toBe('valid')
    })

    it('G06: ````json (4 backticks)', () => {
      const res = parseAgyStructuredText(`\`\`\`\`json\n${validJson}\n\`\`\`\``, knownTools)
      expect(res.kind).toBe('valid')
    })

    it('G07: ~~~json (tildes)', () => {
      const res = parseAgyStructuredText(`~~~json\n${validJson}\n~~~`, knownTools)
      expect(res.kind).toBe('valid')
    })

    it('G08: ~~~JSON (uppercase tildes)', () => {
      const res = parseAgyStructuredText(`~~~JSON\n${validJson}\n~~~`, knownTools)
      expect(res.kind).toBe('valid')
    })

    it('G09: inline fence without newlines', () => {
      const res = parseAgyStructuredText(`\`\`\`json${validJson}\`\`\``, knownTools)
      expect(res.kind).toBe('valid')
    })
  })

  describe('Defect K: readStructuredToolTurn schema bounds parity', () => {
    it('K01: non-string text (number) is rejected', () => {
      expect(readStructuredToolTurn({ text: 123, tool_calls: [] }, knownTools)).toBeNull()
    })

    it('K02: non-string text (boolean) is rejected', () => {
      expect(readStructuredToolTurn({ text: true, tool_calls: [] }, knownTools)).toBeNull()
    })

    it('K03: non-string text (null) is rejected', () => {
      expect(readStructuredToolTurn({ text: null, tool_calls: [] }, knownTools)).toBeNull()
    })

    it('K04: unrecognized top-level field is rejected', () => {
      expect(
        readStructuredToolTurn({ text: 'ok', tool_calls: [], extra_prop: 1 }, knownTools),
      ).toBeNull()
    })

    it('K05: unrecognized tool_call property is rejected', () => {
      expect(
        readStructuredToolTurn(
          {
            text: 'ok',
            tool_calls: [{ name: 'replace_text', arguments: {}, extra_field: 2 }],
          },
          knownTools,
        ),
      ).toBeNull()
    })

    it('K06: non-object arguments is rejected', () => {
      expect(
        readStructuredToolTurn(
          { text: 'ok', tool_calls: [{ name: 'replace_text', arguments: 'str' }] },
          knownTools,
        ),
      ).toBeNull()
    })

    it('K07: unknown tool name is rejected', () => {
      expect(
        readStructuredToolTurn(
          { text: 'ok', tool_calls: [{ name: 'nonexistent_tool', arguments: {} }] },
          knownTools,
        ),
      ).toBeNull()
    })

    it('K08: tool call count exceeding 8 is rejected', () => {
      const calls = Array.from({ length: 9 }, () => ({ name: 'replace_text', arguments: {} }))
      expect(readStructuredToolTurn({ text: 'ok', tool_calls: calls }, knownTools)).toBeNull()
    })

    it('K09: valid structured turn produces parsed result', () => {
      const turn = readStructuredToolTurn(
        { text: '  Done  ', tool_calls: [{ name: 'replace_text', arguments: { find: 'a' } }] },
        knownTools,
      )
      expect(turn).toEqual({
        text: 'Done',
        calls: [{ name: 'replace_text', input: { find: 'a' } }],
      })
    })

    it('K10: omitted text defaults to empty string', () => {
      const turn = readStructuredToolTurn({ tool_calls: [] }, knownTools)
      expect(turn).toEqual({ text: '', calls: [] })
    })
  })
})
