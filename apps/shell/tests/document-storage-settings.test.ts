import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readStorageSettings,
  writeStorageSettings,
  validateStorageBudgetBytes,
  STORAGE_SETTINGS_FILENAME,
  MIN_STORAGE_BUDGET_BYTES,
  MAX_STORAGE_BUDGET_BYTES,
} from '../src/main/document-memory/storage/storage-settings'
import {
  DEFAULT_STORAGE_BUDGET,
  createStorageBudget,
} from '../src/main/document-memory/storage-budget'
import {
  writeActiveEmbeddingConfig,
  readEmbeddingProfileId,
  EMBEDDING_SETTINGS_FILENAME,
} from '../src/main/document-memory/storage/embedding-settings'
import { MaintenanceScheduler } from '../src/main/document-memory/runtime/maintenance-scheduler'
import { DiagnosticsRepository } from '../src/main/document-memory/storage/repositories/diagnostics-repository'
import { openDatabase } from '../src/main/document-memory/storage/database'
import { applyCanonicalSchemaV3 } from '../src/main/document-memory/storage/schema-v3'

describe('Checkpoint 2: Document Storage Settings & Unified Budget', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dm-storage-settings-test-'))
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('STORAGE-01: falls back to default budget when settings file is missing', () => {
    const config = readStorageSettings(tempDir)
    expect(config.maxDatabaseBytes).toBe(DEFAULT_STORAGE_BUDGET.maxDatabaseBytes)
    expect(config.preset).toBe('custom')
  })

  it('STORAGE-02: reads and writes 1GB, 3GB, 5GB decimal presets correctly', () => {
    // 1 GB preset
    const p1 = writeStorageSettings(tempDir, { preset: '1gb' })
    expect(p1.maxDatabaseBytes).toBe(1_000_000_000)
    expect(p1.preset).toBe('1gb')
    expect(readStorageSettings(tempDir).maxDatabaseBytes).toBe(1_000_000_000)
    expect(readStorageSettings(tempDir).preset).toBe('1gb')

    // 3 GB preset
    const p3 = writeStorageSettings(tempDir, { preset: '3gb' })
    expect(p3.maxDatabaseBytes).toBe(3_000_000_000)
    expect(p3.preset).toBe('3gb')
    expect(readStorageSettings(tempDir).maxDatabaseBytes).toBe(3_000_000_000)

    // 5 GB preset
    const p5 = writeStorageSettings(tempDir, { preset: '5gb' })
    expect(p5.maxDatabaseBytes).toBe(5_000_000_000)
    expect(p5.preset).toBe('5gb')
    expect(readStorageSettings(tempDir).maxDatabaseBytes).toBe(5_000_000_000)
  })

  it('STORAGE-03: supports custom budget within [500MB, 100GB] range', () => {
    const customBytes = 2_500_000_000
    const res = writeStorageSettings(tempDir, { maxDatabaseBytes: customBytes })
    expect(res.maxDatabaseBytes).toBe(customBytes)
    expect(res.preset).toBe('custom')

    const reloaded = readStorageSettings(tempDir)
    expect(reloaded.maxDatabaseBytes).toBe(customBytes)
    expect(reloaded.preset).toBe('custom')
  })

  it('STORAGE-04: rejects out-of-range and invalid values', () => {
    // Below 500 MB
    expect(validateStorageBudgetBytes(499_999_999)).toBe(false)
    expect(() => writeStorageSettings(tempDir, 400_000_000)).toThrow()

    // Above 100 GB
    expect(validateStorageBudgetBytes(100_000_000_001)).toBe(false)
    expect(() => writeStorageSettings(tempDir, 101_000_000_000)).toThrow()

    // Valid bounds
    expect(validateStorageBudgetBytes(MIN_STORAGE_BUDGET_BYTES)).toBe(true)
    expect(validateStorageBudgetBytes(MAX_STORAGE_BUDGET_BYTES)).toBe(true)

    // Non-integers & negative numbers
    expect(validateStorageBudgetBytes(-1000)).toBe(false)
    expect(validateStorageBudgetBytes(1_500_000_000.5)).toBe(false)
    expect(validateStorageBudgetBytes('3000000000')).toBe(false)
  })

  it('STORAGE-05: handles corrupt JSON gracefully by falling back to default', () => {
    const filePath = join(tempDir, STORAGE_SETTINGS_FILENAME)
    writeFileSync(filePath, '{ corrupt json invalid', 'utf8')

    const config = readStorageSettings(tempDir)
    expect(config.maxDatabaseBytes).toBe(DEFAULT_STORAGE_BUDGET.maxDatabaseBytes)
  })

  it('STORAGE-06: maintains isolation between storage and embedding settings', () => {
    // Write storage settings
    writeStorageSettings(tempDir, { preset: '3gb' })
    expect(existsSync(join(tempDir, STORAGE_SETTINGS_FILENAME))).toBe(true)
    expect(existsSync(join(tempDir, EMBEDDING_SETTINGS_FILENAME))).toBe(false)

    // Write embedding settings
    writeActiveEmbeddingConfig(tempDir, 'high')
    expect(existsSync(join(tempDir, EMBEDDING_SETTINGS_FILENAME))).toBe(true)

    // Storage settings are untouched
    const storageConfig = readStorageSettings(tempDir)
    expect(storageConfig.preset).toBe('3gb')
    expect(storageConfig.maxDatabaseBytes).toBe(3_000_000_000)

    // Embedding settings are untouched
    const embeddingProfile = readEmbeddingProfileId(tempDir)
    expect(embeddingProfile).toBe('high')
  })

  it('STORAGE-07: MaintenanceScheduler supports live budget updates without restart', () => {
    const dbPath = join(tempDir, 'test.db')
    const db = openDatabase(dbPath)
    applyCanonicalSchemaV3(db)

    const mockStore: any = {
      dbPath,
      getStorageFreelistStats: () => ({ reclaimableBytes: 0 }),
    }

    const scheduler = new MaintenanceScheduler({
      store: mockStore,
      budget: createStorageBudget(1_000_000_000),
    })

    expect(scheduler.budget.maxDatabaseBytes).toBe(1_000_000_000)

    // Update budget live
    const newBudget = createStorageBudget(5_000_000_000)
    const snap = scheduler.setBudget(newBudget)

    expect(scheduler.budget.maxDatabaseBytes).toBe(5_000_000_000)
    expect(snap.budgetBytes).toBe(5_000_000_000)

    db.close()
  })

  it('STORAGE-08: DiagnosticsRepository reflects custom runtime storage budget', () => {
    const dbPath = join(tempDir, 'diag-test.db')
    const db = openDatabase(dbPath)
    applyCanonicalSchemaV3(db)

    const diagRepo = new DiagnosticsRepository(db, dbPath)
    const customBudget = createStorageBudget(1_000_000_000) // 1 GB

    const diag = diagRepo.getStorageDiagnostics(undefined, customBudget)
    expect(diag.budgetBytes).toBe(1_000_000_000)

    const snap = diagRepo.getStorageBudgetSnapshot(customBudget)
    expect(snap.budgetBytes).toBe(1_000_000_000)

    db.close()
  })
})
