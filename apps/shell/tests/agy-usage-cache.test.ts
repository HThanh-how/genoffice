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

  it('F1/F2: the quota is read from the configured executable, not from an auto-detected one', async () => {
    const path = cachePath()
    const read = vi.fn(async (cliPath?: string) => reading(cliPath === '/cli/a' ? 0.9 : 0.1, 100))
    const cache = new AgyUsageCache(
      read,
      path,
      () => 100,
      () => {},
      () => '/cli/a',
    )
    await cache.refresh()
    expect(read.mock.calls.map(([cliPath]) => cliPath)).toEqual(['/cli/a'])
    expect(cache.get().groups?.[0]?.buckets[0]?.remaining).toBe(0.9)

    const auto = new AgyUsageCache(
      read,
      cachePath(),
      () => 100,
      () => {},
      () => undefined,
    )
    await auto.refresh()
    expect(read.mock.calls.at(-1)?.[0]).toBeUndefined()
  })

  it('F3/F4: pointing Antigravity at another executable drops the previous quota instead of reusing it', async () => {
    const path = cachePath()
    let cli = '/cli/a'
    const read = vi.fn(async (cliPath?: string) =>
      reading(cliPath === '/cli/a' ? 0.9 : cliPath === '/cli/b' ? 0.2 : 0.5, 100),
    )
    const cache = new AgyUsageCache(
      read,
      path,
      () => 100,
      () => {},
      () => cli,
    )
    await cache.refresh()
    expect(cache.get().groups?.[0]?.buckets[0]?.remaining).toBe(0.9)
    cli = '/cli/b'
    const afterSwitch = cache.get()
    expect(afterSwitch.groups).toBeNull() // A's numbers are not B's quota
    expect(afterSwitch.refreshing).toBe(true)
    const done = await cache.refresh()
    expect(done.groups?.[0]?.buckets[0]?.remaining).toBe(0.2)
    cli = undefined
    const backToAuto = cache.get()
    expect(backToAuto.groups).toBeNull()
    expect((await cache.refresh()).groups?.[0]?.buckets[0]?.remaining).toBe(0.5)
  })

  it("F5: a quota read that fails after a CLI switch reports failure rather than the old CLI's numbers", async () => {
    const path = cachePath()
    let cli = '/cli/a'
    const read = vi.fn(async (cliPath?: string) =>
      cliPath === '/cli/a' ? reading(0.9, 100) : null,
    )
    const cache = new AgyUsageCache(
      read,
      path,
      () => 100,
      () => {},
      () => cli,
    )
    await cache.refresh()
    cli = '/cli/b'
    const failed = await cache.refresh()
    expect(failed.failed).toBe(true)
    expect(failed.groups).toBeNull()
  })

  it('F6: a cache written by one CLI is not presented as the quota of another before it answers', async () => {
    const path = cachePath()
    writeFileSync(
      path,
      JSON.stringify({ groups: reading(0.9, 100).groups, readAt: 100, cliKey: '/cli/a' }),
      'utf8',
    )
    const read = vi.fn(async () => reading(0.3, 200))
    const cache = new AgyUsageCache(
      read,
      path,
      () => 200,
      () => {},
      () => '/cli/b',
    )
    const first = cache.get()
    expect(first.groups).toBeNull()
    expect(first.refreshing).toBe(true)
    expect((await cache.refresh()).groups?.[0]?.buckets[0]?.remaining).toBe(0.3)
    // the file now records which executable the numbers belong to
    const restored = new AgyUsageCache(
      read,
      path,
      () => 200,
      () => {},
      () => '/cli/b',
    )
    expect(restored.get().groups?.[0]?.buckets[0]?.remaining).toBe(0.3)
  })
})
