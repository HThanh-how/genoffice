import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LEGACY_INDEX_EVIDENCE_BYTES,
  MAX_STORAGE_BUDGET_BYTES,
  MIN_STORAGE_BUDGET_BYTES,
  STORAGE_PRESET_BYTES,
  STORAGE_SETTINGS_FILENAME,
  ensureStorageSettings,
  readStorageSettings,
  recommendStoragePreset,
  validateStorageBudgetBytes,
  writeStorageSettings,
} from '../src/main/document-memory/storage/storage-settings'
import { memoryTierFromTotal } from '../src/main/document-memory/memory-tier'
import { DEFAULT_STORAGE_BUDGET, createStorageBudget, hardCapBytes } from '../src/main/document-memory/storage-budget'
import { StorageBudgetCoordinator } from '../src/main/document-memory/runtime/storage-budget-coordinator'
import { MaintenanceScheduler } from '../src/main/document-memory/runtime/maintenance-scheduler'
import { BackupRetentionRunner } from '../src/main/document-memory/runtime/backup-retention-runner'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import { EMBEDDING_PROFILES } from '../src/main/document-memory/embedding-profiles'
import { registerDocumentIndexStorageHandlers } from '../src/main/fork/document-index-storage-handlers'
import { DOCUMENT_INDEX_CHANNELS } from '../src/shared/fork/document-index-api'
import {
  ESTIMATED_CHUNKS_PER_DOC,
  LEXICAL_BYTES_PER_DOC,
  QUOTA_MAX_BYTES,
  QUOTA_MIN_BYTES,
  QUOTA_PRESET_BYTES,
  VECTOR_ROW_OVERHEAD_BYTES,
  bytesPerVector,
  estimateDocumentCapacity,
  formatQuotaBytes,
  isQuotaInRange,
  recommendQuotaPreset,
} from '../src/shared/fork/storage-estimate'
import { simulatedAccountingRunner } from './helpers/compaction-worker-harness'
import { storageBudgetAckReply } from './helpers/storage-budget-ack'

const GIB = 1024 ** 3
const GB = 1_000_000_000

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'storage-quota-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('quota presets and bounds', () => {
  it('the three presets are 1 / 3 / 5 decimal GB and the renderer constants match the main-process ones', () => {
    expect(STORAGE_PRESET_BYTES).toEqual({ '1gb': GB, '3gb': 3 * GB, '5gb': 5 * GB })
    expect(QUOTA_PRESET_BYTES).toEqual(STORAGE_PRESET_BYTES)
    expect(QUOTA_MIN_BYTES).toBe(MIN_STORAGE_BUDGET_BYTES)
    expect(QUOTA_MAX_BYTES).toBe(MAX_STORAGE_BUDGET_BYTES)
  })

  it('enforces the 500 MB minimum and the 100 GB maximum, in main and in the renderer helper', () => {
    for (const ok of [500_000_000, 500_000_001, GB, 100 * GB]) {
      expect(validateStorageBudgetBytes(ok)).toBe(true)
      expect(isQuotaInRange(ok)).toBe(true)
    }
    for (const bad of [499_999_999, 0, -1, 100 * GB + 1, Number.NaN, Infinity, 1.5 * GB + 0.5, '1000000000', null]) {
      expect(validateStorageBudgetBytes(bad)).toBe(false)
      expect(isQuotaInRange(bad)).toBe(false)
    }
    expect(() => writeStorageSettings(dir, { maxDatabaseBytes: 499_999_999, preset: 'custom' })).toThrow(/500 MB/)
    expect(existsSync(join(dir, STORAGE_SETTINGS_FILENAME))).toBe(false) // a rejected write leaves nothing behind
  })

  it('persists presets and a custom size, and a version bump only when the choice changes', () => {
    const a = writeStorageSettings(dir, { preset: '1gb' })
    expect(a).toMatchObject({ maxDatabaseBytes: GB, preset: '1gb', version: 2 })
    expect(writeStorageSettings(dir, { preset: '1gb' }).version).toBe(2)
    const b = writeStorageSettings(dir, { maxDatabaseBytes: 7_500_000_000, preset: 'custom' })
    expect(b).toMatchObject({ maxDatabaseBytes: 7_500_000_000, preset: 'custom', version: 3 })
    expect(readStorageSettings(dir)).toMatchObject({ maxDatabaseBytes: 7_500_000_000, preset: 'custom', version: 3 })
    expect(JSON.parse(readFileSync(join(dir, STORAGE_SETTINGS_FILENAME), 'utf8')).maxDatabaseBytes).toBe(7_500_000_000)
  })
})

