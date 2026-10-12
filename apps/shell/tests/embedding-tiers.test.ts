import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EMBEDDING_PROFILE,
  EMBEDDING_PROFILES,
  EMBEDDING_PROFILE_IDS,
  TIERED_PROFILE_IDS,
  assertEmbeddingManifest,
  embeddingProfile,
  isEmbeddingProfileId,
  suggestBiggestProfile,
  type EmbeddingProfile,
} from '../src/main/document-memory/embedding-profiles'
import {
  BEKKO_A8M,
  BEKKO_A25M,
  EMBEDDING_GEMMA_2,
  HARRIER_270M,
  PREFIX_VERSION,
  buildEmbeddingId,
} from '../src/main/document-memory/embedding/model-specs'
import { compareVersions, ortSupports } from '../src/main/document-memory/embedding/ort-support'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chooseInitialEmbeddingProfile,
  resolveStartupEmbeddingProfile,
} from '../src/main/document-memory/embedding/initial-profile'
import {
  readEmbeddingProfileId,
  writeActiveEmbeddingConfig,
} from '../src/main/document-memory/storage/embedding-settings'

const tiered = TIERED_PROFILE_IDS.map((id) => EMBEDDING_PROFILES[id])
const ORT_OK = '1.23.2'

describe('tiered embedding profiles', () => {
  it('keeps the legacy profiles byte-for-byte compatible', () => {
    const { standard, high } = EMBEDDING_PROFILES
    expect(standard.embeddingId).toBe('f2llm-v2-80m:ad88d7a126:q8:last-token:320:v1')
    expect(standard.dimensions).toBe(320)
    expect(standard.repo).toBe('genoffice/F2LLM-v2-80M-ONNX')
    expect(standard.revision).toBe('ad88d7a126711f1490cd4bad645dc9d3acc2af6a')
    expect(standard.vectorQuantisation).toBe('fp32')
    expect(high.embeddingId).toBe('qwen3-embedding-0.6b:bd58e9fd4b:q8:last-token:512:v1')
    expect(high.dimensions).toBe(512)
    expect(high.vectorQuantisation).toBe('fp32')
    expect(high.heavy).toBe(true)
    expect(standard.tier).toBe('legacy')
    expect(high.tier).toBe('legacy')
    expect(DEFAULT_EMBEDDING_PROFILE).toBe('standard')
    expect(embeddingProfile('nonsense').id).toBe('standard')
  })

  it('has the four tiers with the benchmark models and stored dimensions', () => {
    expect(EMBEDDING_PROFILE_IDS).toEqual(['standard', 'high', 'base', 'balanced', 'mid', 'plus'])
    const { base, balanced, mid, plus } = EMBEDDING_PROFILES
    expect([base.repo, base.dimensions, base.vectorQuantisation]).toEqual([
      'hotchpotch/bekko-embedding-v1-a8m',
      384,
      'int8',
    ])
    expect([balanced.repo, balanced.dimensions, balanced.vectorQuantisation]).toEqual([
      'hotchpotch/bekko-embedding-v1-a25m',
      384,
      'int8',
    ])
    expect([mid.repo, mid.dimensions, mid.nativeDimensions, mid.vectorQuantisation]).toEqual([
      'onnx-community/embeddinggemma-2-ONNX',
      512,
      768,
      'int8',
    ])
    expect([plus.repo, plus.dimensions, plus.nativeDimensions, plus.vectorQuantisation]).toEqual([
      'onnx-community/embeddinggemma-2-ONNX',
      512,
      768,
      'int8',
    ])
    expect(base.pooling).toBe('mean')
    expect(mid.pooling).toBe('sentence')
    expect(base.tier).toBe('base')
    expect(balanced.tier).toBe('default')
    expect(mid.tier).toBe('mid')
    expect(plus.tier).toBe('high')
  })

  it('pins full commit SHAs and sha256+size for every downloaded file', () => {
    for (const profile of tiered) {
      expect(profile.revision).toMatch(/^[0-9a-f]{40}$/)
      expect(() => assertEmbeddingManifest(profile)).not.toThrow()
      for (const file of profile.files) {
        expect(file.sha256, `${profile.id}:${file.path}`).toMatch(/^[0-9a-f]{64}$/)
        expect(file.bytes, `${profile.id}:${file.path}`).toBeGreaterThan(0)
      }
      const paths = profile.files.map((f) => f.path)
      expect(paths).toContain(profile.modelFile)
      expect(paths).toContain(profile.tokenizerFile)
      expect(paths).toContain(profile.tokenizerConfigFile)
    }
    // external-weights export: the data file must be downloaded next to the .onnx
    expect(EMBEDDING_PROFILES.mid.files.map((f) => f.path)).toContain(
      'onnx/model_quantized.onnx_data',
    )
  })

  it('rejects a mutable revision, a bad size and a missing pin on a tiered profile', () => {
    const base = EMBEDDING_PROFILES.base
    expect(() => assertEmbeddingManifest({ ...base, revision: 'main' })).toThrow('full commit SHA')
    expect(() =>
      assertEmbeddingManifest({
        ...base,
        files: base.files.map((f, i) => (i ? f : { ...f, bytes: -1 })),
      }),
    ).toThrow('Invalid size')
    expect(() =>
      assertEmbeddingManifest({
        ...base,
        files: base.files.map((f, i) => (i ? f : { path: f.path })),
      }),
    ).toThrow('must pin sha256')
    expect(() => assertEmbeddingManifest({ ...base, files: base.files.slice(1) })).toThrow(
      'Missing manifest entry',
    )
  })

  it('gives every distinct vector space a distinct embeddingId; mid and plus deliberately share one', () => {
    const ids = EMBEDDING_PROFILE_IDS.map((id) => EMBEDDING_PROFILES[id].embeddingId)
    expect(new Set(ids).size).toBe(ids.length - 1)
    expect(EMBEDDING_PROFILES.mid.embeddingId).toBe(EMBEDDING_PROFILES.plus.embeddingId)
    expect(EMBEDDING_PROFILES.mid.embeddingId).toBe(
      'embeddinggemma-2:daa72c5124:q8:sentence:512:v8:p1',
    )
    expect(EMBEDDING_PROFILES.base.embeddingId).toBe('bekko-a8m:c721113d59:qe8:mean:384:v8:p1')
    expect(EMBEDDING_PROFILES.balanced.embeddingId).toBe('bekko-a25m:44f0b8af0f:qe8:mean:384:v8:p1')
    // mid and plus agree on everything that defines the vectors
    for (const key of [
      'repo',
      'revision',
      'modelFile',
      'dimensions',
      'pooling',
      'queryPrefix',
      'passagePrefix',
      'vectorQuantisation',
    ] as const)
      expect(EMBEDDING_PROFILES.plus[key]).toEqual(EMBEDDING_PROFILES.mid[key])
    // ... and differ only in resources
    expect(EMBEDDING_PROFILES.plus.maxInputTokens).toBeGreaterThan(
      EMBEDDING_PROFILES.mid.maxInputTokens,
    )
    expect(EMBEDDING_PROFILES.plus.maxThreads).toBeGreaterThan(EMBEDDING_PROFILES.mid.maxThreads)
    expect(EMBEDDING_PROFILES.plus.concurrency).toBeGreaterThan(EMBEDDING_PROFILES.mid.concurrency)
  })

  it('changes the embeddingId whenever model, revision, pooling, dimensions, quantisation or prefix version change', () => {
    const base = buildEmbeddingId(EMBEDDING_GEMMA_2, 512, 'int8')
    const variants = [
      buildEmbeddingId({ ...EMBEDDING_GEMMA_2, slug: 'other' }, 512, 'int8'),
      buildEmbeddingId({ ...EMBEDDING_GEMMA_2, revision: 'f'.repeat(40) }, 512, 'int8'),
      buildEmbeddingId({ ...EMBEDDING_GEMMA_2, modelPrecision: 'qe8' }, 512, 'int8'),
      buildEmbeddingId({ ...EMBEDDING_GEMMA_2, pooling: 'mean' }, 512, 'int8'),
      buildEmbeddingId(EMBEDDING_GEMMA_2, 768, 'int8'),
      buildEmbeddingId(EMBEDDING_GEMMA_2, 512, 'fp32'),
    ]
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1)
    expect(base.endsWith(`:${PREFIX_VERSION}`)).toBe(true)
  })

  it('uses the prefixes the benchmark measured', () => {
    expect(BEKKO_A8M.queryPrefix + BEKKO_A8M.passagePrefix + BEKKO_A8M.queryInstruction).toBe('')
    expect(BEKKO_A25M.queryPrefix + BEKKO_A25M.passagePrefix + BEKKO_A25M.queryInstruction).toBe('')
    expect(EMBEDDING_GEMMA_2.queryPrefix).toBe('task: search result | query: ')
    expect(EMBEDDING_GEMMA_2.passagePrefix).toBe('title: none | text: ')
    expect(EMBEDDING_GEMMA_2.queryInstruction).toBe('')
    expect(HARRIER_270M.queryInstruction).toContain(
      'retrieve the most relevant local document passages',
    )
    expect(HARRIER_270M.passagePrefix).toBe('')
    expect(EMBEDDING_PROFILES.mid.emptyInputs?.map((i) => i.name)).toEqual([
      'image_features',
      'video_features',
      'audio_features',
    ])
  })

  it('keeps each tier within 15-20% of its RAM floor and asks for head-room before loading', () => {
    const floorMB = { base: 4096, balanced: 8192, mid: 16384, plus: 32768 } as const
    for (const id of TIERED_PROFILE_IDS) {
      const profile = EMBEDDING_PROFILES[id]
      expect(profile.memoryMB / floorMB[id]).toBeLessThanOrEqual(0.2)
      expect(profile.minFreeMemoryMB).toBeGreaterThan(profile.memoryMB)
      expect(profile.minFreeMemoryMB).toBeLessThanOrEqual(floorMB[id] * 0.25)
    }
    expect(EMBEDDING_PROFILES.base.downloadMB).toBeLessThan(EMBEDDING_PROFILES.balanced.downloadMB)
  })

  it('records the licence and the ONNX Runtime floor', () => {
    expect(EMBEDDING_PROFILES.base.license).toBe('MIT')
    expect(EMBEDDING_PROFILES.mid.license).toContain('Gemma Prohibited-Use')
    expect(EMBEDDING_PROFILES.mid.minOrtVersion).toBe('1.23.0')
    expect(EMBEDDING_PROFILES.base.minOrtVersion).toBeUndefined()
    expect(ortSupports('1.23.0', '1.21.0')).toBe(false)
    expect(ortSupports('1.23.0', '1.23.2')).toBe(true)
    expect(ortSupports('1.23.0', null)).toBe(true)
    expect(compareVersions('1.30.0', '1.4.0')).toBe(1)
    expect(compareVersions('1.23.0-dev.1', '1.23.0')).toBe(0)
  })

  it('resolves ids and embeddingIds to profiles', () => {
    for (const id of EMBEDDING_PROFILE_IDS) expect(isEmbeddingProfileId(id)).toBe(true)
    expect(isEmbeddingProfileId('default')).toBe(false)
    expect(isEmbeddingProfileId('toString')).toBe(false)
    expect(embeddingProfile('plus').id).toBe('plus')
    expect(embeddingProfile(EMBEDDING_PROFILES.base.embeddingId).id).toBe('base')
    expect(embeddingProfile(EMBEDDING_PROFILES.mid.embeddingId).id).toBe('mid')
    expect(embeddingProfile(EMBEDDING_PROFILES.standard.embeddingId).id).toBe('standard')
  })
})

