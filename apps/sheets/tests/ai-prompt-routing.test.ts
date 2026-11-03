import { describe, expect, it, vi } from 'vitest'
import type { AiProviderConfig, AiProviderId, AiSettings } from '@genoffice/ai-provider/browser'
import { InMemoryWorkbookAdapter } from '@genoffice/xlsx-gateway/domain/in-memory-workbook'
import { initialSnapshot } from '../src/renderer/app-constants'
import {
  runDeterministicPlan as runDeterministicPlanImpl,
  type PlanContext,
} from '../src/renderer/plan-operations'
import { runSendFlow, type LocalPlanResult, type SendFlowDeps } from '../src/renderer/ai/send-flow'

function createMockPlanContext(): PlanContext {
  const adapter = new InMemoryWorkbookAdapter(initialSnapshot)
  return {
    adapterRef: { current: adapter },
    univerRef: { current: null },
    lazyWorkbookRef: { current: null },
    lazyPreviewRef: { current: null },
    setPreview: vi.fn(),
    autoApplySafePlan: vi.fn(async () => ({
      ok: true,
      changedCells: 0,
      changedFormats: 0,
      modifiedSheets: [],
    })),
  }
}

function settings(provider: AiProviderId, config?: Partial<AiProviderConfig>): AiSettings {
  return {
    provider,
    providers: {
      [provider]: {
        apiKey: config?.apiKey ?? 'test-api-key',
        model: config?.model ?? 'test-model',
        baseUrl: config?.baseUrl,
        cliPath: config?.cliPath,
      },
    } as never,
  }
}

const NO_KEY = { apiKey: '' }

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/**
 * The state the chat panel owns, as the real flow touches it: the composer text, the bubbles, the
 * run that was started. `consume` is what handleSend does to the user's message.
 */
function harness(
  instruction: string,
  options: {
    current?: AiSettings | null
    fresh?: AiSettings | null | Error
    canStartAgent?: boolean
    plan?: (text: string) => LocalPlanResult
  } = {},
) {
  const state = {
    composer: instruction,
    bubbles: [] as string[],
    replies: [] as Array<{ text: string; isError: boolean }>,
    started: [] as Array<{ instruction: string; sent: { skills: string[] } }>,
    adopted: [] as AiSettings[],
    blocked: [] as string[],
    logged: [] as string[],
    planCalls: 0,
  }
  const lock = { held: false }
  const base: Mutable<SendFlowDeps<{ skills: string[] }>> = {
    instruction,
    lock,
    currentSettings: () => options.current ?? null,
    getFreshSettings: async () => {
      if (options.fresh instanceof Error) throw options.fresh
      return options.fresh === undefined ? (options.current ?? null) : options.fresh
    },
    adoptSettings: (s) => state.adopted.push(s),
    canStartAgent: () => options.canStartAgent ?? true,
    consume: () => {
      state.bubbles.push(instruction)
      state.composer = ''
      return { skills: ['chip-1'] }
    },
    startAgent: (sent) => state.started.push({ instruction, sent }),
    runDeterministicPlan: (text) => {
      state.planCalls++
      return options.plan?.(text) ?? runDeterministicPlanImpl(createMockPlanContext(), text)
    },
    replyLocal: (_sent, result) =>
      state.replies.push({ text: result.text, isError: result.isError === true }),
    onBlocked: (reason) => state.blocked.push(reason),
    log: (message) => state.logged.push(message),
  }
  return { state, lock, deps: base }
}

describe('local planner (the fixed micro-DSL)', () => {
  it('flags natural language as unsupported without changing anything', () => {
    const result = runDeterministicPlanImpl(createMockPlanContext(), 'giải thích file này')
    expect(result.unsupported).toBe(true)
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Try “set A1 to 42”')
  })

  it('handles a fixed command', () => {
    const result = runDeterministicPlanImpl(createMockPlanContext(), 'set A1 to 42')
    expect(result.unsupported).toBeUndefined()
    expect(result.isError).toBeFalsy()
  })
})

