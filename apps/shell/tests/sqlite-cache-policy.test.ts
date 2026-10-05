import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentMemoryStore } from '../src/main/document-memory/store'
import {
  defaultSqliteCacheKiB,
  MEMORY_TIER_POLICIES,
  memoryTierFromTotal,
} from '../src/main/document-memory/memory-tier'

describe('SQLite Page Cache Policy & Connection Roles', () => {
  let tempDirs: string[] = []

  const createTempStore = (options: Parameters<typeof DocumentMemoryStore['prototype']['constructor']>[1] = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'cache-policy-test-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'test.db')
    return new DocumentMemoryStore(dbPath, options)
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    }
    tempDirs = []
  })

  it('configures distinct cache tiers for low (4GB), normal (8GB), and high (16GB+) memory', () => {
    expect(MEMORY_TIER_POLICIES.low.sqliteSearchCacheKiB).toBe(8192)
    expect(MEMORY_TIER_POLICIES.low.sqliteWorkerCacheKiB).toBe(4096)

    expect(MEMORY_TIER_POLICIES.normal.sqliteSearchCacheKiB).toBe(24576)
    expect(MEMORY_TIER_POLICIES.normal.sqliteWorkerCacheKiB).toBe(8192)

    expect(MEMORY_TIER_POLICIES.high.sqliteSearchCacheKiB).toBe(49152)
    expect(MEMORY_TIER_POLICIES.high.sqliteWorkerCacheKiB).toBe(16384)

    // Helper mapping
    expect(defaultSqliteCacheKiB('search', 'low')).toBe(8192)
    expect(defaultSqliteCacheKiB('worker', 'low')).toBe(4096)
    expect(defaultSqliteCacheKiB('search', 'normal')).toBe(24576)
    expect(defaultSqliteCacheKiB('worker', 'normal')).toBe(8192)
  })

  it('sets negative PRAGMA cache_size (KiB) based on role', () => {
    const searchStore = createTempStore({ role: 'search' })
    const workerStore = createTempStore({ role: 'worker' })

    const searchRow = searchStore.rawDb.prepare('PRAGMA cache_size').get() as { cache_size: number }
    const workerRow = workerStore.rawDb.prepare('PRAGMA cache_size').get() as { cache_size: number }

    // Negative value indicates KiB budget in SQLite
    expect(searchRow.cache_size).toBeLessThan(0)
    expect(workerRow.cache_size).toBeLessThan(0)

    // Worker cache budget is smaller than search cache budget
    expect(Math.abs(workerRow.cache_size)).toBeLessThanOrEqual(Math.abs(searchRow.cache_size))

    searchStore.close()
    workerStore.close()
  })

  it('allows explicit cacheKiB override in constructor options', () => {
    const customStore = createTempStore({ cacheKiB: 12345 })
    const row = customStore.rawDb.prepare('PRAGMA cache_size').get() as { cache_size: number }

    expect(row.cache_size).toBe(-12345)
    customStore.close()
  })
})