describe('suggestBiggestProfile (tiers)', () => {
  const m = (
    totalMemGiB: number,
    logicalCores: number,
    extra: Partial<Parameters<typeof suggestBiggestProfile>[0]> = {},
  ) =>
    suggestBiggestProfile({
      arch: 'x64',
      platform: 'linux',
      totalMemGiB,
      logicalCores,
      ortVersion: ORT_OK,
      ...extra,
    })

  it('maps RAM and cores to base / balanced / mid / plus', () => {
    expect(m(4, 2).profile).toBe('base')
    expect(m(6, 8).profile).toBe('base')
    expect(m(16, 2).profile).toBe('base') // cores <= 2
    expect(m(6.1, 4).profile).toBe('balanced')
    expect(m(8, 4).profile).toBe('balanced')
    expect(m(12, 8).profile).toBe('balanced')
    expect(m(12.1, 8).profile).toBe('mid')
    expect(m(16, 8).profile).toBe('mid')
    expect(m(24, 12).profile).toBe('mid')
    expect(m(24.1, 12).profile).toBe('plus')
    expect(m(64, 16).profile).toBe('plus')
  })

  it('explains why a bigger tier is not advised', () => {
    expect(m(16, 2)).toEqual({ profile: 'base', limit: 'cpu' })
    expect(m(4, 2)).toEqual({ profile: 'base', limit: 'memory' })
    expect(m(8, 8)).toEqual({ profile: 'balanced', limit: 'memory' })
    expect(m(32, 8).limit).toBeUndefined()
  })

  it('never selects a profile whose minFreeMemoryMB exceeds the available RAM', () => {
    for (const total of [3, 4, 6, 8, 12, 16, 24, 32, 64]) {
      for (const free of [300, 700, 900, 1100, 1300, 2000, 4000, 20000]) {
        const advice = m(total, 8, { freeMemMB: free })
        const profile = EMBEDDING_PROFILES[advice.profile]
        // the smallest tier is returned even when nothing fits: it is the best we can offer
        if (advice.profile !== 'base') expect(profile.minFreeMemoryMB).toBeLessThanOrEqual(free)
      }
    }
    expect(m(32, 8, { freeMemMB: 1250 }).profile).toBe('mid')
    expect(m(32, 8, { freeMemMB: 800 }).profile).toBe('base')
    expect(m(8, 8, { freeMemMB: 1100 }).profile).toBe('base')
  })

  it('skips tiers whose model the bundled onnxruntime cannot load', () => {
    expect(m(32, 8, { ortVersion: '1.21.0' }).profile).toBe('balanced')
    expect(m(16, 8, { ortVersion: '1.22.0' }).profile).toBe('balanced')
    expect(m(16, 8, { ortVersion: '1.30.0' }).profile).toBe('mid')
  })
})

