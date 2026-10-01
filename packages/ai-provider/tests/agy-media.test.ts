import { describe, expect, it, vi } from 'vitest'
import {
  AI_MEDIA_PROVIDERS,
  activeMediaConfig,
  activeMediaProvider,
  defaultAiMediaSettings,
  getMediaProviderMeta,
  imageGenerationAvailable,
  mediaAnalysisAvailable,
  mediaConfigUsable,
  providerHasCapability,
  resolveAiMediaSettings,
  videoAnalysisAvailable,
} from '../src/media'
import { defaultAiSettings, resolveAiSettings } from '../src/providers'
import type { AiSettings } from '../src/types'
import type { AgyRunOptions } from '../src/agy-cli'

vi.mock('../src/agy-cli', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agy-cli')>()),
  listAgyModels: vi.fn(),
}))

import { listAgyModels } from '../src/agy-cli'
import { analyzeMediaWithAgy, buildAgyMediaPlan, testAgyMediaProvider } from '../src/agy-media'
import { testMediaProvider } from '../src/media-protocols'

const withAgy = (): AiSettings => {
  const base = defaultAiSettings()
  return {
    ...base,
    media: {
      ...base.media!,
      imageProvider: 'agy',
      analysisProvider: 'agy',
      videoAnalysisProvider: 'agy',
    },
  }
}

describe('agy media provider registry', () => {
  it('is an opt-in CLI provider without a key that does image, analysis and video', () => {
    const meta = getMediaProviderMeta('agy')!
    expect(meta.keyPlaceholder).toBe('')
    expect(meta.needsBaseUrl).toBeUndefined()
    for (const cap of ['image', 'analysis', 'video'] as const) {
      expect(providerHasCapability(meta, cap)).toBe(true)
    }
    expect(meta.defaultImageModel).toBeTruthy()
    expect(AI_MEDIA_PROVIDERS.map((m) => m.id)).toContain('agy')
  })

  it('leaves default selections unchanged (gemini) and nothing active without a key', () => {
    const defaults = defaultAiMediaSettings()
    expect(defaults.imageProvider).toBe('gemini')
    expect(defaults.analysisProvider).toBe('gemini')
    expect(defaults.videoAnalysisProvider).toBe('gemini')
    expect(defaults.providers.agy).toMatchObject({ apiKey: '' })
    const settings = defaultAiSettings()
    expect(activeMediaProvider(settings, 'image')).toBe('genspark')
    expect(imageGenerationAvailable(settings, false)).toBe(false)
    expect(mediaAnalysisAvailable(settings, false)).toBe(false)
    expect(resolveAiSettings({}, defaultAiSettings()).media?.imageProvider).toBe('gemini')
  })

  it('treats agy as usable without an api key, other vendors unchanged', () => {
    const meta = getMediaProviderMeta('agy')!
    expect(mediaConfigUsable(meta, { apiKey: '', imageModel: '', analysisModel: '' })).toBe(true)
    expect(mediaConfigUsable(meta, undefined)).toBe(false)
    const gemini = getMediaProviderMeta('gemini')!
    expect(mediaConfigUsable(gemini, { apiKey: '', imageModel: '', analysisModel: '' })).toBe(false)
    expect(mediaConfigUsable(gemini, { apiKey: ' k ', imageModel: '', analysisModel: '' })).toBe(
      true,
    )
    const custom = getMediaProviderMeta('custom')!
    expect(mediaConfigUsable(custom, { apiKey: 'k', imageModel: '', analysisModel: '' })).toBe(
      false,
    )
  })

  it('selecting agy makes every capability available even when signed out of Genspark', () => {
    const settings = withAgy()
    expect(activeMediaProvider(settings, 'image')).toBe('agy')
    expect(activeMediaProvider(settings, 'analysis')).toBe('agy')
    expect(activeMediaProvider(settings, 'video')).toBe('agy')
    expect(imageGenerationAvailable(settings, false)).toBe(true)
    expect(mediaAnalysisAvailable(settings, false)).toBe(true)
    expect(videoAnalysisAvailable(settings, false)).toBe(true)
  })

  it('shares the chat provider path unless the media block overrides it', () => {
    const settings = withAgy()
    settings.providers.agy = { ...settings.providers.agy, cliPath: 'C:\\agy\\agy.exe' }
    expect(activeMediaConfig(settings, 'image')?.config.cliPath).toBe('C:\\agy\\agy.exe')
    settings.media!.providers.agy = {
      ...settings.media!.providers.agy,
      cliPath: 'D:\\own\\agy.exe',
    }
    expect(activeMediaConfig(settings, 'image')?.config.cliPath).toBe('D:\\own\\agy.exe')
    expect(activeMediaConfig(defaultAiSettings(), 'image')).toBeNull()
  })

  it('keeps a stored cliPath and trims it when resolving settings', () => {
    const base = defaultAiMediaSettings()
    const resolved = resolveAiMediaSettings({
      ...base,
      providers: { ...base.providers, agy: { ...base.providers.agy, cliPath: '  /opt/agy  ' } },
    })
    expect(resolved.providers.agy.cliPath).toBe('/opt/agy')
    expect(resolveAiMediaSettings(base).providers.agy.cliPath).toBeUndefined()
  })
})

