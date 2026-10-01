import { CLI, FakeChild, runDeps, tick } from './helpers/agy-fake'
import { describe, expect, it, vi } from 'vitest'
import { AGY_REQUEST_TIMEOUT_MS, buildAgyPrompt, streamAgy } from '../src/agy-cli'
import { agyToolNote, parseAgyToolCalls, renderAgyToolCalls } from '../src/agy-tools'

const tools = [
  {
    name: 'replace_text',
    description: 'Replace text in the open document',
    inputSchema: { type: 'object', properties: { find: { type: 'string' } } },
  },
]
const known = new Set(tools.map((t) => t.name))

describe('parseAgyToolCalls', () => {
  it('extracts a call and keeps the surrounding text', () => {
    const out = parseAgyToolCalls(
      'Sửa ngay.\n<tool_call>{"name":"replace_text","arguments":{"find":"a"}}</tool_call>',
      known,
    )
    expect(out.text).toBe('Sửa ngay.')
    expect(out.calls).toHaveLength(1)
    expect(out.invalidBlocks).toBe(0)
    expect(out.calls[0]).toMatchObject({ name: 'replace_text', input: { find: 'a' } })
  })

  it('accepts fenced JSON, several calls and a cut-off last block', () => {
    const text =
      '<tool_call>```json\n{"name":"replace_text","arguments":{"find":"x"}}\n```</tool_call>' +
      '<tool_call>{"name":"replace_text","arguments":{"find":"y"}}'
    const out = parseAgyToolCalls(text, known)
    expect(out.calls.map((c) => c.input.find)).toEqual(['x', 'y'])
    expect(out.invalidBlocks).toBe(0)
  })

  it('counts unknown tools and malformed JSON while giving valid calls unique ids', () => {
    const out = parseAgyToolCalls(
      '<tool_call>{"name":"rm_rf","arguments":{}}</tool_call><tool_call>not json</tool_call>' +
        '<tool_call>{"name":"replace_text"}</tool_call><tool_call>{"name":"replace_text"}</tool_call>',
      known,
    )
    expect(out.calls).toHaveLength(2)
    expect(new Set(out.calls.map((c) => c.id)).size).toBe(2)
    expect(out.invalidBlocks).toBe(2)
  })
})

describe('agy tool prompt', () => {
  it('lists the tools and replays calls and results in history', () => {
    const note = agyToolNote(tools)
    expect(note).toContain('replace_text')
    expect(note).toContain('Do not invoke Antigravity CLI tools')
    expect(note).toContain('do not request permission or wait for approval')
    expect(note).toContain('plain-text blocks')
    const call = { id: '1', name: 'replace_text', input: { find: 'a' } }
    const { prompt } = buildAgyPrompt(
      '',
      [
        { role: 'user', text: 'đổi a' },
        { role: 'assistant', text: '', toolCalls: [call] },
        {
          role: 'tool',
          results: [{ id: '1', name: 'replace_text', output: 'replaced 2', isError: false }],
        },
      ],
      tools,
    )
    expect(prompt).toContain(renderAgyToolCalls([call]))
    expect(prompt).toContain('Tool result (replace_text): replaced 2')
    expect(prompt).not.toContain('document-editing tools are NOT available')
  })

  it('keeps the text-only note when there are no tools', () => {
    expect(buildAgyPrompt('', [{ role: 'user', text: 'hi' }]).prompt).toContain(
      'document-editing tools are NOT available',
    )
  })
})

