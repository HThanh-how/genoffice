import { describe, expect, it, vi } from 'vitest'
import type { AgentMessage, AgentToolCall, AgentToolDef } from '@genoffice/agent-core'
import { streamAgy, runAgy, buildAgyArgs, AGY_MAX_PROMPT_CHARS } from '../src/agy-cli'
import { agyAppendOnly, agyMessageHash } from '../src/agy-conversation'
import { CLI, FakeChild, runDeps } from './helpers/agy-fake'

const user = (text: string): AgentMessage => ({ role: 'user', text })
const assistant = (text: string, toolCalls: AgentToolCall[] = []): AgentMessage => ({
  role: 'assistant',
  text,
  toolCalls,
})
const tool: AgentToolDef = {
  name: 'read_document',
  description: 'Read',
  inputSchema: { type: 'object' },
}
type Reply = { text?: string; id?: string; error?: string; partial?: string }

function harness(replies: Reply[], enabled = true) {
  const requests: Array<{ args: string[]; prompt: string }> = []
  const { deps, removed } = runDeps(new FakeChild(), {
    env: enabled ? { GENOFFICE_AGY_RESUME: '1' } : {},
    spawn: (_command, args) => {
      const child = new FakeChild()
      const reply = replies.shift()
      if (!reply) throw new Error('Unexpected spawn')
      child.stdin.once('finish', () => {
        requests.push({ args, prompt: JSON.parse(child.stdinText).message.content })
        if (reply.partial)
          child.emitLines([
            JSON.stringify({
              event: 'step_update',
              step_update: {
                step_index: 1,
                step_type: 'agent_response',
                state: 'ACTIVE',
                text_delta: reply.partial,
              },
            }),
          ])
        child.emitLines([
          JSON.stringify({
            event: 'result',
            result: {
              status: reply.error ? 'ERROR' : 'SUCCESS',
              error: reply.error,
              response: reply.text ?? 'answer',
              conversation_id: reply.id,
            },
          }),
        ])
        child.exit(reply.error ? 3 : 0)
      })
      return child.asChild()
    },
  })
  async function turn(
    messages: AgentMessage[],
    options: {
      sessionId?: string
      scope?: string
      model?: string
      system?: string
      tools?: AgentToolDef[]
    } = {},
  ) {
    const deltas: string[] = []
    const calls: AgentToolCall[] = []
    await streamAgy(
      { apiKey: '', cliPath: CLI, model: options.model ?? 'm' },
      options.system ?? 'private instructions',
      messages,
      options.tools ?? [],
      1000,
      {
        sessionId: options.sessionId ?? 'chat',
        sessionScope: options.scope ?? 'window',
        signal: new AbortController().signal,
        onDelta: (delta) => deltas.push(delta),
        onToolCall: (call) => calls.push(call),
      },
      deps,
    )
    return { text: deltas.join(''), calls }
  }
  return { turn, requests, deps, removed }
}

