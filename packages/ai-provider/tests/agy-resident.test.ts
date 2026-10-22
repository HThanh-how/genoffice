import { afterEach, describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AgentMessage, AgentToolCall, AgentToolDef } from '@genoffice/agent-core'
import { agyGenericToolTurnSchema } from '../src/agy-structured-turn'
import {
  AGY_RESIDENT_IDLE_TTL_MS,
  AGY_RESIDENT_TURN_TIMEOUT_MS,
  isResidentEligible,
  prewarmAgy,
  semanticFingerprint,
  shutdownAgyResidentServers,
  retireAgyResidentScope,
} from '../src/agy-resident'
import type { AgyRunDeps } from '../src/agy-cli'
import { streamAgy } from '../src/agy-cli'
import { clearAgyChatDefaults, recordAgyChatDefault } from '../src/agy-default'

class FakeResidentChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  pid: number
  stdinText = ''
  killed = false

  constructor(pid = 4242) {
    super()
    this.pid = pid
    this.stdin.on('data', (c: Buffer) => {
      const text = c.toString('utf8')
      this.stdinText += text
      this.emit('stdin_data', text)
    })
  }

  emitLines(lines: string[]) {
    this.stdout.write(lines.join('\n') + '\n')
  }

  kill = vi.fn(() => {
    if (this.killed) return true
    this.killed = true
    this.stdout.end()
    this.emit('close', 0)
    return true
  })

  asChild() {
    return this as unknown as ChildProcessWithoutNullStreams
  }
}

function createMockDeps() {
  let nextPid = 1000
  const children: FakeResidentChild[] = []
  const spawned: Array<{ command: string; args: string[] }> = []
  const createdDirs: string[] = []
  const removedDirs: string[] = []
  const writtenFiles: Array<{ path: string; content: string }> = []
  let semaphoreAcquires = 0
  let semaphoreReleases = 0

  const mockDeps: AgyRunDeps = {
    platform: 'darwin',
    env: {},
    home: '/home/u',
    isFile: async () => true,
    isExecutable: async () => true,
    loginShellLookup: async () => undefined,
    spawn: (command, args) => {
      const child = new FakeResidentChild(nextPid++)
      children.push(child)
      spawned.push({ command, args })
      return child.asChild()
    },
    killTree: (child) => {
      const fake = children.find((c) => c.pid === child.pid)
      fake?.kill()
    },
    makeStagingDir: async () => {
      const dir = `/tmp/genoffice-agy-test-${createdDirs.length}`
      createdDirs.push(dir)
      return dir
    },
    removeDir: async (dir) => {
      removedDirs.push(dir)
    },
    writeFile: async (path, bytes) => {
      writtenFiles.push({ path, content: new TextDecoder().decode(bytes) })
    },
    capabilities: async () => ({
      jsonSchema: true,
      effort: false,
    }),
    machineSemaphore: {
      acquire: async () => {
        semaphoreAcquires++
        return async () => {
          semaphoreReleases++
        }
      },
    },
  }

  return {
    deps: mockDeps,
    children,
    spawned,
    createdDirs,
    removedDirs,
    writtenFiles,
    getSemaphoreStats: () => ({ acquires: semaphoreAcquires, releases: semaphoreReleases }),
  }
}

