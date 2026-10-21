import { afterEach, describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AgentMessage, AgentToolDef } from '@genoffice/agent-core'
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
import { AGY_CHAT_DEFAULT_MODEL } from '../src/agy-chat'

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
    spawn: () => {
      const child = new FakeResidentChild(nextPid++)
      children.push(child)
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
          onToolCall: vi.fn(),
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
          toolCalls: [{ id: 'agy-call-0', name: 'create_document', input: { name: 'Doc1' } }],
        },
        {
          role: 'tool',
          results: [
            { id: 'agy-call-0', name: 'create_document', output: 'Document created: Doc1' },
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

    it('defaults prewarmed resident worker to AGY_CHAT_DEFAULT_MODEL when model is omitted', async () => {
      const mock = createMockDeps()
      shutdownAgyResidentServers(mock.deps)

      const configWithoutModel = { apiKey: '', cliPath: '/usr/local/bin/agy' }

      await prewarmAgy(configWithoutModel, mock.deps)
      expect(mock.children.length).toBe(1)
      const prewarmedChild = mock.children[0]!
      expect(prewarmedChild.stdinText).toBe('')

      // Subsequent session request with AGY_CHAT_DEFAULT_MODEL binds to prewarmed worker
      const turn = streamAgy(
        { ...configWithoutModel, model: AGY_CHAT_DEFAULT_MODEL },
        'sys',
        [{ role: 'user', text: 'Chat request with default high' }],
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

      // Binds to existing worker without spawning a new one
      expect(mock.children.length).toBe(1)
      await vi.waitFor(() => expect(prewarmedChild.stdinText).toContain('Chat request with default high'))

      prewarmedChild.emitLines([
        JSON.stringify({
          event: 'result',
          result: {
            status: 'SUCCESS',
            structured_output: { text: 'Welcome High', tool_calls: [] },
          },
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
