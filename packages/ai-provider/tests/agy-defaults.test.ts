import { afterEach, describe, expect, it, vi } from 'vitest'
import { agyDefaultsUsable, onAgyUsableChange, setAgyUsable } from '../src/agy-default'
import {
  AGY_USABLE_FRESH_MS,
  agyUsableForDefaults,
  probeAgyUsable,
  type AgyDetectDeps,
} from '../src/agy-detect'
import {
  activeMediaConfig,
  activeMediaProvider,
  defaultAiMediaSettings,
  resolveAiMediaSettings,
} from '../src/media'
import { activeProvider, defaultAiSettings, resolveAiSettings } from '../src/providers'
import {
  activeSearchProvider,
  defaultAiSearchSettings,
  resolveAiSearchSettings,
} from '../src/search-settings'

afterEach(() => setAgyUsable(null))

describe('agy-first defaults', () => {
  it("keeps today's fallbacks while agy is not known to be usable", () => {
    const settings = defaultAiSettings()
    expect(settings.provider).toBe('gemini')
    expect(settings.media).toMatchObject({
      imageProvider: 'gemini',
      analysisProvider: 'gemini',
      videoAnalysisProvider: 'gemini',
    })
    expect(settings.search?.provider).toBe('parallel')
    setAgyUsable(false)
    expect(defaultAiSettings().provider).toBe('gemini')
  })

  it('starts every feature on agy once it is usable', () => {
    setAgyUsable(true)
    const settings = defaultAiSettings()
    expect(settings.provider).toBe('agy')
    expect(settings.media).toMatchObject({
      imageProvider: 'agy',
      analysisProvider: 'agy',
      videoAnalysisProvider: 'agy',
    })
    expect(settings.search?.provider).toBe('agy')
    // the selection is real, not just a label: the active resolvers honor it
    expect(activeProvider(settings)).toBe('agy')
    expect(activeSearchProvider(settings)).toBe('agy')
    for (const capability of ['image', 'analysis', 'video'] as const) {
      expect(activeMediaProvider(settings, capability)).toBe('agy')
      expect(activeMediaConfig(settings, capability)?.provider).toBe('agy')
    }
  })

  it('takes the usability as an explicit argument too (no module state needed)', () => {
    expect(defaultAiSettings(undefined, true).provider).toBe('agy')
    expect(defaultAiSettings(undefined, false).provider).toBe('gemini')
    expect(defaultAiMediaSettings(true).imageProvider).toBe('agy')
    expect(defaultAiSearchSettings(true).provider).toBe('agy')
    setAgyUsable(true)
    expect(defaultAiSettings(undefined, false).provider).toBe('gemini')
  })

  it('a fresh install (no stored settings) resolves to agy when usable, to the old defaults otherwise', () => {
    setAgyUsable(true)
    const fresh = resolveAiSettings(undefined, defaultAiSettings())
    expect(fresh.provider).toBe('agy')
    expect(fresh.media?.imageProvider).toBe('agy')
    expect(fresh.search?.provider).toBe('agy')
    setAgyUsable(false)
    const fallback = resolveAiSettings({}, defaultAiSettings())
    expect(fallback.provider).toBe('gemini')
    expect(fallback.media?.imageProvider).toBe('gemini')
    expect(fallback.search?.provider).toBe('parallel')
  })

  it('fills only what the stored file leaves open', () => {
    setAgyUsable(true)
    const resolved = resolveAiSettings(
      {
        provider: 'anthropic',
        providers: {} as never,
        media: { imageProvider: 'openai' } as never,
      },
      defaultAiSettings(),
    )
    expect(resolved.provider).toBe('anthropic')
    expect(resolved.media?.imageProvider).toBe('openai')
    // not stored: follows the agy default
    expect(resolved.media?.analysisProvider).toBe('agy')
    expect(resolved.search?.provider).toBe('agy')
  })

  it('never overrides valid user choices, whether or not agy is usable', () => {
    const stored = {
      provider: 'openai',
      providers: { openai: { apiKey: 'sk-test', model: 'gpt-5.5' } } as never,
      media: {
        imageProvider: 'openai',
        analysisProvider: 'gemini',
        videoAnalysisProvider: 'qwen',
        providers: { openai: { apiKey: 'sk-img', imageModel: 'gpt-image-2' } },
      } as never,
      search: { provider: 'serper', providers: { serper: { apiKey: 'serper-key' } } } as never,
    }
    for (const usable of [false, true]) {
      setAgyUsable(usable)
      const resolved = resolveAiSettings(stored, defaultAiSettings())
      expect(resolved.provider).toBe('openai')
      expect(resolved.providers.openai.apiKey).toBe('sk-test')
      expect(resolved.media).toMatchObject({
        imageProvider: 'openai',
        analysisProvider: 'gemini',
        videoAnalysisProvider: 'qwen',
      })
      expect(resolved.search?.provider).toBe('serper')
      expect(activeSearchProvider(resolved)).toBe('serper')
      expect(activeMediaProvider(resolved, 'image')).toBe('openai')
    }
  })

  it('keeps a stored Gemini or Parallel choice that happens to equal the old defaults', () => {
    setAgyUsable(true)
    const resolved = resolveAiSettings(
      {
        provider: 'gemini',
        providers: {} as never,
        media: { imageProvider: 'gemini', analysisProvider: 'gemini' } as never,
        search: { provider: 'parallel', providers: {} } as never,
      },
      defaultAiSettings(),
    )
    expect(resolved.provider).toBe('gemini')
    expect(resolved.media?.imageProvider).toBe('gemini')
    expect(resolved.search?.provider).toBe('parallel')
  })

  it('a stored genspark selection is normalised to the agy default (or the old fallback)', () => {
    const stored = {
      provider: 'genspark',
      providers: {} as never,
      media: {
        imageProvider: 'genspark',
        analysisProvider: 'genspark',
        videoAnalysisProvider: 'genspark',
      } as never,
      search: { provider: 'genspark', providers: {} } as never,
    }
    setAgyUsable(true)
    const viaAgy = resolveAiSettings(stored, defaultAiSettings())
    expect(viaAgy.provider).toBe('agy')
    expect(viaAgy.media).toMatchObject({
      imageProvider: 'agy',
      analysisProvider: 'agy',
      videoAnalysisProvider: 'agy',
    })
    expect(viaAgy.search?.provider).toBe('agy')
    setAgyUsable(false)
    const fallback = resolveAiSettings(stored, defaultAiSettings())
    expect(fallback.provider).toBe('gemini')
    expect(fallback.media?.imageProvider).toBe('gemini')
    expect(fallback.search?.provider).toBe('parallel')
  })

  it('the media and search resolvers follow the same module state', () => {
    setAgyUsable(true)
    expect(resolveAiMediaSettings(undefined).imageProvider).toBe('agy')
    expect(resolveAiSearchSettings(undefined).provider).toBe('agy')
  })

  it('never routes a default through Genspark', () => {
    for (const usable of [false, true]) {
      setAgyUsable(usable)
      const settings = resolveAiSettings(undefined, defaultAiSettings())
      expect(settings.gskToolsEnabled).toBe(false)
      expect(settings.provider).not.toBe('genspark')
      expect(settings.media?.imageProvider).not.toBe('genspark')
      expect(settings.media?.analysisProvider).not.toBe('genspark')
      expect(settings.media?.videoAnalysisProvider).not.toBe('genspark')
      expect(settings.search?.provider).not.toBe('genspark')
    }
  })
})

