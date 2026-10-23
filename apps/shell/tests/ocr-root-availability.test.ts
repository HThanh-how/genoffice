import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RootAvailability, rootAvailability } from '../src/main/document-memory/root-availability'
import { watchRootAvailability } from '../src/main/document-memory/runtime/root-lifecycle'

afterEach(() => vi.useRealTimers())

describe('root availability state machine', () => {
  it('probes indefinitely with 1m, 5m, 15m, 1h backoff, including weeks away', async () => {
    let now = 1_000
    let online = false
    const probe = vi.fn(async () => online)
    const roots = new RootAvailability(probe, () => now)
    const root = join(process.cwd(), 'synthetic-share')
    roots.register(root)
    const recovered = vi.fn()
    roots.onRecovered(recovered)
    for (const delay of [60_000, 300_000, 900_000, ...Array<number>(24 * 21).fill(3_600_000)]) {
      await roots.probeDue()
      const state = roots.snapshot()[0]!
      expect(state).toMatchObject({
        online: false,
        offlineSince: 1_000,
        lastProbeAt: now,
        nextProbeAt: now + delay,
      })
      expect(await roots.checkPath(join(root, 'scan.pdf'))).toBe(false)
      now += delay
    }
    online = true
    await roots.probeDue()
    expect(recovered).toHaveBeenCalledExactlyOnceWith(root)
    expect(roots.selectable(join(root, 'scan.pdf'))).toBe(true)
    expect(roots.snapshot()[0]?.offlineSince).toBeNull()
    await roots.probeDue()
    expect(recovered).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledTimes(508)
  })

  it('a timed-out native probe remains single-flight even after days and forced checks', async () => {
    vi.useFakeTimers()
    let complete!: (online: boolean) => void
    const probe = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve
        }),
    )
    const roots = new RootAvailability(probe, Date.now, 100)
    const root = join(process.cwd(), 'synthetic-hung-share')
    const first = roots.check(root)
    const concurrent = roots.check(root, true)
    expect(first).toBe(concurrent)
    await vi.advanceTimersByTimeAsync(100)
    expect(await first).toBe(false)
    await vi.advanceTimersByTimeAsync(7 * 86400_000)
    expect(await roots.check(root, true)).toBe(false)
    expect(probe).toHaveBeenCalledTimes(1)
    const recovered = vi.fn()
    roots.onRecovered(recovered)
    complete(true)
    await Promise.resolve()
    await Promise.resolve()
    await vi.runAllTimersAsync()
    expect(recovered).toHaveBeenCalledExactlyOnceWith(root)
    expect(roots.snapshot()[0]?.online).toBe(true)
  })

  it('coalesces root checks across files and debounces resume/focus/online checks', async () => {
    let now = 0
    const probe = vi.fn(async () => false)
    const roots = new RootAvailability(probe, () => now)
    const root = join(process.cwd(), 'synthetic-mount')
    roots.register(root)
    await Promise.all(
      Array.from({ length: 1454 }, (_, i) => roots.checkPath(join(root, `${i}.pdf`))),
    )
    expect(probe).toHaveBeenCalledTimes(1)
    await roots.probeDue(true)
    await roots.probeDue(true)
    expect(probe).toHaveBeenCalledTimes(2)
    now = 5001
    await roots.probeDue(true)
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('wires resume and window focus to immediate probes and removes listeners on quit', async () => {
    const app = new EventEmitter()
    const power = new EventEmitter()
    const check = vi.spyOn(rootAvailability, 'probeDue').mockResolvedValue()
    watchRootAvailability(app, power)
    power.emit('resume')
    app.emit('browser-window-focus')
    expect(check).toHaveBeenCalledTimes(2)
    expect(check).toHaveBeenCalledWith(true)
    app.emit('will-quit')
    power.emit('resume')
    app.emit('browser-window-focus')
    expect(check).toHaveBeenCalledTimes(2)
    check.mockRestore()
  })

  it('reconciliation and repeated scans respect offline backoff', async () => {
    let now = 0
    const probe = vi.fn(async () => false)
    const roots = new RootAvailability(probe, () => now)
    const root = join(process.cwd(), 'synthetic-offline-reconcile')
    roots.register(root)
    await roots.check(root)
    for (now = 5_001; now < 60_000; now += 5_001) {
      expect(await roots.confirmPath(join(root, 'scan.pdf'))).toBe(false)
      expect(await roots.check(root)).toBe(false)
    }
    expect(probe).toHaveBeenCalledTimes(1)
    now = 60_000
    await roots.probeDue()
    expect(probe).toHaveBeenCalledTimes(2)
  })
})
