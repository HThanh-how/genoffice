import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSourceAvailabilityProbe } from '../src/main/document-memory/source-availability'

afterEach(() => vi.useRealTimers())
describe('Source availability probe', () => {
  it('bounds UI waits while reusing a network lookup that has not returned', async () => {
    vi.useFakeTimers()
    let release!: (available: boolean) => void
    const lookup = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        }),
    )
    const probe = createSourceAvailabilityProbe(lookup, 100, 1000)
    const first = probe('Z:/')
    await vi.advanceTimersByTimeAsync(100)
    expect(await first).toBe(true)
    await vi.advanceTimersByTimeAsync(1001)
    const second = probe('Z:/')
    await vi.advanceTimersByTimeAsync(100)
    expect(await second).toBe(true)
    expect(lookup).toHaveBeenCalledTimes(1)
    release(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(await probe('Z:/')).toBe(false)
  })
  it('refreshes a previously offline source and shares a healthy cached result', async () => {
    vi.useFakeTimers()
    const lookup = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    const probe = createSourceAvailabilityProbe(lookup, 100, 1000)
    expect(await probe('Z:/')).toBe(true)
    expect(await probe('Z:/')).toBe(true)
    expect(lookup).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await probe('Z:/')).toBe(false)
    expect(lookup).toHaveBeenCalledTimes(2)
  })
})