describe('buildAgyMediaPlan', () => {
  const bytes = (n: number) => new Uint8Array(n)
  it('stages images, video and audio under safe names and names them in the prompt', () => {
    const plan = buildAgyMediaPlan({
      media: [
        { bytes: bytes(3), mime: 'image/png' },
        { bytes: bytes(3), mime: 'video/mp4' },
        { bytes: bytes(3), mime: 'audio/x-wav' },
        { bytes: bytes(3), mime: 'image/jpeg' },
      ],
      requirements: 'Describe everything',
    })
    expect(plan.files.map((f) => f.name)).toEqual([
      'image-1.png',
      'video-1.mp4',
      'audio-1.wav',
      'image-2.jpg',
    ])
    expect(plan.prompt).toContain('image-1.png, video-1.mp4')
    expect(plan.prompt).toContain('Describe everything')
    expect(plan.prompt).toContain('Do not run shell commands')
  })

  it('rejects unsupported types, oversize files, nothing and too many files', () => {
    const one = (mime: string, size = 3) => ({
      media: [{ bytes: bytes(size), mime }],
      requirements: 'x',
    })
    expect(() => buildAgyMediaPlan(one('application/pdf'))).toThrow(/images, video and audio only/)
    expect(() => buildAgyMediaPlan(one('image/png', 21 * 1024 * 1024))).toThrow(/20 MB/)
    expect(() => buildAgyMediaPlan({ media: [], requirements: 'x' })).toThrow()
    expect(() =>
      buildAgyMediaPlan({
        media: Array.from({ length: 13 }, () => ({ bytes: bytes(1), mime: 'image/png' })),
        requirements: 'x',
      }),
    ).toThrow(/at most/)
  })
})

describe('analyzeMediaWithAgy', () => {
  const config = { apiKey: '', imageModel: '', analysisModel: '', cliPath: 'C:\\agy.exe' }
  it('runs agy with the staged files and returns the text', async () => {
    let options: AgyRunOptions | undefined
    const text = await analyzeMediaWithAgy(
      config,
      { media: [{ bytes: new Uint8Array(2), mime: 'image/png' }], requirements: 'read it' },
      undefined,
      {
        run: async (o) => {
          options = o
          return { text: 'HOA DON 0042467' }
        },
      },
    )
    expect(text).toBe('HOA DON 0042467')
    expect(options?.cliPath).toBe('C:\\agy.exe')
    expect(options?.files?.[0]?.name).toBe('image-1.png')
    expect(options?.model).toBeTruthy()
  })

  it('fails clearly on an empty reply', async () => {
    await expect(
      analyzeMediaWithAgy(
        config,
        { media: [{ bytes: new Uint8Array(2), mime: 'image/png' }], requirements: 'x' },
        undefined,
        { run: async () => ({ text: '  ' }) },
      ),
    ).rejects.toThrow(/no content/)
  })
})

describe('connection test (agy models, no quota)', () => {
  const config = { apiKey: '', imageModel: '', analysisModel: '' }
  it('passes when models are listed and reports the CLI error otherwise', async () => {
    vi.mocked(listAgyModels).mockResolvedValueOnce({ models: ['a', 'b'], defaultModel: 'a' })
    expect(await testAgyMediaProvider(config)).toEqual({ ok: true })
    vi.mocked(listAgyModels).mockResolvedValueOnce({
      models: [],
      defaultModel: '',
      error: 'not found',
    })
    expect(await testAgyMediaProvider(config)).toEqual({ ok: false, error: 'not found' })
    vi.mocked(listAgyModels).mockResolvedValueOnce({ models: [], defaultModel: '' })
    expect((await testAgyMediaProvider(config)).ok).toBe(false)
  })

  it('is what testMediaProvider runs for agy', async () => {
    vi.mocked(listAgyModels).mockResolvedValueOnce({ models: ['a'], defaultModel: 'a' })
    expect(await testMediaProvider('agy', { ...config, cliPath: ' C:\\x\\agy.exe ' })).toEqual({
      ok: true,
    })
    expect(vi.mocked(listAgyModels).mock.calls.at(-1)?.[0]).toBe('C:\\x\\agy.exe')
  })
})