describe('streamAgy with tools', () => {
  it('turns a <tool_call> reply into onToolCall and never shows the block', async () => {
    const reply = 'OK\n<tool_call>{"name":"replace_text","arguments":{"find":"a"}}</tool_call>'
    const deltas: string[] = []
    const calls: string[] = []
    let stop = ''
    const child = new FakeChild()
    const { deps } = runDeps(child)
    const pending = streamAgy(
      { apiKey: '', cliPath: CLI, model: 'm' },
      '',
      [{ role: 'user', text: 'go' }],
      tools,
      1000,
      {
        signal: new AbortController().signal,
        onDelta: (t: string) => deltas.push(t),
        onToolCall: (c: { name: string }) => calls.push(c.name),
        onStopReason: (r: string) => (stop = r),
      },
      deps,
    )
    await tick()
    await tick()
    child.emitLines([
      JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: reply } }),
    ])
    child.exit(0)
    await pending
    expect(child.stdinText).toContain('replace_text')
    expect(deltas.join('')).toBe('OK')
    expect(calls).toEqual(['replace_text'])
    expect(stop).toBe('tool_use')
  })

  it('retries the vendor malformed-function-call result once, with the original deadline budget', async () => {
    const first = new FakeChild()
    const second = new FakeChild()
    const children = [first, second]
    const { deps } = runDeps(first, {
      spawn: () => children.shift()!.asChild(),
    })
    const calls: string[] = []
    const diagnostics: Array<Record<string, unknown>> = []
    const pending = streamAgy(
      { apiKey: '', cliPath: CLI, model: 'm' },
      '',
      [{ role: 'user', text: 'format the table' }],
      tools,
      1000,
      {
        signal: new AbortController().signal,
        onDelta: vi.fn(),
        onToolCall: (call) => calls.push(call.name),
        onDiagnostic: (record) => diagnostics.push(record),
      },
      deps,
    )
    await tick()
    await tick()
    first.emitLines([
      JSON.stringify({
        event: 'result',
        result: {
          status: 'ERROR',
          error:
            'Your previous response contained an improperly formatted function call. Retries remaining: 3',
        },
      }),
    ])
    first.exit(1)
    await tick()
    await tick()
    second.emitLines([
      JSON.stringify({
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: '<tool_call>{"name":"replace_text","arguments":{"find":"x"}}</tool_call>',
        },
      }),
    ])
    second.exit(0)
    await pending
    expect(children).toHaveLength(0)
    expect(first.stdinText).toContain('format the table')
    expect(second.stdinText).toContain('plain-text-only turn')
    expect(calls).toEqual(['replace_text'])
    expect(diagnostics).toEqual([
      {
        provider: 'agy',
        status: 'retry',
        reason: 'malformed_native_call',
        attempts: 1,
      },
      {
        provider: 'agy',
        status: 'success',
        reason: 'cli_result',
        attempts: 2,
        toolCallCount: 1,
      },
    ])
  })

  it('turns a repeated malformed-call CLI ERROR into an actionable failure without a third call', async () => {
    const first = new FakeChild()
    const second = new FakeChild()
    const third = new FakeChild()
    const children = [first, second, third]
    const { deps } = runDeps(first, {
      spawn: () => children.shift()!.asChild(),
    })
    const pending = streamAgy(
      { apiKey: '', cliPath: CLI, model: 'm' },
      '',
      [{ role: 'user', text: 'format the table' }],
      tools,
      1000,
      {
        signal: new AbortController().signal,
        onDelta: vi.fn(),
        onToolCall: vi.fn(),
      },
      deps,
    )
    const emitMalformedError = (child: FakeChild) => {
      child.emitLines([
        JSON.stringify({
          event: 'result',
          result: {
            status: 'ERROR',
            error: 'Your previous response contained an improperly formatted function call',
          },
        }),
      ])
      child.exit(1)
    }
    await tick()
    await tick()
    emitMalformedError(first)
    await tick()
    await tick()
    emitMalformedError(second)
    await expect(pending).rejects.toThrow(/after one retry.*no host tool was run/i)
    expect(children).toHaveLength(1)
    expect(children[0]).toBe(third)
  })

  it('does not retry after cancellation while handling the malformed-call result', async () => {
    const child = new FakeChild()
    const { deps, spawned } = runDeps(child)
    const controller = new AbortController()
    const pending = streamAgy(
      { apiKey: '', cliPath: CLI, model: 'm' },
      '',
      [{ role: 'user', text: 'format the table' }],
      tools,
      1000,
      {
        signal: controller.signal,
        onDelta: vi.fn(),
        onToolCall: vi.fn(),
        onDiagnostic: (record) => {
          if (record.status === 'retry') controller.abort()
        },
      },
      deps,
    )
    await tick()
    await tick()
    child.emitLines([
      JSON.stringify({
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: 'Your previous response contained an improperly formatted function call',
        },
      }),
    ])
    child.exit(0)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawned).toHaveLength(1)
  })

  it('does not start the retry after the original request deadline expires', async () => {
    const child = new FakeChild()
    const { deps, spawned } = runDeps(child)
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1000 + AGY_REQUEST_TIMEOUT_MS + 1)
    try {
      const pending = streamAgy(
        { apiKey: '', cliPath: CLI, model: 'm' },
        '',
        [{ role: 'user', text: 'format the table' }],
        tools,
        1000,
        {
          signal: new AbortController().signal,
          onDelta: vi.fn(),
          onToolCall: vi.fn(),
        },
        deps,
      )
      await tick()
      await tick()
      child.emitLines([
        JSON.stringify({
          event: 'result',
          result: {
            status: 'SUCCESS',
            response: 'Your previous response contained an improperly formatted function call',
          },
        }),
      ])
      child.exit(0)
      await expect(pending).rejects.toThrow(/timed out/i)
      expect(spawned).toHaveLength(1)
    } finally {
      now.mockRestore()
    }
  })

  it('rejects malformed GenOffice tool blocks without silently ending or running partial calls', async () => {
    const child = new FakeChild()
    const { deps } = runDeps(child)
    const onToolCall = vi.fn()
    const onDelta = vi.fn()
    const diagnostics: Array<Record<string, unknown>> = []
    const pending = streamAgy(
      { apiKey: '', cliPath: CLI, model: 'm' },
      '',
      [{ role: 'user', text: 'edit' }],
      tools,
      1000,
      {
        signal: new AbortController().signal,
        onDelta,
        onToolCall,
        onDiagnostic: (record) => diagnostics.push(record),
      },
      deps,
    )
    await tick()
    await tick()
    child.emitLines([
      JSON.stringify({
        event: 'result',
        result: {
          status: 'SUCCESS',
          response:
            'Should not leak\n<tool_call>not json</tool_call><tool_call>{"name":"replace_text","arguments":{}}</tool_call>',
        },
      }),
    ])
    child.exit(0)
    await expect(pending).rejects.toThrow(/malformed GenOffice <tool_call>/)
    expect(onDelta).not.toHaveBeenCalled()
    expect(onToolCall).not.toHaveBeenCalled()
    expect(diagnostics).toMatchObject([
      {
        provider: 'agy',
        status: 'failure',
        reason: 'malformed_host_tool_call',
        attempts: 1,
      },
    ])
  })
})
