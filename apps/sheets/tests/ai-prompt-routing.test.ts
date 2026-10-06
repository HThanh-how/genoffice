import { describe, expect, it, vi } from 'vitest'
import type { AiProviderConfig, AiProviderId, AiSettings } from '@genoffice/ai-provider/browser'
import { InMemoryWorkbookAdapter } from '@genoffice/xlsx-gateway/domain/in-memory-workbook'
import { initialSnapshot } from '../src/renderer/app-constants'
import {
  runDeterministicPlan as runDeterministicPlanImpl,
  type PlanContext,
} from '../src/renderer/plan-operations'
import { routePrompt } from '../src/renderer/ai/prompt-routing'

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

function createTestSettings(
  provider: AiProviderId,
  config?: Partial<AiProviderConfig>,
): AiSettings {
  return {
    provider,
    providers: {
      [provider]: {
        apiKey: config?.apiKey ?? 'test-api-key',
        model: config?.model ?? 'test-model',
        baseUrl: config?.baseUrl,
        cliPath: config?.cliPath,
      },
    } as any,
  }
}

describe('AI Prompt Routing & Deterministic Planner', () => {
  describe('runDeterministicPlan return type', () => {
    it('returns unsupported=true when prompt is natural language', () => {
      const ctx = createMockPlanContext()
      const result = runDeterministicPlanImpl(ctx, 'giải thích file này')
      expect(result.unsupported).toBe(true)
      expect(result.isError).toBe(true)
      expect(result.text).toContain('Try “set A1 to 42”')
    })

    it('returns unsupported=undefined and succeeds for micro-DSL command', () => {
      const ctx = createMockPlanContext()
      const result = runDeterministicPlanImpl(ctx, 'set A1 to 42')
      expect(result.unsupported).toBeUndefined()
      expect(result.isError).toBeFalsy()
      expect(result.text).toBeTruthy()
    })
  })

  describe('routePrompt SPEC PART A test suite (AI-01 to AI-10)', () => {
    // AI-01: current settings OpenAI + natural language -> refresh -> Agent -> deterministic NOT called
    it('AI-01: current settings OpenAI + natural language -> refresh -> Agent -> deterministic NOT called', async () => {
      const currentSettings = createTestSettings('openai', {
        apiKey: 'sk-initial',
        model: 'gpt-4o',
      })
      const freshSettings = createTestSettings('openai', { apiKey: 'sk-fresh', model: 'gpt-4o' })
      const runAgent = vi.fn(async () => {})
      const runDeterministicPlan = vi.fn(() => ({ text: 'mock plan' }))
      const getFreshSettings = vi.fn(async () => freshSettings)

      const result = await routePrompt({
        instruction: 'giải thích file này',
        currentSettings,
        getFreshSettings,
        runAgent,
        runDeterministicPlan,
      })

      expect(getFreshSettings).toHaveBeenCalledTimes(1)
      expect(result.action).toBe('agent')
      expect(runAgent).toHaveBeenCalledTimes(1)
      expect(runAgent).toHaveBeenCalledWith('giải thích file này', [])
      expect(runDeterministicPlan).not.toHaveBeenCalled()
    })

    // AI-02: current settings null, fresh settings Genspark -> Agent
    it('AI-02: current settings null, fresh settings Genspark -> Agent', async () => {
      const freshSettings = createTestSettings('genspark', {
        apiKey: '',
        model: 'claude-3-5-sonnet',
      })
      const runAgent = vi.fn(async () => {})
      const runDeterministicPlan = vi.fn(() => ({ text: 'mock plan' }))
      const getFreshSettings = vi.fn(async () => freshSettings)

      const result = await routePrompt({
        instruction: 'giải thích file này',
        currentSettings: null,
        getFreshSettings,
        runAgent,
        runDeterministicPlan,
      })

      expect(getFreshSettings).toHaveBeenCalledTimes(1)
      expect(result.action).toBe('agent')
      expect(runAgent).toHaveBeenCalledTimes(1)
      expect(runAgent).toHaveBeenCalledWith('giải thích file này', [])
      expect(runDeterministicPlan).not.toHaveBeenCalled()
    })

    // AI-03: current settings stale OpenAI, fresh settings Codex -> Agent -> fresh settings wins
    it('AI-03: current settings stale OpenAI, fresh settings Codex -> Agent -> fresh settings wins', async () => {
      const staleSettings = createTestSettings('openai', { apiKey: 'sk-stale', model: 'gpt-4o' })
      const freshSettings = createTestSettings('codex', { apiKey: '', model: 'gpt-5-codex' })
      const runAgent = vi.fn(async () => {})
      const runDeterministicPlan = vi.fn(() => ({ text: 'mock plan' }))
      const getFreshSettings = vi.fn(async () => freshSettings)

      const result = await routePrompt({
        instruction: 'tổng hợp sheet này',
        currentSettings: staleSettings,
        getFreshSettings,
        runAgent,
        runDeterministicPlan,
      })

      expect(getFreshSettings).toHaveBeenCalledTimes(1)
      expect(result.action).toBe('agent')
      expect(runAgent).toHaveBeenCalledTimes(1)
      expect(runDeterministicPlan).not.toHaveBeenCalled()
    })

    // AI-04: Codex model="" apiKey="" -> Agent
    it('AI-04: Codex model="" apiKey="" -> Agent', async () => {
      const codexSettings = createTestSettings('codex', { apiKey: '', model: '' })
      const runAgent = vi.fn(async () => {})
      const runDeterministicPlan = vi.fn(() => ({ text: 'mock plan' }))
      const getFreshSettings = vi.fn(async () => codexSettings)

      const result = await routePrompt({
        instruction: 'phân tích dữ liệu',
        currentSettings: null,
        getFreshSettings,
        runAgent,
        runDeterministicPlan,
      })

      expect(result.action).toBe('agent')
      expect(runAgent).toHaveBeenCalledTimes(1)
      expect(runDeterministicPlan).not.toHaveBeenCalled()
    })

    // AI-05: FORK ONLY: AGY apiKey="" model=gemini-3.8-flash-low -> Agent
    it('AI-05: FORK ONLY: AGY apiKey="" model=gemini-3.8-flash-low -> Agent', async () => {
      const agySettings = createTestSettings('agy', {
        apiKey: '',
        model: 'gemini-3.8-flash-low',
      })
      const runAgent = vi.fn(async () => {})
      const runDeterministicPlan = vi.fn(() => ({ text: 'mock plan' }))
      const getFreshSettings = vi.fn(async () => agySettings)

      const result = await routePrompt({
        instruction: 'tính tổng doanh thu',
        currentSettings: agySettings,
        getFreshSettings,
        runAgent,
        runDeterministicPlan,
      })

      expect(result.action).toBe('agent')
      expect(runAgent).toHaveBeenCalledTimes(1)
      expect(runDeterministicPlan).not.toHaveBeenCalled()
    })

    // AI-06: API-key provider thiếu key + micro-DSL -> deterministic
    it('AI-06: API-key provider missing key + micro-DSL -> deterministic', async () => {
      const ctx = createMockPlanContext()
      const localSettings = createTestSettings('custom', {
        apiKey: '',
        model: 'llama3:latest',
        baseUrl: 'http://localhost:11434/v1',
      })
      const runAgent = vi.fn(async () => {})
      const runDeterministicPlan = vi.fn((instruction: string) =>
        runDeterministicPlanImpl(ctx, instruction),
      )
      const getFreshSettings = vi.fn(async () => localSettings)

      const result = await routePrompt({
        instruction: 'set A1 to 42',
        currentSettings: localSettings,
        getFreshSettings,
        runAgent,
        runDeterministicPlan,
      })

      expect(result.action).toBe('deterministic')
      expect(result.isError).toBeFalsy()
      expect(result.message).toBeTruthy()
      expect(runAgent).not.toHaveBeenCalled()
      expect(runDeterministicPlan).toHaveBeenCalledTimes(1)
    })

    // AI-07: no settings current, no settings fresh, "set A1 to 42" -> deterministic succeeds
    it('AI-07: no settings current, no settings fresh, "set A1 to 42" -> deterministic succeeds', async () => {
      const ctx = createMockPlanContext()
      const runAgent = vi.fn(async () => {})
      const runDeterministicPlan = vi.fn((instruction: string) =>
        runDeterministicPlanImpl(ctx, instruction),
      )
      const getFreshSettings = vi.fn(async () => null)

      const result = await routePrompt({
        instruction: 'set A1 to 42',
        currentSettings: null,
        getFreshSettings,
        runAgent,
        runDeterministicPlan,
      })

      expect(result.action).toBe('deterministic')
      expect(result.isError).toBeFalsy()
      expect(result.message).toBeTruthy()
      expect(runAgent).not.toHaveBeenCalled()
      expect(runDeterministicPlan).toHaveBeenCalledTimes(1)
    })

    // AI-08: no settings current/fresh, "giải thích file này" -> action=unconfigured -> NOT command syntax error
    it('AI-08: no settings current/fresh, "giải thích file này" -> action=unconfigured -> NOT command syntax error', async () => {
      const ctx = createMockPlanContext()
      const runAgent = vi.fn(async () => {})
      const runDeterministicPlan = vi.fn((instruction: string) =>
        runDeterministicPlanImpl(ctx, instruction),
      )
      const getFreshSettings = vi.fn(async () => null)

      const result = await routePrompt({
        instruction: 'giải thích file này',
        currentSettings: null,
        getFreshSettings,
        runAgent,
        runDeterministicPlan,
      })

      expect(result.action).toBe('unconfigured')
      expect(result.isError).toBe(true)
      expect(result.message).toBeUndefined()
      expect(runAgent).not.toHaveBeenCalled()
      expect(runDeterministicPlan).toHaveBeenCalledTimes(1)
    })

    // AI-09: getFreshSettings fails/falls back cached, cached valid -> Agent
    it('AI-09: getFreshSettings fails/falls back cached, cached valid -> Agent', async () => {
      const cachedSettings = createTestSettings('openai', { apiKey: 'sk-cached', model: 'gpt-4o' })
      // getFreshSettings returns null (or fails/falls back)
      const getFreshSettings = vi.fn(async () => null)
      const runAgent = vi.fn(async () => {})
      const runDeterministicPlan = vi.fn(() => ({ text: 'mock plan' }))

      const result = await routePrompt({
        instruction: 'giúp tôi vẽ biểu đồ',
        currentSettings: cachedSettings,
        getFreshSettings,
        runAgent,
        runDeterministicPlan,
      })

      expect(result.action).toBe('agent')
      expect(runAgent).toHaveBeenCalledTimes(1)
      expect(runDeterministicPlan).not.toHaveBeenCalled()
    })

    // AI-10: current provider A, fresh provider B, runAgent reads B through aiSettingsRef
    it('AI-10: current provider A, fresh provider B, runAgent reads B through aiSettingsRef', async () => {
      const settingsA = createTestSettings('openai', { apiKey: 'sk-a', model: 'gpt-4o' })
      const settingsB = createTestSettings('anthropic', {
        apiKey: 'sk-b',
        model: 'claude-3-5-sonnet',
      })
      const aiSettingsRef = { current: settingsA as AiSettings | null }

      const getFreshSettings = vi.fn(async () => {
        aiSettingsRef.current = settingsB
        return settingsB
      })
      let providerSeenByAgent = ''
      const runAgent = vi.fn(async () => {
        providerSeenByAgent = aiSettingsRef.current?.provider ?? ''
      })
      const runDeterministicPlan = vi.fn(() => ({ text: 'mock plan' }))

      const result = await routePrompt({
        instruction: 'phân tích doanh thu quý',
        currentSettings: aiSettingsRef.current,
        getFreshSettings,
        runAgent,
        runDeterministicPlan,
      })

      expect(result.action).toBe('agent')
      expect(providerSeenByAgent).toBe('anthropic')
      expect(runAgent).toHaveBeenCalledTimes(1)
      expect(runDeterministicPlan).not.toHaveBeenCalled()
    })

    // AI-11: Gemini empty key + micro-DSL ("set A1 to 42") -> deterministic
    it('AI-11: Gemini empty key + micro-DSL ("set A1 to 42") -> deterministic', async () => {
      const ctx = createMockPlanContext()
      const geminiSettings = createTestSettings('gemini', {
        apiKey: '',
        model: 'gemini-2.5-flash',
      })
      const runAgent = vi.fn(async () => {})
      const runDeterministicPlan = vi.fn((instruction: string) =>
        runDeterministicPlanImpl(ctx, instruction),
      )
      const getFreshSettings = vi.fn(async () => geminiSettings)

      const result = await routePrompt({
        instruction: 'set A1 to 42',
        currentSettings: geminiSettings,
        getFreshSettings,
        runAgent,
        runDeterministicPlan,
      })

      expect(result.action).toBe('deterministic')
      expect(result.isError).toBeFalsy()
      expect(result.message).toBeTruthy()
      expect(runAgent).not.toHaveBeenCalled()
      expect(runDeterministicPlan).toHaveBeenCalledTimes(1)
    })

    // AI-12: Gemini empty key + natural language ("giải thích file này") -> unconfigured
    it('AI-12: Gemini empty key + natural language ("giải thích file này") -> unconfigured', async () => {
      const ctx = createMockPlanContext()
      const geminiSettings = createTestSettings('gemini', {
        apiKey: '',
        model: 'gemini-2.5-flash',
      })
      const runAgent = vi.fn(async () => {})
      const runDeterministicPlan = vi.fn((instruction: string) =>
        runDeterministicPlanImpl(ctx, instruction),
      )
      const getFreshSettings = vi.fn(async () => geminiSettings)

      const result = await routePrompt({
        instruction: 'giải thích file này',
        currentSettings: geminiSettings,
        getFreshSettings,
        runAgent,
        runDeterministicPlan,
      })

      expect(result.action).toBe('unconfigured')
      expect(result.isError).toBe(true)
      expect(runAgent).not.toHaveBeenCalled()
      expect(runDeterministicPlan).toHaveBeenCalledTimes(1)
    })

    // AI-13: AGY empty key + natural language ("giải thích file này") -> Agent
    it('AI-13: AGY empty key + natural language ("giải thích file này") -> Agent', async () => {
      const agySettings = createTestSettings('agy', {
        apiKey: '',
        model: '',
      })
      const runAgent = vi.fn(async () => {})
      const runDeterministicPlan = vi.fn(() => ({ text: 'mock plan' }))
      const getFreshSettings = vi.fn(async () => agySettings)

      const result = await routePrompt({
        instruction: 'giải thích file này',
        currentSettings: agySettings,
        getFreshSettings,
        runAgent,
        runDeterministicPlan,
      })

      expect(result.action).toBe('agent')
      expect(runAgent).toHaveBeenCalledTimes(1)
      expect(runDeterministicPlan).not.toHaveBeenCalled()
    })

    // AI-14: Codex empty model -> Agent
    it('AI-14: Codex empty model -> Agent', async () => {
      const codexSettings = createTestSettings('codex', {
        apiKey: '',
        model: '',
      })
      const runAgent = vi.fn(async () => {})
      const runDeterministicPlan = vi.fn(() => ({ text: 'mock plan' }))
      const getFreshSettings = vi.fn(async () => codexSettings)

      const result = await routePrompt({
        instruction: 'giải thích file này',
        currentSettings: codexSettings,
        getFreshSettings,
        runAgent,
        runDeterministicPlan,
      })

      expect(result.action).toBe('agent')
      expect(runAgent).toHaveBeenCalledTimes(1)
      expect(runDeterministicPlan).not.toHaveBeenCalled()
    })
  })

  describe('Send-race guard (aiSendRoutingRef)', () => {
    it('blocks concurrent send while settings refresh is pending', async () => {
      let aiSendRouting = false
      const runStarting = false
      const aiBusy = false

      let resolveSettings: ((val: AiSettings) => void) | null = null
      const freshSettingsPromise = new Promise<AiSettings>((resolve) => {
        resolveSettings = resolve
      })

      const getFreshSettings = vi.fn(() => freshSettingsPromise)
      const runAgent = vi.fn(async () => {})
      const appendChat = vi.fn()

      async function simulatedHandleSend(instruction: string) {
        if (!instruction || aiBusy || runStarting || aiSendRouting) return
        aiSendRouting = true
        try {
          appendChat(instruction)
          const settings = await getFreshSettings()
          if (settings) {
            await runAgent()
          }
        } finally {
          aiSendRouting = false
        }
      }

      // First send starts and pauses at await getFreshSettings
      const send1 = simulatedHandleSend('lệnh thứ nhất')

      // Second send triggers immediately before getFreshSettings resolves
      const send2 = simulatedHandleSend('lệnh thứ hai trùng lặp')

      expect(aiSendRouting).toBe(true)
      expect(appendChat).toHaveBeenCalledTimes(1)
      expect(appendChat).toHaveBeenCalledWith('lệnh thứ nhất')

      // Resolve settings
      resolveSettings!(createTestSettings('openai', { apiKey: 'sk-test', model: 'gpt-4o' }))
      await Promise.all([send1, send2])

      expect(aiSendRouting).toBe(false)
      expect(runAgent).toHaveBeenCalledTimes(1)
      expect(appendChat).toHaveBeenCalledTimes(1)
    })
  })
})
