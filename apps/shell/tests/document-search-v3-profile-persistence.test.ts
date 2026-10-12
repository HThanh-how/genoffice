/**
 * PAIR 01 — Embedding Profile Persistence QA Audit Suite (QA-01)
 *
 * Invariant specifications:
 * - PROFILE-01: save High → restart manager → High
 * - PROFILE-02: bootstrap reads High → manager runtime reports High
 * - PROFILE-03: High → Standard → canonical file updated
 * - PROFILE-04: canonical file and legacy file conflict → canonical wins
 * - PROFILE-05: runtime embeddingId after restart == bootstrap activeSpaceId
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentMemoryManager } from '../src/main/document-memory/manager'
import {
  EMBEDDING_SETTINGS_FILENAME,
  LEGACY_EMBEDDING_SETTINGS_FILENAME,
  readActiveEmbeddingConfig,
  readEmbeddingProfileId,
  writeActiveEmbeddingConfig,
} from '../src/main/document-memory/storage/embedding-settings'
import { ensureDocumentMemoryStorageReady } from '../src/main/document-memory/storage-bootstrap'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'

describe('Pair 01: Document Search V3 Embedding Profile Persistence (QA-01)', () => {
  let dir: string
  let managers: DocumentMemoryManager[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-profile-persistence-'))
    managers = []
  })

  afterEach(async () => {
    for (const m of managers) {
      try {
        await m.closeAsync()
      } catch {
        // ignore errors during teardown
      }
    }
    rmSync(dir, { recursive: true, force: true })
  })

  function createManager(targetDir = dir): DocumentMemoryManager {
    const m = new DocumentMemoryManager(targetDir, { initialEnabled: false })
    managers.push(m)
    return m
  }

  it('PROFILE-01: save High → restart manager → High', async () => {
    // 1. Initial manager instance starts (default profile is standard)
    const mgr1 = createManager()
    expect(mgr1.embeddingSettings().profile).toBe('standard')

    // 2. Explicitly switch profile to 'high'
    const switchResult = mgr1.setEmbeddingProfile('high')
    expect(switchResult.changed).toBe(true)
    expect(mgr1.embeddingSettings().profile).toBe('high')
    expect(mgr1.indexingActivityStatus().activeEmbeddingSpace).toBe(
      EMBEDDING_PROFILES.high.embeddingId,
    )

    // 3. Gracefully close manager 1 before simulating application restart
    await mgr1.closeAsync()

    // 4. Restart manager: new instance pointing to the exact same directory
    const mgr2 = createManager()
    expect(mgr2.embeddingSettings().profile).toBe('high')
    expect(mgr2.indexingActivityStatus().activeEmbeddingSpace).toBe(
      EMBEDDING_PROFILES.high.embeddingId,
    )
  })

  it('PROFILE-02: bootstrap reads High → manager runtime reports High', async () => {
    // 1. Persist 'high' to canonical settings file prior to bootstrap & database launch
    writeActiveEmbeddingConfig(dir, 'high')

    // 2. Storage bootstrap phase: bootstrap reads active embedding config before opening database
    const bootstrapConfig = readActiveEmbeddingConfig(dir)
    expect(bootstrapConfig.profileId).toBe('high')
    expect(bootstrapConfig.activeSpaceId).toBe(EMBEDDING_PROFILES.high.embeddingId)
    expect(bootstrapConfig.activeDimensions).toBe(EMBEDDING_PROFILES.high.dimensions)

    const bootstrapResult = await ensureDocumentMemoryStorageReady(dir)
    expect(bootstrapResult.ready).toBe(true)

    // 3. Manager runtime phase: manager starts up in the same storage directory
    const mgr = createManager()

    // 4. Verify runtime reports match bootstrap values exactly
    expect(mgr.embeddingSettings().profile).toBe(bootstrapConfig.profileId)
    expect(mgr.embeddingSettings().profile).toBe('high')
    expect(mgr.indexingActivityStatus().activeEmbeddingSpace).toBe(bootstrapConfig.activeSpaceId)
    expect(mgr.indexingActivityStatus().activeEmbeddingSpace).toBe(
      EMBEDDING_PROFILES.high.embeddingId,
    )
  })

  it('PROFILE-03: High → Standard → canonical file updated', async () => {
    const canonicalPath = join(dir, EMBEDDING_SETTINGS_FILENAME)

    // 1. Initial state: save High profile and verify on disk
    writeActiveEmbeddingConfig(dir, 'high')
    expect(existsSync(canonicalPath)).toBe(true)
    const initialDisk = JSON.parse(readFileSync(canonicalPath, 'utf8'))
    expect(initialDisk.profile).toBe('high')

    // 2. Start manager and verify it is running on High
    const mgr = createManager()
    expect(mgr.embeddingSettings().profile).toBe('high')

    // 3. Switch profile from High to Standard
    const switchResult = mgr.setEmbeddingProfile('standard')
    expect(switchResult.changed).toBe(true)
    expect(mgr.embeddingSettings().profile).toBe('standard')
    expect(mgr.indexingActivityStatus().activeEmbeddingSpace).toBe(
      EMBEDDING_PROFILES.standard.embeddingId,
    )

    // 4. Verify canonical file on disk was updated to Standard
    expect(existsSync(canonicalPath)).toBe(true)
    const updatedDisk = JSON.parse(readFileSync(canonicalPath, 'utf8'))
    expect(updatedDisk.profile).toBe('standard')

    // 5. Verify independent config readers also return Standard
    expect(readEmbeddingProfileId(dir)).toBe('standard')
    const activeConfig = readActiveEmbeddingConfig(dir)
    expect(activeConfig.profileId).toBe('standard')
    expect(activeConfig.activeSpaceId).toBe(EMBEDDING_PROFILES.standard.embeddingId)
  })

  it('PROFILE-04: canonical file and legacy file conflict → canonical wins', async () => {
    const canonicalPath = join(dir, EMBEDDING_SETTINGS_FILENAME)
    const legacyPath = join(dir, LEGACY_EMBEDDING_SETTINGS_FILENAME)

    // Case A: Canonical is 'high', Legacy is 'standard'
    writeFileSync(canonicalPath, JSON.stringify({ profile: 'high' }, null, 2), 'utf8')
    writeFileSync(legacyPath, JSON.stringify({ profile: 'standard' }, null, 2), 'utf8')

    // Independent reader check
    expect(readEmbeddingProfileId(dir)).toBe('high')
    const configA = readActiveEmbeddingConfig(dir)
    expect(configA.profileId).toBe('high')
    expect(configA.activeSpaceId).toBe(EMBEDDING_PROFILES.high.embeddingId)

    // Manager runtime check
    const mgrA = createManager()
    expect(mgrA.embeddingSettings().profile).toBe('high')
    expect(mgrA.indexingActivityStatus().activeEmbeddingSpace).toBe(
      EMBEDDING_PROFILES.high.embeddingId,
    )
    await mgrA.closeAsync()

    // Canonical file must remain 'high' and not be overridden by legacy
    const diskA = JSON.parse(readFileSync(canonicalPath, 'utf8'))
    expect(diskA.profile).toBe('high')

    // Case B: Canonical is 'standard', Legacy is 'high'
    writeFileSync(canonicalPath, JSON.stringify({ profile: 'standard' }, null, 2), 'utf8')
    writeFileSync(legacyPath, JSON.stringify({ profile: 'high' }, null, 2), 'utf8')

    // Independent reader check
    expect(readEmbeddingProfileId(dir)).toBe('standard')
    const configB = readActiveEmbeddingConfig(dir)
    expect(configB.profileId).toBe('standard')
    expect(configB.activeSpaceId).toBe(EMBEDDING_PROFILES.standard.embeddingId)

    // Manager runtime check
    const mgrB = createManager()
    expect(mgrB.embeddingSettings().profile).toBe('standard')
    expect(mgrB.indexingActivityStatus().activeEmbeddingSpace).toBe(
      EMBEDDING_PROFILES.standard.embeddingId,
    )
    await mgrB.closeAsync()

    // Canonical file must remain 'standard'
    const diskB = JSON.parse(readFileSync(canonicalPath, 'utf8'))
    expect(diskB.profile).toBe('standard')
  })

  it('PROFILE-05: runtime embeddingId after restart == bootstrap activeSpaceId', async () => {
    // 1. First scenario with High profile
    writeActiveEmbeddingConfig(dir, 'high')

    // Read active config during bootstrap phase
    const bootstrapConfigHigh = readActiveEmbeddingConfig(dir)
    const bootstrapResultHigh = await ensureDocumentMemoryStorageReady(dir)
    expect(bootstrapResultHigh.ready).toBe(true)
    expect(bootstrapConfigHigh.activeSpaceId).toBe(EMBEDDING_PROFILES.high.embeddingId)

    // Launch manager, verify runtime embeddingId, then gracefully close
    const mgr1 = createManager()
    expect(mgr1.indexingActivityStatus().activeEmbeddingSpace).toBe(
      bootstrapConfigHigh.activeSpaceId,
    )
    await mgr1.closeAsync()

    // Restart manager and verify runtime embeddingId after restart == bootstrap activeSpaceId
    const mgrRestartHigh = createManager()
    expect(mgrRestartHigh.indexingActivityStatus().activeEmbeddingSpace).toBe(
      bootstrapConfigHigh.activeSpaceId,
    )
    expect(mgrRestartHigh.indexingActivityStatus().activeEmbeddingSpace).toBe(
      EMBEDDING_PROFILES.high.embeddingId,
    )
    expect(mgrRestartHigh.getMigrationDiagnostics().activeEmbeddingSpace).toBe(
      bootstrapConfigHigh.activeSpaceId,
    )
    await mgrRestartHigh.closeAsync()

    // 2. Second scenario: switch to Standard profile and verify restart invariance
    const separateDir = mkdtempSync(join(tmpdir(), 'genoffice-profile-p5-std-'))
    try {
      writeActiveEmbeddingConfig(separateDir, 'standard')
      const bootstrapConfigStd = readActiveEmbeddingConfig(separateDir)
      const bootstrapResultStd = await ensureDocumentMemoryStorageReady(separateDir)
      expect(bootstrapResultStd.ready).toBe(true)
      expect(bootstrapConfigStd.activeSpaceId).toBe(EMBEDDING_PROFILES.standard.embeddingId)

      const mgrStd1 = createManager(separateDir)
      expect(mgrStd1.indexingActivityStatus().activeEmbeddingSpace).toBe(
        bootstrapConfigStd.activeSpaceId,
      )
      await mgrStd1.closeAsync()

      // Restart manager in standard directory
      const mgrRestartStd = createManager(separateDir)
      expect(mgrRestartStd.indexingActivityStatus().activeEmbeddingSpace).toBe(
        bootstrapConfigStd.activeSpaceId,
      )
      expect(mgrRestartStd.indexingActivityStatus().activeEmbeddingSpace).toBe(
        EMBEDDING_PROFILES.standard.embeddingId,
      )
      expect(mgrRestartStd.getMigrationDiagnostics().activeEmbeddingSpace).toBe(
        bootstrapConfigStd.activeSpaceId,
      )
      await mgrRestartStd.closeAsync()
    } finally {
      rmSync(separateDir, { recursive: true, force: true })
    }

    // 3. Third scenario: switch profile dynamically in manager, close, read bootstrap activeSpaceId, restart
    const dynamicDir = mkdtempSync(join(tmpdir(), 'genoffice-profile-p5-dyn-'))
    try {
      const mgrDyn = createManager(dynamicDir)
      mgrDyn.setEmbeddingProfile('high')
      await mgrDyn.closeAsync()

      // Independent bootstrap config read
      const bootstrapDynamic = readActiveEmbeddingConfig(dynamicDir)
      expect(bootstrapDynamic.profileId).toBe('high')
      expect(bootstrapDynamic.activeSpaceId).toBe(EMBEDDING_PROFILES.high.embeddingId)

      // Restart manager
      const mgrDynRestart = createManager(dynamicDir)
      expect(mgrDynRestart.indexingActivityStatus().activeEmbeddingSpace).toBe(
        bootstrapDynamic.activeSpaceId,
      )
      expect(mgrDynRestart.indexingActivityStatus().activeEmbeddingSpace).toBe(
        EMBEDDING_PROFILES.high.embeddingId,
      )
      expect(mgrDynRestart.getMigrationDiagnostics().activeEmbeddingSpace).toBe(
        bootstrapDynamic.activeSpaceId,
      )
      await mgrDynRestart.closeAsync()
    } finally {
      rmSync(dynamicDir, { recursive: true, force: true })
    }
  })
})
