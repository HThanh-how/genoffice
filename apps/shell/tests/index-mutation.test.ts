import { afterEach, describe, expect, it, vi } from 'vitest'
import { IndexMutationTimeout, runIndexMutation } from '../src/renderer/src/fork/index-mutation'

afterEach(() => vi.useRealTimers())

describe('Index mutation deadline', () => {
  it('releases a hung UI action without issuing the mutation again', async () => {
    vi.useFakeTimers()
    const request = vi.fn(() => new Promise<never>(() => {}))
    const result = runIndexMutation(request, 100)
    const assertion = expect(result).rejects.toBeInstanceOf(IndexMutationTimeout)
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    await vi.advanceTimersByTimeAsync(5000)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('accepts an acknowledgment and clears its deadline', async () => {
    vi.useFakeTimers()
    await expect(runIndexMutation(async () => ({ queued: 2 }))).resolves.toEqual({ queued: 2 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('handles a late completion after timeout without repeating work', async () => {
    vi.useFakeTimers()
    let finish!: (value: number) => void
    const request = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve
        }),
    )
    const result = runIndexMutation(request, 100)
    const assertion = expect(result).rejects.toBeInstanceOf(IndexMutationTimeout)
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    finish(1)
    await vi.runAllTimersAsync()
    expect(request).toHaveBeenCalledTimes(1)
  })
})
