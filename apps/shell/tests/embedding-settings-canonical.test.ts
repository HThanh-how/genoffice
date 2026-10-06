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
  resolveEmbeddingSettingsPath,
  writeActiveEmbeddingConfig,
} from '../src/main/document-memory/storage/embedding-settings'
import { ensureDocumentMemoryStorageReady } from '../src/main/document-memory/storage-bootstrap'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'

describe('Embedding Profile Single Source of Truth & Canonical Persistence', () => {
  let dir: string
  let managers: DocumentMemoryManager[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-canonical-profile-'))
    managers = []
  })

  afterEach(() => {
    for (const m of managers) {
      try {
        m.close()
      } catch {
        // ignore errors during teardown
      }
    }
    rmSync(dir, { recursive: true, force: true })
  })

  function createManager(optionsDir = dir): DocumentMemoryManager {
    const m = new DocumentMemoryManager(optionsDir, { initialEnabled: false })
    managers.push(m)
    return m
  }

  it('PROFILE-01: saved High -> restart -> High', async () => {
    // 1. First run: switch profile to 'high'
    const mgr1 = createManager()
    const switchResult = mgr1.setEmbeddingProfile('high')
    expect(switchResult.changed).toBe(true)
    expect(mgr1.embeddingSettings().profile).toBe('high')

    // Close first manager before simulating application restart
    mgr1.close()

    // 2. Restart: new manager instance pointing to the same directory
    const mgr2 = createManager()
    expect(mgr2.embeddingSettings().profile).toBe('high')
    expect(mgr2.indexingActivityStatus().activeEmbeddingSpace).toBe(EMBEDDING_PROFILES.high.embeddingId)
  })

  it('PROFILE-02: saved Standard -> restart -> Standard', async () => {
    // 1. First run: switch to 'high' then back to 'standard' to ensure explicit save
    const mgr1 = createManager()
    mgr1.setEmbeddingProfile('high')
    expect(mgr1.embeddingSettings().profile).toBe('high')

    const switchResult = mgr1.setEmbeddingProfile('standard')
    expect(switchResult.changed).toBe(true)
    expect(mgr1.embeddingSettings().profile).toBe('standard')

    // Close first manager before restart
    mgr1.close()

    // 2. Restart: new manager instance pointing to the same directory
    const mgr2 = createManager()
    expect(mgr2.embeddingSettings().profile).toBe('standard')
    expect(mgr2.indexingActivityStatus().activeEmbeddingSpace).toBe(EMBEDDING_PROFILES.standard.embeddingId)

    // Verify canonical JSON file on disk
    const canonicalPath = join(dir, EMBEDDING_SETTINGS_FILENAME)
    expect(existsSync(canonicalPath)).toBe(true)
    const stored = JSON.parse(readFileSync(canonicalPath, 'utf8'))
    expect(stored.profile).toBe('standard')
  })

  it('PROFILE-03: bootstrap profile == manager profile (cùng đọc document-memory-embedding.json)', async () => {
    // 1. Persist 'high' to canonical settings file
    writeActiveEmbeddingConfig(dir, 'high')

    // 2. Bootstrap phase: storage bootstrap reads active embedding config before DB open
    const bootstrapConfig = readActiveEmbeddingConfig(dir)
    const bootstrapResult = await ensureDocumentMemoryStorageReady(dir)
    expect(bootstrapResult.ready).toBe(true)
    expect(bootstrapConfig.profileId).toBe('high')
    expect(bootstrapConfig.activeSpaceId).toBe(EMBEDDING_PROFILES.high.embeddingId)

    // 3. Manager runtime phase: manager starts up in the same directory
    const mgr = createManager()

    // 4. Assert bootstrap profile matches manager profile exactly
    expect(mgr.embeddingSettings().profile).toBe(bootstrapConfig.profileId)
    expect(mgr.indexingActivityStatus().activeEmbeddingSpace).toBe(bootstrapConfig.activeSpaceId)
    expect(mgr.embeddingSettings().profile).toBe('high')

    // 5. Verify symmetry when profile switches to 'standard'
    mgr.setEmbeddingProfile('standard')
    mgr.close()

    const nextBootstrapConfig = readActiveEmbeddingConfig(dir)
    const nextMgr = createManager()
    expect(nextMgr.embeddingSettings().profile).toBe(nextBootstrapConfig.profileId)
    expect(nextMgr.indexingActivityStatus().activeEmbeddingSpace).toBe(nextBootstrapConfig.activeSpaceId)
    expect(nextBootstrapConfig.profileId).toBe('standard')
  })

  it('PROFILE-04: canonical wins over legacy file (nếu cả 2 cùng tồn tại, canonical thắng)', async () => {
    const canonicalPath = join(dir, EMBEDDING_SETTINGS_FILENAME)
    const legacyPath = join(dir, LEGACY_EMBEDDING_SETTINGS_FILENAME)

    // Case A: Canonical = 'high', Legacy = 'standard'
    writeFileSync(canonicalPath, JSON.stringify({ profile: 'high' }, null, 2), 'utf8')
    writeFileSync(legacyPath, JSON.stringify({ profile: 'standard' }, null, 2), 'utf8')

    expect(readEmbeddingProfileId(dir)).toBe('high')
    const activeConfigA = readActiveEmbeddingConfig(dir)
    expect(activeConfigA.profileId).toBe('high')
    expect(activeConfigA.activeSpaceId).toBe(EMBEDDING_PROFILES.high.embeddingId)

    const mgrA = createManager()
    expect(mgrA.embeddingSettings().profile).toBe('high')
    expect(mgrA.indexingActivityStatus().activeEmbeddingSpace).toBe(EMBEDDING_PROFILES.high.embeddingId)
    mgrA.close()

    // Verify canonical content was not modified/overwritten by legacy
    const canonicalContentA = JSON.parse(readFileSync(canonicalPath, 'utf8'))
    expect(canonicalContentA.profile).toBe('high')

    // Case B: Canonical = 'standard', Legacy = 'high'
    writeFileSync(canonicalPath, JSON.stringify({ profile: 'standard' }, null, 2), 'utf8')
    writeFileSync(legacyPath, JSON.stringify({ profile: 'high' }, null, 2), 'utf8')

    expect(readEmbeddingProfileId(dir)).toBe('standard')
    const activeConfigB = readActiveEmbeddingConfig(dir)
    expect(activeConfigB.profileId).toBe('standard')

    const mgrB = createManager()
    expect(mgrB.embeddingSettings().profile).toBe('standard')
    expect(mgrB.indexingActivityStatus().activeEmbeddingSpace).toBe(EMBEDDING_PROFILES.standard.embeddingId)
    mgrB.close()
  })

  it('PROFILE-05: legacy-only migrates once (chỉ có file legacy -> đọc legacy và ghi sang canonical)', async () => {
    const canonicalPath = join(dir, EMBEDDING_SETTINGS_FILENAME)
    const legacyPath = join(dir, LEGACY_EMBEDDING_SETTINGS_FILENAME)

    // Ensure canonical file does not exist initially
    expect(existsSync(canonicalPath)).toBe(false)

    // Create legacy-only configuration file with 'high'
    writeFileSync(legacyPath, JSON.stringify({ profile: 'high' }, null, 2), 'utf8')

    // Read active profile: should detect legacy, read 'high', and migrate to canonical file
    const config = readActiveEmbeddingConfig(dir)
    expect(config.profileId).toBe('high')

    // Verify canonical file now exists and contains 'high'
    expect(existsSync(canonicalPath)).toBe(true)
    const canonicalData = JSON.parse(readFileSync(canonicalPath, 'utf8'))
    expect(canonicalData.profile).toBe('high')

    // Verify it migrates once: mutate legacy file to 'standard'
    writeFileSync(legacyPath, JSON.stringify({ profile: 'standard' }, null, 2), 'utf8')

    // Subsequent read must read from canonical (which is 'high') and not re-migrate from legacy
    const subsequentConfig = readActiveEmbeddingConfig(dir)
    expect(subsequentConfig.profileId).toBe('high')

    // Test direct DocumentMemoryManager startup with legacy-only file in a fresh directory
    const separateDir = mkdtempSync(join(tmpdir(), 'genoffice-legacy-mgr-'))
    try {
      const sepLegacy = join(separateDir, LEGACY_EMBEDDING_SETTINGS_FILENAME)
      const sepCanonical = join(separateDir, EMBEDDING_SETTINGS_FILENAME)
      writeFileSync(sepLegacy, JSON.stringify({ profile: 'high' }, null, 2), 'utf8')
      expect(existsSync(sepCanonical)).toBe(false)

      const mgr = createManager(separateDir)
      expect(mgr.embeddingSettings().profile).toBe('high')
      expect(existsSync(sepCanonical)).toBe(true)
      const sepData = JSON.parse(readFileSync(sepCanonical, 'utf8'))
      expect(sepData.profile).toBe('high')
      mgr.close()
    } finally {
      rmSync(separateDir, { recursive: true, force: true })
    }
  })

  it('PROFILE-06: switch profile persists canonical value (đổi profile ghi đúng document-memory-embedding.json)', async () => {
    const canonicalPath = join(dir, EMBEDDING_SETTINGS_FILENAME)
    const mgr = createManager()

    // Default profile is 'standard'
    expect(mgr.embeddingSettings().profile).toBe('standard')

    // 1. Switch to 'high'
    const res1 = mgr.setEmbeddingProfile('high')
    expect(res1.changed).toBe(true)
    expect(mgr.embeddingSettings().profile).toBe('high')
    expect(mgr.indexingActivityStatus().activeEmbeddingSpace).toBe(EMBEDDING_PROFILES.high.embeddingId)

    // Verify canonical file persisted on disk
    expect(existsSync(canonicalPath)).toBe(true)
    const content1 = JSON.parse(readFileSync(canonicalPath, 'utf8'))
    expect(content1.profile).toBe('high')

    // 2. Switch back to 'standard'
    const res2 = mgr.setEmbeddingProfile('standard')
    expect(res2.changed).toBe(true)
    expect(mgr.embeddingSettings().profile).toBe('standard')
    expect(mgr.indexingActivityStatus().activeEmbeddingSpace).toBe(EMBEDDING_PROFILES.standard.embeddingId)

    // Verify canonical file updated on disk
    const content2 = JSON.parse(readFileSync(canonicalPath, 'utf8'))
    expect(content2.profile).toBe('standard')

    // 3. Idempotent call to current profile: no change, canonical file unchanged
    const res3 = mgr.setEmbeddingProfile('standard')
    expect(res3.changed).toBe(false)
    expect(mgr.embeddingSettings().profile).toBe('standard')
    const content3 = JSON.parse(readFileSync(canonicalPath, 'utf8'))
    expect(content3.profile).toBe('standard')
  })
})
