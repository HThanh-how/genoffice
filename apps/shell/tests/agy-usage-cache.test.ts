import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { whenReady: () => new Promise(() => {}) },
}))
import { AgyUsageCache, AGY_USAGE_FRESH_MS } from '../src/main/fork/agy-chat-ipc'

const dirs: string[] = []
function cachePath() {
  const dir = mkdtempSync(join(tmpdir(), 'agy-usage-'))
  dirs.push(dir)
  return join(dir, 'cache.json')
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const reading = (remaining: number, readAt: number) => ({
  groups: [{ name: 'Gemini Models', buckets: [{ window: '5h' as const, remaining }] }],
  readAt,
})

describe('AgyUsageCache (stale-while-revalidate)', () => {
  it('answers at once from the saved reading and refreshes it behind the scenes', async () => {
    const path = cachePath()
    writeFileSync(path, JSON.stringify({ groups: reading(0.5, 1000).groups, readAt: 1000 }))
    const now = 1000 + AGY_USAGE_FRESH_MS + 1
    const read = vi.fn(async () => reading(0.4, now))
    const seen: boolean[] = []
    const cache = new AgyUsageCache(
      read,
      path,
      () => now,
      (s) => seen.push(s.refreshing),
    )

    const first = cache.get()
    expect(first.groups?.[0]?.buckets[0]?.remaining).toBe(0.5) // stale numbers shown immediately
    expect(first.refreshing).toBe(true)
    const done = await cache.refresh()
    expect(done.groups?.[0]?.buckets[0]?.remaining).toBe(0.4)
    expect(done.refreshing).toBe(false)
    expect(read).toHaveBeenCalledTimes(1) // get() and refresh() shared one read
    expect(seen).toContain(true)
    expect(seen.at(-1)).toBe(false)
  })

  it('does not re-read while the reading is fresh, and keeps old numbers when a read fails', async () => {
    const path = cachePath()
    let now = 5_000
    let ok = true
    const read = vi.fn(async () => (ok ? reading(0.7, now) : null))
    const cache = new AgyUsageCache(
      read,
      path,
      () => now,
      () => {},
    )
    await cache.refresh()
    expect(read).toHaveBeenCalledTimes(1)
    now += 60_000
    cache.get()
    expect(read).toHaveBeenCalledTimes(1)
    ok = false
    const failed = await cache.refresh()
    expect(failed.failed).toBe(true)
    expect(failed.groups?.[0]?.buckets[0]?.remaining).toBe(0.7)
  })
})
