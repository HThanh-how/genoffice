import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import type { MachineSpec } from '../src/main/document-memory/embedding-profiles'
import { currentMachineSpec } from '../src/main/document-memory/embedding/initial-profile'
import { overrideInstalledOrtVersion } from '../src/main/document-memory/embedding/ort-support'
import {
  EMBEDDING_SETTINGS_FILENAME,
  readEmbeddingProfileId,
  writeActiveEmbeddingConfig,
} from '../src/main/document-memory/storage/embedding-settings'

const machine = (totalMemGiB: number, logicalCores: number): MachineSpec => ({
  totalMemGiB,
  logicalCores,
  arch: 'arm64',
  platform: 'darwin',
})

/** Records the environment the manager hands to its indexing worker; never answers. */
class SilentWorker extends EventEmitter {
  postMessage(): void {}
  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
}

describe('startup embedding profile (fresh install vs existing index)', () => {
  let dir: string
  let managers: DocumentMemoryManager[]
  let workerEnv: Record<string, string>[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-startup-profile-'))
    managers = []
    workerEnv = []
    overrideInstalledOrtVersion('1.23.2')
  })
  afterEach(async () => {
    for (const m of managers) await m.closeAsync()
    overrideInstalledOrtVersion(undefined)
    rmSync(dir, { recursive: true, force: true })
  })

  function createManager(spec?: MachineSpec, enabled = false): DocumentMemoryManager {
    const m = new DocumentMemoryManager(dir, {
      initialEnabled: enabled,
      pollIntervalMs: 60_000,
      ...(spec ? { machineSpec: spec } : {}),
      workerFactory: (_path, env) => {
        workerEnv.push(env)
        return new SilentWorker() as unknown as Worker
      },
    })
    managers.push(m)
    return m
  }

  it('a fresh install starts on the fastest tier (base) even on a big machine and remembers it', () => {
    const m = createManager(machine(32, 10))
    expect(m.embeddingSettings().profile).toBe('base')
    expect(readEmbeddingProfileId(dir)).toBe('base')
    expect(existsSync(join(dir, EMBEDDING_SETTINGS_FILENAME))).toBe(true)
  })

  it.each([
    [4, 8, 'base'],
    [8, 8, 'base'],
    [16, 8, 'base'],
    [32, 2, 'base'],
  ] as const)('%i GB / %i cores -> %s', (gib, cores, expected) => {
    expect(createManager(machine(gib, cores)).embeddingSettings().profile).toBe(expected)
  })

  it('the default does not depend on whether the bundled runtime can load the bigger models', () => {
    overrideInstalledOrtVersion('1.21.0')
    expect(createManager(machine(32, 10)).embeddingSettings().profile).toBe('base')
  })

  it('the indexing worker is started with the recommended profile', async () => {
    const m = createManager(machine(32, 10), true)
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'hello recommended tier')
    m.remember(file)
    const started = Date.now()
    while (!workerEnv.length && Date.now() - started < 3000)
      await new Promise((r) => setTimeout(r, 10))
    expect(workerEnv[0]?.embeddingProfile).toBe('base')
  })

  it('the recommendation is made once: a restart on another machine keeps the first answer', () => {
    createManager(machine(4, 8)).close()
    managers.length = 0
    expect(createManager(machine(64, 16)).embeddingSettings().profile).toBe('base')
  })

  it('a saved choice always wins', () => {
    writeActiveEmbeddingConfig(dir, 'high')
    expect(createManager(machine(4, 2)).embeddingSettings().profile).toBe('high')
  })

  it('an existing index without a settings file moves to the base tier and the choice is saved', () => {
    const store = new DocumentMemoryStore(join(dir, 'document-memory.db'))
    store.close()
    expect(createManager(machine(32, 10)).embeddingSettings().profile).toBe('base')
    expect(readEmbeddingProfileId(dir)).toBe('base')
    expect(existsSync(join(dir, EMBEDDING_SETTINGS_FILENAME))).toBe(true)
  })

  it('without a machine spec the manager keeps the legacy default (tests and tools)', () => {
    expect(createManager().embeddingSettings().profile).toBe('standard')
    expect(existsSync(join(dir, EMBEDDING_SETTINGS_FILENAME))).toBe(false)
  })

  it('currentMachineSpec describes this machine', () => {
    const spec = currentMachineSpec()
    expect(spec.totalMemGiB).toBeGreaterThan(0)
    expect(spec.logicalCores).toBeGreaterThan(0)
    expect(spec.platform).toBe(process.platform)
  })
})