const sampleTools: AgentToolDef[] = [
  {
    name: 'create_document',
    description: 'Create a new document',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
]

describe('resident conversation resume after worker eviction', () => {
  let mock: ReturnType<typeof createMockDeps>
  afterEach(() => {
    if (mock) shutdownAgyResidentServers(mock.deps)
    vi.useRealTimers()
  })

  function setup(replies: Array<{ id?: string; error?: string; text?: string }>) {
    mock = createMockDeps()
    mock.deps.env.GENOFFICE_AGY_RESUME = '1'
    const spawn = mock.deps.spawn
    mock.deps.spawn = (...args) => {
      const child = spawn(...args)
      child.stdin.on('finish', () => setImmediate(() => child.emit('close', 0)))
      child.stdin.on('data', () => {
        queueMicrotask(() => {
          const reply = replies.shift()
          if (!reply) throw new Error('Unexpected resident turn')
          child.stdout.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                event: 'result',
                result: {
                  status: reply.error ? 'ERROR' : 'SUCCESS',
                  error: reply.error,
                  response: reply.text ?? 'answer',
                  conversation_id: reply.id,
                  structured_output: { text: reply.text ?? 'answer', tool_calls: [] },
                },
              }) + '\n',
            ),
          )
        })
      })
      return child
    }
    return async (
      messages: AgentMessage[],
      options: { sessionId?: string; model?: string; cliPath?: string } = {},
    ) => {
      const deltas: string[] = []
      await streamAgy(
        {
          apiKey: '',
          model: options.model ?? 'm',
          cliPath: options.cliPath ?? '/usr/local/bin/agy',
        },
        'system instructions',
        messages,
        sampleTools,
        1024,
        {
          sessionId: options.sessionId ?? 'chat',
          sessionScope: 'scope',
          signal: new AbortController().signal,
          onDelta: (text) => deltas.push(text),
          onToolCall: vi.fn(),
        },
        mock.deps,
      )
      return deltas.join('')
    }
  }
  const first: AgentMessage[] = [{ role: 'user', text: 'first' }]
  const next: AgentMessage[] = [
    ...first,
    { role: 'assistant', text: 'answer' },
    { role: 'user', text: 'next' },
  ]

  it('restarts with --conversation and the delta while preserving stream-json worker stdin', async () => {
    vi.useFakeTimers()
    const turn = setup([{ id: 'c1' }, { id: 'c1' }])
    await turn(first)
    await vi.advanceTimersByTimeAsync(AGY_RESIDENT_IDLE_TTL_MS + 1)
    expect(mock.children[0]!.killed).toBe(true)
    await turn(next)
    expect(mock.spawned[1]!.args).toContain('--conversation')
    expect(mock.spawned[1]!.args).toContain('c1')
    expect(mock.spawned[1]!.args).toContain('stream-json')
    expect(JSON.parse(mock.children[1]!.stdinText).message.content).toBe('User: next')
    expect(mock.children[1]!.stdin.writableEnded).toBe(false)
    expect(mock.removedDirs).toEqual([mock.createdDirs[0]])
  })

  it('falls back once to a full seed after a conversation error', async () => {
    vi.useFakeTimers()
    const turn = setup([
      { id: 'c1' },
      { error: 'Conversation c1 is unavailable' },
      { id: 'c2', text: 'fresh answer' },
    ])
    await turn(first)
    await vi.advanceTimersByTimeAsync(AGY_RESIDENT_IDLE_TTL_MS + 1)
    expect(await turn(next)).toBe('fresh answer')
    expect(mock.spawned).toHaveLength(3)
    expect(mock.spawned[1]!.args).toContain('c1')
    expect(mock.spawned[2]!.args).not.toContain('--conversation')
    expect(mock.children[2]!.stdinText).toContain('system instructions')
    expect(mock.children[2]!.stdinText).toContain('User: first')
    expect(mock.children[1]!.killed).toBe(true)
  })

  it.each(['prefix', 'retry', 'model', 'executable'])(
    'starts fresh after %s changes',
    async (change) => {
      vi.useFakeTimers()
      const turn = setup([{ id: 'c1' }, { id: 'c2' }])
      await turn(first)
      await vi.advanceTimersByTimeAsync(AGY_RESIDENT_IDLE_TTL_MS + 1)
      const messages =
        change === 'retry'
          ? first
          : change === 'prefix'
            ? [{ role: 'user', text: 'edited' } as AgentMessage, ...next.slice(1)]
            : next
      await turn(messages, {
        model: change === 'model' ? 'new-model' : 'm',
        cliPath: change === 'executable' ? '/opt/other/agy' : '/usr/local/bin/agy',
      })
      expect(mock.spawned[1]!.args).not.toContain('--conversation')
      expect(mock.children[1]!.stdinText).toContain('system instructions')
    },
  )

  it('keeps two concurrent evicted sessions bound to their own conversation ids', async () => {
    vi.useFakeTimers()
    const turn = setup([{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'b' }])
    await Promise.all([turn(first, { sessionId: 'a' }), turn(first, { sessionId: 'b' })])
    await vi.advanceTimersByTimeAsync(AGY_RESIDENT_IDLE_TTL_MS + 1)
    await Promise.all([turn(next, { sessionId: 'a' }), turn(next, { sessionId: 'b' })])
    expect(mock.spawned[2]!.args).toContain('a')
    expect(mock.spawned[3]!.args).toContain('b')
    expect(
      mock.children.slice(2).every((child) => !child.stdinText.includes('system instructions')),
    ).toBe(true)
  })

  it('forgets evicted conversations when their window scope is retired', async () => {
    vi.useFakeTimers()
    const turn = setup([{ id: 'c1' }, { id: 'c2' }])
    await turn(first)
    await vi.advanceTimersByTimeAsync(AGY_RESIDENT_IDLE_TTL_MS + 1)
    retireAgyResidentScope('scope', mock.deps)
    await turn(next)
    expect(mock.spawned[1]!.args).not.toContain('--conversation')
  })

  it('starts fresh when switching between the text and schema tool protocols', async () => {
    const turn = setup([{ id: 'text' }, { id: 'schema' }, { id: 'text2' }])
    mock.deps.env.GENOFFICE_AGY_TOOL_MODE = 'text'
    await turn(first)
    delete mock.deps.env.GENOFFICE_AGY_TOOL_MODE
    await turn(next)
    mock.deps.env.GENOFFICE_AGY_TOOL_MODE = 'text'
    await turn([...next, { role: 'assistant', text: 'answer' }, { role: 'user', text: 'third' }])
    expect(mock.spawned).toHaveLength(3)
    expect(mock.spawned.every(({ args }) => !args.includes('--conversation'))).toBe(true)
  })
})