describe('agy usability detection', () => {
  const deps = (
    list: AgyDetectDeps['list'],
    now: () => number = () => 1_000,
  ): AgyDetectDeps & { list: ReturnType<typeof vi.fn> } => ({
    list: vi.fn(list),
    now,
  })

  it('is usable when `agy models` lists models', async () => {
    const d = deps(async () => ({ models: ['gemini-3.8-flash-low'] }))
    await expect(probeAgyUsable(undefined, d)).resolves.toBe(true)
    expect(agyDefaultsUsable()).toBe(true)
  })

  it.each([
    ['not installed / not signed in (error)', async () => ({ models: [], error: 'not found' })],
    ['empty model list', async () => ({ models: [] })],
    [
      'unexpected throw',
      async () => {
        throw new Error('boom')
      },
    ],
  ])('is not usable on %s', async (_name, list) => {
    setAgyUsable(true)
    await expect(probeAgyUsable(undefined, deps(list))).resolves.toBe(false)
    expect(agyDefaultsUsable()).toBe(false)
  })

  it('passes a configured CLI path through and joins concurrent probes', async () => {
    const d = deps(async () => ({ models: ['m'] }))
    await Promise.all([probeAgyUsable(' /opt/agy ', d), probeAgyUsable(' /opt/agy ', d)])
    expect(d.list).toHaveBeenCalledTimes(1)
    expect(d.list).toHaveBeenCalledWith('/opt/agy')
  })

  it('announces only real flips of the answer', async () => {
    const seen: boolean[] = []
    const off = onAgyUsableChange((usable) => seen.push(usable))
    setAgyUsable(false)
    setAgyUsable(false)
    setAgyUsable(true)
    setAgyUsable(true)
    setAgyUsable(false)
    off()
    setAgyUsable(true)
    expect(seen).toEqual([true, false])
  })

  it('serves a known answer at once and refreshes a stale one behind it', async () => {
    setAgyUsable(true, 0)
    const d = deps(
      async () => ({ models: [] }),
      () => AGY_USABLE_FRESH_MS + 1,
    )
    await expect(agyUsableForDefaults(undefined, d)).resolves.toBe(true)
    expect(d.list).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(agyDefaultsUsable()).toBe(false))

    setAgyUsable(true, 0)
    const fresh = deps(
      async () => ({ models: [] }),
      () => 10,
    )
    await expect(agyUsableForDefaults(undefined, fresh)).resolves.toBe(true)
    expect(fresh.list).not.toHaveBeenCalled()
  })

  it('waits for the first probe only briefly, then falls back without blocking', async () => {
    let release: (value: { models: string[] }) => void = () => undefined
    const slow = deps(() => new Promise((resolve) => (release = resolve)))
    const started = Date.now()
    await expect(agyUsableForDefaults(undefined, slow, 20)).resolves.toBe(false)
    expect(Date.now() - started).toBeLessThan(1_000)
    // the probe keeps going and lands for the next read
    release({ models: ['m'] })
    await vi.waitFor(() => expect(agyDefaultsUsable()).toBe(true))
  })

  it('answers the first read from the probe when it is quick', async () => {
    const quick = deps(async () => ({ models: ['m'] }))
    await expect(agyUsableForDefaults(undefined, quick, 1_000)).resolves.toBe(true)
  })
})
