import { describe, expect, it } from 'vitest'
import { defaultAiSettings, type AiSettings } from '../src'
import { decideSettingsWrite } from '../src/ai-settings-guard'

/**
 * `ai:set-settings` is the generic settings route every editor's renderer can call. Schema
 * checking bounds the shape of the payload; it cannot know whether the Antigravity CLI that is
 * configured right now can serve the chat model being asked for. These tests exercise the real
 * decision the main process makes before it writes ai-settings.json.
 */
const HIGH = 'gemini-3.8-flash-high'
const LOW = 'gemini-3.8-flash-low'
const PRO = 'gemini-3.1-pro-high'
const CLAUDE = 'claude-sonnet-4-6'

const ok = (models: string[]) => async () => ({ models })
const failed = async () => ({ models: [], error: 'agy models timed out' })

function agySettings(model: string): AiSettings {
  const settings = defaultAiSettings()
  settings.provider = 'agy'
  settings.providers.agy = { apiKey: '', cliPath: '/fixture/agy', model }
  return settings
}

describe('the generic settings route cannot authorize an Antigravity chat model (A1-A10)', () => {
  it('A1: a model missing from the current catalog is not stored', async () => {
    const decision = await decideSettingsWrite(
      agySettings(PRO),
      agySettings(HIGH),
      ok([HIGH, LOW]),
      [HIGH, LOW, PRO],
    )
    expect(decision.ok).toBe(false)
    expect(decision.reason).toBe('not-confirmed')
    expect(decision.settings?.providers.agy.model).toBe(HIGH)
  })

  it('A2: a model the person switched off is not stored', async () => {
    const decision = await decideSettingsWrite(
      agySettings(HIGH),
      agySettings(LOW),
      ok([HIGH, LOW]),
      [LOW],
    )
    expect(decision.ok).toBe(false)
    expect(decision.reason).toBe('not-enabled')
    expect(decision.settings?.providers.agy.model).toBe(LOW)
  })

  it('A3: after a catalog failure an unverified model is not stored', async () => {
    const decision = await decideSettingsWrite(agySettings(HIGH), agySettings(LOW), failed, [HIGH])
    expect(decision.ok).toBe(false)
    expect(decision.reason).toBe('unverified')
    expect(decision.settings?.providers.agy.model).toBe(LOW)
  })

  it('A4: an unrelated settings change keeps a saved, currently unverified model', async () => {
    const previous = agySettings(HIGH)
    const next = { ...previous, maxOutputTokens: 8192 }
    const decision = await decideSettingsWrite(next, previous, failed, undefined)
    expect(decision.ok).toBe(true)
    expect(decision.settings?.providers.agy.model).toBe(HIGH)
    expect(decision.settings?.maxOutputTokens).toBe(8192)
  })

  it('A5: a confirmed, switched-on model is accepted and persisted', async () => {
    const decision = await decideSettingsWrite(
      agySettings(HIGH),
      agySettings(LOW),
      ok([HIGH, LOW]),
      [HIGH, LOW],
    )
    expect(decision.ok).toBe(true)
    expect(decision.settings?.providers.agy.model).toBe(HIGH)
  })

  it('A6: a change between two non-Antigravity providers is untouched', async () => {
    const previous = agySettings(HIGH)
    previous.provider = 'openai'
    previous.providers.openai = { apiKey: 'sk-test', model: 'gpt-4.1-mini' }
    const decision = await decideSettingsWrite(previous, agySettings(HIGH), failed, undefined)
    expect(decision.ok).toBe(true)
    expect(decision.settings?.provider).toBe('openai')
    expect(decision.settings?.providers.openai).toEqual({
      apiKey: 'sk-test',
      model: 'gpt-4.1-mini',
    })
    expect(decision.settings?.providers.agy.model).toBe(HIGH)
  })

  it('A7: a payload with valid provider data but an invalid Antigravity model never mixes the two', async () => {
    const payload = {
      provider: 'gemini',
      providers: {
        gemini: { apiKey: 'gk', model: 'gemini-2.5-flash' },
        agy: { apiKey: '', cliPath: '/fixture/agy', model: PRO },
      },
      search: {
        provider: 'agy',
        providers: { agy: { apiKey: '', cliPath: '/search/agy', model: 'search-model' } },
      },
    }
    const decision = await decideSettingsWrite(payload, agySettings(HIGH), ok([HIGH, LOW]), [
      HIGH,
      LOW,
    ])
    expect(decision.ok).toBe(false)
    expect(decision.settings?.provider).toBe('gemini')
    expect(decision.settings?.providers.agy.model).toBe(HIGH)
    expect(decision.settings?.search?.providers.agy.model).toBe('search-model')
  })

  it('A8: a direct IPC-shaped payload is checked, not just a UI click', async () => {
    const decision = await decideSettingsWrite(
      {
        provider: 'agy',
        providers: { agy: { apiKey: '', cliPath: '/fixture/agy', model: 'made-up-model' } },
      },
      agySettings(LOW),
      ok([HIGH, LOW]),
      [HIGH, LOW],
    )
    expect(decision.ok).toBe(false)
    expect(decision.settings?.providers.agy.model).toBe(LOW)
  })

  it('A9: a refused model is reported to the caller as a failure', async () => {
    const decision = await decideSettingsWrite(agySettings(PRO), agySettings(HIGH), ok([HIGH]), [
      HIGH,
    ])
    expect(decision.ok).toBe(false)
    expect(typeof decision.reason).toBe('string')
  })

  it('A10: a rejected value never reaches the settings file', async () => {
    const decision = await decideSettingsWrite(
      agySettings(PRO),
      agySettings(HIGH),
      ok([HIGH, LOW]),
      [HIGH, LOW],
    )
    const persisted = JSON.parse(JSON.stringify(decision.settings ?? {})) as AiSettings
    expect(persisted.providers.agy.model).toBe(HIGH)
    // reading the persisted file back gives the same answer the guard returned
    const again = await decideSettingsWrite(persisted, persisted, ok([HIGH, LOW]), [HIGH, LOW])
    expect(again.ok).toBe(true)
  })

  it('A11: clearing the Antigravity model is allowed and does not fabricate one', async () => {
    const decision = await decideSettingsWrite(
      agySettings(''),
      agySettings(HIGH),
      failed,
      undefined,
    )
    expect(decision.ok).toBe(true)
    expect(decision.settings?.providers.agy.model).toBe('')
  })

  it('A12: an explicitly enabled non-Gemini model the CLI confirmed is accepted', async () => {
    const decision = await decideSettingsWrite(
      agySettings(CLAUDE),
      agySettings(HIGH),
      ok([CLAUDE, HIGH]),
      [CLAUDE],
    )
    expect(decision.ok).toBe(true)
    expect(decision.settings?.providers.agy.model).toBe(CLAUDE)
  })

  it('A13: a model the CLI lists is not enabled by the guard on its own', async () => {
    const decision = await decideSettingsWrite(
      agySettings(CLAUDE),
      agySettings(HIGH),
      ok([CLAUDE, HIGH]),
      undefined,
    )
    expect(decision.ok).toBe(false)
    expect(decision.reason).toBe('not-enabled')
  })

  it('A14: saving unrelated settings never spawns the catalog probe', async () => {
    let calls = 0
    const decision = await decideSettingsWrite(
      agySettings(HIGH),
      agySettings(HIGH),
      async () => {
        calls += 1
        return { models: [HIGH] }
      },
      undefined,
    )
    expect(decision.ok).toBe(true)
    expect(calls).toBe(0)
  })
})
