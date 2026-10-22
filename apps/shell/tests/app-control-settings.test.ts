import { describe, expect, it, vi } from 'vitest'
import { defaultAiSettings } from '@genoffice/ai-provider'
import type { HomeApi } from '../src/shared/home-api'
import { runWhitelistedSetting } from '../src/renderer/src/app-control-settings'

function setup() {
  const settings = defaultAiSettings()
  settings.provider = 'openai'
  settings.providers.openai = {
    model: 'old-model',
    apiKey: 'private-key',
    baseUrl: 'https://private-endpoint',
    cliPath: 'private-path',
  }
  const api = {
    getTheme: vi.fn(async () => 'dark'),
    setTheme: vi.fn(async () => {}),
    getLanguage: vi.fn(async () => 'vi'),
    setLanguage: vi.fn(async () => {}),
    getAiSettings: vi.fn(async () => settings),
    setAiSettings: vi.fn(async () => {}),
    getAiProviders: vi.fn(() => [{ id: 'openai', models: ['old-model', 'configured-model'] }]),
  }
  const run = (input: unknown, signal = new AbortController().signal) =>
    runWhitelistedSetting(
      api as unknown as HomeApi,
      input as Parameters<typeof runWhitelistedSetting>[1],
      signal,
      vi.fn(),
    )
  return { api, settings, run }
}
describe('settings tool adapter', () => {
  it.each(['apiKey', 'cliPath', 'baseUrl', 'providers', 'defaultSaveDir'])(
    'rejects %s before touching any settings API',
    async (key) => {
      const { api, run } = setup()
      await expect(run({ kind: 'get_setting', key })).rejects.toThrow('whitelisted')
      await expect(run({ kind: 'set_setting', key, value: 'arbitrary' })).rejects.toThrow(
        'whitelisted',
      )
      expect(api.getAiSettings).not.toHaveBeenCalled()
      expect(api.setAiSettings).not.toHaveBeenCalled()
    },
  )
  it('reads only the model scalar and never returns the settings object', async () => {
    const { run } = setup()
    const result = await run({ kind: 'get_setting', key: 'default-model' })
    expect(result).toEqual({ status: 'completed', value: 'old-model' })
    expect(JSON.stringify(result)).not.toContain('private')
  })
  it('reuses model selection and preserves credentials, endpoint and paths', async () => {
    const { api, run } = setup()
    await run({ kind: 'set_setting', key: 'default-model', value: 'configured-model' })
    const saved = api.setAiSettings.mock.calls[0] as unknown as [
      ReturnType<typeof defaultAiSettings>,
    ]
    expect(saved[0].providers.openai).toEqual({
      model: 'configured-model',
      apiKey: 'private-key',
      baseUrl: 'https://private-endpoint',
      cliPath: 'private-path',
    })
  })
  it('rejects an arbitrary model without writing', async () => {
    const { api, run } = setup()
    await expect(
      run({ kind: 'set_setting', key: 'default-model', value: 'invented' }),
    ).rejects.toThrow('configured choice')
    expect(api.setAiSettings).not.toHaveBeenCalled()
  })
  it('refuses the generic write route for AGY', async () => {
    const { api, settings, run } = setup()
    settings.provider = 'agy'
    await expect(
      run({ kind: 'set_setting', key: 'default-model', value: 'invented' }),
    ).rejects.toThrow('validated model handler')
    expect(api.setAiSettings).not.toHaveBeenCalled()
  })
  it('AGY uses only the validated picker handler, with no CLI or generic settings write in this test', async () => {
    const { api, settings } = setup()
    settings.provider = 'agy'
    const select = vi.fn(async () => true)
    const input = {
      kind: 'set_setting' as const,
      key: 'default-model' as const,
      value: 'enabled-model',
    }
    expect(
      await runWhitelistedSetting(
        api as unknown as HomeApi,
        input,
        new AbortController().signal,
        vi.fn(),
        select,
      ),
    ).toEqual({ status: 'completed', value: 'enabled-model' })
    expect(select).toHaveBeenCalledExactlyOnceWith('enabled-model')
    expect(api.setAiSettings).not.toHaveBeenCalled()
    select.mockResolvedValue(false)
    await expect(
      runWhitelistedSetting(
        api as unknown as HomeApi,
        input,
        new AbortController().signal,
        vi.fn(),
        select,
      ),
    ).rejects.toThrow('refused')
  })
  it('uses existing language/theme setters and never loads AI credentials for them', async () => {
    const { api, run } = setup()
    expect(await run({ kind: 'set_setting', key: 'theme', value: 'dark' })).toEqual({
      status: 'completed',
      value: 'dark',
    })
    expect(await run({ kind: 'set_setting', key: 'language', value: 'vi' })).toEqual({
      status: 'completed',
      value: 'vi',
    })
    expect(api.setTheme).toHaveBeenCalledWith('dark')
    expect(api.setLanguage).toHaveBeenCalledWith('vi')
    expect(api.getAiSettings).not.toHaveBeenCalled()
  })
  it('an aborted request never reads or writes', async () => {
    const { api, run } = setup()
    const controller = new AbortController()
    controller.abort()
    expect(
      await run({ kind: 'set_setting', key: 'theme', value: 'dark' }, controller.signal),
    ).toEqual({ status: 'cancelled' })
    expect(api.setTheme).not.toHaveBeenCalled()
  })
})
