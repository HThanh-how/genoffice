import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureDocumentMemoryStorageReady,
  type StorageBootstrapProgress,
} from '../src/main/document-memory/storage-bootstrap'
import { runStorageBootstrapOffThread } from '../src/main/document-memory/runtime/storage-bootstrap-runner'
import { buildLegacyV2Database } from './helpers/legacy-v2-fixture'

/**
 * The V2 -> V3 migration (and the health check of a big V3 database) is synchronous SQLite work. Run on the Electron
 * main thread it freezes every window until it ends: a white, unresponsive window, for minutes on a multi-gigabyte
 * index (reported on 0.11.104). These tests run the real migration and watch the event loop of *this* thread, which
 * is the stand-in for the main thread.
 */

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-bootstrap-loop-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Longest gap between two ticks of a 10 ms timer while `work` runs (a free loop never exceeds ~20 ms). */
async function maxLoopGapDuring<T>(
  work: () => Promise<T>,
): Promise<{ value: T; maxGapMs: number; durationMs: number }> {
  let last = performance.now()
  let maxGapMs = 0
  const timer = setInterval(() => {
    const now = performance.now()
    maxGapMs = Math.max(maxGapMs, now - last)
    last = now
  }, 10)
  const started = performance.now()
  last = started
  try {
    const value = await work()
    maxGapMs = Math.max(maxGapMs, performance.now() - last)
    return { value, maxGapMs, durationMs: performance.now() - started }
  } finally {
    clearInterval(timer)
  }
}

describe('document-memory storage bootstrap does not block the calling thread', () => {
  it('control: the in-process bootstrap freezes the loop for most of the migration', async () => {
    buildLegacyV2Database(join(dir, 'document-memory.db'), 120, 60)
    const { value, maxGapMs, durationMs } = await maxLoopGapDuring(() =>
      ensureDocumentMemoryStorageReady(dir, { settingsDir: dir }),
    )
    expect(value.migrated).toBe(true)
    // proves the harness can see a block: one long uninterrupted stall
    expect(maxGapMs).toBeGreaterThan(durationMs * 0.5)
  }, 120_000)

  it('the worker-thread bootstrap migrates the same database while the loop keeps ticking', async () => {
    buildLegacyV2Database(join(dir, 'document-memory.db'), 120, 60)
    const progress: StorageBootstrapProgress[] = []
    const { value, maxGapMs, durationMs } = await maxLoopGapDuring(() =>
      runStorageBootstrapOffThread(
        dir,
        { settingsDir: dir },
        { onProgress: (p) => progress.push(p), progressIntervalMs: 0 },
      ),
    )
    expect(value.error).toBeUndefined()
    expect(value.ready).toBe(true)
    expect(value.migrated).toBe(true)
    expect(value.migrationResult?.documentsCopied).toBe(120)
    // the V2 file is kept as the rollback backup, and a V3 database is in its place
    expect(existsSync(join(dir, 'document-memory.db'))).toBe(true)
    expect(readdirSync(dir).some((name) => /\.v2\..*backup\.db$/.test(name))).toBe(true)
    // the loop never stalled for anything like the duration of the migration
    expect(durationMs).toBeGreaterThan(300)
    expect(maxGapMs).toBeLessThan(Math.min(400, durationMs * 0.25))
    // progress reached the caller, in order, ending past 90%
    const migrating = progress.filter((p) => p.phase === 'migrating').map((p) => p.percent ?? 0)
    expect(migrating.length).toBeGreaterThan(2)
    expect([...migrating].sort((a, b) => a - b)).toEqual(migrating)
    expect(migrating[migrating.length - 1]).toBeGreaterThanOrEqual(90)
    expect(progress[0]?.phase).toBe('checking')
    expect(progress.some((p) => p.phase === 'finalizing')).toBe(true)
  }, 120_000)

  it('a database that cannot be migrated comes back fail-closed through the worker too', async () => {
    // a file that is not a database: the bootstrap must report not-ready, never throw into the caller
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'document-memory.db'), 'this is not a sqlite database')
    const result = await runStorageBootstrapOffThread(dir, { settingsDir: dir })
    expect(result.ready).toBe(false)
    expect(result.migrated).toBe(false)
    expect(result.error).toBeTruthy()
  }, 60_000)

  it('an empty directory is simply ready (nothing to migrate)', async () => {
    await expect(runStorageBootstrapOffThread(dir, { settingsDir: dir })).resolves.toEqual({
      ready: true,
      migrated: false,
    })
  }, 60_000)
})