describe('chooseInitialEmbeddingProfile', () => {
  const spec = {
    arch: 'x64',
    platform: 'linux',
    totalMemGiB: 32,
    logicalCores: 8,
    ortVersion: ORT_OK,
  }

  it('never overrides a saved profile', () => {
    for (const saved of ['standard', 'high', 'base', 'balanced', 'mid', 'plus'] as const)
      expect(chooseInitialEmbeddingProfile({ saved, hasExistingIndex: true, spec })).toEqual({
        profile: saved,
        source: 'saved',
      })
    expect(
      chooseInitialEmbeddingProfile({ saved: 'standard', hasExistingIndex: false, spec }).profile,
    ).toBe('standard')
  })

  it('moves an existing index without a settings file to the base tier (the legacy repository is gone)', () => {
    expect(
      chooseInitialEmbeddingProfile({ saved: undefined, hasExistingIndex: true, spec }),
    ).toEqual({
      profile: 'base',
      source: 'existing-index',
    })
  })

  it('recommends a tier on a fresh install (and ignores an unreadable saved value)', () => {
    expect(
      chooseInitialEmbeddingProfile({ saved: undefined, hasExistingIndex: false, spec }),
    ).toEqual({ profile: 'base', source: 'recommended' })
    expect(
      chooseInitialEmbeddingProfile({
        saved: 'garbage',
        hasExistingIndex: false,
        spec: { ...spec, totalMemGiB: 4 },
      }).profile,
    ).toBe('base')
  })
})