describe('agy resident transport', () => {
  it('builds a generic tool turn schema without hardcoded name enum', () => {
    const schema = agyGenericToolTurnSchema() as {
      type: string
      properties: {
        text: { type: string }
        tool_calls: {
          items: {
            properties: {
              name: { type: string; enum?: string[] }
              arguments: { type: string }
            }
          }
        }
      }
      required: string[]
    }
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['text', 'tool_calls'])
    expect(schema.properties.tool_calls.items.properties.name.type).toBe('string')
    expect(schema.properties.tool_calls.items.properties.name.enum).toBeUndefined()
  })

  describe('semanticFingerprint', () => {
    it('normalizes user messages', () => {
      const msg: AgentMessage = { role: 'user', text: 'Hello' }
      const fp1 = semanticFingerprint(msg)
      const fp2 = semanticFingerprint({ role: 'user', text: 'Hello' })
      expect(fp1).toBe(fp2)
      expect(fp1).not.toBe(semanticFingerprint({ role: 'user', text: 'Hello World' }))
    })

    it('ignores random assistant tool-call IDs and validates name + args + text', () => {
      const msg1: AgentMessage = {
        role: 'assistant',
        text: 'Working on it',
        toolCalls: [{ id: 'random-uuid-1', name: 'create_document', input: { name: 'test.docx' } }],
      }
      const msg2: AgentMessage = {
        role: 'assistant',
        text: 'Working on it',
        toolCalls: [
          { id: 'different-uuid-2', name: 'create_document', input: { name: 'test.docx' } },
        ],
      }
      expect(semanticFingerprint(msg1)).toBe(semanticFingerprint(msg2))

      const msgChangedArgs: AgentMessage = {
        role: 'assistant',
        text: 'Working on it',
        toolCalls: [
          { id: 'random-uuid-1', name: 'create_document', input: { name: 'other.docx' } },
        ],
      }
      expect(semanticFingerprint(msg1)).not.toBe(semanticFingerprint(msgChangedArgs))

      const msgChangedText: AgentMessage = {
        role: 'assistant',
        text: 'Done working',
        toolCalls: [{ id: 'random-uuid-1', name: 'create_document', input: { name: 'test.docx' } }],
      }
      expect(semanticFingerprint(msg1)).not.toBe(semanticFingerprint(msgChangedText))
    })

    it('ignores random tool result IDs and validates name + output', () => {
      const r1: AgentMessage = {
        role: 'tool',
        results: [{ id: 'id-1', name: 'create_document', output: 'ok' }],
      }
      const r2: AgentMessage = {
        role: 'tool',
        results: [{ id: 'id-2', name: 'create_document', output: 'ok' }],
      }
      expect(semanticFingerprint(r1)).toBe(semanticFingerprint(r2))

      const rChanged: AgentMessage = {
        role: 'tool',
        results: [{ id: 'id-1', name: 'create_document', output: 'failed' }],
      }
      expect(semanticFingerprint(r1)).not.toBe(semanticFingerprint(rChanged))
    })
  })

  describe('isResidentEligible', () => {
    it('requires stable sessionId, tools, schema protocol, and no attachments', () => {
      expect(
        isResidentEligible({
          sessionId: 'session-123',
          tools: sampleTools,
          protocol: 'schema',
          messages: [{ role: 'user', text: 'hi' }],
        }),
      ).toBe(true)

      // Missing sessionId
      expect(
        isResidentEligible({
          sessionId: undefined,
          tools: sampleTools,
          protocol: 'schema',
          messages: [{ role: 'user', text: 'hi' }],
        }),
      ).toBe(false)

      // No tools
      expect(
        isResidentEligible({
          sessionId: 'session-123',
          tools: [],
          protocol: 'schema',
          messages: [{ role: 'user', text: 'hi' }],
        }),
      ).toBe(false)

      // Text protocol
      expect(
        isResidentEligible({
          sessionId: 'session-123',
          tools: sampleTools,
          protocol: 'text',
          messages: [{ role: 'user', text: 'hi' }],
        }),
      ).toBe(false)

      // Has attachments -> safe one-shot
      expect(
        isResidentEligible({
          sessionId: 'session-123',
          tools: sampleTools,
          protocol: 'schema',
          messages: [{ role: 'user', text: 'hi', images: [{ mime: 'image/png', base64: 'abc' }] }],
        }),
      ).toBe(false)
    })
  })

  describe('resident worker reuse, isolation, mismatch, and cleanup', () => {
    afterEach(() => {
      shutdownAgyResidentServers()
    })

    it('cleans an allocated worker when its window cancels before the first stdin write', async () => {
      const mock = createMockDeps()
      const controller = new AbortController()
      const spawn = mock.deps.spawn
      mock.deps.spawn = (...args) => {
        const child = spawn(...args)
        controller.abort()
        return child
      }
      await expect(
        streamAgy(
          { apiKey: '', model: 'gemini-3.8-flash-low', cliPath: '/usr/local/bin/agy' },
          'sys',
          [{ role: 'user', text: 'Never dispatch this cancelled request' }],
          sampleTools,
          1024,
          {
            sessionId: 'cancel-before-write',
            signal: controller.signal,
            onDelta: vi.fn(),
            onToolCall: vi.fn(),
          },
          mock.deps,
        ),
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(mock.children).toHaveLength(1)
      expect(mock.children[0]!.stdinText).toBe('')
      expect(mock.children[0]!.killed).toBe(true)
      expect(mock.removedDirs).toEqual(mock.createdDirs)
    })

    it.each(['action', 'example', 'invalid'] as const)(
      'corrects an embedded envelope once without replay or implicit execution: %s',
      async (mode) => {
        const mock = createMockDeps()
        const onToolCall = vi.fn()
        const pending = streamAgy(
          { apiKey: '', model: 'gemini-3.8-flash-low', cliPath: '/usr/local/bin/agy' },
          'sys',
          [{ role: 'user', text: 'Unique original instruction' }],
          sampleTools,
          1024,
          {
            sessionId: 'format-repair',
            signal: new AbortController().signal,
            onDelta: vi.fn(),
            onToolCall,
          },
          mock.deps,
        ).then(
          (value) => ({ value, error: null }),
          (error) => ({ value: null, error }),
        )
        await vi.waitFor(() => expect(mock.children).toHaveLength(1))
        const child = mock.children[0]!
        const embedded = {
          text: JSON.stringify({
            text: '',
            tool_calls: [{ name: 'create_document', arguments: { name: 'Doc1' } }],
          }),
          tool_calls: [],
        }
        const emit = (structured_output: unknown) =>
          child.emitLines([
            JSON.stringify({ event: 'result', result: { status: 'SUCCESS', structured_output } }),
          ])
        emit(embedded)
        await vi.waitFor(() => expect(child.stdinText.trim().split('\n')).toHaveLength(2))
        expect(onToolCall).not.toHaveBeenCalled()
        expect(child.stdinText.trim().split('\n')[1]).not.toContain('Unique original instruction')
        emit(
          mode === 'invalid'
            ? embedded
            : mode === 'example'
              ? { text: 'This JSON is only an example.', tool_calls: [] }
              : {
                  text: '',
                  tool_calls: [{ name: 'create_document', arguments: { name: 'Doc1' } }],
                },
        )
        const outcome = await pending
        expect(mock.children).toHaveLength(1)
        expect(child.stdinText.trim().split('\n')).toHaveLength(2)
        if (mode === 'invalid') {
          expect(outcome.error).toBeInstanceOf(Error)
          expect(child.killed).toBe(true)
          expect(onToolCall).not.toHaveBeenCalled()
        } else {
          expect(outcome.error).toBeNull()
          expect(onToolCall).toHaveBeenCalledTimes(mode === 'action' ? 1 : 0)
          if (mode === 'action')
            expect(onToolCall).toHaveBeenCalledWith(
              expect.objectContaining({ name: 'create_document' }),
            )
        }
      },
    )

    it('reuses the same worker process for multi-turn conversations and passes causal tail', async () => {
      const mock = createMockDeps()
      const returnedCalls: AgentToolCall[] = []
      shutdownAgyResidentServers(mock.deps)

      const config = { apiKey: '', model: 'gemini-3.8-flash-low', cliPath: '/usr/local/bin/agy' }
      const system = 'You are a test assistant'

      // Turn 1
      const turn1Promise = streamAgy(
        config,
        system,
        [{ role: 'user', text: 'Create document Doc1' }],
        sampleTools,
        1024,
        {
          sessionId: 'chat-42',
          sessionScope: 'window-1',
          signal: new AbortController().signal,
          onDelta: vi.fn(),
          onToolCall: (call) => returnedCalls.push(call),
        },
        mock.deps,
      )

      await vi.waitFor(() => expect(mock.children.length).toBe(1))
      const child = mock.children[0]!
      expect(child.stdinText).toContain('Create document Doc1')

      // Emit structured tool call result for Turn 1
      child.emitLines([
        JSON.stringify({ event: 'init', conversation_id: 'conv-101' }),
        JSON.stringify({
          event: 'result',
          result: {
            status: 'SUCCESS',
            conversation_id: 'conv-101',
            structured_output: {
              text: 'Creating document now',
              tool_calls: [{ name: 'create_document', arguments: { name: 'Doc1' } }],
            },
          },
        }),
      ])
      await turn1Promise

      // Worker should still be alive (not killed)
      expect(child.killed).toBe(false)

      // Turn 2: Host appends assistant turn and tool result
      const turn2Messages: AgentMessage[] = [
        { role: 'user', text: 'Create document Doc1' },
        {
          role: 'assistant',
          text: 'Creating document now',
          toolCalls: returnedCalls,
        },
        {
          role: 'tool',
          results: [
            { id: returnedCalls[0]!.id, name: 'create_document', output: 'Document created: Doc1' },
          ],
        },
      ]

      child.stdinText = '' // reset tracking

      const turn2Promise = streamAgy(
        config,
        system,
        turn2Messages,
        sampleTools,
        1024,
        {
          sessionId: 'chat-42',
          sessionScope: 'window-1',
          signal: new AbortController().signal,
          onDelta: vi.fn(),
          onToolCall: vi.fn(),
        },
        mock.deps,
      )

      // Same child reused!
      expect(mock.children.length).toBe(1)
      await vi.waitFor(() => expect(child.stdinText).toContain('Tool result (create_document)'))
      // Verify causal delta only, not full flattened replay of instructions
      expect(child.stdinText).not.toContain('You are a test assistant')

      child.emitLines([
        JSON.stringify({
          event: 'result',
          result: {
            status: 'SUCCESS',
            conversation_id: 'conv-101',
            structured_output: {
              text: 'Document Doc1 is ready.',
              tool_calls: [],
            },
          },
        }),
      ])
      await turn2Promise

      // Verify semaphore was released while idle
      const stats = mock.getSemaphoreStats()
      expect(stats.acquires).toBe(2)
      expect(stats.releases).toBe(2)

      shutdownAgyResidentServers(mock.deps)
      expect(child.killed).toBe(true)
    })

    it('reseeds with the newly configured CLI executable for an existing session', async () => {
      const mock = createMockDeps()
      const spawn = vi.spyOn(mock.deps, 'spawn')
      const messages: AgentMessage[] = [{ role: 'user', text: 'Hello' }]
      const run = (cliPath: string) =>
        streamAgy(
          { apiKey: '', model: 'gemini-3.8-flash-low', cliPath },
          'Test assistant',
          messages,
          sampleTools,
          1024,
          {
            sessionId: 'changed-cli',
            sessionScope: 'window-1',
            signal: new AbortController().signal,
            onDelta: vi.fn(),
            onToolCall: vi.fn(),
          },
          mock.deps,
        )
      const finish = (child: FakeResidentChild) =>
        child.emitLines([
          JSON.stringify({
            event: 'result',
            result: { status: 'SUCCESS', structured_output: { text: 'Hi', tool_calls: [] } },
          }),
        ])
      const first = run('/old/agy')
      await vi.waitFor(() => expect(mock.children[0]?.stdinText).toContain('Hello'))
      finish(mock.children[0]!)
      await first
      messages.push({ role: 'assistant', text: 'Hi' }, { role: 'user', text: 'Continue' })
      const second = run('/new/agy')
      const settled = second.catch(() => undefined)
      try {
        await vi.waitFor(() => expect(mock.children[1]?.stdinText).toContain('Continue'))
        expect(mock.children[0]!.killed).toBe(true)
        expect(spawn.mock.calls.map(([path]) => path)).toEqual(['/old/agy', '/new/agy'])
        finish(mock.children[1]!)
        await second
      } finally {
        shutdownAgyResidentServers(mock.deps)
        await settled
      }
    })

    it('isolates different sessionScopes and sessionIds', async () => {
      const mock = createMockDeps()
      shutdownAgyResidentServers(mock.deps)

      const config = { apiKey: '', model: 'gemini-3.8-flash-low', cliPath: '/usr/local/bin/agy' }

      const turnA = streamAgy(
        config,
        'sys',
        [{ role: 'user', text: 'User A' }],
        sampleTools,
        1024,
        {
          sessionId: 'chat-1',
          sessionScope: 'scope-A',
          signal: new AbortController().signal,
          onDelta: vi.fn(),
          onToolCall: vi.fn(),
        },
        mock.deps,
      )

      await vi.waitFor(() => expect(mock.children.length).toBe(1))
      mock.children[0]!.emitLines([
        JSON.stringify({
          event: 'result',
          result: {
            status: 'SUCCESS',
            structured_output: { text: 'Reply A', tool_calls: [] },
          },
        }),
      ])
      await turnA

      const turnB = streamAgy(
        config,
        'sys',
        [{ role: 'user', text: 'User B' }],
        sampleTools,
        1024,
        {
          sessionId: 'chat-1',
          sessionScope: 'scope-B', // Different scope!
          signal: new AbortController().signal,
          onDelta: vi.fn(),
          onToolCall: vi.fn(),
        },
        mock.deps,
      )

      await vi.waitFor(() => expect(mock.children.length).toBe(2))
      mock.children[1]!.emitLines([
        JSON.stringify({
          event: 'result',
          result: {
            status: 'SUCCESS',
            structured_output: { text: 'Reply B', tool_calls: [] },
          },
        }),
      ])
      await turnB

      expect(mock.children[0]!.pid).not.toBe(mock.children[1]!.pid)
      shutdownAgyResidentServers(mock.deps)
    })

    it('reseeds when history or assistant response was edited', async () => {
      const mock = createMockDeps()
      shutdownAgyResidentServers(mock.deps)

      const config = { apiKey: '', model: 'gemini-3.8-flash-low', cliPath: '/usr/local/bin/agy' }

      // Turn 1
      const turn1 = streamAgy(
        config,
        'sys',
        [{ role: 'user', text: 'Original message' }],
        sampleTools,
        1024,
        {
          sessionId: 'chat-mismatch',
          sessionScope: 'scope-1',
          signal: new AbortController().signal,
          onDelta: vi.fn(),
          onToolCall: vi.fn(),
        },
        mock.deps,
      )

      await vi.waitFor(() => expect(mock.children.length).toBe(1))
      mock.children[0]!.emitLines([
        JSON.stringify({
          event: 'result',
          result: {
            status: 'SUCCESS',
            structured_output: { text: 'Original answer', tool_calls: [] },
          },
        }),
      ])
      await turn1

      // Turn 2 with edited assistant response (text changed from 'Original answer' to 'TAMPERED')
      const turn2 = streamAgy(
        config,
        'sys',
        [
          { role: 'user', text: 'Original message' },
          { role: 'assistant', text: 'TAMPERED', toolCalls: [] },
          { role: 'user', text: 'Next question' },
        ],
        sampleTools,
        1024,
        {
          sessionId: 'chat-mismatch',
          sessionScope: 'scope-1',
          signal: new AbortController().signal,
          onDelta: vi.fn(),
          onToolCall: vi.fn(),
        },
        mock.deps,
      )

      // Old worker should be killed and a second child spawned (reseed)
      await vi.waitFor(() => expect(mock.children.length).toBe(2))
      expect(mock.children[0]!.killed).toBe(true)

      mock.children[1]!.emitLines([
        JSON.stringify({
          event: 'result',
          result: {
            status: 'SUCCESS',
            structured_output: { text: 'Reseeded reply', tool_calls: [] },
          },
        }),
      ])
      await turn2
      shutdownAgyResidentServers(mock.deps)
    })

    it('kills worker on abort and does not blindly replay', async () => {
      const mock = createMockDeps()
      shutdownAgyResidentServers(mock.deps)

      const controller = new AbortController()
      const config = { apiKey: '', model: 'gemini-3.8-flash-low', cliPath: '/usr/local/bin/agy' }

      const turn = streamAgy(
        config,
        'sys',
        [{ role: 'user', text: 'Slow request' }],
        sampleTools,
        1024,
        {
          sessionId: 'chat-abort',
          sessionScope: 'scope-1',
          signal: controller.signal,
          onDelta: vi.fn(),
          onToolCall: vi.fn(),
        },
        mock.deps,
      )

      await vi.waitFor(() => expect(mock.children.length).toBe(1))
      const child = mock.children[0]!
      await vi.waitFor(() => expect(child.stdinText.length).toBeGreaterThan(0))

      controller.abort()

      await expect(turn).rejects.toThrow(/aborted/i)
      // Worker retired and killed immediately
      expect(child.killed).toBe(true)

      shutdownAgyResidentServers(mock.deps)
    })

    it('supports prewarm without token waste, binding to the first matching session', async () => {
      const mock = createMockDeps()
      shutdownAgyResidentServers(mock.deps)

      const config = { apiKey: '', model: 'gemini-3.8-flash-low', cliPath: '/usr/local/bin/agy' }

      await prewarmAgy(config, mock.deps)
      expect(mock.children.length).toBe(1)
      const prewarmedChild = mock.children[0]!

      // Zero stdin written during prewarm!
      expect(prewarmedChild.stdinText).toBe('')

      // Subsequent session request binds to prewarmed worker
      const turn = streamAgy(
        config,
        'sys',
        [{ role: 'user', text: 'First chat request' }],
        sampleTools,
        1024,
        {
          sessionId: 'chat-first',
          sessionScope: 'scope-1',
          signal: new AbortController().signal,
          onDelta: vi.fn(),
          onToolCall: vi.fn(),
        },
        mock.deps,
      )

      // No new child spawned
      expect(mock.children.length).toBe(1)
      await vi.waitFor(() => expect(prewarmedChild.stdinText).toContain('First chat request'))

      prewarmedChild.emitLines([
        JSON.stringify({
          event: 'result',
          result: {
            status: 'SUCCESS',
            structured_output: { text: 'Welcome', tool_calls: [] },
          },
        }),
      ])
      await turn

      shutdownAgyResidentServers(mock.deps)
    })

    it('T17: a resident chat turn with no stored model uses the High chat default', async () => {
      const mock = createMockDeps()
      shutdownAgyResidentServers(mock.deps)

      // an unreachable CLI path keeps the catalog probe from touching the real machine
      const config = { apiKey: '', model: '', cliPath: '/nonexistent/agy' }
      const modelOf = (args: string[]) => args[args.indexOf('--model') + 1]
      await prewarmAgy(config, mock.deps)
      expect(modelOf(mock.spawned[0]!.args)).toBe('gemini-3.8-flash-high')

      const child = mock.children[0]!
      const turn = streamAgy(
        config,
        'sys',
        [{ role: 'user', text: 'Hello' }],
        sampleTools,
        1024,
        {
          sessionId: 'chat-default-model',
          sessionScope: 'scope-default',
          signal: new AbortController().signal,
          onDelta: vi.fn(),
          onToolCall: vi.fn(),
        },
        mock.deps,
      )
      // the prewarmed worker is reused, and it was warmed for the same model
      expect(mock.children.length).toBe(1)
      child.emitLines([
        JSON.stringify({
          event: 'result',
          result: { status: 'SUCCESS', structured_output: { text: 'ok', tool_calls: [] } },
        }),
      ])
      await turn
      shutdownAgyResidentServers(mock.deps)
    })

    it('T40: a resident turn sends a stored High even when this CLI only reported Low', async () => {
      const mock = createMockDeps()
      shutdownAgyResidentServers(mock.deps)
      clearAgyChatDefaults()
      recordAgyChatDefault('/nonexistent/agy', { models: ['gemini-3.8-flash-low'] }, 0)
      const modelOf = (args: string[]) => args[args.indexOf('--model') + 1]
      await prewarmAgy(
        { apiKey: '', model: 'gemini-3.8-flash-high', cliPath: '/nonexistent/agy' },
        mock.deps,
      )
      expect(modelOf(mock.spawned[0]!.args)).toBe('gemini-3.8-flash-high')
      clearAgyChatDefaults()
      shutdownAgyResidentServers(mock.deps)
    })

    it('T18: switching models never reuses a worker warmed for another model', async () => {
      const mock = createMockDeps()
      shutdownAgyResidentServers(mock.deps)

      await prewarmAgy({ apiKey: '', model: '', cliPath: '/nonexistent/agy' }, mock.deps)
      const modelOf = (args: string[]) => args[args.indexOf('--model') + 1]
      expect(modelOf(mock.spawned[0]!.args)).toBe('gemini-3.8-flash-high')

      const turn = streamAgy(
        { apiKey: '', model: 'gemini-3.1-pro-high', cliPath: '/nonexistent/agy' },
        'sys',
        [{ role: 'user', text: 'Pro turn' }],
        sampleTools,
        1024,
        {
          sessionId: 'chat-pro',
          sessionScope: 'scope-pro',
          signal: new AbortController().signal,
          onDelta: vi.fn(),
          onToolCall: vi.fn(),
        },
        mock.deps,
      )
      await vi.waitFor(() => expect(mock.spawned.length).toBe(2))
      expect(modelOf(mock.spawned[1]!.args)).toBe('gemini-3.1-pro-high')
      const proChild = mock.children[1]!
      proChild.emitLines([
        JSON.stringify({
          event: 'result',
          result: { status: 'SUCCESS', structured_output: { text: 'pro', tool_calls: [] } },
        }),
      ])
      await turn
      shutdownAgyResidentServers(mock.deps)
    })

    it('retires worker on turn timeout and removes staging directory', async () => {
      vi.useFakeTimers()
      try {
        const mock = createMockDeps()
        shutdownAgyResidentServers(mock.deps)

        const config = { apiKey: '', model: 'gemini-3.8-flash-low', cliPath: '/usr/local/bin/agy' }

        const turnPromise = streamAgy(
          config,
          'sys',
          [{ role: 'user', text: 'Hanging turn' }],
          sampleTools,
          1024,
          {
            sessionId: 'chat-timeout',
            sessionScope: 'scope-1',
            signal: new AbortController().signal,
            onDelta: vi.fn(),
            onToolCall: vi.fn(),
          },
          mock.deps,
        )

        await vi.advanceTimersByTimeAsync(10)
        expect(mock.children.length).toBe(1)
        const child = mock.children[0]!

        // Attach the rejection handler before the timer rejects the turn.
        const timedOut = expect(turnPromise).rejects.toThrow(/timed out/i)
        // Fast-forward past turn timeout
        await vi.advanceTimersByTimeAsync(AGY_RESIDENT_TURN_TIMEOUT_MS + 1000)

        await timedOut
        expect(child.killed).toBe(true)
        expect(mock.removedDirs.length).toBeGreaterThanOrEqual(1)

        shutdownAgyResidentServers(mock.deps)
      } finally {
        vi.useRealTimers()
      }
    })

    it('handles late trailing stdout chunks after turn settlement without error or listener leakage', async () => {
      const mock = createMockDeps()
      shutdownAgyResidentServers(mock.deps)

      const config = { apiKey: '', model: 'gemini-3.8-flash-low', cliPath: '/usr/local/bin/agy' }

      const turn = streamAgy(
        config,
        'sys',
        [{ role: 'user', text: 'Normal turn' }],
        sampleTools,
        1024,
        {
          sessionId: 'chat-late-stdout',
          sessionScope: 'scope-1',
          signal: new AbortController().signal,
          onDelta: vi.fn(),
          onToolCall: vi.fn(),
        },
        mock.deps,
      )

      await vi.waitFor(() => expect(mock.children.length).toBe(1))
      const child = mock.children[0]!

      // Emit normal result
      child.emitLines([
        JSON.stringify({
          event: 'result',
          result: {
            status: 'SUCCESS',
            structured_output: { text: 'Done', tool_calls: [] },
          },
        }),
      ])
      await turn

      // Now emit late trailing stdout noise after turn is already settled
      expect(() => {
        child.emitLines(['{"event":"step_update","step_update":{"late":true}}', 'trailing text'])
      }).not.toThrow()

      shutdownAgyResidentServers(mock.deps)
    })

    it('evicts oldest idle worker when pool reaches AGY_MAX_RESIDENT_WORKERS capacity', async () => {
      const mock = createMockDeps()
      shutdownAgyResidentServers(mock.deps)

      const config = { apiKey: '', model: 'gemini-3.8-flash-low', cliPath: '/usr/local/bin/agy' }

      // Session 1
      const turn1 = streamAgy(
        config,
        'sys',
        [{ role: 'user', text: 'Chat 1' }],
        sampleTools,
        1024,
        {
          sessionId: 'chat-1',
          sessionScope: 'scope-1',
          signal: new AbortController().signal,
          onDelta: vi.fn(),
          onToolCall: vi.fn(),
        },
        mock.deps,
      )
      await vi.waitFor(() => expect(mock.children.length).toBe(1))
      mock.children[0]!.emitLines([
        JSON.stringify({
          event: 'result',
          result: { status: 'SUCCESS', structured_output: { text: 'R1', tool_calls: [] } },
        }),
      ])
      await turn1

      // Session 2
      const turn2 = streamAgy(
        config,
        'sys',
        [{ role: 'user', text: 'Chat 2' }],
        sampleTools,
        1024,
        {
          sessionId: 'chat-2',
          sessionScope: 'scope-1',
          signal: new AbortController().signal,
          onDelta: vi.fn(),
          onToolCall: vi.fn(),
        },
        mock.deps,
      )
      await vi.waitFor(() => expect(mock.children.length).toBe(2))
      mock.children[1]!.emitLines([
        JSON.stringify({
          event: 'result',
          result: { status: 'SUCCESS', structured_output: { text: 'R2', tool_calls: [] } },
        }),
      ])
      await turn2

      expect(mock.children[0]!.killed).toBe(false)
      expect(mock.children[1]!.killed).toBe(false)

      // Session 3: Pool capacity is 2. Must evict oldest idle worker (worker 0)
      const turn3 = streamAgy(
        config,
        'sys',
        [{ role: 'user', text: 'Chat 3' }],
        sampleTools,
        1024,
        {
          sessionId: 'chat-3',
          sessionScope: 'scope-1',
          signal: new AbortController().signal,
          onDelta: vi.fn(),
          onToolCall: vi.fn(),
        },
        mock.deps,
      )
      await vi.waitFor(() => expect(mock.children.length).toBe(3))
      // Worker 0 should be evicted and killed
      expect(mock.children[0]!.killed).toBe(true)

      mock.children[2]!.emitLines([
        JSON.stringify({
          event: 'result',
          result: { status: 'SUCCESS', structured_output: { text: 'R3', tool_calls: [] } },
        }),
      ])
      await turn3

      shutdownAgyResidentServers(mock.deps)
    })

    it('retires idle worker and cleans up after idle TTL expiration', async () => {
      vi.useFakeTimers()
      try {
        const mock = createMockDeps()
        shutdownAgyResidentServers(mock.deps)

        const config = { apiKey: '', model: 'gemini-3.8-flash-low', cliPath: '/usr/local/bin/agy' }

        const turn = streamAgy(
          config,
          'sys',
          [{ role: 'user', text: 'Chat TTL' }],
          sampleTools,
          1024,
          {
            sessionId: 'chat-ttl',
            sessionScope: 'scope-1',
            signal: new AbortController().signal,
            onDelta: vi.fn(),
            onToolCall: vi.fn(),
          },
          mock.deps,
        )
        await vi.advanceTimersByTimeAsync(10)
        expect(mock.children.length).toBe(1)
        const child = mock.children[0]!

        child.emitLines([
          JSON.stringify({
            event: 'result',
            result: { status: 'SUCCESS', structured_output: { text: 'TTL Reply', tool_calls: [] } },
          }),
        ])
        await turn

        expect(child.killed).toBe(false)

        // Advance past idle TTL (120s)
        await vi.advanceTimersByTimeAsync(AGY_RESIDENT_IDLE_TTL_MS + 1000)

        // Child process should be killed on idle timeout
        expect(child.killed).toBe(true)
        expect(mock.removedDirs.length).toBeGreaterThanOrEqual(1)

        shutdownAgyResidentServers(mock.deps)
      } finally {
        vi.useRealTimers()
      }
    })

    it('serializes concurrent async worker allocations and strictly caps total workers at 2', async () => {
      const mock = createMockDeps()
      shutdownAgyResidentServers(mock.deps)

      // Add delay to makeStagingDir to expose any race in spawnWorker
      const origMakeStagingDir = mock.deps.makeStagingDir
      mock.deps.makeStagingDir = async () => {
        await new Promise((r) => setTimeout(r, 20))
        return origMakeStagingDir()
      }

      const config = { apiKey: '', model: 'gemini-3.8-flash-low', cliPath: '/usr/local/bin/agy' }

      // Launch 3 concurrent turns with different models to try to force 3 spawns
      const p1 = streamAgy(
        config,
        'sys',
        [{ role: 'user', text: 'Turn 1' }],
        sampleTools,
        1024,
        {
          sessionId: 's1',
          sessionScope: 'scope-1',
          signal: new AbortController().signal,
          onDelta: vi.fn(),
          onToolCall: vi.fn(),
        },
        mock.deps,
      )

      const p2 = streamAgy(
        { ...config, model: 'gemini-3.8-flash-high' },
        'sys',
        [{ role: 'user', text: 'Turn 2' }],
        sampleTools,
        1024,
        {
          sessionId: 's2',
          sessionScope: 'scope-1',
          signal: new AbortController().signal,
          onDelta: vi.fn(),
          onToolCall: vi.fn(),
        },
        mock.deps,
      )

      const p3 = streamAgy(
        { ...config, model: 'gemini-3.8-pro' },
        'sys',
        [{ role: 'user', text: 'Turn 3' }],
        sampleTools,
        1024,
        {
          sessionId: 's3',
          sessionScope: 'scope-1',
          signal: new AbortController().signal,
          onDelta: vi.fn(),
          onToolCall: vi.fn(),
        },
        mock.deps,
      )

      // Even during concurrent asynchronous setup, children spawned must NEVER exceed AGY_MAX_RESIDENT_WORKERS (2)
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100))
        console.log(
          'children',
          mock.children.length,
          'spawned',
          mock.spawned.map((x) => x.args[x.args.indexOf('--model') + 1]),
        )
      }
      await vi.waitFor(() => expect(mock.children.length).toBe(2))
      expect(mock.children.length).toBeLessThanOrEqual(2)

      // Complete Turn 1
      mock.children[0]!.emitLines([
        JSON.stringify({
          event: 'result',
          result: { status: 'SUCCESS', structured_output: { text: 'Done 1', tool_calls: [] } },
        }),
      ])
      await p1

      // Complete Turn 2
      mock.children[1]!.emitLines([
        JSON.stringify({
          event: 'result',
          result: { status: 'SUCCESS', structured_output: { text: 'Done 2', tool_calls: [] } },
        }),
      ])
      await p2

      // Complete Turn 3
      await vi.waitFor(() => expect(mock.children.length).toBe(3))
      const lastChild = mock.children[2]!
      lastChild.emitLines([
        JSON.stringify({
          event: 'result',
          result: { status: 'SUCCESS', structured_output: { text: 'Done 3', tool_calls: [] } },
        }),
      ])
      await p3

      shutdownAgyResidentServers(mock.deps)
    })

    it('retires idle workers in a destroyed sender scope promptly while keeping other scopes active', async () => {
      const mock = createMockDeps()
      shutdownAgyResidentServers(mock.deps)

      const config = { apiKey: '', model: 'gemini-3.8-flash-low', cliPath: '/usr/local/bin/agy' }

      // Turn on scope 1
      const turn1 = streamAgy(
        config,
        'sys',
        [{ role: 'user', text: 'Scope 1 Turn' }],
        sampleTools,
        1024,
        {
          sessionId: 's1',
          sessionScope: 'scope-1',
          signal: new AbortController().signal,
          onDelta: vi.fn(),
          onToolCall: vi.fn(),
        },
        mock.deps,
      )

      await vi.waitFor(() => expect(mock.children.length).toBe(1))
      const child1 = mock.children[0]!
      child1.emitLines([
        JSON.stringify({
          event: 'result',
          result: { status: 'SUCCESS', structured_output: { text: 'Reply 1', tool_calls: [] } },
        }),
      ])
      await turn1

      // Turn on scope 2
      const turn2 = streamAgy(
        config,
        'sys',
        [{ role: 'user', text: 'Scope 2 Turn' }],
        sampleTools,
        1024,
        {
          sessionId: 's2',
          sessionScope: 'scope-2',
          signal: new AbortController().signal,
          onDelta: vi.fn(),
          onToolCall: vi.fn(),
        },
        mock.deps,
      )

      await vi.waitFor(() => expect(mock.children.length).toBe(2))
      const child2 = mock.children[1]!
      child2.emitLines([
        JSON.stringify({
          event: 'result',
          result: { status: 'SUCCESS', structured_output: { text: 'Reply 2', tool_calls: [] } },
        }),
      ])
      await turn2

      expect(child1.killed).toBe(false)
      expect(child2.killed).toBe(false)

      // Destroy scope 1
      retireAgyResidentScope('scope-1', mock.deps)

      expect(child1.killed).toBe(true)
      expect(child2.killed).toBe(false)

      shutdownAgyResidentServers(mock.deps)
    })
  })
})