describe('agy conversation resume (mocked CLI only)', () => {
  it('resumes the same session by explicit id and sends only new user input', async () => {
    const h = harness([{ id: 'c1' }, { id: 'c1', text: 'second' }])
    await h.turn([user('first')])
    await h.turn([user('first'), assistant('answer'), user('next')])
    expect(h.requests[0]!.args).not.toContain('--conversation')
    expect(h.requests[1]!.args).toContain('--conversation')
    expect(h.requests[1]!.args[h.requests[1]!.args.indexOf('--conversation') + 1]).toBe('c1')
    expect(h.requests[1]!.args).not.toContain('--continue')
    expect(h.requests[1]!.prompt).toBe('User: next')
    expect(h.removed).toHaveLength(2)
  })

  it.each(['user edit', 'assistant edit', 'retry', 'model', 'system', 'tools', 'scope', 'id'])(
    '%s starts a fresh conversation',
    async (change) => {
      const h = harness([{ id: 'c1' }, { id: 'c2' }])
      await h.turn([user('first')])
      const messages =
        change === 'retry'
          ? [user('first')]
          : [
              user(change === 'user edit' ? 'edited' : 'first'),
              assistant(change === 'assistant edit' ? 'edited' : 'answer'),
              user('next'),
            ]
      await h.turn(messages, {
        model: change === 'model' ? 'different' : 'm',
        system: change === 'system' ? 'new system' : 'private instructions',
        tools: change === 'tools' ? [tool] : [],
        scope: change === 'scope' ? 'different' : 'window',
        sessionId: change === 'id' ? 'different' : 'chat',
      })
      expect(h.requests[1]!.args).not.toContain('--conversation')
      expect(h.requests[1]!.prompt).toContain('Instructions from the application:')
    },
  )

  it('retries conversation errors once fresh without publishing partial resumed prose', async () => {
    const h = harness([
      { id: 'c1' },
      { error: 'Conversation c1 not found', partial: 'discard this' },
      { id: 'c2', text: 'fresh' },
      { id: 'c2' },
    ])
    await h.turn([user('first')])
    const messages = [user('first'), assistant('answer'), user('next')]
    expect(await h.turn(messages)).toEqual({ text: 'fresh', calls: [] })
    expect(h.requests[1]!.args).toContain('--conversation')
    expect(h.requests[2]!.args).not.toContain('--conversation')
    expect(h.requests[2]!.prompt).toContain('User: first')
    await h.turn([...messages, assistant('fresh'), user('third')])
    expect(h.requests[3]!.args).toContain('c2')
  })

  it('does not retry a fresh conversation error or an unrelated resume error', async () => {
    const h = harness([
      { id: 'c1' },
      { error: 'model unavailable' },
      { error: 'Conversation failure' },
    ])
    await h.turn([user('first')])
    await expect(h.turn([user('first'), assistant('answer'), user('next')])).rejects.toThrow(
      'model unavailable',
    )
    await expect(h.turn([user('first')])).rejects.toThrow('Conversation failure')
    expect(h.requests).toHaveLength(3)
    expect(h.requests[2]!.args).not.toContain('--conversation')
  })

  it('isolates two concurrent sessions and serializes turns within each session', async () => {
    const h = harness([{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'b' }])
    await Promise.all([
      h.turn([user('A')], { sessionId: 'a' }),
      h.turn([user('B')], { sessionId: 'b' }),
    ])
    await Promise.all([
      h.turn([user('A'), assistant('answer'), user('A2')], { sessionId: 'a' }),
      h.turn([user('B'), assistant('answer'), user('B2')], { sessionId: 'b' }),
    ])
    expect(h.requests[2]!.args).toContain('a')
    expect(h.requests[2]!.prompt).toBe('User: A2')
    expect(h.requests[3]!.args).toContain('b')
    expect(h.requests[3]!.prompt).toBe('User: B2')
  })

  it('sends only tool results after a host tool call in the text protocol', async () => {
    const h = harness([
      { id: 'c1', text: '<tool_call>{"name":"read_document","arguments":{}}</tool_call>' },
      { id: 'c1', text: 'done' },
    ])
    const first = await h.turn([user('read')], { tools: [tool] })
    expect(first.calls).toHaveLength(1)
    await h.turn(
      [
        user('read'),
        assistant(first.text, first.calls),
        {
          role: 'tool',
          results: [{ ...first.calls[0]!, output: 'contents' }],
        },
      ],
      { tools: [tool] },
    )
    expect(h.requests[1]!.args).toContain('c1')
    expect(h.requests[1]!.prompt).toContain('Tool result (read_document)')
    expect(h.requests[1]!.prompt).not.toContain('Assistant:')
    expect(h.requests[1]!.prompt).not.toContain('private instructions')
  })

  it('serializes concurrent requests for the same session before deciding whether to resume', async () => {
    const h = harness([{ id: 'c1' }, { id: 'c1' }])
    await Promise.all([
      h.turn([user('first')]),
      h.turn([user('first'), assistant('answer'), user('next')]),
    ])
    expect(h.requests[1]!.args).toContain('c1')
    expect(h.requests[1]!.prompt).toBe('User: next')
  })

  it('snapshots the sent prefix before asynchronous work', async () => {
    const h = harness([{ id: 'c1' }, { id: 'c1' }])
    const original = { role: 'user' as const, text: 'first' }
    const pending = h.turn([original])
    original.text = 'edited while sending'
    await pending
    await h.turn([user('first'), assistant('answer'), user('next')])
    expect(h.requests[0]!.prompt).toContain('User: first')
    expect(h.requests[1]!.prompt).toBe('User: next')
  })

  it('keeps the existing prompt budget when a delta is too large', async () => {
    const h = harness([{ id: 'c1' }, { id: 'c2' }])
    await h.turn([user('first')])
    await h.turn([user('first'), assistant('answer'), user('x'.repeat(AGY_MAX_PROMPT_CHARS + 1))])
    expect(h.requests[1]!.args).not.toContain('--conversation')
    expect(h.requests[1]!.prompt.length).toBeLessThan(AGY_MAX_PROMPT_CHARS + 100)
  })

  it('rejects conversation ids that could be interpreted as command options', () => {
    expect(() =>
      buildAgyArgs({
        model: 'm',
        stagingDir: 'stage',
        timeoutMs: 1000,
        conversationId: '--continue',
      }),
    ).toThrow('Invalid Antigravity conversation id')
  })

  it('defaults off and never resumes attachments', async () => {
    for (const enabled of [false, true]) {
      const h = harness([{ id: 'c1' }, { id: 'c1' }], enabled)
      const first: AgentMessage = enabled
        ? { role: 'user', text: 'image', images: [{ base64: 'aGVsbG8=', mime: 'image/png' }] }
        : user('first')
      await h.turn([first])
      await h.turn([first, assistant('answer'), user('next')])
      expect(h.requests[1]!.args).not.toContain('--conversation')
    }
  })

  it('rejects changes to tool IDs, result error flags, and noncausal appended assistants', () => {
    const messages: AgentMessage[] = [
      user('first'),
      assistant('answer', [{ id: 'id', name: tool.name, input: {} }]),
      { role: 'tool', results: [{ id: 'id', name: tool.name, output: 'ok' }] },
    ]
    const hashes = messages.map(agyMessageHash)
    expect(agyAppendOnly([...messages, user('next')], hashes)).toBe(true)
    expect(agyAppendOnly([...messages, assistant('unsent'), user('next')], hashes)).toBe(false)
    expect(
      agyAppendOnly(
        [
          messages[0]!,
          assistant('answer', [{ id: 'changed', name: tool.name, input: {} }]),
          messages[2]!,
          user('next'),
        ],
        hashes,
      ),
    ).toBe(false)
    expect(
      agyAppendOnly(
        [
          ...messages.slice(0, 2),
          { role: 'tool', results: [{ id: 'id', name: tool.name, output: 'ok', isError: true }] },
          user('next'),
        ],
        hashes,
      ),
    ).toBe(false)
  })

  it('includes the step timeline on resumed timeouts', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild()
      const { deps } = runDeps(child)
      const pending = runAgy(
        { cliPath: CLI, model: 'm', conversationId: 'c1', prompt: 'next', timeoutMs: 1000 },
        deps,
      )
      const rejected = expect(pending).rejects.toThrow(/steps=\[0s tool:read_file\]/)
      await vi.advanceTimersByTimeAsync(0)
      child.emitLines([
        JSON.stringify({
          event: 'step_update',
          step_update: {
            step_index: 1,
            state: 'ACTIVE',
            step_type: 'tool',
            tool_name: 'read_file',
          },
        }),
      ])
      await vi.advanceTimersByTimeAsync(1000)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })
})
