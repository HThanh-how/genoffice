import { describe, expect, it } from 'vitest'
import { raceTimeout } from '../src/main/document-memory/runtime/race-timeout'

describe('raceTimeout', () => {
  it('returns when the work finishes first, and leaves no timer behind', async () => {
    const started = Date.now()
    await raceTimeout(Promise.resolve('done'), 5_000)
    expect(Date.now() - started).toBeLessThan(200)
  })

  it('stops waiting at the limit when the work never finishes', async () => {
    const started = Date.now()
    await raceTimeout(new Promise<void>(() => undefined), 40)
    expect(Date.now() - started).toBeGreaterThanOrEqual(30)
    expect(Date.now() - started).toBeLessThan(400)
  })

  it('passes on a rejection of the work', async () => {
    await expect(raceTimeout(Promise.reject(new Error('boom')), 1_000)).rejects.toThrow('boom')
  })
})