describe('runSendFlow: a provider that can chat gets the message', () => {
  it('natural language with OpenAI configured goes to the agent, the planner is never asked', async () => {
    const h = harness('giải thích file này', { current: settings('openai') })
    const outcome = await runSendFlow(h.deps)
    expect(outcome).toEqual({ kind: 'agent' })
    expect(h.state.started).toHaveLength(1)
    expect(h.state.planCalls).toBe(0)
    expect(h.state.bubbles).toEqual(['giải thích file này'])
    expect(h.state.composer).toBe('')
    // the agent receives what consume() produced: skills, attachments and so on ride along
    expect(h.state.started[0]!.sent.skills).toEqual(['chip-1'])
  })

  it('DESIGN: a command like "set A1 to 42" also goes to the agent when a provider is ready', async () => {
    const h = harness('set A1 to 42', { current: settings('openai') })
    expect((await runSendFlow(h.deps)).kind).toBe('agent')
    expect(h.state.planCalls).toBe(0)
  })

  it('first send: nothing loaded yet, the fresh settings decide', async () => {
    const h = harness('hello', { current: null, fresh: settings('genspark' as AiProviderId) })
    expect((await runSendFlow(h.deps)).kind).toBe('agent')
  })

  it('stale current settings lose to the fresh ones, and the run adopts the fresh ones', async () => {
    const codex = settings('codex' as AiProviderId, { apiKey: '', model: '' })
    const h = harness('hello', { current: settings('openai', NO_KEY), fresh: codex })
    expect((await runSendFlow(h.deps)).kind).toBe('agent')
    expect(h.state.adopted).toEqual([codex])
  })

  it('AGY with no key, and Codex with no model, count as ready', async () => {
    for (const s of [
      settings('agy' as AiProviderId, { apiKey: '', model: 'gemini-3.8-flash-low' }),
      settings('codex' as AiProviderId, { apiKey: '', model: '' }),
    ]) {
      const h = harness('giải thích file này', { current: s })
      expect((await runSendFlow(h.deps)).kind).toBe('agent')
    }
  })

  it('runs on the same settings it decided on, never on an empty answer', async () => {
    const cached = settings('openai')
    const h = harness('hello', { current: cached, fresh: null })
    expect((await runSendFlow(h.deps)).kind).toBe('agent')
    expect(h.state.adopted).toEqual([cached])
  })

  it('a failing settings read falls back to the cached settings and says so in the log', async () => {
    const h = harness('hello', { current: settings('openai'), fresh: new Error('ipc down') })
    expect((await runSendFlow(h.deps)).kind).toBe('agent')
    expect(h.state.logged).toEqual(['could not read the AI settings'])
  })

  it('does not consume the message when a run cannot start right now', async () => {
    const h = harness('hello', { current: settings('openai'), canStartAgent: false })
    expect(await runSendFlow(h.deps)).toEqual({ kind: 'busy' })
    expect(h.state.bubbles).toEqual([])
    expect(h.state.composer).toBe('hello')
    expect(h.state.started).toEqual([])
    expect(h.lock.held).toBe(false)
  })
})

describe('runSendFlow: no provider that can chat', () => {
  it('a fixed command still runs locally and the message is consumed', async () => {
    const h = harness('set A1 to 42', { current: settings('gemini' as AiProviderId, NO_KEY) })
    expect(await runSendFlow(h.deps)).toEqual({ kind: 'local' })
    expect(h.state.bubbles).toEqual(['set A1 to 42'])
    expect(h.state.replies).toHaveLength(1)
    expect(h.state.replies[0]!.isError).toBe(false)
    expect(h.state.started).toEqual([])
  })

  it('natural language is blocked with the real reason, and nothing is consumed', async () => {
    const h = harness('giải thích file này', {
      current: settings('gemini' as AiProviderId, NO_KEY),
    })
    expect(await runSendFlow(h.deps)).toEqual({ kind: 'blocked', reason: 'not-configured' })
    expect(h.state.blocked).toEqual(['not-configured'])
    expect(h.state.composer).toBe('giải thích file này') // still there, so Send works after setup
    expect(h.state.bubbles).toEqual([])
    expect(h.state.replies).toEqual([]) // and the command-syntax hint is never shown as an answer
  })

  it('unreadable settings are reported as such, not as "not configured"', async () => {
    const h = harness('giải thích file này', { current: null, fresh: new Error('ipc down') })
    expect(await runSendFlow(h.deps)).toEqual({ kind: 'blocked', reason: 'settings-unreadable' })
    expect(h.state.logged).toEqual(['could not read the AI settings'])
    expect(h.state.composer).toBe('giải thích file này')
  })

  it('a read failure with settings already held that say "not configured" stays "not-configured"', async () => {
    const h = harness('giải thích file này', {
      current: settings('gemini' as AiProviderId, NO_KEY),
      fresh: new Error('ipc down'),
    })
    expect(await runSendFlow(h.deps)).toEqual({ kind: 'blocked', reason: 'not-configured' })
  })

  it('a command the planner understands but cannot apply is an answer, not "unsupported"', async () => {
    const h = harness('set A1 to 42', {
      current: null,
      fresh: null,
      plan: () => {
        throw new Error('sheet is protected')
      },
    })
    expect(await runSendFlow(h.deps)).toEqual({ kind: 'local' })
    expect(h.state.replies).toEqual([{ text: 'sheet is protected', isError: true }])
    expect(h.state.bubbles).toEqual(['set A1 to 42'])
  })
})

describe('runSendFlow: the send lock', () => {
  it('ignores a second send while the first is still reading settings', async () => {
    let release!: (s: AiSettings) => void
    const h = harness('first', { current: settings('openai') })
    h.deps.getFreshSettings = () => new Promise((resolve) => (release = resolve))
    const first = runSendFlow(h.deps)
    const second = await runSendFlow({ ...h.deps, instruction: 'second' })
    expect(second).toEqual({ kind: 'ignored' })
    release(settings('openai'))
    expect((await first).kind).toBe('agent')
    expect(h.state.started).toHaveLength(1)
    expect(h.lock.held).toBe(false)
  })

  it('releases the lock when a step throws, so the next send works', async () => {
    const h = harness('hello', { current: settings('openai') })
    const original = h.deps.consume
    h.deps.consume = () => {
      throw new Error('persist failed')
    }
    await expect(runSendFlow(h.deps)).rejects.toThrow('persist failed')
    expect(h.lock.held).toBe(false)
    h.deps.consume = original
    expect((await runSendFlow(h.deps)).kind).toBe('agent')
  })

  it('ignores an empty or whitespace-only message', async () => {
    for (const text of ['', '   ', '\n']) {
      const h = harness(text, { current: settings('openai') })
      expect(await runSendFlow(h.deps)).toEqual({ kind: 'ignored' })
      expect(h.state.started).toEqual([])
    }
  })
})
