import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getEventLoopMetrics,
  getSqliteTimingSummary,
  recordSqliteTiming,
  resetSqliteTiming,
  SQLITE_CRITICAL_THRESHOLD_MS,
  SQLITE_RING_BUFFER_CAPACITY,
  SQLITE_SLOW_THRESHOLD_MS,
} from '../src/main/document-memory/sqlite-timing'
import { DocumentMemoryStore } from '../src/main/document-memory/store'

describe('SQLite Latency Timing Telemetry & Event Loop Monitor', () => {
  beforeEach(() => {
    resetSqliteTiming()
  })

  describe('Thresholds & Ring Buffer', () => {
    it('defines standard slow and critical thresholds', () => {
      expect(SQLITE_SLOW_THRESHOLD_MS).toBe(16)
      expect(SQLITE_CRITICAL_THRESHOLD_MS).toBe(50)
      expect(SQLITE_RING_BUFFER_CAPACITY).toBe(100)
    })

    it('does not record operations below slow threshold into ring buffer', () => {
      recordSqliteTiming('stats', 5) // 5 ms < 16 ms

      const summary = getSqliteTimingSummary()
      expect(summary.totalOperations).toBe(1)
      expect(summary.slowOperations).toBe(0)
      expect(summary.criticalOperations).toBe(0)
      expect(summary.recentSlow).toHaveLength(0)
      expect(summary.operations['stats']?.count).toBe(1)
      expect(summary.operations['stats']?.slowCount).toBe(0)
    })

    it('records slow operations (> 16 ms) into ring buffer with severity=slow', () => {
      recordSqliteTiming('searchLexical', 25, 'query: hello') // 25 ms > 16 ms, <= 50 ms

      const summary = getSqliteTimingSummary()
      expect(summary.totalOperations).toBe(1)
      expect(summary.slowOperations).toBe(1)
      expect(summary.criticalOperations).toBe(0)
      expect(summary.recentSlow).toHaveLength(1)

      const record = summary.recentSlow[0]!
      expect(record.operation).toBe('searchLexical')
      expect(record.durationMs).toBe(25)
      expect(record.detail).toBe('query: hello')
      expect(record.severity).toBe('slow')
    })

    it('records critical operations (> 50 ms) into ring buffer with severity=critical', () => {
      recordSqliteTiming('replace slice', 75, 'doc: test.pdf') // 75 ms > 50 ms

      const summary = getSqliteTimingSummary()
      expect(summary.totalOperations).toBe(1)
      expect(summary.slowOperations).toBe(1)
      expect(summary.criticalOperations).toBe(1)
      expect(summary.recentSlow).toHaveLength(1)

      const record = summary.recentSlow[0]!
      expect(record.operation).toBe('replace slice')
      expect(record.durationMs).toBe(75)
      expect(record.severity).toBe('critical')
    })

    it('enforces ring buffer maximum capacity of 100 entries FIFO', () => {
      const overflowCount = 120
      for (let i = 1; i <= overflowCount; i++) {
        recordSqliteTiming('FTS step', 20, `step-${i}`)
      }

      const summary = getSqliteTimingSummary()
      expect(summary.totalOperations).toBe(overflowCount)
      expect(summary.slowOperations).toBe(overflowCount)
      expect(summary.recentSlow).toHaveLength(SQLITE_RING_BUFFER_CAPACITY)

      // First entry should be step-21 (first 20 were shifted out)
      expect(summary.recentSlow[0]?.detail).toBe('step-21')
      // Last entry should be step-120
      expect(summary.recentSlow[SQLITE_RING_BUFFER_CAPACITY - 1]?.detail).toBe('step-120')
    })
  })

  describe('Event Loop Monitor', () => {
    it('returns event loop metrics with valid numbers and no NaN', () => {
      const metrics = getEventLoopMetrics()

      expect(metrics).toHaveProperty('p50')
      expect(metrics).toHaveProperty('p95')
      expect(metrics).toHaveProperty('p99')
      expect(metrics).toHaveProperty('max')

      expect(typeof metrics.p50).toBe('number')
      expect(typeof metrics.p95).toBe('number')
      expect(typeof metrics.p99).toBe('number')
      expect(typeof metrics.max).toBe('number')

      expect(Number.isFinite(metrics.p50)).toBe(true)
      expect(Number.isFinite(metrics.p95)).toBe(true)
      expect(Number.isFinite(metrics.p99)).toBe(true)
      expect(Number.isFinite(metrics.max)).toBe(true)

      expect(metrics.p50).toBeGreaterThanOrEqual(0)
      expect(metrics.max).toBeGreaterThanOrEqual(0)
    })
  })

  describe('DocumentMemoryStore Instrumentation', () => {
    let tempDir: string
    let store: DocumentMemoryStore

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'genoffice-store-timing-'))
      store = new DocumentMemoryStore(join(tempDir, 'test.db'), { role: 'main' })
      resetSqliteTiming()
    })

    afterEach(() => {
      store.close()
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // cleanup
      }
    })

    it('instruments core operations in DocumentMemoryStore', () => {
      // 1. stats
      store.stats()

      // 2. folderChunkProgress
      store.folderChunkProgress()

      // 3. searchLexical
      store.searchLexical('test query')

      // 4. FTS step
      store.mergeFtsStep()

      // 5. GC step
      store.cleanupDanglingBuildingSets()

      // 6. embedding-count rebuild
      store.backfillCounters()

      const summary = getSqliteTimingSummary()

      expect(summary.operations['stats']?.count).toBeGreaterThanOrEqual(1)
      expect(summary.operations['folderChunkProgress']?.count).toBeGreaterThanOrEqual(1)
      expect(summary.operations['searchLexical']?.count).toBeGreaterThanOrEqual(1)
      expect(summary.operations['FTS step']?.count).toBeGreaterThanOrEqual(1)
      expect(summary.operations['GC step']?.count).toBeGreaterThanOrEqual(1)
      expect(summary.operations['embedding-count rebuild']?.count).toBeGreaterThanOrEqual(1)
    })
  })
})