describe('default quota of a fresh install', () => {
  it.each([
    [3.7 * GIB, '1gb'], // a 4 GB machine reports ~3.7 GiB
    [5.9 * GIB, '1gb'],
    [6 * GIB, '3gb'],
    [7.6 * GIB, '3gb'], // an 8 GB machine
    [11.9 * GIB, '3gb'],
    [12 * GIB, '5gb'],
    [31.8 * GIB, '5gb'],
  ])('%d bytes of RAM -> %s, persisted once', (totalMemBytes, preset) => {
    const config = ensureStorageSettings(dir, { totalMemBytes })
    expect(config).toMatchObject({ preset, maxDatabaseBytes: STORAGE_PRESET_BYTES[preset as '1gb'], version: 1 })
    expect(readStorageSettings(dir)).toMatchObject({ preset, version: 1 })
    // the decision is stored: more RAM later must not move it
    expect(ensureStorageSettings(dir, { totalMemBytes: 64 * GIB }).preset).toBe(preset)
  })

  it('uses the existing memory-tier boundaries (and the renderer recommendation agrees with them)', () => {
    for (const gib of [1, 3.7, 5.99, 6, 8, 11.99, 12, 16, 64]) {
      const tier = memoryTierFromTotal(gib * 1024)
      const expected = tier === 'low' ? '1gb' : tier === 'normal' ? '3gb' : '5gb'
      expect(recommendStoragePreset(gib * GIB)).toBe(expected)
      expect(recommendQuotaPreset(gib)).toBe(expected)
    }
  })

  it('never changes a saved quota: valid, custom or even unreadable files are left alone', () => {
    writeStorageSettings(dir, { maxDatabaseBytes: 2_345_000_000, preset: 'custom' })
    const before = readFileSync(join(dir, STORAGE_SETTINGS_FILENAME), 'utf8')
    expect(ensureStorageSettings(dir, { totalMemBytes: 2 * GIB }).maxDatabaseBytes).toBe(2_345_000_000)
    expect(readFileSync(join(dir, STORAGE_SETTINGS_FILENAME), 'utf8')).toBe(before)

    const corrupt = mkdtempSync(join(tmpdir(), 'storage-quota-corrupt-'))
    try {
      writeFileSync(join(corrupt, STORAGE_SETTINGS_FILENAME), '{not json', 'utf8')
      const config = ensureStorageSettings(corrupt, { totalMemBytes: 2 * GIB })
      expect(config.maxDatabaseBytes).toBe(DEFAULT_STORAGE_BUDGET.maxDatabaseBytes) // legacy default, not the 1 GB tier
      expect(readFileSync(join(corrupt, STORAGE_SETTINGS_FILENAME), 'utf8')).toBe('{not json')
    } finally {
      rmSync(corrupt, { recursive: true, force: true })
    }
  })

  it('an index that predates the setting keeps the historical 4 GiB instead of being shrunk to the RAM tier', () => {
    writeFileSync(join(dir, 'document-memory.db'), Buffer.alloc(LEGACY_INDEX_EVIDENCE_BYTES + 1))
    const config = ensureStorageSettings(dir, { totalMemBytes: 3 * GIB })
    expect(config.maxDatabaseBytes).toBe(DEFAULT_STORAGE_BUDGET.maxDatabaseBytes)
    expect(config.preset).toBe('custom')
    // a freshly created (schema-only) database does not count as an existing index
    const fresh = mkdtempSync(join(tmpdir(), 'storage-quota-fresh-'))
    try {
      writeFileSync(join(fresh, 'document-memory.db'), Buffer.alloc(300 * 1024))
      expect(ensureStorageSettings(fresh, { totalMemBytes: 3 * GIB }).preset).toBe('1gb')
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
    // a relocated index (location marker) is an existing install too
    const moved = mkdtempSync(join(tmpdir(), 'storage-quota-moved-'))
    try {
      writeFileSync(join(moved, 'document-memory-location.json'), '{"dir":"D:/idx"}')
      expect(ensureStorageSettings(moved, { totalMemBytes: 3 * GIB }).maxDatabaseBytes).toBe(DEFAULT_STORAGE_BUDGET.maxDatabaseBytes)
    } finally {
      rmSync(moved, { recursive: true, force: true })
    }
  })
})

describe('document capacity estimate', () => {
  it('is calibrated at ~40 KB per document with vectors (standard 320-dim) and 28 KB lexical-only', () => {
    const dims = EMBEDDING_PROFILES.standard.dimensions
    expect(dims).toBe(320)
    expect(bytesPerVector(dims)).toBe(320 * 4 + VECTOR_ROW_OVERHEAD_BYTES)
    expect(estimateDocumentCapacity(GB, dims).bytesPerDocument).toBe(40_000)
    expect(LEXICAL_BYTES_PER_DOC + ESTIMATED_CHUNKS_PER_DOC * bytesPerVector(dims)).toBe(40_000)
    expect(estimateDocumentCapacity(GB, 0).bytesPerDocument).toBe(28_000)
    expect(estimateDocumentCapacity(GB, null).bytesPerDocument).toBe(28_000)
  })

  it('counts documents per preset, rounded down to three significant figures', () => {
    expect(estimateDocumentCapacity(1 * GB, 320).documents).toBe(25_000)
    expect(estimateDocumentCapacity(3 * GB, 320).documents).toBe(75_000)
    expect(estimateDocumentCapacity(5 * GB, 320).documents).toBe(125_000)
    expect(estimateDocumentCapacity(1 * GB, 0).documents).toBe(35_700) // 35 714 -> 35 700
    expect(estimateDocumentCapacity(500_000_000, 320).documents).toBe(12_500)
  })

  it('a wider profile (512-dim "high") fits proportionally fewer documents; bad input fits none', () => {
    const wide = estimateDocumentCapacity(3 * GB, EMBEDDING_PROFILES.high.dimensions)
    expect(EMBEDDING_PROFILES.high.dimensions).toBe(512)
    expect(wide.bytesPerDocument).toBe(28_000 + 8 * (512 * 4 + 220))
    expect(wide.documents).toBeLessThan(estimateDocumentCapacity(3 * GB, 320).documents)
    for (const bad of [0, -5, Number.NaN, Infinity]) expect(estimateDocumentCapacity(bad, 320).documents).toBe(0)
  })

  it('formats sizes in decimal units next to the quota', () => {
    expect(formatQuotaBytes(0)).toBe('0 B')
    expect(formatQuotaBytes(840_000_000, 'en')).toBe('840 MB')
    expect(formatQuotaBytes(2_400_000_000, 'en')).toBe('2.4 GB')
    expect(formatQuotaBytes(GB, 'en')).toBe('1 GB')
  })
})

describe('changing the quota reaches the worker through the live budget path', () => {
  function makeCoordinator(opts: { onSet?: (b: ReturnType<typeof createStorageBudget>) => void } = {}) {
    const sent: any[] = []
    let budget = createStorageBudget(3 * GB)
    const coord = new StorageBudgetCoordinator({
      settingsDir: dir,
      getMaintBudget: () => budget,
      setMaintBudget: (b) => {
        budget = b
        opts.onSet?.(b)
      },
      askWorker: async (req) => {
        sent.push(req)
        return storageBudgetAckReply(req as any) as any
      },
      isStopped: () => false,
    })
    return { coord, sent, budget: () => budget }
  }

  it('a preset click persists, bumps the desired version, sends the exact budget and reopens writes on the exact ACK', async () => {
    writeStorageSettings(dir, { preset: '3gb', version: 1 })
    const { coord, sent, budget } = makeCoordinator()
    expect(await coord.onWorkerSpawned()).toBe(true)
    expect(sent.map((r) => [r.type, r.budget.maxDatabaseBytes, r.configVersion])).toEqual([['set-storage-budget', 3 * GB, 1]])

    const result = await coord.setStorageBudget({ preset: '1gb' })
    expect(result).toMatchObject({ maxDatabaseBytes: GB, preset: '1gb', version: 2, appliedVersion: 2, status: 'applied', appliedBudgetBytes: GB })
    expect(sent[1]).toMatchObject({ type: 'set-storage-budget', configVersion: 2 })
    expect(sent[1].budget).toMatchObject({ maxDatabaseBytes: GB, overshootRatio: 0.1 })
    expect(coord.isWriteReady()).toBe(true)
    expect(budget().maxDatabaseBytes).toBe(GB)
    expect(hardCapBytes(budget())).toBe(1_100_000_000)
    expect(readStorageSettings(dir)).toMatchObject({ maxDatabaseBytes: GB, preset: '1gb', version: 2 })
    coord.close()

    // restart: main reads the saved quota and the next worker gets it in the startup handshake
    const restarted = makeCoordinator()
    await restarted.coord.onWorkerSpawned()
    expect(restarted.sent[0]).toMatchObject({ configVersion: 2 })
    expect(restarted.sent[0].budget.maxDatabaseBytes).toBe(GB)
    restarted.coord.close()
  })

  it('writes stay closed while the new version is unacknowledged, and lowering never briefly admits the old larger quota', async () => {
    writeStorageSettings(dir, { preset: '5gb', version: 1 })
    const seen: number[] = []
    let release: ((reply: unknown) => void) | undefined
    const sent: any[] = []
    let budget = createStorageBudget(5 * GB)
    const coord = new StorageBudgetCoordinator({
      settingsDir: dir,
      getMaintBudget: () => budget,
      setMaintBudget: (b) => {
        budget = b
        seen.push(b.maxDatabaseBytes)
      },
      askWorker: (req) => {
        sent.push(req)
        if (sent.length === 1) return Promise.resolve(storageBudgetAckReply(req as any) as any)
        return new Promise((resolve) => (release = resolve))
      },
      isStopped: () => false,
    })
    await coord.onWorkerSpawned()
    expect(coord.isWriteReady()).toBe(true)
    seen.length = 0 // only what main enforces from the moment the user lowers the quota

    const pending = coord.setStorageBudget({ preset: '1gb' })
    await new Promise((resolve) => setTimeout(resolve, 0)) // the dispatch to the worker is queued behind the persist
    expect(release).toBeDefined()
    expect(coord.isWriteReady()).toBe(false) // gate closed until the worker confirms version 2
    expect(budget.maxDatabaseBytes).toBe(GB) // main already enforces the LOWER quota while waiting
    release!(storageBudgetAckReply(sent[1]))
    expect((await pending).status).toBe('applied')
    expect(coord.isWriteReady()).toBe(true)
    expect(seen.length).toBeGreaterThan(0)
    expect(Math.max(...seen)).toBeLessThanOrEqual(GB)
    coord.close()
  })

  it('a worker that acknowledges a stale version does not reopen the gate', async () => {
    writeStorageSettings(dir, { preset: '3gb', version: 1 })
    const sent: any[] = []
    let budget = createStorageBudget(3 * GB)
    const coord = new StorageBudgetCoordinator({
      settingsDir: dir,
      getMaintBudget: () => budget,
      setMaintBudget: (b) => (budget = b),
      askWorker: async (req) => {
        sent.push(req)
        const ack = storageBudgetAckReply(req as any)!
        return sent.length === 1 ? (ack as any) : ({ ...ack, result: { ...ack.result, appliedVersion: 1 } } as any)
      },
      isStopped: () => false,
    })
    await coord.onWorkerSpawned()
    const result = await coord.setStorageBudget({ preset: '1gb' })
    expect(result.status).toBe('error')
    expect(coord.isWriteReady()).toBe(false)
    coord.close()
  })

  it('invalid sizes are rejected before anything is persisted or sent', async () => {
    writeStorageSettings(dir, { preset: '3gb', version: 1 })
    const { coord, sent } = makeCoordinator()
    await coord.onWorkerSpawned()
    await expect(coord.setStorageBudget({ maxDatabaseBytes: 400_000_000, preset: 'custom' })).rejects.toThrow()
    await expect(coord.setStorageBudget({ maxDatabaseBytes: 101 * GB, preset: 'custom' })).rejects.toThrow()
    expect(sent).toHaveLength(1)
    expect(readStorageSettings(dir)).toMatchObject({ maxDatabaseBytes: 3 * GB, version: 1 })
    coord.close()
  })
})

describe('lowering the quota arms compaction at once', () => {
  let storeDir: string
  let store: DocumentMemoryStore
  let scheduler: MaintenanceScheduler | undefined
  beforeEach(() => {
    vi.useFakeTimers()
    storeDir = mkdtempSync(join(tmpdir(), 'storage-quota-compaction-'))
    store = new DocumentMemoryStore(join(storeDir, 'document-memory.db'))
  })
  afterEach(() => {
    scheduler?.dispose()
    store.close()
    vi.clearAllTimers()
    vi.useRealTimers()
    rmSync(storeDir, { recursive: true, force: true })
  })

  function inlineBackupRunner(): BackupRetentionRunner {
    return new BackupRetentionRunner({
      workerPath: 'inline-retention-worker',
      workerFactory: () => {
        const w: any = new EventEmitter()
        w.terminate = () => Promise.resolve(0)
        queueMicrotask(() => w.emit('message', { purgedCount: 0 }))
        return w
      },
    })
  }

  it('usage above the new hard cap -> urgent run-retention, no original file is touched, writes reopen after the ACK', async () => {
    const used = 700_000_000 // 70% of 1 GB: calm; 140% of 500 MB: over the 550 MB hard cap
    writeStorageSettings(dir, { maxDatabaseBytes: GB, preset: '1gb', version: 1 })
    const compactionRequests: any[] = []
    const budgetAcks: any[] = []
    // eslint-disable-next-line prefer-const -- read by the scheduler callbacks below before the coordinator exists
    let coord!: StorageBudgetCoordinator
    scheduler = new MaintenanceScheduler({
      store,
      budget: createStorageBudget(GB),
      storageAccountingRunner: simulatedAccountingRunner(() => used),
      backupRetentionRunner: inlineBackupRunner(),
      isWriteReady: () => coord.isWriteReady(),
      askWorker: async (req: any) => {
        compactionRequests.push(req)
        return {
          id: compactionRequests.length,
          result: {
            kind: 'run-retention', runId: req.runId, epoch: req.epoch, status: 'completed', durationMs: 1, urgency: req.urgency,
            report: null, bytesBefore: used, bytesAfter: used, belowSoftQuota: false,
            release: { vectorDocuments: 0, vectorChunks: 0, skeletonDocuments: 0, skeletonEstimatedBytes: 0 },
            affectedAnnSpaces: [], annRequests: [],
          },
        } as any
      },
    })
    coord = new StorageBudgetCoordinator({
      settingsDir: dir,
      getMaintBudget: () => scheduler!.budget,
      setMaintBudget: (b) => scheduler!.setBudget(b),
      askWorker: async (req) => {
        budgetAcks.push(req)
        return storageBudgetAckReply(req as any) as any
      },
      isStopped: () => false,
    })
    await coord.onWorkerSpawned()
    await scheduler.refreshAccountingAsync()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(compactionRequests.filter((r) => r.type === 'run-retention')).toHaveLength(0) // 70% of 1 GB: nothing to do

    await coord.setStorageBudget({ maxDatabaseBytes: MIN_STORAGE_BUDGET_BYTES, preset: 'custom' })
    expect(budgetAcks.at(-1)).toMatchObject({ type: 'set-storage-budget', configVersion: 2 })
    expect(scheduler.budget.maxDatabaseBytes).toBe(MIN_STORAGE_BUDGET_BYTES)
    expect(scheduler.getStorageBudgetSnapshot()).toMatchObject({ softBudgetBytes: 500_000_000, graceActive: false, limitState: 'full' })
    expect(used).toBeGreaterThanOrEqual(scheduler.getStorageBudgetSnapshot().hardCapBytes!)

    await vi.advanceTimersByTimeAsync(2_500)
    const runs = compactionRequests.filter((r) => r.type === 'run-retention')
    expect(runs.length).toBeGreaterThanOrEqual(1)
    expect(runs[0]).toMatchObject({ urgency: 'urgent', configVersion: 2 })
    expect(runs[0].reclaimToSoftBytes).toBe(used - MIN_STORAGE_BUDGET_BYTES)
    expect(coord.isWriteReady()).toBe(true)
    coord.close()
  })
})

describe('storage IPC handlers validate and propagate', () => {
  function register(memory: any) {
    const handlers = new Map<string, (event: unknown, input?: unknown) => Promise<any>>()
    registerDocumentIndexStorageHandlers({
      ipcMain: { handle: (channel: string, fn: any) => handlers.set(channel, fn) },
      getDocumentMemory: () => memory,
      dbPath: () => join(dir, 'document-memory.db'),
      settingsPath: () => join(dir, 'app-settings.json'),
    } as any)
    return handlers
  }

  it('rejects out-of-range sizes without touching the settings, and applies a preset through the memory manager', async () => {
    const { coord } = (() => {
      const c = new StorageBudgetCoordinator({
        settingsDir: dir,
        getMaintBudget: () => createStorageBudget(GB),
        setMaintBudget: () => {},
        askWorker: async (req) => storageBudgetAckReply(req as any) as any,
        isStopped: () => false,
      })
      return { coord: c }
    })()
    await coord.onWorkerSpawned()
    const handlers = register({ getStorageBudgetConfig: () => coord.getConfig(), setStorageBudget: (i: unknown) => coord.setStorageBudget(i as any) })
    const set = handlers.get(DOCUMENT_INDEX_CHANNELS.setStorageBudgetSettings)!
    const get = handlers.get(DOCUMENT_INDEX_CHANNELS.getStorageBudgetSettings)!

    expect(await set({}, { maxDatabaseBytes: 100_000_000, preset: 'custom' })).toEqual({ ok: false, error: 'invalid-budget-range' })
    expect(await set({}, 'x')).toEqual({ ok: false, error: 'invalid-argument' })
    const before = (await get({})).version

    const ok = await set({}, { preset: '5gb' })
    expect(ok).toMatchObject({ ok: true, settings: { maxDatabaseBytes: 5 * GB, preset: '5gb', status: 'applied' } })
    expect((await get({})).version).toBe(before + 1)
    coord.close()
  })

  it('without a running manager the getter still yields the RAM-tier default for a fresh install and persists it', async () => {
    const handlers = register(null)
    const config = await handlers.get(DOCUMENT_INDEX_CHANNELS.getStorageBudgetSettings)!({})
    expect(['1gb', '3gb', '5gb']).toContain(config.preset)
    expect(config.preset).toBe(recommendStoragePreset())
    expect(existsSync(join(dir, STORAGE_SETTINGS_FILENAME))).toBe(true)
  })
})