describe('profile type surface', () => {
  it('exposes every field the loader needs on every profile', () => {
    for (const profile of Object.values(EMBEDDING_PROFILES) as EmbeddingProfile[]) {
      expect(profile.maxThreads).toBeGreaterThanOrEqual(1)
      expect(profile.concurrency).toBeGreaterThanOrEqual(1)
      expect(profile.dimensions).toBeLessThanOrEqual(profile.nativeDimensions)
      expect(['fp32', 'int8']).toContain(profile.vectorQuantisation)
    }
  })
})

describe('resolveStartupEmbeddingProfile (real files)', () => {
  const spec = {
    arch: 'x64',
    platform: 'linux',
    totalMemGiB: 16,
    logicalCores: 8,
    ortVersion: ORT_OK,
  }
  const withDir = (run: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'genoffice-initial-profile-'))
    try {
      run(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('persists the recommendation once for a fresh install, then leaves later choices alone', () =>
    withDir((dir) => {
      const dbPath = join(dir, 'document-memory.db')
      expect(resolveStartupEmbeddingProfile({ settingsDir: dir, dbPath, spec })).toEqual({
        profile: 'base',
        source: 'recommended',
      })
      expect(readEmbeddingProfileId(dir)).toBe('base')
      // the user picks something else; a bigger machine later must not change it
      writeActiveEmbeddingConfig(dir, 'mid')
      expect(
        resolveStartupEmbeddingProfile({
          settingsDir: dir,
          dbPath,
          spec: { ...spec, totalMemGiB: 64 },
        }),
      ).toEqual({
        profile: 'mid',
        source: 'saved',
      })
    }))

  it('moves an existing index to the base tier and remembers it', () =>
    withDir((dir) => {
      const dbPath = join(dir, 'document-memory.db')
      writeFileSync(dbPath, 'sqlite')
      expect(resolveStartupEmbeddingProfile({ settingsDir: dir, dbPath, spec })).toEqual({
        profile: 'base',
        source: 'existing-index',
      })
      expect(readEmbeddingProfileId(dir)).toBe('base')
    }))

  it('honours a saved legacy choice in the legacy file name and in the parent directory', () =>
    withDir((dir) => {
      writeFileSync(join(dir, 'embedding-settings.json'), JSON.stringify({ profile: 'high' }))
      const sub = join(dir, 'db')
      mkdirSync(sub)
      expect(
        resolveStartupEmbeddingProfile({ settingsDir: sub, dbPath: join(sub, 'x.db'), spec })
          .profile,
      ).toBe('high')
      expect(
        resolveStartupEmbeddingProfile({ settingsDir: dir, dbPath: join(dir, 'x.db'), spec })
          .source,
      ).toBe('saved')
    }))
})
