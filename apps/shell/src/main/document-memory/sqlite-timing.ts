import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

export type EventLoopDelayMonitor = ReturnType<typeof monitorEventLoopDelay>

export const SQLITE_SLOW_THRESHOLD_MS = 16
export const SQLITE_CRITICAL_THRESHOLD_MS = 50
export const SQLITE_RING_BUFFER_CAPACITY = 100

export interface SqliteTimingRecord {
  operation: string
  durationMs: number
  detail?: string
  timestamp: number
  severity: 'slow' | 'critical'
}

export interface SqliteOperationStats {
  count: number
  slowCount: number
  criticalCount: number
  totalDurationMs: number
  maxDurationMs: number
  avgDurationMs: number
}

export interface SqliteTimingSummary {
  totalOperations: number
  slowOperations: number
  criticalOperations: number
  recentSlow: SqliteTimingRecord[]
  operations: Record<string, SqliteOperationStats>
}

let totalOps = 0
let slowOps = 0
let criticalOps = 0
const slowRingBuffer: SqliteTimingRecord[] = []
const opStatsMap = new Map<string, {
  count: number
  slowCount: number
  criticalCount: number
  totalDurationMs: number
  maxDurationMs: number
}>()

export function recordSqliteTiming(operation: string, durationMs: number, detail?: string): void {
  const roundedMs = Math.round(durationMs * 100) / 100
  totalOps++

  let stats = opStatsMap.get(operation)
  if (!stats) {
    stats = {
      count: 0,
      slowCount: 0,
      criticalCount: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
    }
    opStatsMap.set(operation, stats)
  }

  stats.count++
  stats.totalDurationMs = Math.round((stats.totalDurationMs + roundedMs) * 100) / 100
  stats.maxDurationMs = Math.max(stats.maxDurationMs, roundedMs)

  if (roundedMs > SQLITE_SLOW_THRESHOLD_MS) {
    slowOps++
    stats.slowCount++

    const isCritical = roundedMs > SQLITE_CRITICAL_THRESHOLD_MS
    if (isCritical) {
      criticalOps++
      stats.criticalCount++
    }

    const record: SqliteTimingRecord = {
      operation,
      durationMs: roundedMs,
      detail,
      timestamp: Date.now(),
      severity: isCritical ? 'critical' : 'slow',
    }

    if (slowRingBuffer.length >= SQLITE_RING_BUFFER_CAPACITY) {
      slowRingBuffer.shift()
    }
    slowRingBuffer.push(record)
  }
}

export function getSqliteTimingSummary(): SqliteTimingSummary {
  const operations: Record<string, SqliteOperationStats> = {}

  for (const [op, stat] of opStatsMap.entries()) {
    operations[op] = {
      count: stat.count,
      slowCount: stat.slowCount,
      criticalCount: stat.criticalCount,
      totalDurationMs: stat.totalDurationMs,
      maxDurationMs: stat.maxDurationMs,
      avgDurationMs: stat.count > 0 ? Math.round((stat.totalDurationMs / stat.count) * 100) / 100 : 0,
    }
  }

  return {
    totalOperations: totalOps,
    slowOperations: slowOps,
    criticalOperations: criticalOps,
    recentSlow: [...slowRingBuffer],
    operations,
  }
}

export function resetSqliteTiming(): void {
  totalOps = 0
  slowOps = 0
  criticalOps = 0
  slowRingBuffer.length = 0
  opStatsMap.clear()
}

export function measureSqlite<T>(operation: string, fn: () => T, detail?: string): T {
  const started = performance.now()
  try {
    return fn()
  } finally {
    const durationMs = performance.now() - started
    recordSqliteTiming(operation, durationMs, detail)
  }
}

export async function measureSqliteAsync<T>(
  operation: string,
  fn: () => Promise<T>,
  detail?: string,
): Promise<T> {
  const started = performance.now()
  try {
    return await fn()
  } finally {
    const durationMs = performance.now() - started
    recordSqliteTiming(operation, durationMs, detail)
  }
}

// --- Event Loop Monitoring ---

let eventLoopMonitor: EventLoopDelayMonitor | null = null

export function initEventLoopMonitor(resolution = 20): EventLoopDelayMonitor {
  if (!eventLoopMonitor) {
    eventLoopMonitor = monitorEventLoopDelay({ resolution })
    eventLoopMonitor.enable()
  }
  return eventLoopMonitor
}

export function getEventLoopMetrics(): { p50: number; p95: number; p99: number; max: number } {
  const monitor = eventLoopMonitor ?? initEventLoopMonitor()

  const toMs = (ns: number): number => {
    if (!Number.isFinite(ns) || ns <= 0) return 0
    return Math.round((ns / 1_000_000) * 100) / 100
  }

  return {
    p50: toMs(monitor.percentile(50)),
    p95: toMs(monitor.percentile(95)),
    p99: toMs(monitor.percentile(99)),
    max: toMs(monitor.max),
  }
}

export function resetEventLoopMonitor(): void {
  if (eventLoopMonitor) {
    eventLoopMonitor.reset()
  }
}
