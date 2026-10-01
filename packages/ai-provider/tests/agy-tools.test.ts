import { CLI, FakeChild, runDeps, tick } from './helpers/agy-fake'
import { describe, expect, it } from 'vitest'
import { buildAgyPrompt, streamAgy } from '../src/agy-cli'
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
    expect(out.calls[0]).toMatchObject({ name: 'replace_text', input: { find: 'a' } })
  })

  it('accepts fenced JSON, several calls and a cut-off last block', () => {
    const text =
      '<tool_call>```json\n{"name":"replace_text","arguments":{"find":"x"}}\n```</tool_call>' +
      '<tool_call>{"name":"replace_text","arguments":{"find":"y"}}'
    const out = parseAgyToolCalls(text, known)
    expect(out.calls.map((c) => c.input.find)).toEqual(['x', 'y'])
  })

  it('ignores unknown tools and malformed JSON, and gives unique ids', () => {
    const out = parseAgyToolCalls(
      '<tool_call>{"name":"rm_rf","arguments":{}}</tool_call><tool_call>not json</tool_call>' +
        '<tool_call>{"name":"replace_text"}</tool_call><tool_call>{"name":"replace_text"}</tool_call>',
      known,
    )
    expect(out.calls).toHaveLength(2)
    expect(new Set(out.calls.map((c) => c.id)).size).toBe(2)
  })
})

describe('agy tool prompt', () => {
  it('lists the tools and replays calls and results in history', () => {
    expect(agyToolNote(tools)).toContain('replace_text')
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
})
