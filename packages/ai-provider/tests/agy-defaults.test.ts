import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agyChatDefaultModel,
  agyChatDefaultRecord,
  agyCliUsable,
  agyActiveCliKey,
  agyCliCheckedAt,
  agyDefaultsUsable,
  agyUsabilityCheckedAt,
  clearAgyChatDefaults,
  clearAgyCliUsability,
  onAgyUsableChange,
  recordAgyChatDefault,
  setAgyUsable,
} from '../src/agy-default'
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
import { AGY_OCR_DEFAULT_MODEL } from '../src/agy-ocr'
import { AGY_PROVIDER_META } from '../src/agy-meta'
import { activeProvider, defaultAiSettings, resolveAiSettings } from '../src/providers'
import {
  activeSearchProvider,
  defaultAiSearchSettings,
  resolveAiSearchSettings,
} from '../src/search-settings'

afterEach(() => {
  setAgyUsable(null)
  clearAgyCliUsability()
  clearAgyChatDefaults()
})

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

  it("a usability answer learned from one executable is not served as another's", async () => {
    // the answer that was learned came from the auto-detected CLI (no configured path)
    const auto = deps(async () => ({ models: ['m'] }))
    await probeAgyUsable(undefined, auto)
    expect(agyDefaultsUsable()).toBe(true)
    // the person now points Antigravity at a different executable: the global answer belongs to
    // the auto-detected one, so /cli/b has to be probed before it can count as usable
    const configured = deps(async () => ({ models: [] }))
    await expect(agyUsableForDefaults('/cli/b', configured)).resolves.toBe(false)
    expect(configured.list).toHaveBeenCalledTimes(1)
    expect(configured.list).toHaveBeenCalledWith('/cli/b')

    // and an answer recorded for /cli/a is likewise never reused for an unprobed /cli/c
    const a = deps(async () => ({ models: ['m'] }))
    await probeAgyUsable('/cli/a', a)
    expect(agyDefaultsUsable()).toBe(true)
    const c = deps(async () => ({ models: [] }))
    await expect(agyUsableForDefaults('/cli/c', c)).resolves.toBe(false)
    expect(c.list).toHaveBeenCalledWith('/cli/c')
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

describe('first-run chat model, scoped to the CLI that was configured', () => {
  it('T01: a CLI that reports High leaves chat on High', () => {
    recordAgyChatDefault('', { models: ['gemini-3.8-flash-low', 'gemini-3.8-flash-high'] }, 0)
    expect(agyChatDefaultModel('')).toBe('gemini-3.8-flash-high')
  })

  it('T08: a CLI without High seeds a model it really has', async () => {
    const deps: AgyDetectDeps = {
      list: async () => ({ models: ['gemini-3.1-pro-low', 'gemini-3.8-flash-medium'] }),
      now: () => 0,
    }
    await probeAgyUsable('/cli/a', deps)
    expect(agyChatDefaultRecord('/cli/a')).toEqual({ model: 'gemini-3.1-pro-low', verified: true })
  })

  it('T14: a model discovered for one CLI is never the default of another', () => {
    recordAgyChatDefault('/cli/a', { models: ['gemini-3.8-flash-high'] }, 0)
    recordAgyChatDefault('/cli/b', { models: ['gemini-3.1-pro-low'] }, 1)
    expect(agyChatDefaultRecord('/cli/a')?.model).toBe('gemini-3.8-flash-high')
    expect(agyChatDefaultRecord('/cli/b')?.model).toBe('gemini-3.1-pro-low')
    expect(agyChatDefaultRecord('/cli/removed')).toBeUndefined()
  })

  it('T15: an older probe finishing late cannot overwrite the newer configured path', async () => {
    let releaseOld: (value: { models: string[] }) => void = () => undefined
    const oldProbe = probeAgyUsable('/cli/old', {
      list: () => new Promise((resolve) => (releaseOld = resolve)),
      now: () => 5,
    })
    // the person switches to a different CLI while the first probe is still running
    await probeAgyUsable('/cli/new', {
      list: async () => ({ models: ['gemini-3.8-flash-high'] }),
      now: () => 1,
    })
    releaseOld({ models: ['gemini-3.1-pro-low'] })
    await oldProbe
    expect(agyChatDefaultRecord('/cli/new')?.model).toBe('gemini-3.8-flash-high')
    expect(agyChatDefaultRecord('/cli/old')?.model).toBe('gemini-3.1-pro-low')
  })

  it('T13: a later failure keeps the last answer but marks it unverified', () => {
    recordAgyChatDefault('/cli/a', { models: ['gemini-3.8-flash-high'] }, 0)
    recordAgyChatDefault('/cli/a', { models: [], error: 'agy not found' }, 1)
    expect(agyChatDefaultRecord('/cli/a')).toEqual({
      model: 'gemini-3.8-flash-high',
      verified: false,
    })
  })

  it('T39: a CLI with no Gemini is recorded as having no chat model, not as having High', () => {
    recordAgyChatDefault('/cli/c', { models: ['claude-sonnet-4-6', 'gpt-oss-120b-medium'] }, 0)
    expect(agyChatDefaultRecord('/cli/c')).toEqual({ model: null, verified: true })
    expect(agyChatDefaultModel('/cli/c')).toBeUndefined()
  })

  it('fresh settings store no Antigravity model, so a stored one is always a real choice', () => {
    setAgyUsable(true)
    const settings = defaultAiSettings()
    expect(settings.providers.agy.model).toBe('')
    expect(settings.provider).toBe('agy')
    // the picker still has something to offer for a provider nobody configured
    expect(AGY_PROVIDER_META.defaultModel).toBe('gemini-3.8-flash-high')
  })

  it('does not change search or OCR defaults', () => {
    setAgyUsable(true)
    const settings = defaultAiSettings()
    // retrieval work keeps its own empty model, which resolves to the Low task default
    expect(settings.search?.providers.agy.model).toBe('')
    expect(AGY_OCR_DEFAULT_MODEL).toBe('gemini-3.8-flash-low')
  })
})

describe('CLI usability is scoped to the configured CLI (U1-U12)', () => {
  const high = { models: ['gemini-3.8-flash-high'] }
  const broken = { models: [], error: 'agy not found' }

  it('U1: a probe that answers makes that CLI the effective usable one', async () => {
    const ok = await probeAgyUsable('/cli/a', { list: async () => high, now: () => 1 })
    expect(ok).toBe(true)
    expect(agyDefaultsUsable()).toBe(true)
    expect(agyCliUsable('/cli/a')).toBe(true)
    expect(agyActiveCliKey()).toBe('/cli/a')
  })

  it('U2: a probe that fails makes it the effective unusable one', async () => {
    const ok = await probeAgyUsable('/cli/a', { list: async () => broken, now: () => 1 })
    expect(ok).toBe(false)
    expect(agyDefaultsUsable()).toBe(false)
    expect(agyCliUsable('/cli/a')).toBe(false)
  })

  it('U3: an old failure finishing after a newer success cannot break the current CLI', async () => {
    let releaseOld: (value: { models: string[]; error?: string }) => void = () => undefined
    const old = probeAgyUsable('/cli/old', {
      list: () => new Promise((resolve) => (releaseOld = resolve)),
      now: () => 5,
    })
    await probeAgyUsable('/cli/new', { list: async () => high, now: () => 1 })
    expect(agyDefaultsUsable()).toBe(true)
    releaseOld(broken)
    await old
    expect(agyDefaultsUsable()).toBe(true)
    expect(agyActiveCliKey()).toBe('/cli/new')
    expect(agyCliUsable('/cli/old')).toBe(false)
    expect(agyCliUsable('/cli/new')).toBe(true)
  })

  it('U4: an old success finishing after a newer failure cannot hide a broken CLI', async () => {
    let releaseOld: (value: { models: string[]; error?: string }) => void = () => undefined
    const old = probeAgyUsable('/cli/old', {
      list: () => new Promise((resolve) => (releaseOld = resolve)),
      now: () => 5,
    })
    await probeAgyUsable('/cli/new', { list: async () => broken, now: () => 1 })
    expect(agyDefaultsUsable()).toBe(false)
    releaseOld(high)
    await old
    expect(agyDefaultsUsable()).toBe(false)
    expect(agyCliUsable('/cli/old')).toBe(true)
  })

  it('U5: two paths probing at the same time keep their own answers', async () => {
    const both = Promise.all([
      probeAgyUsable('/cli/a', { list: async () => high, now: () => 1 }),
      probeAgyUsable('/cli/b', { list: async () => broken, now: () => 2 }),
    ])
    const [a, b] = await both
    expect([a, b]).toEqual([true, false])
    // whichever probe started last is the configured one; the other is only known for its path
    expect(agyActiveCliKey()).toBe('/cli/b')
    expect(agyDefaultsUsable()).toBe(false)
    expect(agyCliUsable('/cli/a')).toBe(true)
  })

  it('U6: a second request for the same path joins the probe already running', async () => {
    let calls = 0
    const deps: AgyDetectDeps = {
      list: () => {
        calls += 1
        return new Promise((resolve) => setTimeout(() => resolve(high), 5))
      },
      now: () => 1,
    }
    const first = probeAgyUsable('/cli/a', deps)
    const second = probeAgyUsable('/cli/a', deps)
    expect(first).toBe(second)
    await first
    expect(calls).toBe(1)
  })

  it('U7: changing the CLI path during an in-flight probe makes the new path the active one', async () => {
    let releaseOld: (value: { models: string[]; error?: string }) => void = () => undefined
    const old = probeAgyUsable('/cli/old', {
      list: () => new Promise((resolve) => (releaseOld = resolve)),
      now: () => 9,
    })
    expect(agyActiveCliKey()).toBe('/cli/old')
    await probeAgyUsable('/cli/new', { list: async () => high, now: () => 3 })
    expect(agyActiveCliKey()).toBe('/cli/new')
    releaseOld(broken)
    await old
    expect(agyDefaultsUsable()).toBe(true)
    expect(agyUsabilityCheckedAt()).toBe(3)
  })

  it('U8: an outdated answer cannot change what the defaults use', async () => {
    let releaseOld: (value: { models: string[]; error?: string }) => void = () => undefined
    const old = probeAgyUsable('/cli/old', {
      list: () => new Promise((resolve) => (releaseOld = resolve)),
      now: () => 9,
    })
    await agyUsableForDefaults('/cli/new', { list: async () => high, now: () => 3 })
    releaseOld(broken)
    await old
    expect(await agyUsableForDefaults('/cli/new', { list: async () => high, now: () => 4 })).toBe(
      true,
    )
    expect(agyDefaultsUsable()).toBe(true)
  })

  it('U9: a later refresh of the current CLI updates its usability honestly', async () => {
    await probeAgyUsable('/cli/a', { list: async () => high, now: () => 1 })
    expect(agyDefaultsUsable()).toBe(true)
    await probeAgyUsable('/cli/a', { list: async () => broken, now: () => 2 })
    expect(agyDefaultsUsable()).toBe(false)
    expect(agyUsabilityCheckedAt()).toBe(2)
    await probeAgyUsable('/cli/a', { list: async () => high, now: () => 3 })
    expect(agyDefaultsUsable()).toBe(true)
  })

  it('U10: a failed probe keeps the model that was learned for that CLI, marked unverified', async () => {
    await probeAgyUsable('/cli/a', { list: async () => high, now: () => 1 })
    await probeAgyUsable('/cli/a', { list: async () => broken, now: () => 2 })
    expect(agyChatDefaultRecord('/cli/a')).toEqual({
      model: 'gemini-3.8-flash-high',
      verified: false,
    })
    expect(agyChatDefaultModel('/cli/a')).toBe('gemini-3.8-flash-high')
  })

  it('U11: a successful catalog refresh records the model under the right CLI identity', async () => {
    await probeAgyUsable('/cli/a', {
      list: async () => ({ models: ['gemini-3.1-pro-low'] }),
      now: () => 1,
    })
    await probeAgyUsable('/cli/b', { list: async () => high, now: () => 2 })
    expect(agyChatDefaultRecord('/cli/a')).toEqual({ model: 'gemini-3.1-pro-low', verified: true })
    expect(agyChatDefaultRecord('/cli/b')).toEqual({
      model: 'gemini-3.8-flash-high',
      verified: true,
    })
  })

  it('U12: a first run uses the currently configured CLI, not a previous executable', async () => {
    await probeAgyUsable('/cli/old', {
      list: async () => ({ models: ['gemini-3.1-pro-low'] }),
      now: () => 1,
    })
    await probeAgyUsable('/cli/new', { list: async () => ({ models: [] }), now: () => 2 })
    setAgyUsable(true)
    const settings = defaultAiSettings()
    expect(settings.provider).toBe('agy')
    expect(settings.providers.agy.model).toBe('')
    expect(agyChatDefaultModel('/cli/new')).toBeUndefined()
    expect(agyChatDefaultModel('/cli/old')).toBe('gemini-3.1-pro-low')
  })
})

describe('CLI usability is scoped to the configured path (D1-D16)', () => {
  const ok = { models: ['gemini-3.8-flash-high'] }
  const bad = { models: [], error: 'not installed' }

  it('D1/D2: each path keeps its own answer', async () => {
    expect(await probeAgyUsable('/cli/a', { list: async () => ok, now: () => 1 })).toBe(true)
    expect(await probeAgyUsable('/cli/b', { list: async () => bad, now: () => 2 })).toBe(false)
    expect(agyCliUsable('/cli/a')).toBe(true)
    expect(agyCliUsable('/cli/b')).toBe(false)
    // each answer carries the time it was read, so a stale one can be recognised
    expect(agyCliCheckedAt('/cli/a')).toBe(1)
    expect(agyCliCheckedAt('/cli/b')).toBe(2)
    expect(agyCliCheckedAt('/cli/never-probed')).toBe(0)
  })

  it('D6: A -> B -> A while A is still probing makes A the active CLI again', async () => {
    let releaseA: (value: { models: string[]; error?: string }) => void = () => undefined
    const a = probeAgyUsable('/cli/a', {
      list: () => new Promise((resolve) => (releaseA = resolve)),
      now: () => 5,
    })
    await probeAgyUsable('/cli/b', { list: async () => ok, now: () => 2 })
    expect(agyActiveCliKey()).toBe('/cli/b')
    // the user switches back to A while A's probe is still running: the request joins that probe
    // instead of launching the CLI a second time
    let relaunches = 0
    const again = probeAgyUsable('/cli/a', {
      list: () => {
        relaunches += 1
        return Promise.resolve(ok)
      },
      now: () => 3,
    })
    expect(again).toBe(a)
    expect(relaunches).toBe(0)
    expect(agyActiveCliKey()).toBe('/cli/a')
    releaseA(bad)
    await a
    expect(agyDefaultsUsable()).toBe(false)
    expect(agyCliUsable('/cli/b')).toBe(true)
  })

  it("D8: a fresh answer for one CLI is not served as another CLI's verified usability", async () => {
    await probeAgyUsable('/cli/a', { list: async () => ok, now: () => 1 })
    expect(await agyUsableForDefaults('/cli/b', { list: async () => bad, now: () => 2 })).toBe(
      false,
    )
    expect(agyCliUsable('/cli/b')).toBe(false)
  })

  it('D9/D16: concurrent requests for one path share a single probe', async () => {
    let calls = 0
    const d: AgyDetectDeps = {
      list: () => {
        calls += 1
        return Promise.resolve(ok)
      },
      now: () => 1,
    }
    await Promise.all([probeAgyUsable('/cli/a', d), probeAgyUsable('/cli/a', d)])
    expect(calls).toBe(1)
  })

  it('D3: two CLIs probed at the same time answer for themselves only', async () => {
    let releaseA: (value: { models: string[]; error?: string }) => void = () => undefined
    let releaseB: (value: { models: string[]; error?: string }) => void = () => undefined
    const a = probeAgyUsable('/cli/a', {
      list: () => new Promise((resolve) => (releaseA = resolve)),
      now: () => 1,
    })
    const b = probeAgyUsable('/cli/b', {
      list: () => new Promise((resolve) => (releaseB = resolve)),
      now: () => 2,
    })
    releaseB(bad)
    releaseA(ok)
    await Promise.all([a, b])
    expect(agyCliUsable('/cli/a')).toBe(true)
    expect(agyCliUsable('/cli/b')).toBe(false)
    // B was the last configured path, so its answer is the effective one
    expect(agyActiveCliKey()).toBe('/cli/b')
    expect(agyDefaultsUsable()).toBe(false)
  })

  it('D5: an old CLI answering successfully after the new one failed does not make it usable', async () => {
    let releaseOld: (value: { models: string[]; error?: string }) => void = () => undefined
    const old = probeAgyUsable('/cli/old', {
      list: () => new Promise((resolve) => (releaseOld = resolve)),
      now: () => 9,
    })
    await probeAgyUsable('/cli/new', { list: async () => bad, now: () => 2 })
    expect(agyDefaultsUsable()).toBe(false)
    releaseOld(ok)
    await old
    expect(agyDefaultsUsable()).toBe(false)
    expect(agyCliUsable('/cli/old')).toBe(true)
    expect(agyCliUsable('/cli/new')).toBe(false)
  })

  it('D7: B -> A -> B while B is still probing makes B the active CLI again', async () => {
    let relaunches = 0
    let releaseB: (value: { models: string[]; error?: string }) => void = () => undefined
    const b = probeAgyUsable('/cli/b', {
      list: () => new Promise((resolve) => (releaseB = resolve)),
      now: () => 7,
    })
    await probeAgyUsable('/cli/a', { list: async () => bad, now: () => 1 })
    expect(agyActiveCliKey()).toBe('/cli/a')
    expect(agyDefaultsUsable()).toBe(false)
    const again = probeAgyUsable('/cli/b', {
      list: () => {
        relaunches += 1
        return Promise.resolve(ok)
      },
      now: () => 3,
    })
    expect(again).toBe(b)
    expect(relaunches).toBe(0)
    expect(agyActiveCliKey()).toBe('/cli/b')
    releaseB(ok)
    await b
    expect(agyDefaultsUsable()).toBe(true)
    expect(agyCliUsable('/cli/a')).toBe(false)
  })

  it('D10/D11: only the configured path can move the effective answer', async () => {
    let releaseStale: (value: { models: string[]; error?: string }) => void = () => undefined
    const stale = probeAgyUsable('/cli/stale', {
      list: () => new Promise((resolve) => (releaseStale = resolve)),
      now: () => 1,
    })
    await probeAgyUsable('/cli/a', { list: async () => ok, now: () => 2 })
    expect(agyDefaultsUsable()).toBe(true)
    // the probe started for a path that has since been replaced answers late: it is kept for that
    // path, but it cannot change what the defaults use
    releaseStale(bad)
    await stale
    expect(agyDefaultsUsable()).toBe(true)
    expect(agyCliUsable('/cli/stale')).toBe(false)
    // a legitimate refresh of the configured path does
    await probeAgyUsable('/cli/a', { list: async () => bad, now: () => 3 })
    expect(agyDefaultsUsable()).toBe(false)
    expect(agyUsabilityCheckedAt()).toBe(3)
  })

  it('D12: the auto-detected CLI (no configured path) is scoped like any other', async () => {
    await probeAgyUsable(undefined, { list: async () => ok, now: () => 1 })
    expect(agyActiveCliKey()).toBe('')
    expect(agyCliUsable()).toBe(true)
    expect(agyCliUsable(undefined)).toBe(true)
    await probeAgyUsable('/cli/other', { list: async () => bad, now: () => 2 })
    expect(agyCliUsable()).toBe(true)
    expect(agyCliUsable('/cli/other')).toBe(false)
    expect(await agyUsableForDefaults(undefined, { list: async () => ok, now: () => 3 })).toBe(true)
  })

  it('D15: two executables with different catalogs keep separate chat defaults', async () => {
    await probeAgyUsable('/cli/a', {
      list: async () => ({ models: ['gemini-3.1-pro-low', 'gemini-3.8-flash-low'] }),
      now: () => 1,
    })
    await probeAgyUsable('/cli/b', {
      list: async () => ({ models: ['gemini-3.8-flash-high'] }),
      now: () => 2,
    })
    expect(agyChatDefaultModel('/cli/a')).toBe('gemini-3.1-pro-low')
    expect(agyChatDefaultModel('/cli/b')).toBe('gemini-3.8-flash-high')
    expect(agyChatDefaultModel('/cli/never-probed')).toBe('gemini-3.8-flash-high')
  })

  it('D13/D14: probing another path never rewrites stored model or provider choices', async () => {
    await probeAgyUsable('/cli/a', { list: async () => ok, now: () => 1 })
    await probeAgyUsable('/cli/b', { list: async () => bad, now: () => 2 })
    const settings = defaultAiSettings()
    expect(settings.provider).toBe('gemini')
    expect(settings.providers.agy.model).toBe('')
    expect(agyChatDefaultModel('/cli/a')).toBe('gemini-3.8-flash-high')
    expect(agyChatDefaultModel('/cli/b')).toBeUndefined()
  })
})
